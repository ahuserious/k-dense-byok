import { createHash } from "node:crypto";
import {
  readTrustedDagFusionCompactionAudit,
  type TrustedDagFusionCompactionAudit,
} from "../../pi-packages/dag-fusion-drive/compaction-audit.ts";
import type {
  WorkflowBehaviorDispatch,
  WorkflowBehaviorRegistry,
  WorkflowBehaviorResult,
} from "./behavior-registry.ts";

export const COMPACTION_WATCHER_BEHAVIOR = "compaction-watcher";
export const DEFAULT_COMPACTION_WATCHER_MODEL =
  "openrouter/google/gemini-3.1-flash-lite";
export const DEFAULT_COMPACTION_REPAIR_MODEL =
  "openrouter/anthropic/claude-opus-4.8";

const MODEL_REF_PATTERN = /^[a-z0-9][a-z0-9._-]*\/.+$/;
const STOPPED_WORKFLOW_STATUSES = new Set([
  "blocked",
  "failed",
  "interrupted",
  "stalled",
  "stopped",
]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 256;
const MAX_FINDING_BYTES = 16 * 1024;

export type CompactionWatcherErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_AUDIT_INPUT"
  | "INVALID_MODEL_VERDICT"
  | "INVALID_BEHAVIOR_DISPATCH"
  | "OPERATION_IN_PROGRESS"
  | "REDEPLOY_REJECTED"
  | "RESTART_PARTIAL_SUCCESS"
  | "RESTART_REJECTED";

export class CompactionWatcherError extends Error {
  constructor(
    readonly code: CompactionWatcherErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompactionWatcherError";
  }
}

export class CompactionWatcherPartialSuccessError extends CompactionWatcherError {
  constructor(
    message: string,
    readonly operation: WatcherOperationRecord,
    options?: ErrorOptions,
  ) {
    super("RESTART_PARTIAL_SUCCESS", message, options);
    this.name = "CompactionWatcherPartialSuccessError";
  }
}

/**
 * Marks a failure that happened before the repair runner was invoked. The
 * watcher may safely persist this as retryable because no deployment side
 * effect can have occurred.
 */
export class CompactionWatcherAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompactionWatcherAdmissionError";
  }
}

export interface CompactionSemanticRecord {
  /** Exact bounded record visible immediately before Pi compacted the session. */
  preCompactionRecord: string;
  /** Exact summary Pi installed in place of that record. */
  compactedSummary: string;
  userPrompt: string;
  goal: string;
  openTodos: readonly string[];
}

export interface CompactionSemanticModelRequest extends CompactionSemanticRecord {
  model: string;
  runId: string;
  childRunId: string;
  instruction: string;
}

export interface CompactionSemanticVerdict {
  verdict: "clean" | "context-rot";
  hallucinations: readonly string[];
  missedTodos: readonly string[];
  promptDeviations: readonly string[];
}

export type CompactionSemanticModel = (
  request: CompactionSemanticModelRequest,
) => Promise<unknown>;

export interface WatcherRestartRequest {
  runId: string;
  nodeId?: string;
  /** Always true: the watcher, not the origin adapter, owns this restart. */
  resume: true;
  originIndependent: true;
  recovery: DurableRestartProof;
  resumeResponse?: WatcherResumeResponse;
  reason: string;
}

export interface WatcherRestartReceipt {
  resumed: boolean;
  detail?: string;
}

export interface WatcherRepairRequest {
  runId: string;
  nodeId?: string;
  auditIdentity: string;
  model: string;
  reason: string;
  semanticVerdict?: CompactionSemanticVerdict;
}

export interface WatcherRepairReceipt {
  redeployed: boolean;
  workflowRevision?: number;
  recovery?: DurableRestartProof;
  detail?: string;
}

export interface DurableRestartProof {
  runId: string;
  checkpointId: string;
  restartToken: string;
  verified: true;
  sideEffectSafety: "no-side-effects" | "idempotent" | "compensated";
}

export interface WatcherResumeResponse {
  resumable?: boolean;
  restartRequired?: boolean;
  restartWarning?: string;
}

export interface WatcherRescueProposalRequest {
  runId: string;
  nodeId?: string;
  reason: string;
  resumeResponse?: WatcherResumeResponse;
  recovery?: DurableRestartProof;
}

export interface WatcherRescueProposalReceipt {
  proposalId: string;
  detail?: string;
}

export type WatcherOperationPhase =
  | "repairing"
  | "repair-failed"
  | "redeployed"
  | "restart-failed"
  | "completed";

export interface WatcherOperationRecord {
  version: 1;
  operationKey: string;
  sequence: number;
  runId: string;
  nodeId?: string;
  auditIdentity: string;
  phase: WatcherOperationPhase;
  updatedAt: number;
  workflowRevision?: number;
  recovery?: DurableRestartProof;
  detail?: string;
}

export interface WatcherOperationTransaction {
  readonly current: WatcherOperationRecord | undefined;
  compareAndSwap(
    expectedPhase: WatcherOperationPhase | undefined,
    next: Omit<WatcherOperationRecord, "version" | "operationKey" | "sequence" | "updatedAt">,
  ): WatcherOperationRecord;
}

export interface WatcherOperationStore {
  runExclusive<T>(
    operationKey: string,
    operation: (transaction: WatcherOperationTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface CompactionWatcherBehaviorResult extends WorkflowBehaviorResult {
  resumable: boolean;
  resumed?: boolean;
  redeployed?: boolean;
  workflowRevision?: number;
  operationKey?: string;
  proposal?: {
    proposalId: string;
    reason: string;
    resumeResponse?: WatcherResumeResponse;
  };
}

export interface CompactionWatcherDependencies {
  registry: WorkflowBehaviorRegistry;
  semanticModel: CompactionSemanticModel;
  restartWorkflow(request: WatcherRestartRequest): Promise<WatcherRestartReceipt>;
  repairAndRedeploy(request: WatcherRepairRequest): Promise<WatcherRepairReceipt>;
  proposeRescue(request: WatcherRescueProposalRequest): Promise<WatcherRescueProposalReceipt>;
  operationStore: WatcherOperationStore;
  readFingerprintAudit?: (
    sandboxRoot: string,
    childRunId: string,
  ) => TrustedDagFusionCompactionAudit;
  env?: NodeJS.ProcessEnv;
  watcherModel?: string;
  repairModel?: string;
}

export interface WatchCompactionRequest extends CompactionSemanticRecord {
  runId: string;
  childRunId: string;
  sandboxRoot: string;
  nodeId?: string;
}

export type WatchCompactionResult =
  | { status: "not-compacted"; fingerprintAudit: TrustedDagFusionCompactionAudit }
  | {
      status: "clean";
      fingerprintAudit: TrustedDagFusionCompactionAudit;
      semanticVerdict: CompactionSemanticVerdict;
    }
  | {
      status: "repaired-and-restarted";
      fingerprintAudit: TrustedDagFusionCompactionAudit;
      semanticVerdict?: CompactionSemanticVerdict;
      behavior: CompactionWatcherBehaviorResult;
    };

export interface RestartStoppedWorkflowRequest {
  runId: string;
  status: string;
  nodeId?: string;
  recovery?: DurableRestartProof;
  /** Exact normalized shape consumed from the deferred S2b API seam. */
  resumeResponse?: WatcherResumeResponse;
}

export interface CompactionWatcher {
  watcherModel: string;
  repairModel: string;
  watch(request: WatchCompactionRequest): Promise<WatchCompactionResult>;
  restartStoppedWorkflow(
    request: RestartStoppedWorkflowRequest,
  ): Promise<CompactionWatcherBehaviorResult>;
}

function configuredModel(
  explicit: string | undefined,
  environmentValue: string | undefined,
  fallback: string,
  slot: string,
): string {
  const model = explicit?.trim() || environmentValue?.trim() || fallback;
  if (!MODEL_REF_PATTERN.test(model)) {
    throw new CompactionWatcherError(
      "INVALID_CONFIGURATION",
      `${slot} must be a provider-qualified model reference.`,
    );
  }
  return model;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= MAX_TEXT_BYTES;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedFindings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_FINDINGS && value.every(
    (finding) => typeof finding === "string" && finding.length > 0 &&
      utf8Bytes(finding) <= MAX_FINDING_BYTES,
  );
}

function validateSemanticRecord(record: CompactionSemanticRecord): void {
  if (
    !boundedText(record.preCompactionRecord) ||
    !boundedText(record.compactedSummary) ||
    !boundedText(record.userPrompt) ||
    !boundedText(record.goal) ||
    !Array.isArray(record.openTodos) ||
    record.openTodos.length > MAX_FINDINGS ||
    !record.openTodos.every((todo) =>
      typeof todo === "string" && todo.length > 0 && utf8Bytes(todo) <= MAX_FINDING_BYTES
    )
  ) {
    throw new CompactionWatcherError(
      "INVALID_AUDIT_INPUT",
      "The semantic compaction record is empty, malformed, or exceeds its bounds.",
    );
  }
}

export function parseCompactionSemanticVerdict(
  value: unknown,
): CompactionSemanticVerdict {
  if (
    !plainRecord(value) ||
    Object.keys(value).some((key) => ![
      "verdict",
      "hallucinations",
      "missedTodos",
      "promptDeviations",
    ].includes(key)) ||
    (value.verdict !== "clean" && value.verdict !== "context-rot") ||
    !boundedFindings(value.hallucinations) ||
    !boundedFindings(value.missedTodos) ||
    !boundedFindings(value.promptDeviations)
  ) {
    throw new CompactionWatcherError(
      "INVALID_MODEL_VERDICT",
      "The compaction watcher model returned an invalid verdict.",
    );
  }
  const findings = [
    ...value.hallucinations,
    ...value.missedTodos,
    ...value.promptDeviations,
  ];
  if (
    (value.verdict === "clean" && findings.length > 0) ||
    (value.verdict === "context-rot" && findings.length === 0)
  ) {
    throw new CompactionWatcherError(
      "INVALID_MODEL_VERDICT",
      "The compaction watcher verdict contradicts its findings.",
    );
  }
  return {
    verdict: value.verdict,
    hallucinations: [...value.hallucinations],
    missedTodos: [...value.missedTodos],
    promptDeviations: [...value.promptDeviations],
  };
}

function dispatchPayload(dispatch: WorkflowBehaviorDispatch): Record<string, unknown> {
  if (!plainRecord(dispatch.payload)) {
    throw new CompactionWatcherError(
      "INVALID_BEHAVIOR_DISPATCH",
      `Watcher behavior ${dispatch.capability} requires a payload.`,
    );
  }
  return dispatch.payload;
}

function optionalNodeId(dispatch: WorkflowBehaviorDispatch): string | undefined {
  if (dispatch.nodeId === undefined) return undefined;
  if (!boundedText(dispatch.nodeId) || utf8Bytes(dispatch.nodeId) > MAX_FINDING_BYTES) {
    throw new CompactionWatcherError(
      "INVALID_BEHAVIOR_DISPATCH",
      "Watcher behavior nodeId is invalid.",
    );
  }
  return dispatch.nodeId;
}

function reasonFromPayload(payload: Record<string, unknown>): string {
  if (!boundedText(payload.reason) || utf8Bytes(payload.reason) > MAX_FINDING_BYTES) {
    throw new CompactionWatcherError(
      "INVALID_BEHAVIOR_DISPATCH",
      "Watcher behavior requires a bounded reason.",
    );
  }
  return payload.reason;
}

function semanticVerdictFromPayload(
  payload: Record<string, unknown>,
): CompactionSemanticVerdict | undefined {
  return payload.semanticVerdict === undefined
    ? undefined
    : parseCompactionSemanticVerdict(payload.semanticVerdict);
}

function resumeResponseFromPayload(value: unknown): WatcherResumeResponse | undefined {
  if (value === undefined) return undefined;
  if (
    !plainRecord(value) ||
    Object.keys(value).some((key) => ![
      "resumable",
      "restartRequired",
      "restartWarning",
    ].includes(key)) ||
    (value.resumable !== undefined && typeof value.resumable !== "boolean") ||
    (value.restartRequired !== undefined && typeof value.restartRequired !== "boolean") ||
    (value.restartWarning !== undefined && (
      typeof value.restartWarning !== "string" ||
      utf8Bytes(value.restartWarning) > MAX_FINDING_BYTES
    ))
  ) {
    throw new CompactionWatcherError(
      "INVALID_BEHAVIOR_DISPATCH",
      "Watcher resume response is malformed or exceeds its bounds.",
    );
  }
  return {
    ...(value.resumable !== undefined ? { resumable: value.resumable } : {}),
    ...(value.restartRequired !== undefined
      ? { restartRequired: value.restartRequired }
      : {}),
    ...(value.restartWarning !== undefined
      ? { restartWarning: value.restartWarning }
      : {}),
  };
}

function durableRestartProof(value: unknown, runId: string): DurableRestartProof | undefined {
  if (
    !plainRecord(value) ||
    Object.keys(value).some((key) => ![
      "runId",
      "checkpointId",
      "restartToken",
      "verified",
      "sideEffectSafety",
    ].includes(key)) ||
    value.runId !== runId ||
    !boundedText(value.checkpointId) ||
    utf8Bytes(value.checkpointId) > MAX_FINDING_BYTES ||
    !boundedText(value.restartToken) ||
    utf8Bytes(value.restartToken) > MAX_FINDING_BYTES ||
    value.verified !== true ||
    !["no-side-effects", "idempotent", "compensated"].includes(
      value.sideEffectSafety as string,
    )
  ) return undefined;
  return {
    runId,
    checkpointId: value.checkpointId,
    restartToken: value.restartToken,
    verified: true,
    sideEffectSafety: value.sideEffectSafety as DurableRestartProof["sideEffectSafety"],
  };
}

function auditIdentityFromPayload(payload: Record<string, unknown>): string {
  if (
    typeof payload.auditIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.auditIdentity)
  ) {
    throw new CompactionWatcherError(
      "INVALID_BEHAVIOR_DISPATCH",
      "Fix-redeploy requires a deterministic audit identity.",
    );
  }
  return payload.auditIdentity;
}

function operationKey(runId: string, nodeId: string | undefined, auditIdentity: string): string {
  return createHash("sha256")
    .update(runId, "utf8")
    .update("\0")
    .update(nodeId ?? "", "utf8")
    .update("\0")
    .update(auditIdentity, "utf8")
    .digest("hex");
}

function compactionAuditIdentity(
  request: WatchCompactionRequest,
  audit: TrustedDagFusionCompactionAudit,
): string {
  const hash = createHash("sha256");
  hash.update(request.childRunId, "utf8");
  hash.update("\0");
  hash.update(request.preCompactionRecord, "utf8");
  hash.update("\0");
  hash.update(request.compactedSummary, "utf8");
  hash.update("\0");
  hash.update(JSON.stringify(audit), "utf8");
  return hash.digest("hex");
}

function recoveryBlockReason(
  recovery: DurableRestartProof | undefined,
  resumeResponse: WatcherResumeResponse | undefined,
): string | undefined {
  if (!recovery) return "durable-recovery-proof-missing-or-invalid";
  if (resumeResponse?.resumable === false) return "upstream-marked-non-resumable";
  if (resumeResponse?.restartRequired === true) return "upstream-requires-new-run";
  return undefined;
}

function fingerprintFailure(audit: TrustedDagFusionCompactionAudit): string | undefined {
  if (audit.occurred && audit.checks.length === 0) return "audit:MISSING_CHECKS";
  const failed = audit.checks.find((check) => !check.passed);
  return failed
    ? `${failed.phase}:${failed.errorCode ?? "AUDIT_CHECK_FAILED"}`
    : undefined;
}

const SEMANTIC_AUDIT_INSTRUCTION = [
  "Compare the compacted summary against the exact pre-compaction record.",
  "Detect only three classes of context rot: invented facts or commitments,",
  "missed open todos, and deviation from the user's prompt or active goal.",
  "Return a strict object with verdict, hallucinations, missedTodos, and",
  "promptDeviations. A clean verdict must have three empty finding arrays.",
].join(" ");

/**
 * Register the only behavior that owns workflow restart after watcher action.
 * Runner auto-rescue and the proposal-only helper remain separate callers.
 */
export function createCompactionWatcher(
  dependencies: CompactionWatcherDependencies,
): CompactionWatcher {
  const env = dependencies.env ?? process.env;
  const watcherModel = configuredModel(
    dependencies.watcherModel,
    env.KADY_COMPACTION_WATCHER_MODEL,
    DEFAULT_COMPACTION_WATCHER_MODEL,
    "KADY_COMPACTION_WATCHER_MODEL",
  );
  const repairModel = configuredModel(
    dependencies.repairModel,
    env.KADY_COMPACTION_REPAIR_MODEL,
    DEFAULT_COMPACTION_REPAIR_MODEL,
    "KADY_COMPACTION_REPAIR_MODEL",
  );
  const readFingerprintAudit = dependencies.readFingerprintAudit ??
    readTrustedDagFusionCompactionAudit;

  const proposeInsteadOfRestart = async (
    runId: string,
    nodeId: string | undefined,
    reason: string,
    resumeResponse: WatcherResumeResponse | undefined,
    recovery: DurableRestartProof | undefined,
  ): Promise<CompactionWatcherBehaviorResult> => {
    const proposal = await dependencies.proposeRescue({
      runId,
      ...(nodeId ? { nodeId } : {}),
      reason,
      ...(resumeResponse ? { resumeResponse } : {}),
      ...(recovery ? { recovery } : {}),
    });
    return {
      handled: true,
      resumable: false,
      proposal: {
        proposalId: proposal.proposalId,
        reason,
        ...(resumeResponse ? { resumeResponse } : {}),
      },
      detail: proposal.detail ?? `Created rescue proposal ${proposal.proposalId}.`,
    };
  };

  dependencies.registry.register(
    COMPACTION_WATCHER_BEHAVIOR,
    ["restart-workflow", "escalate-fix-redeploy"],
    async (dispatch): Promise<CompactionWatcherBehaviorResult> => {
      const payload = dispatchPayload(dispatch);
      const nodeId = optionalNodeId(dispatch);
      const reason = reasonFromPayload(payload);

      if (dispatch.capability === "restart-workflow") {
        const resumeResponse = resumeResponseFromPayload(payload.resumeResponse);
        const recovery = durableRestartProof(payload.recovery, dispatch.runId);
        const blocked = recoveryBlockReason(recovery, resumeResponse);
        if (blocked) {
          return proposeInsteadOfRestart(
            dispatch.runId,
            nodeId,
            `${reason}:${blocked}`,
            resumeResponse,
            recovery,
          );
        }
        const restart = await dependencies.restartWorkflow({
          runId: dispatch.runId,
          ...(nodeId ? { nodeId } : {}),
          resume: true,
          originIndependent: true,
          recovery: recovery!,
          ...(resumeResponse ? { resumeResponse } : {}),
          reason,
        });
        if (!restart.resumed) {
          throw new CompactionWatcherError(
            "RESTART_REJECTED",
            restart.detail ?? `Watcher restart was rejected for ${dispatch.runId}.`,
          );
        }
        return {
          handled: true,
          resumable: true,
          resumed: true,
          detail: restart.detail ?? `Watcher resumed ${dispatch.runId}.`,
        };
      }

      if (dispatch.capability !== "escalate-fix-redeploy") {
        throw new CompactionWatcherError(
          "INVALID_BEHAVIOR_DISPATCH",
          `Unsupported watcher capability ${dispatch.capability}.`,
        );
      }
      const semanticVerdict = semanticVerdictFromPayload(payload);
      const auditIdentity = auditIdentityFromPayload(payload);
      const resumeResponse = resumeResponseFromPayload(payload.resumeResponse);
      const key = operationKey(dispatch.runId, nodeId, auditIdentity);
      return dependencies.operationStore.runExclusive(key, async (transaction) => {
        let operation = transaction.current;
        if (operation?.phase === "completed") {
          return {
            handled: true,
            resumable: true,
            redeployed: true,
            resumed: true,
            workflowRevision: operation.workflowRevision,
            operationKey: key,
            detail: operation.detail ?? `Watcher operation ${key} already completed.`,
          };
        }
        if (operation?.phase === "repairing") {
          throw new CompactionWatcherPartialSuccessError(
            `Watcher operation ${key} was interrupted while repair state was ambiguous.`,
            operation,
          );
        }

        if (!operation || operation.phase === "repair-failed") {
          const expectedPhase = operation?.phase;
          operation = transaction.compareAndSwap(expectedPhase, {
            runId: dispatch.runId,
            ...(nodeId ? { nodeId } : {}),
            auditIdentity,
            phase: "repairing",
          });
          let repair: WatcherRepairReceipt;
          try {
            repair = await dependencies.repairAndRedeploy({
              runId: dispatch.runId,
              ...(nodeId ? { nodeId } : {}),
              auditIdentity,
              model: repairModel,
              reason,
              ...(semanticVerdict ? { semanticVerdict } : {}),
            });
          } catch (error) {
            if (error instanceof CompactionWatcherAdmissionError) {
              const detail = `Repair admission rejected before runner execution: ${error.message}`;
              transaction.compareAndSwap("repairing", {
                runId: dispatch.runId,
                ...(nodeId ? { nodeId } : {}),
                auditIdentity,
                phase: "repair-failed",
                detail,
              });
              throw new CompactionWatcherError("REDEPLOY_REJECTED", detail, {
                cause: error,
              });
            }
            operation = transaction.compareAndSwap("repairing", {
              runId: dispatch.runId,
              ...(nodeId ? { nodeId } : {}),
              auditIdentity,
              phase: "repairing",
              detail: error instanceof Error
                ? `Repair outcome is unknown: ${error.message}`
                : "Repair outcome is unknown.",
            });
            throw new CompactionWatcherPartialSuccessError(
              `Watcher operation ${key} may have redeployed before repair failed. Automatic repair retry is disabled until the persisted operation is reconciled.`,
              operation,
              { cause: error },
            );
          }
          const recovery = durableRestartProof(repair.recovery, dispatch.runId);
          if (!repair.redeployed) {
            const detail = repair.detail ??
              "Watcher repair explicitly reported that no revision was deployed.";
            transaction.compareAndSwap("repairing", {
              runId: dispatch.runId,
              ...(nodeId ? { nodeId } : {}),
              auditIdentity,
              phase: "repair-failed",
              detail,
            });
            throw new CompactionWatcherError("REDEPLOY_REJECTED", detail);
          }
          if (
            !Number.isSafeInteger(repair.workflowRevision) ||
            (repair.workflowRevision ?? 0) < 1 ||
            !recovery
          ) {
            operation = transaction.compareAndSwap("repairing", {
              runId: dispatch.runId,
              ...(nodeId ? { nodeId } : {}),
              auditIdentity,
              phase: "repairing",
              detail: repair.detail ??
                "A deployment was reported without its durable revision or restart proof.",
            });
            throw new CompactionWatcherPartialSuccessError(
              `Watcher operation ${key} reported a deployment without trustworthy restart state. Automatic repair retry is disabled until it is reconciled.`,
              operation,
            );
          }
          // Persist the exact deployed revision and recovery proof before any
          // restart attempt. A retry can now resume here without redeploying.
          operation = transaction.compareAndSwap("repairing", {
            runId: dispatch.runId,
            ...(nodeId ? { nodeId } : {}),
            auditIdentity,
            phase: "redeployed",
            workflowRevision: repair.workflowRevision,
            recovery,
            ...(repair.detail ? { detail: repair.detail } : {}),
          });
        }

        const recovery = durableRestartProof(operation.recovery, dispatch.runId);
        if (!recovery || operation.workflowRevision === undefined) {
          throw new CompactionWatcherPartialSuccessError(
            `Watcher operation ${key} has no trustworthy persisted restart state.`,
            operation,
          );
        }
        const blocked = recoveryBlockReason(recovery, resumeResponse);
        if (blocked) {
          const proposal = await proposeInsteadOfRestart(
            dispatch.runId,
            nodeId,
            `${reason}:${blocked}`,
            resumeResponse,
            recovery,
          );
          operation = transaction.compareAndSwap(operation.phase, {
            runId: dispatch.runId,
            ...(nodeId ? { nodeId } : {}),
            auditIdentity,
            phase: "restart-failed",
            workflowRevision: operation.workflowRevision,
            recovery,
            detail: proposal.detail,
          });
          return {
            ...proposal,
            redeployed: true,
            workflowRevision: operation.workflowRevision,
            operationKey: key,
          };
        }

        let restart: WatcherRestartReceipt;
        try {
          restart = await dependencies.restartWorkflow({
            runId: dispatch.runId,
            ...(nodeId ? { nodeId } : {}),
            resume: true,
            originIndependent: true,
            recovery,
            ...(resumeResponse ? { resumeResponse } : {}),
            reason: `redeployed:${reason}`,
          });
          if (!restart.resumed) {
            throw new CompactionWatcherError(
              "RESTART_REJECTED",
              restart.detail ?? `Watcher restart was rejected for ${dispatch.runId}.`,
            );
          }
        } catch (error) {
          operation = transaction.compareAndSwap(operation.phase, {
            runId: dispatch.runId,
            ...(nodeId ? { nodeId } : {}),
            auditIdentity,
            phase: "restart-failed",
            workflowRevision: operation.workflowRevision,
            recovery,
            detail: error instanceof Error ? error.message : "Restart failed.",
          });
          throw new CompactionWatcherPartialSuccessError(
            `Workflow revision ${operation.workflowRevision} was redeployed, but restart failed. Retry operation ${key} to resume without another deployment.`,
            operation,
            { cause: error },
          );
        }

        operation = transaction.compareAndSwap(operation.phase, {
          runId: dispatch.runId,
          ...(nodeId ? { nodeId } : {}),
          auditIdentity,
          phase: "completed",
          workflowRevision: operation.workflowRevision,
          recovery,
          detail: restart.detail ??
            `Watcher repaired, redeployed, and resumed ${dispatch.runId}.`,
        });
        return {
          handled: true,
          resumable: true,
          redeployed: true,
          resumed: true,
          workflowRevision: operation.workflowRevision,
          operationKey: key,
          detail: operation.detail,
        };
      });
    },
  );

  return {
    watcherModel,
    repairModel,
    async watch(request): Promise<WatchCompactionResult> {
      const fingerprintAudit = readFingerprintAudit(
        request.sandboxRoot,
        request.childRunId,
      );
      if (!fingerprintAudit.occurred) {
        return { status: "not-compacted", fingerprintAudit };
      }
      const auditIdentity = compactionAuditIdentity(request, fingerprintAudit);
      const deterministicFailure = fingerprintFailure(fingerprintAudit);
      if (deterministicFailure) {
        const behavior = await dependencies.registry.dispatch(
          COMPACTION_WATCHER_BEHAVIOR,
          {
            capability: "escalate-fix-redeploy",
            runId: request.runId,
            ...(request.nodeId ? { nodeId: request.nodeId } : {}),
            payload: {
              reason: `fingerprint-audit:${deterministicFailure}`,
              auditIdentity,
            },
          },
        ) as CompactionWatcherBehaviorResult;
        return { status: "repaired-and-restarted", fingerprintAudit, behavior };
      }
      validateSemanticRecord(request);
      const semanticVerdict = parseCompactionSemanticVerdict(
        await dependencies.semanticModel({
          model: watcherModel,
          runId: request.runId,
          childRunId: request.childRunId,
          instruction: SEMANTIC_AUDIT_INSTRUCTION,
          preCompactionRecord: request.preCompactionRecord,
          compactedSummary: request.compactedSummary,
          userPrompt: request.userPrompt,
          goal: request.goal,
          openTodos: [...request.openTodos],
        }),
      );
      if (semanticVerdict.verdict === "clean") {
        return { status: "clean", fingerprintAudit, semanticVerdict };
      }
      const behavior = await dependencies.registry.dispatch(
        COMPACTION_WATCHER_BEHAVIOR,
        {
          capability: "escalate-fix-redeploy",
          runId: request.runId,
          ...(request.nodeId ? { nodeId: request.nodeId } : {}),
          payload: {
            reason: "semantic-context-rot",
            semanticVerdict,
            auditIdentity,
          },
        },
      ) as CompactionWatcherBehaviorResult;
      return {
        status: "repaired-and-restarted",
        fingerprintAudit,
        semanticVerdict,
        behavior,
      };
    },
    async restartStoppedWorkflow(request): Promise<CompactionWatcherBehaviorResult> {
      if (!STOPPED_WORKFLOW_STATUSES.has(request.status)) {
        throw new CompactionWatcherError(
          "INVALID_BEHAVIOR_DISPATCH",
          `Workflow ${request.runId} is ${request.status}, not stopped or stalled.`,
        );
      }
      return await dependencies.registry.dispatch(
        COMPACTION_WATCHER_BEHAVIOR,
        {
          capability: "restart-workflow",
          runId: request.runId,
          ...(request.nodeId ? { nodeId: request.nodeId } : {}),
          payload: {
            reason: `watcher-observed:${request.status}`,
            ...(request.recovery ? { recovery: request.recovery } : {}),
            ...(request.resumeResponse
              ? { resumeResponse: request.resumeResponse }
              : {}),
          },
        },
      ) as CompactionWatcherBehaviorResult;
    },
  };
}
