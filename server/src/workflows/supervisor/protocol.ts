import type {
  DagFusionDelegationIdentity,
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageLimits,
  DagFusionDelegationUsageSettlement,
  OwnedDelegationV2Request,
} from "../../../pi-packages/dag-fusion-drive/index.ts";
import type {
  HostedOpenRouterFusionRequest,
  HostedOpenRouterFusionResult,
} from "../hosted-fusion.ts";
import {
  parseSupervisedWorkflowBudgetDescriptor,
  type SupervisedWorkflowBudgetDescriptorV1,
} from "../supervised-budget.ts";
import {
  isWorkflowSupervisorCredentialKey,
  type WorkflowSupervisorCredentialKey,
} from "./credential-contract.ts";

export const WORKFLOW_SUPERVISOR_PROTOCOL_VERSION = 1 as const;
export const MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES = 4 * 1024 * 1024;

const MAX_GENERIC_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 256;
const MIN_TOKEN_LENGTH = 32;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_VALUES = 100_000;

const GENERIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PROJECT_IDS = new Set(["new", "index", "archive"]);
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const SUPERVISOR_STATES = [
  "starting",
  "ready",
  "quiescing",
  "shutting-down",
] as const;

const ATTEMPT_STATES = [
  "running",
  "cancelling",
  "quarantined",
] as const;

const DELEGATION_RESPONSE_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "turn_budget_exhausted",
  "tool_budget_exhausted",
  "structured_output_failed",
  "acceptance_failed",
  "invalid_request",
  "unavailable_context",
  "duplicate_node",
] as const;

const SETTLEMENT_REASONS = [
  "terminal-response",
  "caller-cancelled",
  "caller-aborted",
  "host-timeout",
  "host-disposed",
  "protocol-error",
] as const;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const WORKFLOW_SUPERVISOR_SAFE_ERRORS = {
  FRAME_TOO_LARGE: {
    message: "The supervisor IPC frame exceeds the allowed size.",
    retryable: false,
  },
  INVALID_UTF8: {
    message: "The supervisor IPC frame is not valid UTF-8.",
    retryable: false,
  },
  INVALID_JSON: {
    message: "The supervisor IPC frame is not valid JSON.",
    retryable: false,
  },
  INVALID_MESSAGE: {
    message: "The supervisor IPC message does not match protocol v1.",
    retryable: false,
  },
  UNSUPPORTED_VERSION: {
    message: "The supervisor IPC protocol version is not supported.",
    retryable: false,
  },
  UNAUTHORIZED: {
    message: "The supervisor IPC client is not authorized.",
    retryable: false,
  },
  NOT_ATTACHED: {
    message: "The supervisor IPC client is not attached.",
    retryable: true,
  },
  STALE_EPOCH: {
    message: "The supervisor IPC attachment epoch is stale.",
    retryable: true,
  },
  DUPLICATE_MESSAGE: {
    message: "The supervisor IPC message identity was already used.",
    retryable: false,
  },
  PROJECT_QUIESCING: {
    message: "The workflow project is quiescing.",
    retryable: true,
  },
  SUPERVISOR_BUSY: {
    message: "The workflow supervisor is busy.",
    retryable: true,
  },
  OPERATION_FAILED: {
    message: "The workflow supervisor operation failed.",
    retryable: false,
  },
  SHUTTING_DOWN: {
    message: "The workflow supervisor is shutting down.",
    retryable: true,
  },
} as const;

export type WorkflowSupervisorErrorCode =
  keyof typeof WORKFLOW_SUPERVISOR_SAFE_ERRORS;
export type WorkflowSupervisorState = (typeof SUPERVISOR_STATES)[number];
export type WorkflowSupervisorAttemptState = (typeof ATTEMPT_STATES)[number];

/**
 * The supervisor is a separate local process, so only data crosses the wire.
 * Project paths are resolved by the supervisor and cancellation/reconciliation
 * remain owned by the backend that attached for the current epoch.
 */
export type SerializedHostedOpenRouterFusionRequest = Omit<
  HostedOpenRouterFusionRequest,
  "paths" | "signal" | "reconcileUsage"
>;

interface WorkflowSupervisorRequestBase {
  version: typeof WORKFLOW_SUPERVISOR_PROTOCOL_VERSION;
  messageId: string;
  token: string;
}

interface WorkflowSupervisorAttachedRequestBase
  extends WorkflowSupervisorRequestBase {
  epoch: number;
}

export interface WorkflowSupervisorPingRequest
  extends WorkflowSupervisorRequestBase {
  op: "ping";
}

export interface WorkflowSupervisorAttachRequest
  extends WorkflowSupervisorRequestBase {
  op: "attach";
  epoch: number;
}

export interface WorkflowSupervisorDelegateRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "delegate";
  projectId: string;
  request: OwnedDelegationV2Request;
  limits: DagFusionDelegationUsageLimits;
  budget: SupervisedWorkflowBudgetDescriptorV1;
}

export interface WorkflowSupervisorHostedFusionRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "hosted-fusion";
  projectId: string;
  request: SerializedHostedOpenRouterFusionRequest;
  budget: SupervisedWorkflowBudgetDescriptorV1;
}

export interface WorkflowSupervisorReloadCredentialsRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "reload-credentials";
  keys: WorkflowSupervisorCredentialKey[];
}

export type WorkflowSupervisorQuiesceReason =
  | "shutdown"
  | "project-delete"
  | "restart-recovery"
  | "caller-request";

export interface WorkflowSupervisorQuiesceProjectRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "quiesce-project";
  projectId: string;
  reason: WorkflowSupervisorQuiesceReason;
}

/**
 * Cancel one in-flight operation without dropping its transport. Destroying the
 * operation socket also cancels, but takes the supervisor's terminal settlement
 * with it, which leaves the backend guessing at usage it never observed.
 */
export interface WorkflowSupervisorCancelRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "cancel";
  targetMessageId: string;
}

export interface WorkflowSupervisorSnapshotRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "snapshot";
  projectId?: string;
}

export interface WorkflowSupervisorShutdownRequest
  extends WorkflowSupervisorAttachedRequestBase {
  op: "shutdown";
  reason: "backend-shutdown" | "supervisor-restart";
}

export type WorkflowSupervisorRequest =
  | WorkflowSupervisorPingRequest
  | WorkflowSupervisorAttachRequest
  | WorkflowSupervisorDelegateRequest
  | WorkflowSupervisorHostedFusionRequest
  | WorkflowSupervisorReloadCredentialsRequest
  | WorkflowSupervisorQuiesceProjectRequest
  | WorkflowSupervisorCancelRequest
  | WorkflowSupervisorSnapshotRequest
  | WorkflowSupervisorShutdownRequest;

export interface WorkflowSupervisorPingResult {
  pid: number;
  state: WorkflowSupervisorState;
  attachedEpoch: number | null;
}

export interface WorkflowSupervisorAttachResult {
  attached: true;
  epoch: number;
}

export interface WorkflowSupervisorDelegateResult {
  receipt: DagFusionDelegationReceipt;
  settlement: DagFusionDelegationUsageSettlement;
}

export interface WorkflowSupervisorHostedFusionResult {
  result: HostedOpenRouterFusionResult;
  settlement: DagFusionDelegationUsageSettlement;
}

export interface WorkflowSupervisorAttemptSnapshot {
  messageId: string;
  projectId: string;
  kind: "delegate" | "hosted-fusion";
  identity: DagFusionDelegationIdentity;
  state: WorkflowSupervisorAttemptState;
  startedAt: number;
}

export interface WorkflowSupervisorSnapshot {
  pid: number;
  state: WorkflowSupervisorState;
  attachedEpoch: number | null;
  quiescingProjectIds: string[];
  attempts: WorkflowSupervisorAttemptSnapshot[];
}

export interface WorkflowSupervisorCancelResult {
  targetMessageId: string;
  /** False when no attempt with that identity was still in flight. */
  cancelled: boolean;
}

export interface WorkflowSupervisorQuiesceProjectResult {
  projectId: string;
  quiescent: true;
  cancelledAttempts: number;
}

export interface WorkflowSupervisorSnapshotResult {
  snapshot: WorkflowSupervisorSnapshot;
}

export interface WorkflowSupervisorShutdownResult {
  accepted: true;
}

export interface WorkflowSupervisorReloadCredentialsResult {
  reloaded: true;
  keys: WorkflowSupervisorCredentialKey[];
}

interface WorkflowSupervisorSuccessBase {
  version: typeof WORKFLOW_SUPERVISOR_PROTOCOL_VERSION;
  messageId: string;
  ok: true;
}

export type WorkflowSupervisorSuccessResponse =
  | (WorkflowSupervisorSuccessBase & {
      op: "ping";
      result: WorkflowSupervisorPingResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "attach";
      result: WorkflowSupervisorAttachResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "delegate";
      result: WorkflowSupervisorDelegateResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "hosted-fusion";
      result: WorkflowSupervisorHostedFusionResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "reload-credentials";
      result: WorkflowSupervisorReloadCredentialsResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "quiesce-project";
      result: WorkflowSupervisorQuiesceProjectResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "cancel";
      result: WorkflowSupervisorCancelResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "snapshot";
      result: WorkflowSupervisorSnapshotResult;
    })
  | (WorkflowSupervisorSuccessBase & {
      op: "shutdown";
      result: WorkflowSupervisorShutdownResult;
    });

export interface WorkflowSupervisorSafeError {
  code: WorkflowSupervisorErrorCode;
  message: string;
  retryable: boolean;
}

export interface WorkflowSupervisorErrorResponse {
  version: typeof WORKFLOW_SUPERVISOR_PROTOCOL_VERSION;
  /** Null is used when an invalid frame has no trustworthy correlation id. */
  messageId: string | null;
  ok: false;
  error: WorkflowSupervisorSafeError;
  /** Terminal usage is safe structured accounting data, never error text. */
  settlement?: DagFusionDelegationUsageSettlement;
}

export type WorkflowSupervisorResponse =
  | WorkflowSupervisorSuccessResponse
  | WorkflowSupervisorErrorResponse;

export class WorkflowSupervisorProtocolError extends Error {
  constructor(readonly code: WorkflowSupervisorErrorCode) {
    super(WORKFLOW_SUPERVISOR_SAFE_ERRORS[code].message);
    this.name = "WorkflowSupervisorProtocolError";
  }
}

export function isWorkflowSupervisorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_GENERIC_ID_LENGTH &&
    GENERIC_ID_RE.test(value)
  );
}

export function isWorkflowSupervisorToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_TOKEN_LENGTH &&
    value.length <= MAX_TOKEN_LENGTH &&
    TOKEN_RE.test(value)
  );
}

export function isWorkflowSupervisorEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isProjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PROJECT_ID_RE.test(value) &&
    !RESERVED_PROJECT_IDS.has(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isOneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximumLength &&
    !value.includes("\0")
  );
}

function isJsonValue(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let valueCount = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    valueCount += 1;
    if (valueCount > MAX_JSON_VALUES || current.depth > MAX_JSON_DEPTH) {
      return false;
    }

    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value !== "object") return false;
    if (seen.has(current.value)) return false;
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) return false;
    for (const [key, entry] of Object.entries(current.value)) {
      if (key.length > MAX_GENERIC_ID_LENGTH || key.includes("\0")) return false;
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}

function isIdentity(value: unknown): value is DagFusionDelegationIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["requestId", "ownerRunId", "nodeId"]) &&
    isWorkflowSupervisorId(value.requestId) &&
    isWorkflowSupervisorId(value.ownerRunId) &&
    isWorkflowSupervisorId(value.nodeId)
  );
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cost",
      "turns",
      "toolCalls",
      "durationMs",
    ]) &&
    isNonNegativeInteger(value.input) &&
    isNonNegativeInteger(value.output) &&
    isNonNegativeInteger(value.cacheRead) &&
    isNonNegativeInteger(value.cacheWrite) &&
    isFiniteNonNegative(value.cost) &&
    isNonNegativeInteger(value.turns) &&
    isNonNegativeInteger(value.toolCalls) &&
    isNonNegativeInteger(value.durationMs)
  );
}

function isProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["started", "tokens", "toolCalls", "durationMs"],
      ["model"],
    ) &&
    typeof value.started === "boolean" &&
    (value.model === undefined || isBoundedString(value.model, 512)) &&
    isNonNegativeInteger(value.tokens) &&
    isNonNegativeInteger(value.toolCalls) &&
    isNonNegativeInteger(value.durationMs)
  );
}

function isSettlement(
  value: unknown,
): value is DagFusionDelegationUsageSettlement {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["identity", "reason", "progress"],
      ["responseStatus", "usage"],
    ) &&
    isIdentity(value.identity) &&
    isOneOf(value.reason, SETTLEMENT_REASONS) &&
    (value.responseStatus === undefined ||
      isOneOf(value.responseStatus, DELEGATION_RESPONSE_STATUSES)) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    isProgress(value.progress)
  );
}

function isUsageLimits(value: unknown): value is DagFusionDelegationUsageLimits {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["maxTokens", "maxCostUsd"]) &&
    isPositiveInteger(value.maxTokens) &&
    isFiniteNonNegative(value.maxCostUsd)
  );
}

function isBudgetDescriptor(
  value: unknown,
): value is SupervisedWorkflowBudgetDescriptorV1 {
  try {
    parseSupervisedWorkflowBudgetDescriptor(value);
    return true;
  } catch {
    return false;
  }
}

function isTurnBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["maxTurns"], ["graceTurns"]) &&
    isPositiveInteger(value.maxTurns) &&
    value.maxTurns <= 10_000 &&
    (value.graceTurns === undefined ||
      (isNonNegativeInteger(value.graceTurns) && value.graceTurns <= 10_000))
  );
}

function isToolBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["hard", "block"], ["soft"]) &&
    isPositiveInteger(value.hard) &&
    value.hard <= 1_000_000 &&
    (value.soft === undefined ||
      (isNonNegativeInteger(value.soft) && value.soft <= value.hard)) &&
    value.block === "*"
  );
}

function isSkillSelection(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (isBoundedString(value, 256)) return true;
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((entry) => isBoundedString(entry, 256))
  );
}

function isDelegationResultRequest(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "text") return hasExactKeys(value, ["kind"]);
  return (
    value.kind === "structured" &&
    hasExactKeys(value, ["kind", "schema"]) &&
    isRecord(value.schema) &&
    isJsonValue(value.schema)
  );
}

function isOwnedDelegationRequest(
  value: unknown,
): value is OwnedDelegationV2Request {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(
      value,
      [
        "version",
        "requestId",
        "ownerRunId",
        "nodeId",
        "agent",
        "task",
        "context",
        "cwd",
        "model",
        "thinking",
        "timeoutMs",
        "turnBudget",
        "toolBudget",
        "result",
      ],
      ["skill", "artifacts"],
    )
  ) {
    return false;
  }
  return (
    value.version === 2 &&
    isWorkflowSupervisorId(value.requestId) &&
    isWorkflowSupervisorId(value.ownerRunId) &&
    isWorkflowSupervisorId(value.nodeId) &&
    isWorkflowSupervisorId(value.agent) &&
    isBoundedString(value.task, MAX_TEXT_LENGTH) &&
    (value.context === "fresh" || value.context === "fork") &&
    isBoundedString(value.cwd, 4_096) &&
    isBoundedString(value.model, 512) &&
    isOneOf(value.thinking, THINKING_LEVELS) &&
    isPositiveInteger(value.timeoutMs) &&
    value.timeoutMs <= 86_400_000 &&
    isTurnBudget(value.turnBudget) &&
    isToolBudget(value.toolBudget) &&
    (value.skill === undefined || isSkillSelection(value.skill)) &&
    (value.artifacts === undefined || typeof value.artifacts === "boolean") &&
    isDelegationResultRequest(value.result)
  );
}

function isHostedRequest(
  value: unknown,
  projectId: string,
): value is SerializedHostedOpenRouterFusionRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "projectId",
      "identity",
      "fusion",
      "resolved",
      "task",
      "maxTokens",
      "maxCostUsd",
      "timeoutMs",
    ]) &&
    value.projectId === projectId &&
    isIdentity(value.identity) &&
    isRecord(value.fusion) &&
    value.fusion.mode === "openrouter-router" &&
    isJsonValue(value.fusion) &&
    isRecord(value.resolved) &&
    isJsonValue(value.resolved) &&
    isBoundedString(value.task, MAX_TEXT_LENGTH) &&
    isPositiveInteger(value.maxTokens) &&
    isFiniteNonNegative(value.maxCostUsd) &&
    isPositiveInteger(value.timeoutMs) &&
    value.timeoutMs <= 86_400_000
  );
}

function isRequestBase(value: Record<string, unknown>): boolean {
  return (
    value.version === WORKFLOW_SUPERVISOR_PROTOCOL_VERSION &&
    isWorkflowSupervisorId(value.messageId) &&
    isWorkflowSupervisorToken(value.token)
  );
}

function isAttachedRequestBase(value: Record<string, unknown>): boolean {
  return isRequestBase(value) && isWorkflowSupervisorEpoch(value.epoch);
}

function isWorkflowSupervisorRequest(
  value: unknown,
): value is WorkflowSupervisorRequest {
  if (!isRecord(value) || !isRequestBase(value)) return false;
  switch (value.op) {
    case "ping":
      return hasExactKeys(value, ["version", "messageId", "token", "op"]);
    case "attach":
      return (
        hasExactKeys(value, ["version", "messageId", "token", "op", "epoch"]) &&
        isWorkflowSupervisorEpoch(value.epoch)
      );
    case "delegate":
      return (
        hasExactKeys(value, [
          "version",
          "messageId",
          "token",
          "op",
          "epoch",
          "projectId",
          "request",
          "limits",
          "budget",
        ]) &&
        isAttachedRequestBase(value) &&
        isProjectId(value.projectId) &&
        isOwnedDelegationRequest(value.request) &&
        isUsageLimits(value.limits) &&
        isBudgetDescriptor(value.budget)
      );
    case "hosted-fusion":
      return (
        hasExactKeys(value, [
          "version",
          "messageId",
          "token",
          "op",
          "epoch",
          "projectId",
          "request",
          "budget",
        ]) &&
        isAttachedRequestBase(value) &&
        isProjectId(value.projectId) &&
        isHostedRequest(value.request, value.projectId) &&
        isBudgetDescriptor(value.budget)
      );
    case "reload-credentials":
      return (
        hasExactKeys(value, [
          "version",
          "messageId",
          "token",
          "op",
          "epoch",
          "keys",
        ]) &&
        isAttachedRequestBase(value) &&
        Array.isArray(value.keys) &&
        value.keys.length >= 1 &&
        value.keys.length <= 4 &&
        value.keys.every(isWorkflowSupervisorCredentialKey) &&
        new Set(value.keys).size === value.keys.length
      );
    case "cancel":
      return (
        hasExactKeys(value, [
          "version",
          "messageId",
          "token",
          "op",
          "epoch",
          "targetMessageId",
        ]) &&
        isAttachedRequestBase(value) &&
        isWorkflowSupervisorId(value.targetMessageId)
      );
    case "quiesce-project":
      return (
        hasExactKeys(value, [
          "version",
          "messageId",
          "token",
          "op",
          "epoch",
          "projectId",
          "reason",
        ]) &&
        isAttachedRequestBase(value) &&
        isProjectId(value.projectId) &&
        isOneOf(value.reason, [
          "shutdown",
          "project-delete",
          "restart-recovery",
          "caller-request",
        ] as const)
      );
    case "snapshot":
      return (
        hasExactKeys(
          value,
          ["version", "messageId", "token", "op", "epoch"],
          ["projectId"],
        ) &&
        isAttachedRequestBase(value) &&
        (value.projectId === undefined || isProjectId(value.projectId))
      );
    case "shutdown":
      return (
        hasExactKeys(value, [
          "version",
          "messageId",
          "token",
          "op",
          "epoch",
          "reason",
        ]) &&
        isAttachedRequestBase(value) &&
        (value.reason === "backend-shutdown" ||
          value.reason === "supervisor-restart")
      );
    default:
      return false;
  }
}

function isReceipt(value: unknown): value is DagFusionDelegationReceipt {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["identity", "requested", "response", "progress"],
      ["resolved", "usage"],
    ) &&
    isIdentity(value.identity) &&
    isJsonValue(value.requested) &&
    isJsonValue(value.response) &&
    (value.resolved === undefined || isJsonValue(value.resolved)) &&
    (value.usage === undefined || isJsonValue(value.usage)) &&
    isProgress(value.progress)
  );
}

function isHostedResult(value: unknown): value is HostedOpenRouterFusionResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["text", "textTruncated", "usage"]) &&
    isBoundedString(value.text, MAX_TEXT_LENGTH, true) &&
    typeof value.textTruncated === "boolean" &&
    isUsage(value.usage)
  );
}

function isAttemptSnapshot(
  value: unknown,
): value is WorkflowSupervisorAttemptSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "messageId",
      "projectId",
      "kind",
      "identity",
      "state",
      "startedAt",
    ]) &&
    isWorkflowSupervisorId(value.messageId) &&
    isProjectId(value.projectId) &&
    (value.kind === "delegate" || value.kind === "hosted-fusion") &&
    isIdentity(value.identity) &&
    isOneOf(value.state, ATTEMPT_STATES) &&
    isNonNegativeInteger(value.startedAt)
  );
}

function isSnapshot(value: unknown): value is WorkflowSupervisorSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "pid",
      "state",
      "attachedEpoch",
      "quiescingProjectIds",
      "attempts",
    ]) &&
    isPositiveInteger(value.pid) &&
    isOneOf(value.state, SUPERVISOR_STATES) &&
    (value.attachedEpoch === null || isWorkflowSupervisorEpoch(value.attachedEpoch)) &&
    Array.isArray(value.quiescingProjectIds) &&
    value.quiescingProjectIds.length <= 10_000 &&
    value.quiescingProjectIds.every(isProjectId) &&
    new Set(value.quiescingProjectIds).size === value.quiescingProjectIds.length &&
    Array.isArray(value.attempts) &&
    value.attempts.length <= 10_000 &&
    value.attempts.every(isAttemptSnapshot)
  );
}

function isSuccessResponse(
  value: unknown,
): value is WorkflowSupervisorSuccessResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "messageId", "ok", "op", "result"]) ||
    value.version !== WORKFLOW_SUPERVISOR_PROTOCOL_VERSION ||
    !isWorkflowSupervisorId(value.messageId) ||
    value.ok !== true ||
    !isRecord(value.result)
  ) {
    return false;
  }
  const result = value.result;
  switch (value.op) {
    case "ping":
      return (
        hasExactKeys(result, ["pid", "state", "attachedEpoch"]) &&
        isPositiveInteger(result.pid) &&
        isOneOf(result.state, SUPERVISOR_STATES) &&
        (result.attachedEpoch === null ||
          isWorkflowSupervisorEpoch(result.attachedEpoch))
      );
    case "attach":
      return (
        hasExactKeys(result, ["attached", "epoch"]) &&
        result.attached === true &&
        isWorkflowSupervisorEpoch(result.epoch)
      );
    case "delegate":
      return (
        hasExactKeys(result, ["receipt", "settlement"]) &&
        isReceipt(result.receipt) &&
        isSettlement(result.settlement)
      );
    case "hosted-fusion":
      return (
        hasExactKeys(result, ["result", "settlement"]) &&
        isHostedResult(result.result) &&
        isSettlement(result.settlement)
      );
    case "reload-credentials":
      return (
        hasExactKeys(result, ["reloaded", "keys"]) &&
        result.reloaded === true &&
        Array.isArray(result.keys) &&
        result.keys.length >= 1 &&
        result.keys.length <= 4 &&
        result.keys.every(isWorkflowSupervisorCredentialKey) &&
        new Set(result.keys).size === result.keys.length
      );
    case "quiesce-project":
      return (
        hasExactKeys(result, ["projectId", "quiescent", "cancelledAttempts"]) &&
        isProjectId(result.projectId) &&
        result.quiescent === true &&
        isNonNegativeInteger(result.cancelledAttempts)
      );
    case "cancel":
      return (
        hasExactKeys(result, ["targetMessageId", "cancelled"]) &&
        isWorkflowSupervisorId(result.targetMessageId) &&
        typeof result.cancelled === "boolean"
      );
    case "snapshot":
      return hasExactKeys(result, ["snapshot"]) && isSnapshot(result.snapshot);
    case "shutdown":
      return hasExactKeys(result, ["accepted"]) && result.accepted === true;
    default:
      return false;
  }
}

function isErrorResponse(
  value: unknown,
): value is WorkflowSupervisorErrorResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["version", "messageId", "ok", "error"],
      ["settlement"],
    ) ||
    value.version !== WORKFLOW_SUPERVISOR_PROTOCOL_VERSION ||
    (value.messageId !== null && !isWorkflowSupervisorId(value.messageId)) ||
    value.ok !== false ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, ["code", "message", "retryable"]) ||
    typeof value.error.code !== "string" ||
    !Object.hasOwn(WORKFLOW_SUPERVISOR_SAFE_ERRORS, value.error.code)
  ) {
    return false;
  }
  const code = value.error.code as WorkflowSupervisorErrorCode;
  const safe = WORKFLOW_SUPERVISOR_SAFE_ERRORS[code];
  return (
    value.error.message === safe.message &&
    value.error.retryable === safe.retryable &&
    (value.settlement === undefined || isSettlement(value.settlement))
  );
}

function isWorkflowSupervisorResponse(
  value: unknown,
): value is WorkflowSupervisorResponse {
  return isRecord(value) &&
    (value.ok === true ? isSuccessResponse(value) : isErrorResponse(value));
}

function decodeFrame(frame: string | Uint8Array): unknown {
  const byteLength =
    typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
  if (byteLength > MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES) {
    throw new WorkflowSupervisorProtocolError("FRAME_TOO_LARGE");
  }
  if (byteLength === 0) {
    throw new WorkflowSupervisorProtocolError("INVALID_JSON");
  }

  let text: string;
  if (typeof frame === "string") {
    text = frame;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      throw new WorkflowSupervisorProtocolError("INVALID_UTF8");
    }
  }

  if (text.endsWith("\n")) {
    text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
  }
  if (text.includes("\n") || text.includes("\r")) {
    throw new WorkflowSupervisorProtocolError("INVALID_JSON");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkflowSupervisorProtocolError("INVALID_JSON");
  }
}

function assertSupportedVersion(value: unknown): void {
  if (isRecord(value) && Object.hasOwn(value, "version") &&
      value.version !== WORKFLOW_SUPERVISOR_PROTOCOL_VERSION) {
    throw new WorkflowSupervisorProtocolError("UNSUPPORTED_VERSION");
  }
}

function encodeFrame(value: unknown): string {
  let encoded: string;
  try {
    encoded = `${JSON.stringify(value)}\n`;
  } catch {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES) {
    throw new WorkflowSupervisorProtocolError("FRAME_TOO_LARGE");
  }
  return encoded;
}

export function parseWorkflowSupervisorRequestLine(
  frame: string | Uint8Array,
): WorkflowSupervisorRequest {
  const value = decodeFrame(frame);
  assertSupportedVersion(value);
  if (!isWorkflowSupervisorRequest(value)) {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  return value;
}

export function parseWorkflowSupervisorResponseLine(
  frame: string | Uint8Array,
): WorkflowSupervisorResponse {
  const value = decodeFrame(frame);
  assertSupportedVersion(value);
  if (!isWorkflowSupervisorResponse(value)) {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  return value;
}

export function encodeWorkflowSupervisorRequestLine(
  request: WorkflowSupervisorRequest,
): string {
  if (!isWorkflowSupervisorRequest(request)) {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  return encodeFrame(request);
}

export function encodeWorkflowSupervisorResponseLine(
  response: WorkflowSupervisorResponse,
): string {
  if (!isWorkflowSupervisorResponse(response)) {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  return encodeFrame(response);
}

export function workflowSupervisorErrorResponse(
  messageId: unknown,
  code: WorkflowSupervisorErrorCode,
  settlement?: DagFusionDelegationUsageSettlement,
): WorkflowSupervisorErrorResponse {
  if (!Object.hasOwn(WORKFLOW_SUPERVISOR_SAFE_ERRORS, code)) {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  if (settlement !== undefined && !isSettlement(settlement)) {
    throw new WorkflowSupervisorProtocolError("INVALID_MESSAGE");
  }
  const safe = WORKFLOW_SUPERVISOR_SAFE_ERRORS[code];
  return {
    version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
    messageId: isWorkflowSupervisorId(messageId) ? messageId : null,
    ok: false,
    error: {
      code,
      message: safe.message,
      retryable: safe.retryable,
    },
    ...(settlement === undefined ? {} : { settlement: structuredClone(settlement) }),
  };
}
