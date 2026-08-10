import { withPromptOptimizationNodeExecutor } from "./prompt-opt-node.ts";
import {
  billingCountsTowardBudget,
  billingForProvider,
} from "../cost/billing.ts";
import type { DagFusionDelegationUsageSettlement } from "../../pi-packages/dag-fusion-drive/index.ts";
import {
  MAX_WORKFLOW_BUDGET_LEASE_MS,
  reserveWorkflowBudget,
  workflowBudgetReservationId,
  type ReserveWorkflowBudgetInput,
  type WorkflowBudgetReservationHandle,
} from "./budget.ts";
import {
  WorkflowRunController,
  type WorkflowRunControllerErrorInfo,
} from "./controller.ts";
import {
  createKadyWorkflowNodeExecutor,
  type CreateKadyWorkflowNodeExecutorOptions,
  type KadyNodeExecutorDependencies,
  type KadyWorkflowUsageAdmission,
  type KadyWorkflowUsageReserver,
  type TrustedLeanVerifier,
} from "./kady-node-executor.ts";
import { createTrustedLeanVerifier } from "./lean4-verifier.ts";
import {
  withDeliberationBindings,
  type DeliberationExecutorDependencies,
} from "./deliberation-runtime.ts";
import type { WorkflowNodeExecutor } from "./runner.ts";
import type { WorkflowStore } from "./store.ts";
import {
  createSupervisedWorkflowBudgetDescriptor,
  settleWorkflowBudgetInputForDagFusion,
} from "./supervised-budget.ts";

export const WORKFLOW_BUDGET_SETTLEMENT_GRACE_MS = 30_000;

type ReserveWorkflowBudget = (
  input: ReserveWorkflowBudgetInput,
) => Promise<WorkflowBudgetReservationHandle>;

type KadyWorkflowNodeExecutorFactory = (
  options: CreateKadyWorkflowNodeExecutorOptions,
) => WorkflowNodeExecutor;

export interface CreateProductionWorkflowUsageReserverOptions {
  reserveBudget?: ReserveWorkflowBudget;
}

export interface CreateProductionWorkflowControllerOptions {
  store?: WorkflowStore;
  maxActiveRuns?: number;
  maxActiveRunsPerProject?: number;
  onError?(info: WorkflowRunControllerErrorInfo): void;
  reserveBudget?: ReserveWorkflowBudget;
  leanVerifier?: TrustedLeanVerifier;
  nodeExecutorFactory?: KadyWorkflowNodeExecutorFactory;
  /** Trusted transport overrides, such as the out-of-process workflow supervisor. */
  nodeExecutorDependencies?: Partial<KadyNodeExecutorDependencies>;
  /** Server-only personality loader override used by focused runtime tests. */
  deliberationDependencies?: DeliberationExecutorDependencies;
}

function workflowBudgetLeaseDuration(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Workflow delegation timeout must be a positive integer.");
  }
  return Math.min(
    MAX_WORKFLOW_BUDGET_LEASE_MS,
    Math.max(1_000, timeoutMs + WORKFLOW_BUDGET_SETTLEMENT_GRACE_MS),
  );
}

function assertSettlementIdentity(
  admission: KadyWorkflowUsageAdmission,
  settlement: DagFusionDelegationUsageSettlement,
): void {
  if (
    settlement.identity.ownerRunId !== admission.runId ||
    settlement.identity.nodeId !== `${admission.executionId}:${admission.slotId}`
  ) {
    throw new Error("Workflow usage settlement did not match its durable reservation owner.");
  }
}

/**
 * Convert the executor's pre-dispatch admission into Kady's durable budget
 * reservation. These records are the accounting source for DAG calls; the
 * dedicated workflow session deliberately does not also append cost-ledger
 * rows for the same child process.
 */
export function createProductionWorkflowUsageReserver(
  options: CreateProductionWorkflowUsageReserverOptions = {},
): KadyWorkflowUsageReserver {
  const reserveBudget = options.reserveBudget ?? reserveWorkflowBudget;

  return async (admission) => {
    const reservationId = workflowBudgetReservationId(
      admission.projectId,
      admission.runId,
      admission.executionId,
      admission.attempt,
      admission.slotId,
    );
    const descriptor = createSupervisedWorkflowBudgetDescriptor({
      reservationId,
      runId: admission.runId,
      executionId: admission.executionId,
      attempt: admission.attempt,
      slotId: admission.slotId,
      provider: admission.modelReceipt.resolved.provider,
      authKind: admission.modelReceipt.resolved.auth.kind,
    });
    const billing = billingForProvider(
      descriptor.provider,
      descriptor.authType,
    );
    const countsTowardBudget = billingCountsTowardBudget(billing);
    const handle = await reserveBudget({
      projectId: admission.projectId,
      reservationId,
      runId: admission.runId,
      runMaxCostUsd: admission.runMaxCostUsd,
      runMaxTokens: admission.runMaxTokens,
      runMaxModelCalls: admission.runMaxModelCalls,
      maxCostUsd: countsTowardBudget ? admission.maxCostUsd : 0,
      maxTokens: admission.maxTokens,
      modelCallCount: admission.modelCallCount,
      leaseDurationMs: workflowBudgetLeaseDuration(admission.timeoutMs),
    });

    return {
      descriptor,
      async reconcile(settlement) {
        assertSettlementIdentity(admission, settlement);
        await handle.settle(
          settleWorkflowBudgetInputForDagFusion(descriptor, settlement),
        );
      },
    };
  };
}

/** Compose the production scheduler, trusted node runtime, budget, and Lean verifier. */
export function createProductionWorkflowController(
  options: CreateProductionWorkflowControllerOptions = {},
): WorkflowRunController {
  const reserveUsage = createProductionWorkflowUsageReserver({
    reserveBudget: options.reserveBudget,
  });
  const nodeExecutorFactory = options.nodeExecutorFactory ?? ((executorOptions) => withPromptOptimizationNodeExecutor(createKadyWorkflowNodeExecutor(executorOptions)));
  const kadyExecutor = nodeExecutorFactory({
    reserveUsage,
    verifyLean: options.leanVerifier ?? createTrustedLeanVerifier(),
    ...(options.nodeExecutorDependencies
      ? { dependencies: options.nodeExecutorDependencies }
      : {}),
  });
  const executeNode = withDeliberationBindings(
    kadyExecutor,
    options.deliberationDependencies,
  );

  return new WorkflowRunController({
    store: options.store,
    maxActiveRuns: options.maxActiveRuns,
    maxActiveRunsPerProject: options.maxActiveRunsPerProject,
    onError: options.onError,
    createExecutor: () => executeNode,
  });
}

/** Safe structured log fields: never include error messages, causes, or stacks. */
export function workflowControllerErrorLogFields(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : undefined;
  const rawName = error instanceof Error ? error.name : undefined;
  const errorName = rawName && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
    ? rawName
    : "UnknownError";
  const rawCode = record?.code;
  return {
    errorName,
    ...(typeof rawCode === "string" && /^[A-Z0-9_:-]{1,128}$/.test(rawCode)
      ? { errorCode: rawCode }
      : {}),
  };
}
