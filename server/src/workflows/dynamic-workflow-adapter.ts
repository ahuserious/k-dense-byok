import fs from "node:fs";
import path from "node:path";
import {
  runWorkflow,
  type JournalEntry,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "@quintinshaw/pi-dynamic-workflows";
import type { NodeLimits, WorkflowLimits } from "./schema.ts";
import { isWithin } from "../sandbox-fs.ts";

export type DynamicWorkflowAgent = NonNullable<WorkflowRunOptions["agent"]>;

export type DynamicWorkflowKernel = (
  script: string,
  options: WorkflowRunOptions,
) => Promise<WorkflowRunResult<unknown>>;

export type DynamicWorkflowCallbacks = Pick<
  WorkflowRunOptions,
  | "onAgentEnd"
  | "onAgentHistory"
  | "onAgentJournal"
  | "onAgentStart"
  | "onLog"
  | "onPhase"
  | "onRetrySpend"
  | "onRuntimeEvent"
  | "onTokenUsage"
>;

export interface DynamicWorkflowResumeData {
  journal: Map<string, JournalEntry>;
  fromRunId: string;
  initialTokenUsage?: NonNullable<WorkflowRunOptions["initialTokenUsage"]>;
}

/**
 * Static upper bounds supplied by a Kady compiler. A later compound-node
 * compiler can use the same adapter only after declaring its maximum fan-out.
 */
export interface DynamicWorkflowPlan {
  script: string;
  maxAgentCalls: number;
  maxIterations: number;
  maxParallelism: number;
  minimumAgentCalls?: number;
}

export interface EffectiveDynamicWorkflowLimits {
  limits: WorkflowLimits;
  clampedNodeLimitKeys: (keyof NodeLimits)[];
  kernel: {
    agentRetries: number;
    agentTimeoutMs: number;
    concurrency: number;
    maxAgents: number;
    tokenBudget: number;
  };
}

export interface ExecuteDynamicWorkflowPlanOptions {
  plan: DynamicWorkflowPlan;
  projectCwd: string;
  runCwd: string;
  runId: string;
  graphLimits: WorkflowLimits;
  nodeLimits?: NodeLimits;
  /**
   * Trusted Kady-owned runner. Its promise is a terminal settlement boundary:
   * after cancellation it must settle only once owned provider work has stopped
   * and usage reconciliation has finished. Cancellation must be bounded by the
   * runner/transport itself; this adapter deliberately has no cleanup grace
   * timer and keeps the reservation open until the promise settles.
   */
  agent: DynamicWorkflowAgent;
  /**
   * Reserve the complete effective node budget before any model work starts.
   * The owner must make this reservation atomic against the project/run ledger;
   * the adapter then settles it with the last auditable cumulative usage.
   */
  reserveBudget: DynamicWorkflowBudgetReserver;
  signal?: AbortSignal;
  resume?: DynamicWorkflowResumeData;
  callbacks?: DynamicWorkflowCallbacks;
  /**
   * Trusted kernel override. Its promise must include terminal settlement of
   * every agent call it starts. The pinned package kernel provides that drain;
   * tests and future kernels must preserve it.
   */
  kernel?: DynamicWorkflowKernel;
}

export interface DynamicWorkflowPlanResult {
  result: unknown;
  kernelResult: WorkflowRunResult<unknown>;
  effectiveLimits: EffectiveDynamicWorkflowLimits;
}

export type DynamicWorkflowUsage = NonNullable<
  WorkflowRunResult<unknown>["tokenUsage"]
>;

export interface DynamicWorkflowBudgetSettlement {
  status: "completed" | "failed" | "aborted" | "timed-out";
  usage?: DynamicWorkflowUsage;
}

export interface DynamicWorkflowBudgetReservation {
  settle(
    settlement: DynamicWorkflowBudgetSettlement,
  ): void | Promise<void>;
}

export type DynamicWorkflowBudgetReserver = (request: {
  runId: string;
  maxTokens: number;
  maxCostUsd: number;
  initialUsage?: DynamicWorkflowUsage;
}) => DynamicWorkflowBudgetReservation | Promise<DynamicWorkflowBudgetReservation>;

export type KadyDynamicWorkflowErrorCode =
  | "WORKFLOW_ABORTED"
  | "WORKFLOW_COST_LIMIT_EXCEEDED"
  | "WORKFLOW_INVALID_CONTRACT"
  | "WORKFLOW_ITERATION_LIMIT_UNSUPPORTED"
  | "WORKFLOW_KERNEL_AMBIGUOUS_RESULT"
  | "WORKFLOW_KERNEL_RECOVERABLE_FAILURE"
  | "WORKFLOW_MODEL_RESOLUTION_AMBIGUOUS"
  | "WORKFLOW_MODEL_RESOLUTION_MISMATCH"
  | "WORKFLOW_MODEL_RESOLUTION_UNCONFIRMED"
  | "WORKFLOW_TOKEN_LIMIT_EXCEEDED"
  | "WORKFLOW_TIMEOUT"
  | "WORKFLOW_UNSUPPORTED_MODEL_REQUEST";

export class KadyDynamicWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: KadyDynamicWorkflowErrorCode,
  ) {
    super(message);
    this.name = "KadyDynamicWorkflowError";
  }
}

const NODE_LIMIT_KEYS = [
  "maxIterations",
  "maxModelCalls",
  "maxParallelism",
  "maxSubagents",
  "timeoutMs",
  "maxTokens",
  "maxCostUsd",
  "maxRetries",
] as const satisfies readonly (keyof NodeLimits)[];

const INTEGER_LIMIT_KEYS = new Set<keyof WorkflowLimits>([
  "maxIterations",
  "maxModelCalls",
  "maxParallelism",
  "maxSubagents",
  "timeoutMs",
  "maxTokens",
  "maxRetries",
]);

function invalidContract(message: string): never {
  throw new KadyDynamicWorkflowError(message, "WORKFLOW_INVALID_CONTRACT");
}

function assertAbsoluteCwd(value: string, label: string): void {
  if (!value || !path.isAbsolute(value)) {
    invalidContract(`${label} must be an explicit absolute path.`);
  }
}

function canonicalExecutionDirectories(
  projectCwd: string,
  runCwd: string,
): { projectCwd: string; runCwd: string } {
  assertAbsoluteCwd(projectCwd, "projectCwd");
  assertAbsoluteCwd(runCwd, "runCwd");

  let canonicalProjectCwd: string;
  let canonicalRunCwd: string;
  try {
    if (!fs.statSync(projectCwd).isDirectory()) {
      invalidContract("projectCwd must name an existing directory.");
    }
    if (!fs.statSync(runCwd).isDirectory()) {
      invalidContract("runCwd must name an existing directory.");
    }
    canonicalProjectCwd = fs.realpathSync(projectCwd);
    canonicalRunCwd = fs.realpathSync(runCwd);
  } catch (error) {
    if (error instanceof KadyDynamicWorkflowError) throw error;
    invalidContract(
      `Workflow execution directories must be readable existing directories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isWithin(canonicalProjectCwd, canonicalRunCwd)) {
    invalidContract("runCwd must resolve inside projectCwd.");
  }
  return { projectCwd: canonicalProjectCwd, runCwd: canonicalRunCwd };
}

function assertLimitValue(
  key: keyof WorkflowLimits,
  value: number,
  allowZero: boolean,
): void {
  if (!Number.isFinite(value) || (INTEGER_LIMIT_KEYS.has(key) && !Number.isInteger(value))) {
    invalidContract(`Workflow limit ${key} must be a finite${INTEGER_LIMIT_KEYS.has(key) ? " integer" : " number"}.`);
  }
  if (value < (allowZero ? 0 : 1)) {
    invalidContract(`Workflow limit ${key} must be ${allowZero ? "non-negative" : "positive"}.`);
  }
}

function validateGraphLimits(limits: WorkflowLimits): void {
  for (const key of NODE_LIMIT_KEYS) {
    assertLimitValue(
      key,
      limits[key],
      key === "maxSubagents" || key === "maxCostUsd" || key === "maxRetries",
    );
  }
}

function validateNodeLimit(key: keyof NodeLimits, value: number): void {
  assertLimitValue(
    key,
    value,
    key === "maxSubagents" || key === "maxCostUsd" || key === "maxRetries",
  );
}

function assertPlanBound(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    invalidContract(`${label} must be a positive integer.`);
  }
}

export function deriveDynamicWorkflowLimits(
  graphLimits: WorkflowLimits,
  nodeLimits: NodeLimits | undefined,
  plan: Pick<
    DynamicWorkflowPlan,
    "maxAgentCalls" | "maxIterations" | "maxParallelism" | "minimumAgentCalls"
  >,
): EffectiveDynamicWorkflowLimits {
  validateGraphLimits(graphLimits);
  assertPlanBound(plan.maxAgentCalls, "plan.maxAgentCalls");
  assertPlanBound(plan.maxIterations, "plan.maxIterations");
  assertPlanBound(plan.maxParallelism, "plan.maxParallelism");
  const minimumAgentCalls = plan.minimumAgentCalls ?? 1;
  assertPlanBound(minimumAgentCalls, "plan.minimumAgentCalls");
  if (minimumAgentCalls > plan.maxAgentCalls) {
    invalidContract("plan.minimumAgentCalls cannot exceed plan.maxAgentCalls.");
  }

  const effective = { ...graphLimits };
  const clampedNodeLimitKeys: (keyof NodeLimits)[] = [];
  for (const key of NODE_LIMIT_KEYS) {
    const nodeValue = nodeLimits?.[key];
    if (nodeValue === undefined) continue;
    validateNodeLimit(key, nodeValue);
    if (nodeValue > graphLimits[key]) clampedNodeLimitKeys.push(key);
    effective[key] = Math.min(graphLimits[key], nodeValue);
  }

  if (plan.maxIterations > effective.maxIterations) {
    throw new KadyDynamicWorkflowError(
      `Compiled workflow requires up to ${plan.maxIterations} iterations, but the effective limit is ${effective.maxIterations}.`,
      "WORKFLOW_ITERATION_LIMIT_UNSUPPORTED",
    );
  }

  // maxAgents is a total logical-call ceiling in the dynamic kernel, while
  // Kady's maxSubagents is a live-child/concurrency ceiling. Keep those two
  // dimensions separate so a serial bounded loop does not require one child
  // slot per historical call.
  const maxAgents = Math.min(plan.maxAgentCalls, effective.maxModelCalls);
  if (maxAgents < minimumAgentCalls) {
    invalidContract(
      `Compiled workflow requires at least ${minimumAgentCalls} agent call(s), but model/subagent limits allow ${maxAgents}.`,
    );
  }
  const concurrency = Math.min(
    plan.maxParallelism,
    effective.maxParallelism,
    effective.maxSubagents,
    maxAgents,
  );
  if (concurrency < 1) {
    invalidContract(
      "The compiled workflow performs model work but the effective maxSubagents ceiling is zero.",
    );
  }

  // The package counts logical agent() calls, not retry attempts. Clamp retry
  // rounds so the worst case still fits Kady's model-call ceiling.
  const retryRoundsAllowedByModelCalls = Math.max(
    0,
    Math.floor(effective.maxModelCalls / maxAgents) - 1,
  );

  return {
    limits: effective,
    clampedNodeLimitKeys,
    kernel: {
      agentRetries: Math.min(effective.maxRetries, retryRoundsAllowedByModelCalls),
      agentTimeoutMs: effective.timeoutMs,
      concurrency,
      maxAgents,
      tokenBudget: effective.maxTokens,
    },
  };
}

function createExecutionSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Workflow execution timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  timeout.unref();

  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

const EXPECTED_SIGNAL_SETTLEMENT_CODES = new Set([
  "AGENT_TIMEOUT",
  "DAG_FUSION_ABORTED",
  "DAG_FUSION_CANCELLED",
  "DAG_FUSION_DISPOSED",
  "DAG_FUSION_TIMEOUT",
  "WORKFLOW_ABORTED",
  "WORKFLOW_NODE_ABORTED",
  "WORKFLOW_NODE_TIMEOUT",
  "WORKFLOW_TIMEOUT",
]);

class TrustedExecutionStoppedAfterSettlement extends Error {
  constructor(readonly reason: unknown) {
    super("Trusted workflow work settled after its execution signal stopped.");
    this.name = "TrustedExecutionStoppedAfterSettlement";
  }
}

function stoppedExecutionReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new TrustedExecutionStoppedAfterSettlement(signal.reason);
}

function isExpectedSignalSettlement(error: unknown, signal: AbortSignal): boolean {
  if (error === signal.reason || error instanceof TrustedExecutionStoppedAfterSettlement) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.name === "AbortError" ||
    (typeof record.code === "string" && EXPECTED_SIGNAL_SETTLEMENT_CODES.has(record.code));
}

/**
 * Await trusted work to terminal settlement. The signal asks the owner to stop;
 * it is not itself evidence that the owner or its provider process has stopped.
 */
async function waitForTrustedSettlement<T>(
  workPromise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const result = await workPromise;
  if (signal.aborted) throw stoppedExecutionReason(signal);
  return result;
}

function guardAgentForExecution(
  agent: DynamicWorkflowAgent,
  signal: AbortSignal,
): DynamicWorkflowAgent {
  return {
    async run(prompt, runOptions) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("Workflow execution stopped before agent dispatch.");
      }
      return waitForTrustedSettlement(
        Promise.resolve(agent.run(prompt, { ...runOptions, signal })),
        signal,
      );
    },
  };
}

function validateCumulativeUsage(
  usage: DynamicWorkflowUsage,
  limits: WorkflowLimits,
): KadyDynamicWorkflowError | undefined {
  const numericValues = [
    usage.input,
    usage.output,
    usage.total,
    usage.cost,
    usage.cacheRead ?? 0,
    usage.cacheWrite ?? 0,
  ];
  if (numericValues.some((value) => !Number.isFinite(value) || value < 0)) {
    return new KadyDynamicWorkflowError(
      "The workflow kernel reported invalid cumulative token or cost usage.",
      "WORKFLOW_KERNEL_AMBIGUOUS_RESULT",
    );
  }
  const tokenValues = [
    usage.input,
    usage.output,
    usage.total,
    usage.cacheRead ?? 0,
    usage.cacheWrite ?? 0,
  ];
  if (tokenValues.some((value) => !Number.isSafeInteger(value))) {
    return new KadyDynamicWorkflowError(
      "The workflow kernel reported non-integer token usage.",
      "WORKFLOW_KERNEL_AMBIGUOUS_RESULT",
    );
  }
  if (usage.total > limits.maxTokens) {
    return new KadyDynamicWorkflowError(
      `The workflow used ${usage.total} tokens, exceeding the ${limits.maxTokens} token limit.`,
      "WORKFLOW_TOKEN_LIMIT_EXCEEDED",
    );
  }
  if (usage.cost > limits.maxCostUsd) {
    return new KadyDynamicWorkflowError(
      `The workflow cost $${usage.cost} exceeded the $${limits.maxCostUsd} limit.`,
      "WORKFLOW_COST_LIMIT_EXCEEDED",
    );
  }
  return undefined;
}

function throwIfExecutionStopped(
  callerSignal: AbortSignal | undefined,
  didTimeout: boolean,
): void {
  if (didTimeout) {
    throw new KadyDynamicWorkflowError(
      "The dynamic workflow exceeded its hard execution timeout.",
      "WORKFLOW_TIMEOUT",
    );
  }
  if (callerSignal?.aborted) {
    throw new KadyDynamicWorkflowError(
      "The dynamic workflow was aborted.",
      "WORKFLOW_ABORTED",
    );
  }
}

function defaultKernel(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<unknown>> {
  return runWorkflow(script, options);
}

/**
 * Execute a statically bounded Kady plan through the package's public kernel.
 * Kady supplies every stateful dependency; the kernel never discovers agents,
 * creates its default WorkflowAgent, or persists under global Pi directories.
 */
export async function executeDynamicWorkflowPlan(
  options: ExecuteDynamicWorkflowPlanOptions,
): Promise<DynamicWorkflowPlanResult> {
  const executionDirectories = canonicalExecutionDirectories(
    options.projectCwd,
    options.runCwd,
  );
  if (!options.runId.trim()) invalidContract("runId must be explicit and non-empty.");
  if (!options.agent || typeof options.agent.run !== "function") {
    invalidContract("An injected workflow agent is required.");
  }
  if (typeof options.reserveBudget !== "function") {
    invalidContract("An atomic Kady budget reservation is required before execution.");
  }

  const effectiveLimits = deriveDynamicWorkflowLimits(
    options.graphLimits,
    options.nodeLimits,
    options.plan,
  );
  const initialUsage = options.resume?.initialTokenUsage;
  if (initialUsage) {
    const invalidInitialUsage = validateCumulativeUsage(
      initialUsage,
      effectiveLimits.limits,
    );
    if (invalidInitialUsage) throw invalidInitialUsage;
  }

  const reservation = await options.reserveBudget({
    runId: options.runId,
    maxTokens: effectiveLimits.limits.maxTokens,
    maxCostUsd: effectiveLimits.limits.maxCostUsd,
    ...(initialUsage ? { initialUsage } : {}),
  });
  if (!reservation || typeof reservation.settle !== "function") {
    invalidContract("The Kady budget reserver returned no auditable settlement handle.");
  }

  let recoverableKernelFailure: string | undefined;
  let budgetFailure: KadyDynamicWorkflowError | undefined;
  let latestUsage: DynamicWorkflowUsage | undefined = initialUsage;
  let settlementStatus: DynamicWorkflowBudgetSettlement["status"] = "failed";
  const executionSignal = createExecutionSignal(
    options.signal,
    effectiveLimits.limits.timeoutMs,
  );
  const callbacks = options.callbacks;

  try {
    throwIfExecutionStopped(options.signal, executionSignal.didTimeout());
    const kernelPromise = (options.kernel ?? defaultKernel)(options.plan.script, {
      agent: guardAgentForExecution(options.agent, executionSignal.signal),
      // An injected empty registry prevents the kernel from scanning project or
      // user-level .pi agent directories.
      agentRegistry: new Map(),
      cwd: executionDirectories.runCwd,
      persistLogs: false,
      runId: options.runId,
      signal: executionSignal.signal,
      concurrency: effectiveLimits.kernel.concurrency,
      agentRetries: effectiveLimits.kernel.agentRetries,
      tokenBudget: effectiveLimits.kernel.tokenBudget,
      maxAgents: effectiveLimits.kernel.maxAgents,
      agentTimeoutMs: effectiveLimits.kernel.agentTimeoutMs,
      resumeJournal: options.resume?.journal,
      resumeFromRunId: options.resume?.fromRunId,
      initialTokenUsage: initialUsage,
      onAgentJournal: callbacks?.onAgentJournal,
      onRetrySpend: callbacks?.onRetrySpend,
      onLog: callbacks?.onLog,
      onPhase: callbacks?.onPhase,
      onRuntimeEvent: callbacks?.onRuntimeEvent,
      onAgentStart: callbacks?.onAgentStart,
      onAgentHistory: callbacks?.onAgentHistory,
      onTokenUsage: (usage) => {
        latestUsage = usage;
        callbacks?.onTokenUsage?.(usage);
        const violation = validateCumulativeUsage(usage, effectiveLimits.limits);
        if (violation && !budgetFailure) {
          budgetFailure = violation;
          executionSignal.abort(violation);
        }
      },
      onAgentEnd: (event) => {
        callbacks?.onAgentEnd?.(event);
        if (event.recoverable || event.result == null) {
          recoverableKernelFailure = event.error
            ? `${event.errorCode ?? "UNKNOWN"}: ${event.error}`
            : "The workflow kernel reported a null agent result.";
        }
      },
    });
    const kernelResult = await waitForTrustedSettlement(
      Promise.resolve(kernelPromise),
      executionSignal.signal,
    );

    throwIfExecutionStopped(options.signal, executionSignal.didTimeout());
    if (budgetFailure) throw budgetFailure;
    if (recoverableKernelFailure) {
      throw new KadyDynamicWorkflowError(
        recoverableKernelFailure,
        "WORKFLOW_KERNEL_RECOVERABLE_FAILURE",
      );
    }
    if (kernelResult.result == null) {
      throw new KadyDynamicWorkflowError(
        "The workflow kernel returned a null or undefined result.",
        "WORKFLOW_KERNEL_AMBIGUOUS_RESULT",
      );
    }
    if (kernelResult.runId !== options.runId) {
      throw new KadyDynamicWorkflowError(
        `The workflow kernel returned runId ${String(kernelResult.runId)} instead of ${options.runId}.`,
        "WORKFLOW_KERNEL_AMBIGUOUS_RESULT",
      );
    }
    if (
      !Number.isInteger(kernelResult.agentCount) ||
      kernelResult.agentCount < (options.plan.minimumAgentCalls ?? 1) ||
      kernelResult.agentCount > effectiveLimits.kernel.maxAgents
    ) {
      throw new KadyDynamicWorkflowError(
        `The workflow kernel reported unsupported agentCount ${kernelResult.agentCount}.`,
        "WORKFLOW_KERNEL_AMBIGUOUS_RESULT",
      );
    }

    const tokenUsage = kernelResult.tokenUsage;
    if (!tokenUsage) {
      throw new KadyDynamicWorkflowError(
        "The workflow kernel did not return auditable token and cost usage.",
        "WORKFLOW_KERNEL_AMBIGUOUS_RESULT",
      );
    }
    latestUsage = tokenUsage;
    const usageFailure = validateCumulativeUsage(tokenUsage, effectiveLimits.limits);
    if (usageFailure) throw usageFailure;

    settlementStatus = "completed";
    return {
      result: kernelResult.result,
      kernelResult,
      effectiveLimits,
    };
  } catch (error) {
    const expectedSignalSettlement = executionSignal.signal.aborted &&
      isExpectedSignalSettlement(error, executionSignal.signal);
    settlementStatus = executionSignal.didTimeout()
      ? "timed-out"
      : options.signal?.aborted
        ? "aborted"
        : "failed";
    // Budget evidence remains authoritative only when trusted work settles in
    // the expected cancellation state. An unrelated rejection after the stop
    // signal is a cleanup failure and must remain visible to the caller.
    if (budgetFailure && expectedSignalSettlement) throw budgetFailure;
    if (expectedSignalSettlement) {
      throwIfExecutionStopped(options.signal, executionSignal.didTimeout());
    }
    throw error;
  } finally {
    executionSignal.dispose();
    await reservation.settle({
      status: settlementStatus,
      ...(latestUsage ? { usage: latestUsage } : {}),
    });
  }
}
