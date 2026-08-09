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
  | "REDEPLOY_REJECTED"
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
  upstreamResumable?: boolean;
  reason: string;
}

export interface WatcherRestartReceipt {
  resumed: boolean;
  detail?: string;
}

export interface WatcherRepairRequest {
  runId: string;
  nodeId?: string;
  model: string;
  reason: string;
  semanticVerdict?: CompactionSemanticVerdict;
}

export interface WatcherRepairReceipt {
  redeployed: boolean;
  workflowRevision?: number;
  detail?: string;
}

export interface CompactionWatcherBehaviorResult extends WorkflowBehaviorResult {
  resumable: boolean;
  resumed?: boolean;
  redeployed?: boolean;
  workflowRevision?: number;
}

export interface CompactionWatcherDependencies {
  registry: WorkflowBehaviorRegistry;
  semanticModel: CompactionSemanticModel;
  restartWorkflow(request: WatcherRestartRequest): Promise<WatcherRestartReceipt>;
  repairAndRedeploy(request: WatcherRepairRequest): Promise<WatcherRepairReceipt>;
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
  /** Shape consumed from the deferred S2b vendored API integration seam. */
  resumeResponse?: {
    resumable?: unknown;
    restartRequired?: unknown;
    restartWarning?: unknown;
  };
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

  dependencies.registry.register(
    COMPACTION_WATCHER_BEHAVIOR,
    ["restart-workflow", "escalate-fix-redeploy"],
    async (dispatch): Promise<CompactionWatcherBehaviorResult> => {
      const payload = dispatchPayload(dispatch);
      const nodeId = optionalNodeId(dispatch);
      const reason = reasonFromPayload(payload);

      if (dispatch.capability === "restart-workflow") {
        const restart = await dependencies.restartWorkflow({
          runId: dispatch.runId,
          ...(nodeId ? { nodeId } : {}),
          resume: true,
          originIndependent: true,
          ...(typeof payload.upstreamResumable === "boolean"
            ? { upstreamResumable: payload.upstreamResumable }
            : {}),
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
      const repair = await dependencies.repairAndRedeploy({
        runId: dispatch.runId,
        ...(nodeId ? { nodeId } : {}),
        model: repairModel,
        reason,
        ...(semanticVerdict ? { semanticVerdict } : {}),
      });
      if (!repair.redeployed) {
        throw new CompactionWatcherError(
          "REDEPLOY_REJECTED",
          repair.detail ?? `Watcher repair did not redeploy ${dispatch.runId}.`,
        );
      }
      const restart = await dependencies.restartWorkflow({
        runId: dispatch.runId,
        ...(nodeId ? { nodeId } : {}),
        resume: true,
        originIndependent: true,
        ...(typeof payload.upstreamResumable === "boolean"
          ? { upstreamResumable: payload.upstreamResumable }
          : {}),
        reason: `redeployed:${reason}`,
      });
      if (!restart.resumed) {
        throw new CompactionWatcherError(
          "RESTART_REJECTED",
          restart.detail ?? `Watcher restart was rejected after redeploying ${dispatch.runId}.`,
        );
      }
      return {
        handled: true,
        resumable: true,
        redeployed: true,
        resumed: true,
        ...(repair.workflowRevision !== undefined
          ? { workflowRevision: repair.workflowRevision }
          : {}),
        detail: repair.detail ?? restart.detail ??
          `Watcher repaired, redeployed, and resumed ${dispatch.runId}.`,
      };
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
      const deterministicFailure = fingerprintFailure(fingerprintAudit);
      if (deterministicFailure) {
        const behavior = await dependencies.registry.dispatch(
          COMPACTION_WATCHER_BEHAVIOR,
          {
            capability: "escalate-fix-redeploy",
            runId: request.runId,
            ...(request.nodeId ? { nodeId: request.nodeId } : {}),
            payload: { reason: `fingerprint-audit:${deterministicFailure}` },
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
            ...(typeof request.resumeResponse?.resumable === "boolean"
              ? { upstreamResumable: request.resumeResponse.resumable }
              : {}),
          },
        },
      ) as CompactionWatcherBehaviorResult;
    },
  };
}
