import type { LedgerAuthType } from "../cost/billing.ts";
import {
  billingCountsTowardBudget,
  billingForProvider,
  normalizeUsageCost,
} from "../cost/billing.ts";
import type { DagFusionDelegationUsageSettlement } from "../../pi-packages/dag-fusion-drive/index.ts";
import {
  MAX_WORKFLOW_BUDGET_LEASE_MS,
  reserveWorkflowBudget,
  workflowBudgetReservationId,
  type ReserveWorkflowBudgetInput,
  type WorkflowBudgetReservationHandle,
  type WorkflowBudgetSettlementStatus,
  type WorkflowBudgetUsageInput,
} from "./budget.ts";
import {
  WorkflowRunController,
  type WorkflowRunControllerErrorInfo,
} from "./controller.ts";
import {
  createKadyWorkflowNodeExecutor,
  type CreateKadyWorkflowNodeExecutorOptions,
  type KadyWorkflowUsageAdmission,
  type KadyWorkflowUsageReserver,
  type TrustedLeanVerifier,
} from "./kady-node-executor.ts";
import { createTrustedLeanVerifier } from "./lean4-verifier.ts";
import type { WorkflowNodeExecutor } from "./runner.ts";
import type { WorkflowStore } from "./store.ts";

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
}

function authTypeForAdmission(admission: KadyWorkflowUsageAdmission): LedgerAuthType {
  switch (admission.modelReceipt.resolved.auth.kind) {
    case "oauth":
      return "oauth";
    case "local":
    case "custom":
      return "local";
    case "api-key":
      return "api_key";
    default:
      // An unknown receipt must not silently bypass a project cap.
      return "none";
  }
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

function settlementStatus(
  settlement: DagFusionDelegationUsageSettlement,
): WorkflowBudgetSettlementStatus {
  if (
    settlement.reason === "caller-cancelled" ||
    settlement.reason === "caller-aborted" ||
    settlement.responseStatus === "cancelled" ||
    settlement.responseStatus === "interrupted"
  ) {
    return "aborted";
  }
  if (
    settlement.reason === "host-timeout" ||
    settlement.responseStatus === "timed_out"
  ) {
    return "timed-out";
  }
  // A provider response is successful only with its auditable terminal usage.
  // Missing usage remains a failed, maximum-charge reconciliation.
  if (
    settlement.reason === "terminal-response" &&
    settlement.responseStatus === "completed" &&
    settlement.usage !== undefined
  ) {
    return "completed";
  }
  return "failed";
}

function settlementReason(settlement: DagFusionDelegationUsageSettlement): string {
  const response = settlement.responseStatus ?? "no-response";
  const usage = settlement.usage ? "observed" : "missing";
  return `dag-fusion:${settlement.reason}:${response}:usage-${usage}`;
}

function usageForBudget(
  settlement: DagFusionDelegationUsageSettlement,
  admission: KadyWorkflowUsageAdmission,
): WorkflowBudgetUsageInput | undefined {
  const usage = settlement.usage;
  if (!usage) return undefined;
  const billing = billingForProvider(
    admission.modelReceipt.resolved.provider,
    authTypeForAdmission(admission),
  );
  const normalizedCost = normalizeUsageCost(usage.cost, billing);
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    // Pi's delegation ceiling counts generated and prompt tokens. Cache
    // counters are retained for audit, but adding them again would charge the
    // same logical input twice on providers that report cached prompt tokens.
    total: usage.input + usage.output,
    cost: normalizedCost.costUsd,
  };
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
    const billing = billingForProvider(
      admission.modelReceipt.resolved.provider,
      authTypeForAdmission(admission),
    );
    const countsTowardBudget = billingCountsTowardBudget(billing);
    const handle = await reserveBudget({
      projectId: admission.projectId,
      reservationId: workflowBudgetReservationId(
        admission.projectId,
        admission.runId,
        admission.executionId,
        admission.attempt,
        admission.slotId,
      ),
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
      async reconcile(settlement) {
        assertSettlementIdentity(admission, settlement);
        await handle.settle({
          status: settlementStatus(settlement),
          usage: usageForBudget(settlement, admission),
          reason: settlementReason(settlement),
        });
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
  const nodeExecutorFactory = options.nodeExecutorFactory ?? createKadyWorkflowNodeExecutor;
  const executeNode = nodeExecutorFactory({
    reserveUsage,
    verifyLean: options.leanVerifier ?? createTrustedLeanVerifier(),
  });

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
