import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type {
  ModelRequest,
  RequestedModel,
  WorkflowGraphDocument,
  WorkflowLimits,
  WorkflowNode,
} from "./schema.ts";
import { ModelRequestSchema } from "./schema.ts";
import {
  buildWorkflowEvidenceSourceCatalog,
  effectiveWorkflowEvidencePolicy,
  normalizeWorkflowEvidenceSourceIds,
  requiresWorkflowEvidencePolicyEvaluation,
  workflowEvidenceGateEvaluator,
  workflowEvidencePolicyEvaluator,
  WORKFLOW_EVIDENCE_POLICY_SLOT_ID,
} from "./evidence-policy.ts";
import { trustedLeanArtifactPaths } from "./lean4-artifacts.ts";
import { resolveNodeSpecV1 } from "./validate.ts";
import {
  effectiveHostedFusionDefinition,
  type HostedOpenRouterFusionNode,
} from "./hosted-fusion-definition.ts";

export const WORKFLOW_RUN_STORAGE_VERSION = 1 as const;
export const WORKFLOW_RUN_EVENT_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_RUN_EVENT_TYPES = [
  "run_queued",
  "run_started",
  "run_waiting",
  "run_blocked",
  "run_paused",
  "run_resumed",
  "deliberation_staffing_bound",
  "model_call_declared",
  "model_resolved",
  "node_started",
  "node_succeeded",
  "node_failed",
  "node_skipped",
  "gate_evaluated",
  "evidence_checked",
  "rescue_started",
  "rescue_finished",
  "compaction_checked",
  "store_repaired",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
] as const;

export type WorkflowRunEventType = (typeof WORKFLOW_RUN_EVENT_TYPES)[number];

const WORKFLOW_RUN_EVENT_TYPE_SET = new Set<string>(WORKFLOW_RUN_EVENT_TYPES);

export function isWorkflowRunEventType(value: unknown): value is WorkflowRunEventType {
  return typeof value === "string" && WORKFLOW_RUN_EVENT_TYPE_SET.has(value);
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "paused"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowNodeExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export interface WorkflowRunErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WorkflowArtifactReference {
  path: string;
  size: number;
  sha256?: string;
  mediaType?: string;
}

/** A gate receipt binds a verified file to the authored artifact and writer. */
export interface WorkflowGateArtifactReceipt extends WorkflowArtifactReference {
  artifactId: string;
  writerNodeId: string;
  sha256: string;
}

export interface WorkflowGateDecision {
  supported: boolean;
  sourceIds: string[];
  artifacts: WorkflowGateArtifactReceipt[];
  summary: string;
}

/** A non-gate evidence receipt that replay binds to the terminal node event. */
export interface WorkflowEvidenceDecision {
  supported: boolean;
  sourceIds: string[];
  artifacts: WorkflowArtifactReference[];
  summary?: string;
}

export interface WorkflowResolvedModel {
  provider: string;
  model: string;
  auth: {
    kind: string;
    profile?: string;
  };
  reasoning: RequestedModel["reasoning"];
  runtime: "pi" | "openrouter-fusion" | "kady-fusion" | "local" | "custom";
}

/** Durable receipt proving what was requested and what the runtime actually used. */
export interface WorkflowModelResolutionReceipt {
  request: ModelRequest;
  resolved: WorkflowResolvedModel;
  fallbackUsed: boolean;
  resolutionReason?: string;
}

export interface WorkflowModelCallSlot {
  id: string;
  request: ModelRequest;
}

export interface WorkflowModelCallSlotState extends WorkflowModelCallSlot {
  receipt?: WorkflowModelResolutionReceipt;
}

export interface WorkflowDeliberationStaffingReceipt {
  storeRef: string;
  source: string;
  revision: string;
  storeDigest: string;
  selectedPersonalityRefs: string[];
  effectivePromptSha256: string;
}

export interface WorkflowRunManifestV1 {
  storageVersion: typeof WORKFLOW_RUN_STORAGE_VERSION;
  id: string;
  projectId: string;
  workflowId: string;
  workflowRevision: number;
  graphSha256: string;
  requestId: string;
  requestSha256: string;
  /** Present when the caller required a particular definition revision. */
  expectedWorkflowRevision?: number;
  sessionId?: string;
  createdAt: number;
  requestedBy: "user" | "agent" | "api";
  input: {
    goal?: string;
    variables?: Record<string, unknown>;
  };
  effectiveLimits: WorkflowLimits;
  /** Exact normalized graph executed by this run. Later definition edits cannot alter it. */
  graph: WorkflowGraphDocument;
}

export interface WorkflowRunEventData {
  modelCallSlot?: WorkflowModelCallSlot;
  modelCallSlotId?: string;
  receipt?: WorkflowModelResolutionReceipt;
  deliberationStaffingReceipt?: WorkflowDeliberationStaffingReceipt;
  error?: WorkflowRunErrorInfo;
  artifacts?: WorkflowArtifactReference[];
  [key: string]: unknown;
}

export interface WorkflowRunEventInput {
  eventId: string;
  type: Exclude<WorkflowRunEventType, "store_repaired">;
  executionId?: string;
  nodeId?: string;
  attempt?: number;
  parentExecutionId?: string;
  branchId?: string;
  data?: WorkflowRunEventData;
}

export interface WorkflowRunEventV1 extends Omit<WorkflowRunEventInput, "type"> {
  schemaVersion: typeof WORKFLOW_RUN_EVENT_SCHEMA_VERSION;
  runId: string;
  seq: number;
  ts: number;
  type: WorkflowRunEventType;
}

export interface WorkflowRunDiagnostic {
  code: string;
  message: string;
  fatal: boolean;
  line?: number;
}

export interface WorkflowNodeExecutionState {
  executionId: string;
  nodeId: string;
  status: WorkflowNodeExecutionStatus;
  attempt: number;
  parentExecutionId?: string;
  branchId?: string;
  modelCallSlots: Record<string, WorkflowModelCallSlotState>;
  modelReceipt?: WorkflowModelResolutionReceipt;
  deliberationStaffingReceipt?: WorkflowDeliberationStaffingReceipt;
  artifacts: WorkflowArtifactReference[];
  gateDecision?: WorkflowGateDecision;
  evidenceDecision?: WorkflowEvidenceDecision;
  error?: WorkflowRunErrorInfo;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRunState {
  runId: string;
  status: WorkflowRunStatus;
  lastSeq: number;
  executions: Record<string, WorkflowNodeExecutionState>;
  startedAt?: number;
  finishedAt?: number;
  interruptedAt?: number;
  lastError?: WorkflowRunErrorInfo;
  recoverable: boolean;
  diagnostics: WorkflowRunDiagnostic[];
}

export const RUN_STATE_V1_SCHEMA_VERSION = 1 as const;

const RunStateV1IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const RunStateV1NodeStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("interrupted"),
  Type.Literal("cancelled"),
]);

const RunStateV1ErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ minLength: 1, maxLength: 2_048 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** JSON-schema contract consumed by the future S8 chat live-graph adapter. */
export const RunStateV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(RUN_STATE_V1_SCHEMA_VERSION),
    runId: RunStateV1IdentifierSchema,
    workflowId: RunStateV1IdentifierSchema,
    workflowRevision: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("waiting"),
      Type.Literal("blocked"),
      Type.Literal("paused"),
      Type.Literal("interrupted"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    nodes: Type.Array(
      Type.Object(
        {
          id: RunStateV1IdentifierSchema,
          status: RunStateV1NodeStatusSchema,
          progress: Type.Object(
            {
              completed: Type.Integer({ minimum: 0 }),
              total: Type.Integer({ minimum: 1 }),
              message: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
            },
            { additionalProperties: false },
          ),
          executionId: Type.Optional(RunStateV1IdentifierSchema),
        },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
    topology: Type.Object(
      {
        nodes: Type.Array(
          Type.Object(
            { id: RunStateV1IdentifierSchema },
            { additionalProperties: false },
          ),
          { maxItems: 256 },
        ),
        edges: Type.Array(
          Type.Object(
            {
              id: RunStateV1IdentifierSchema,
              from: RunStateV1IdentifierSchema,
              to: RunStateV1IdentifierSchema,
            },
            { additionalProperties: false },
          ),
          { maxItems: 1_024 },
        ),
      },
      { additionalProperties: false },
    ),
    backgroundAgentTrailingNode: Type.Optional(
      Type.Object(
        {
          slotId: RunStateV1IdentifierSchema,
          agentId: RunStateV1IdentifierSchema,
          nodeId: Type.Optional(RunStateV1IdentifierSchema),
          status: RunStateV1NodeStatusSchema,
        },
        { additionalProperties: false },
      ),
    ),
    errorRouting: Type.Optional(
      Type.Object(
        {
          source: Type.Literal("chat-stream"),
          surface: Type.Literal(true),
          nodeId: Type.Optional(RunStateV1IdentifierSchema),
          error: RunStateV1ErrorSchema,
        },
        { additionalProperties: false },
      ),
    ),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type RunStateV1 = Static<typeof RunStateV1Schema>;

type RunStateV1RunStatus = RunStateV1["status"];
type RunStateV1NodeStatus = RunStateV1["nodes"][number]["status"];

const ALL_RUN_STATE_V1_NODE_STATUSES = new Set<RunStateV1NodeStatus>([
  "pending",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
]);
const TERMINAL_RUN_STATE_V1_NODE_STATUSES = new Set<RunStateV1NodeStatus>([
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
]);
const RUN_STATE_V1_STATUS_COHERENCE: Record<
  RunStateV1RunStatus,
  ReadonlySet<RunStateV1NodeStatus>
> = {
  queued: new Set(["pending"]),
  running: ALL_RUN_STATE_V1_NODE_STATUSES,
  waiting: ALL_RUN_STATE_V1_NODE_STATUSES,
  blocked: ALL_RUN_STATE_V1_NODE_STATUSES,
  paused: ALL_RUN_STATE_V1_NODE_STATUSES,
  interrupted: TERMINAL_RUN_STATE_V1_NODE_STATUSES,
  succeeded: new Set(["succeeded", "skipped"]),
  failed: TERMINAL_RUN_STATE_V1_NODE_STATUSES,
  cancelled: TERMINAL_RUN_STATE_V1_NODE_STATUSES,
};

function assertRunStateV1StatusCoherence(
  runStatus: RunStateV1RunStatus,
  nodeStatus: RunStateV1NodeStatus,
  nodeLabel: string,
): void {
  if (RUN_STATE_V1_STATUS_COHERENCE[runStatus].has(nodeStatus)) return;
  throw new Error(
    `Invalid RunState v1 status coherence: run ${runStatus} cannot contain ${nodeLabel} with status ${nodeStatus}.`,
  );
}

function assertRunStateV1(value: unknown): asserts value is RunStateV1 {
  const schemaErrors = [...Value.Errors(RunStateV1Schema, value)];
  if (schemaErrors.length > 0) {
    const firstError = schemaErrors[0];
    throw new Error(
      `Invalid RunState v1 at ${firstError.instancePath || "/"}: ${firstError.message}`,
    );
  }
  const state = value as RunStateV1;
  const stateNodeIds = new Set<string>();
  for (const node of state.nodes) {
    if (stateNodeIds.has(node.id)) {
      throw new Error(`Invalid RunState v1 nodes: duplicate node id ${node.id}.`);
    }
    stateNodeIds.add(node.id);
    if (node.progress.completed > node.progress.total) {
      throw new Error(`Invalid RunState v1 progress for node ${node.id}.`);
    }
    assertRunStateV1StatusCoherence(state.status, node.status, `node ${node.id}`);
  }
  if (state.backgroundAgentTrailingNode) {
    assertRunStateV1StatusCoherence(
      state.status,
      state.backgroundAgentTrailingNode.status,
      `background-agent trailing slot ${state.backgroundAgentTrailingNode.slotId}`,
    );
  }
  if (
    state.status === "succeeded" &&
    !state.nodes.some((node) => node.status === "succeeded")
  ) {
    throw new Error(
      "Invalid RunState v1 status coherence: a succeeded run requires at least one succeeded node.",
    );
  }
  const topologyNodeIds = new Set(state.topology.nodes.map((node) => node.id));
  if (topologyNodeIds.size !== state.topology.nodes.length) {
    throw new Error("Invalid RunState v1 topology: duplicate node id.");
  }
  if ([...stateNodeIds].some((nodeId) => !topologyNodeIds.has(nodeId))) {
    throw new Error("Invalid RunState v1 nodes: state node is absent from topology.");
  }
  const topologyEdgeIds = new Set(state.topology.edges.map((edge) => edge.id));
  if (topologyEdgeIds.size !== state.topology.edges.length) {
    throw new Error("Invalid RunState v1 topology: duplicate edge id.");
  }
  if (state.topology.edges.some((edge) =>
    !topologyNodeIds.has(edge.from) || !topologyNodeIds.has(edge.to)
  )) {
    throw new Error("Invalid RunState v1 topology: edge references an unknown node.");
  }
  if (
    state.errorRouting?.nodeId !== undefined &&
    !topologyNodeIds.has(state.errorRouting.nodeId)
  ) {
    throw new Error("Invalid RunState v1 error routing: node reference is absent from topology.");
  }
  if (
    state.backgroundAgentTrailingNode?.nodeId !== undefined &&
    !topologyNodeIds.has(state.backgroundAgentTrailingNode.nodeId)
  ) {
    throw new Error(
      "Invalid RunState v1 background-agent trailing node: node reference is absent from topology.",
    );
  }
}

export function serializeRunStateV1(state: RunStateV1): string {
  assertRunStateV1(state);
  return JSON.stringify(state);
}

export function parseRunStateV1(serialized: string): RunStateV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid RunState v1 JSON.");
  }
  assertRunStateV1(value);
  return structuredClone(value);
}

const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function canonicalValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("non-JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, ancestors));
    const source = recordOf(value);
    if (!source) throw new Error("non-plain object");
    // A null-prototype accumulator keeps JSON keys such as __proto__ as data.
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) throw new Error("undefined value");
      output[key] = canonicalValue(source[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
  } catch {
    return false;
  }
}

function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isRunError(value: unknown): value is WorkflowRunErrorInfo {
  const error = recordOf(value);
  return Boolean(
    error &&
    hasOnlyKeys(error, ["code", "message", "retryable"]) &&
    typeof error.code === "string" &&
    /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(error.code) &&
    isBoundedText(error.message, 2_048, true) &&
    typeof error.retryable === "boolean"
  );
}

function errorFromData(data: WorkflowRunEventData | undefined): WorkflowRunErrorInfo | undefined {
  return isRunError(data?.error) ? structuredClone(data.error) : undefined;
}

function isPortableArtifactPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    Buffer.byteLength(value, "utf-8") > 4_096 ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isArtifactReference(value: unknown): value is WorkflowArtifactReference {
  const artifact = recordOf(value);
  return Boolean(
    artifact &&
    hasOnlyKeys(artifact, ["path", "size", "sha256", "mediaType"]) &&
    isPortableArtifactPath(artifact.path) &&
    Number.isSafeInteger(artifact.size) &&
    (artifact.size as number) >= 0 &&
    (artifact.sha256 === undefined || (
      typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256)
    )) &&
    (artifact.mediaType === undefined || isBoundedText(artifact.mediaType, 256))
  );
}

const WORKFLOW_IDENTIFIER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function isGateArtifactReceipt(value: unknown): value is WorkflowGateArtifactReceipt {
  const artifact = recordOf(value);
  if (!artifact || !hasOnlyKeys(artifact, [
    "artifactId",
    "writerNodeId",
    "path",
    "size",
    "sha256",
    "mediaType",
  ])) return false;
  const reference = {
    path: artifact.path,
    size: artifact.size,
    sha256: artifact.sha256,
    ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
  };
  return WORKFLOW_IDENTIFIER_RE.test(String(artifact.artifactId)) &&
    WORKFLOW_IDENTIFIER_RE.test(String(artifact.writerNodeId)) &&
    isArtifactReference(reference) &&
    typeof artifact.sha256 === "string";
}

function gateDecisionFromData(data: WorkflowRunEventData | undefined): WorkflowGateDecision {
  return structuredClone(data as unknown as WorkflowGateDecision);
}

function evidenceDecisionFromData(
  data: WorkflowRunEventData | undefined,
): WorkflowEvidenceDecision {
  return {
    supported: data?.supported === true,
    sourceIds: structuredClone(data?.sourceIds as string[]),
    artifacts: artifactsFromData(data),
    ...(typeof data?.summary === "string" ? { summary: data.summary } : {}),
  };
}

function artifactsFromData(data: WorkflowRunEventData | undefined): WorkflowArtifactReference[] {
  return Array.isArray(data?.artifacts)
    ? data.artifacts.map((artifact) => structuredClone(artifact as WorkflowArtifactReference))
    : [];
}

function leanVerificationStatusFromData(
  data: WorkflowRunEventData | undefined,
): "verified" | "failed" | "unavailable" | undefined {
  const output = recordOf(data?.output);
  if (output?.kind !== "lean4") return undefined;
  return output.status === "verified" || output.status === "failed" ||
      output.status === "unavailable"
    ? output.status
    : undefined;
}

function hasCompleteTrustedLeanArtifacts(
  runId: string,
  executionId: string,
  artifacts: readonly WorkflowArtifactReference[],
): boolean {
  const expected = trustedLeanArtifactPaths(runId, executionId);
  const expectedPaths = new Set([expected.proof, expected.log]);
  return artifacts.length === expectedPaths.size && artifacts.every((artifact) =>
    expectedPaths.has(artifact.path) &&
    typeof artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(artifact.sha256)
  );
}

function isResolvedModel(value: unknown): value is WorkflowResolvedModel {
  const resolved = recordOf(value);
  const auth = recordOf(resolved?.auth);
  return Boolean(
    resolved &&
    auth &&
    hasOnlyKeys(resolved, ["provider", "model", "auth", "reasoning", "runtime"]) &&
    hasOnlyKeys(auth, ["kind", "profile"]) &&
    isBoundedText(resolved.provider, 64) &&
    isBoundedText(resolved.model, 256) &&
    isBoundedText(auth.kind, 64) &&
    (auth.profile === undefined || isBoundedText(auth.profile, 128)) &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      String(resolved.reasoning),
    ) &&
    ["pi", "openrouter-fusion", "kady-fusion", "local", "custom"].includes(
      String(resolved.runtime),
    )
  );
}

function isModelReceipt(value: unknown): value is WorkflowModelResolutionReceipt {
  const receipt = recordOf(value);
  return Boolean(
    receipt &&
    hasOnlyKeys(receipt, ["request", "resolved", "fallbackUsed", "resolutionReason"]) &&
    Value.Check(ModelRequestSchema, receipt.request) &&
    isResolvedModel(receipt.resolved) &&
    typeof receipt.fallbackUsed === "boolean" &&
    (receipt.resolutionReason === undefined || isBoundedText(receipt.resolutionReason, 1_024))
  );
}

function isModelCallSlot(value: unknown): value is WorkflowModelCallSlot {
  const slot = recordOf(value);
  return Boolean(
    slot &&
    hasOnlyKeys(slot, ["id", "request"]) &&
    isWorkflowModelCallSlotId(slot.id) &&
    Value.Check(ModelRequestSchema, slot.request)
  );
}

function isDeliberationStaffingReceipt(
  value: unknown,
): value is WorkflowDeliberationStaffingReceipt {
  const receipt = recordOf(value);
  return Boolean(
    receipt &&
    hasOnlyKeys(receipt, [
      "storeRef",
      "source",
      "revision",
      "storeDigest",
      "selectedPersonalityRefs",
      "effectivePromptSha256",
    ]) &&
    isBoundedText(receipt.storeRef, 256) &&
    isBoundedText(receipt.source, 512) &&
    typeof receipt.revision === "string" && /^[a-f0-9]{40}$/.test(receipt.revision) &&
    typeof receipt.storeDigest === "string" && /^[a-f0-9]{64}$/.test(receipt.storeDigest) &&
    Array.isArray(receipt.selectedPersonalityRefs) &&
    receipt.selectedPersonalityRefs.length >= 1 &&
    receipt.selectedPersonalityRefs.length <= 32 &&
    receipt.selectedPersonalityRefs.every((ref) => isBoundedText(ref, 256)) &&
    new Set(receipt.selectedPersonalityRefs).size === receipt.selectedPersonalityRefs.length &&
    typeof receipt.effectivePromptSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.effectivePromptSha256)
  );
}

function fixedModelMatches(
  requested: Extract<RequestedModel, { source: "fixed" }>,
  resolved: WorkflowResolvedModel,
): boolean {
  return requested.provider === resolved.provider &&
    requested.model === resolved.model &&
    requested.auth.kind === resolved.auth.kind &&
    requested.auth.profile === resolved.auth.profile &&
    requested.reasoning === resolved.reasoning;
}

function requestedModelMatches(
  requested: RequestedModel,
  resolved: WorkflowResolvedModel,
): boolean {
  return requested.source === "fixed"
    ? fixedModelMatches(requested, resolved)
    : requested.reasoning === resolved.reasoning;
}

function modelRequestsForNode(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
): ModelRequest[] {
  const requests: ModelRequest[] = [];
  const add = (
    legacyModel: ModelRequest | undefined,
    applySettingsModel: boolean,
  ): void => {
    const request = resolvedNodeSlotModel(
      graph,
      node,
      legacyModel,
      applySettingsModel,
    );
    if (request) requests.push(request);
  };
  switch (node.kind) {
    case "agent":
    case "research-until-goal":
      add(node.model ?? graph.defaultModel, true);
      break;
    case "council":
      node.members.forEach((member) => add(member.model, false));
      add(node.chair, false);
      break;
    case "fusion":
      if (node.fusion.mode === "openrouter-router") {
        const effective = effectiveHostedFusionDefinition(
          node as HostedOpenRouterFusionNode,
        ).fusion;
        effective.members.forEach((member) => requests.push(member.model));
        requests.push(effective.router, effective.judge);
      } else {
        node.fusion.members.forEach((member) => add(member.model, false));
        add(node.fusion.synthesizer, false);
      }
      break;
    case "best-of-n":
      if (node.candidateModels) {
        node.candidateModels.forEach((candidate) => add(candidate, false));
      } else {
        add(node.model ?? graph.defaultModel, true);
      }
      add(node.evaluator ?? graph.defaultModel, false);
      break;
    case "evidence-gate":
      add(workflowEvidenceGateEvaluator(graph, node), false);
      break;
    case "lean4":
      add(node.solverModel ?? graph.defaultModel, true);
      break;
  }
  if (requiresWorkflowEvidencePolicyEvaluation(graph, node)) {
    add(workflowEvidencePolicyEvaluator(graph, node), false);
  }
  return requests;
}

const MODEL_CALL_SLOT_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export function isWorkflowModelCallSlotId(value: unknown): value is string {
  return typeof value === "string" && MODEL_CALL_SLOT_ID_RE.test(value);
}

function modelCallSlot(id: string, request: ModelRequest | undefined): WorkflowModelCallSlot[] {
  return request ? [{ id, request: structuredClone(request) }] : [];
}

function resolvedNodeSlotModel(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
  legacyModel: ModelRequest | undefined,
  applySettingsModel: boolean,
): ModelRequest | undefined {
  if (!legacyModel && (!applySettingsModel || !node.settings?.model)) return undefined;
  return resolveNodeSpecV1(graph, node, legacyModel, applySettingsModel).model;
}

function withEvidencePolicySlot(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
  slots: WorkflowModelCallSlot[],
): WorkflowModelCallSlot[] {
  if (!requiresWorkflowEvidencePolicyEvaluation(graph, node)) return slots;
  const evaluator = resolvedNodeSlotModel(
    graph,
    node,
    workflowEvidencePolicyEvaluator(graph, node),
    false,
  );
  return evaluator
    ? [
        ...slots,
        {
          id: WORKFLOW_EVIDENCE_POLICY_SLOT_ID,
          request: structuredClone(evaluator),
        },
      ]
    : slots;
}

/**
 * Slots whose resolution is required before this node may succeed. Research
 * starts with one iteration and may declare further sequential iterations at
 * runtime, up to its effective iteration limit.
 */
export function workflowModelCallSlotsForNode(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
): WorkflowModelCallSlot[] {
  switch (node.kind) {
    case "agent":
      return withEvidencePolicySlot(
        graph,
        node,
        modelCallSlot(
          "agent",
          resolvedNodeSlotModel(graph, node, node.model ?? graph.defaultModel, true),
        ),
      );
    case "research-until-goal":
      return withEvidencePolicySlot(
        graph,
        node,
        modelCallSlot(
          "research-iteration-1",
          resolvedNodeSlotModel(graph, node, node.model ?? graph.defaultModel, true),
        ),
      );
    case "council": {
      const slots: WorkflowModelCallSlot[] = [];
      for (let round = 1; round <= node.rounds; round += 1) {
        for (const member of node.members) {
          slots.push({
            id: `council-round-${round}-member-${member.id}`,
            request: resolvedNodeSlotModel(graph, node, member.model, false)!,
          });
        }
        slots.push({
          id: `council-round-${round}-chair`,
          request: resolvedNodeSlotModel(graph, node, node.chair, false)!,
        });
      }
      return withEvidencePolicySlot(graph, node, slots);
    }
    case "fusion": {
      if (node.fusion.mode === "openrouter-router") {
        const effective = effectiveHostedFusionDefinition(
          node as HostedOpenRouterFusionNode,
        );
        return withEvidencePolicySlot(
          graph,
          node,
          effective.slots.map((slot) => structuredClone(slot)),
        );
      }
      const slots: WorkflowModelCallSlot[] = [];
      for (let round = 1; round <= node.fusion.rounds; round += 1) {
        for (const member of node.fusion.members) {
          slots.push({
            id: `fusion-round-${round}-member-${member.id}`,
            request: resolvedNodeSlotModel(graph, node, member.model, false)!,
          });
        }
      }
      slots.push({
        id: "fusion-synthesizer",
        request: resolvedNodeSlotModel(graph, node, node.fusion.synthesizer, false)!,
      });
      return withEvidencePolicySlot(graph, node, slots);
    }
    case "best-of-n": {
      const candidateCount = node.candidateCount ?? node.candidateModels?.length ?? 2;
      const repeatedRequest = resolvedNodeSlotModel(
        graph,
        node,
        node.model ?? graph.defaultModel,
        true,
      );
      const slots: WorkflowModelCallSlot[] = [];
      for (let index = 0; index < candidateCount; index += 1) {
        const request = node.candidateModels?.[index]
          ? resolvedNodeSlotModel(graph, node, node.candidateModels[index], false)
          : repeatedRequest;
        if (request) {
          slots.push({
            id: `candidate-${index + 1}`,
            request: structuredClone(request),
          });
        }
      }
      const evaluator = resolvedNodeSlotModel(
        graph,
        node,
        node.evaluator ?? graph.defaultModel,
        false,
      );
      if (evaluator) {
        slots.push({ id: "candidate-evaluator", request: structuredClone(evaluator) });
      }
      return withEvidencePolicySlot(graph, node, slots);
    }
    case "evidence-gate": {
      const usesModel = node.evaluator !== undefined ||
        node.checks.some((check) => check !== "artifact-exists");
      return usesModel
        ? modelCallSlot(
            "evidence-evaluator",
            resolvedNodeSlotModel(
              graph,
              node,
              workflowEvidenceGateEvaluator(graph, node),
              false,
            ),
          )
        : [];
    }
    case "lean4":
      return withEvidencePolicySlot(
        graph,
        node,
        node.mode === "solve"
          ? modelCallSlot(
              "lean-solver",
              resolvedNodeSlotModel(
                graph,
                node,
                node.solverModel ?? graph.defaultModel,
                true,
              ),
            )
          : [],
      );
  }
}

/** Resolve an allowed slot, including a research iteration declared at runtime. */
export function workflowModelCallSlotForNode(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
  slotId: string,
): WorkflowModelCallSlot | undefined {
  if (!isWorkflowModelCallSlotId(slotId)) return undefined;
  if (node.kind === "research-until-goal") {
    const match = /^research-iteration-([1-9][0-9]*)$/.exec(slotId);
    if (match) {
      const iteration = Number(match[1]);
      const maximumIterations = node.limits?.maxIterations ?? graph.limits.maxIterations;
      const request = resolvedNodeSlotModel(
        graph,
        node,
        node.model ?? graph.defaultModel,
        true,
      );
      return request && iteration >= 1 && iteration <= maximumIterations
        ? { id: slotId, request: structuredClone(request) }
        : undefined;
    }
  }
  return workflowModelCallSlotsForNode(graph, node).find((slot) => slot.id === slotId);
}

function receiptMatchesNode(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
  receipt: WorkflowModelResolutionReceipt,
): boolean {
  if (!modelRequestsForNode(graph, node).some((request) => jsonEqual(request, receipt.request))) {
    return false;
  }
  const candidates = receipt.request.resolution.mode === "explicit-fallback"
    ? [receipt.request.requested, ...receipt.request.resolution.alternatives]
    : [receipt.request.requested];
  const matchingIndexes = candidates.flatMap((candidate, index) =>
    requestedModelMatches(candidate, receipt.resolved) ? [index] : [],
  );
  if (matchingIndexes.length !== 1) return false;
  const selectedIndex = matchingIndexes[0];
  const selected = candidates[selectedIndex];
  if (receipt.fallbackUsed !== (selectedIndex > 0)) return false;
  const expectedReason = selectedIndex > 0 && receipt.request.resolution.mode === "explicit-fallback"
    ? receipt.request.resolution.reason
    : undefined;
  if (receipt.resolutionReason !== expectedReason) return false;

  if (selected.source === "fixed") {
    const expectedRuntime = selected.auth.kind === "local"
      ? "local"
      : selected.auth.kind === "custom"
        ? "custom"
        : "pi";
    const compoundRuntimeAllowed = node.kind === "fusion" && (
      (node.fusion.mode === "openrouter-router" && receipt.resolved.runtime === "openrouter-fusion") ||
      (node.fusion.mode === "kady-panel" && receipt.resolved.runtime === "kady-fusion")
    );
    if (receipt.resolved.runtime !== expectedRuntime && !compoundRuntimeAllowed) return false;
  }
  return true;
}

const RUN_EVENT_TYPES = new Set<WorkflowRunEventType>([
  "run_queued",
  "run_started",
  "run_waiting",
  "run_blocked",
  "run_paused",
  "run_resumed",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "store_repaired",
]);

const NODE_EVENT_TYPES = new Set<WorkflowRunEventType>([
  "deliberation_staffing_bound",
  "model_call_declared",
  "model_resolved",
  "node_started",
  "node_succeeded",
  "node_failed",
  "node_skipped",
  "gate_evaluated",
  "evidence_checked",
  "rescue_started",
  "rescue_finished",
]);

function hasNodeIdentity(event: WorkflowRunEventV1): boolean {
  return Boolean(
    event.executionId &&
    event.nodeId &&
    Number.isSafeInteger(event.attempt) &&
    (event.attempt as number) >= 1 &&
    event.branchId
  );
}

function staticEventContractError(event: WorkflowRunEventV1): string | undefined {
  const envelope = event as unknown as Record<string, unknown>;
  if (!hasOnlyKeys(envelope, [
    "schemaVersion",
    "runId",
    "eventId",
    "seq",
    "ts",
    "type",
    "executionId",
    "nodeId",
    "attempt",
    "parentExecutionId",
    "branchId",
    "data",
  ])) {
    return "Event envelope contains unsupported fields.";
  }
  if (RUN_EVENT_TYPES.has(event.type) && (
    event.executionId !== undefined || event.nodeId !== undefined || event.attempt !== undefined ||
    event.parentExecutionId !== undefined || event.branchId !== undefined
  )) {
    return `${event.type} cannot carry node execution identity.`;
  }
  if (NODE_EVENT_TYPES.has(event.type) && !hasNodeIdentity(event)) {
    return `${event.type} requires executionId, nodeId, attempt, and branchId.`;
  }
  if (event.parentExecutionId === event.executionId && event.executionId !== undefined) {
    return "An execution cannot be its own parent.";
  }
  if (event.type === "compaction_checked") {
    const identityValues = [event.executionId, event.nodeId, event.attempt, event.branchId];
    const presentCount = identityValues.filter((value) => value !== undefined).length;
    if (presentCount !== 0 && presentCount !== identityValues.length) {
      return "compaction_checked must carry a complete node identity or no node identity.";
    }
  }

  const data = event.data === undefined ? undefined : recordOf(event.data);
  if (event.data !== undefined && !data) return `${event.type} data must be a plain object.`;
  const noData = () => event.data === undefined;
  switch (event.type) {
    case "run_queued":
      return data && hasOnlyKeys(data, ["workflowRevision"]) &&
          Number.isSafeInteger(data.workflowRevision) && (data.workflowRevision as number) >= 1
        ? undefined
        : "run_queued requires workflowRevision.";
    case "run_started":
    case "node_started":
    case "run_succeeded":
      return noData() ? undefined : `${event.type} does not accept data.`;
    case "run_waiting":
    case "run_paused":
      return data && hasOnlyKeys(data, ["reason"]) && isBoundedText(data.reason, 2_048)
        ? undefined
        : `${event.type} requires a bounded reason.`;
    case "run_blocked":
    case "run_failed":
    case "run_cancelled":
      return data && hasOnlyKeys(data, ["error"]) && isRunError(data.error)
        ? undefined
        : `${event.type} requires one valid error.`;
    case "run_resumed":
      return data && hasOnlyKeys(data, ["resumeNumber"]) &&
          Number.isSafeInteger(data.resumeNumber) && (data.resumeNumber as number) >= 1
        ? undefined
        : "run_resumed requires a positive resumeNumber.";
    case "run_interrupted":
      return data && hasOnlyKeys(data, ["error", "previousStatus"]) &&
          isRunError(data.error) &&
          ["running", "waiting", "blocked", "paused"].includes(String(data.previousStatus))
        ? undefined
        : "run_interrupted requires an error and previousStatus.";
    case "model_call_declared":
      return data && hasOnlyKeys(data, ["modelCallSlot"]) &&
          isModelCallSlot(data.modelCallSlot)
        ? undefined
        : "model_call_declared requires one valid model-call slot.";
    case "deliberation_staffing_bound":
      return data && hasOnlyKeys(data, ["deliberationStaffingReceipt"]) &&
          isDeliberationStaffingReceipt(data.deliberationStaffingReceipt)
        ? undefined
        : "deliberation_staffing_bound requires one valid immutable staffing receipt.";
    case "model_resolved":
      return data && hasOnlyKeys(data, ["modelCallSlotId", "receipt"]) &&
          isWorkflowModelCallSlotId(data.modelCallSlotId) &&
          isModelReceipt(data.receipt)
        ? undefined
        : "model_resolved requires a declared slot and one valid model receipt.";
    case "node_succeeded":
      if (!data || !hasOnlyKeys(data, ["routeCondition", "output", "artifacts"])) {
        return "node_succeeded data has unsupported fields.";
      }
      if (!["always", "success", "evidence-supported", "evidence-unsupported"].includes(
        String(data.routeCondition),
      )) {
        return "node_succeeded requires a success routeCondition.";
      }
      if (data.output !== undefined) {
        try {
          canonicalValue(data.output);
        } catch {
          return "node_succeeded output must contain only JSON values.";
        }
      }
      return data.artifacts === undefined || (
        Array.isArray(data.artifacts) &&
        data.artifacts.length <= 16 &&
        data.artifacts.every(isArtifactReference)
      )
        ? undefined
        : "node_succeeded contains unsafe artifact references.";
    case "node_failed":
      return data && hasOnlyKeys(data, ["error", "routeCondition"]) &&
          isRunError(data.error) && data.routeCondition === "failure"
        ? undefined
        : "node_failed requires an error and failure routeCondition.";
    case "node_skipped":
      return data && hasOnlyKeys(data, ["reason"]) && isBoundedText(data.reason, 2_048)
        ? undefined
        : "node_skipped requires a bounded reason.";
    case "gate_evaluated":
      return data && hasOnlyKeys(data, ["supported", "sourceIds", "artifacts", "summary"]) &&
          typeof data.supported === "boolean" &&
          Array.isArray(data.sourceIds) && data.sourceIds.length <= 32 &&
          data.sourceIds.every((sourceId) =>
            typeof sourceId === "string" && /^source-[0-9]{3}$/.test(sourceId)
          ) &&
          new Set(data.sourceIds).size === data.sourceIds.length &&
          Array.isArray(data.artifacts) && data.artifacts.length <= 64 &&
          data.artifacts.every(isGateArtifactReceipt) &&
          new Set(data.artifacts.map((artifact) =>
            (artifact as WorkflowGateArtifactReceipt).artifactId
          )).size === data.artifacts.length &&
          isBoundedText(data.summary, 2_048)
        ? undefined
        : "gate_evaluated requires one bounded decision with catalog ids and verified artifacts.";
    case "evidence_checked":
      return data && hasOnlyKeys(data, ["supported", "summary", "sourceIds", "artifacts"]) &&
          typeof data.supported === "boolean" &&
          Array.isArray(data.sourceIds) && data.sourceIds.length <= 32 &&
          data.sourceIds.every((sourceId) =>
            typeof sourceId === "string" && /^source-[0-9]{3}$/.test(sourceId)
          ) &&
          new Set(data.sourceIds).size === data.sourceIds.length &&
          (data.artifacts === undefined || (
            Array.isArray(data.artifacts) && data.artifacts.length <= 16 &&
            data.artifacts.every(isArtifactReference)
          )) &&
          (data.summary === undefined || isBoundedText(data.summary, 2_048, true))
        ? undefined
        : "evidence_checked requires a bounded decision and source catalog ids.";
    case "rescue_started":
      return data && hasOnlyKeys(data, ["trigger", "previousError"]) &&
          ["failure", "stalled", "unsupported-output", "pre-compaction", "post-compaction"].includes(
            String(data.trigger),
          ) && isRunError(data.previousError)
        ? undefined
        : "rescue_started requires a trigger and previous error.";
    case "rescue_finished":
      return data && hasOnlyKeys(data, ["succeeded", "error"]) &&
          typeof data.succeeded === "boolean" &&
          (data.succeeded ? data.error === undefined : isRunError(data.error))
        ? undefined
        : "rescue_finished must match a success or failure result.";
    case "compaction_checked":
      return data && hasOnlyKeys(data, ["phase", "passed", "error"]) &&
          ["pre", "post"].includes(String(data.phase)) &&
          typeof data.passed === "boolean" &&
          (data.passed ? data.error === undefined : isRunError(data.error))
        ? undefined
        : "compaction_checked requires a phase and check result.";
    case "store_repaired":
      return data && hasOnlyKeys(data, ["message", "truncatedBytes"]) &&
          isBoundedText(data.message, 2_048) &&
          Number.isSafeInteger(data.truncatedBytes) && (data.truncatedBytes as number) >= 0
        ? undefined
        : "store_repaired requires repair details.";
  }
}

function executionIdentityConflicts(
  existing: WorkflowNodeExecutionState,
  event: WorkflowRunEventV1,
): string[] {
  return [
    existing.nodeId !== event.nodeId ? "nodeId" : undefined,
    existing.attempt !== event.attempt ? "attempt" : undefined,
    existing.parentExecutionId !== event.parentExecutionId ? "parentExecutionId" : undefined,
    existing.branchId !== event.branchId ? "branchId" : undefined,
  ].filter((field): field is string => field !== undefined);
}

function createExecution(event: WorkflowRunEventV1): WorkflowNodeExecutionState {
  return {
    executionId: event.executionId!,
    nodeId: event.nodeId!,
    status: "pending",
    attempt: event.attempt!,
    ...(event.parentExecutionId ? { parentExecutionId: event.parentExecutionId } : {}),
    branchId: event.branchId!,
    modelCallSlots: {},
    artifacts: [],
  };
}

function interruptRunningExecutions(
  executions: Record<string, WorkflowNodeExecutionState>,
  timestamp: number,
): void {
  for (const execution of Object.values(executions)) {
    if (execution.status !== "running") continue;
    execution.status = "interrupted";
    execution.finishedAt ??= timestamp;
  }
}

/**
 * Fold the immutable manifest and authoritative event stream into current state.
 * The reducer never invents a terminal run state from a node failure: the runner
 * must append an explicit run_failed/run_blocked/rescue decision.
 */
export function reduceWorkflowRun(
  manifest: WorkflowRunManifestV1,
  events: WorkflowRunEventV1[],
  initialDiagnostics: WorkflowRunDiagnostic[] = [],
): WorkflowRunState {
  const state: WorkflowRunState = {
    runId: manifest.id,
    status: "queued",
    lastSeq: 0,
    executions: {},
    recoverable: true,
    diagnostics: [...initialDiagnostics],
  };
  const seenEventIds = new Set<string>();
  const graphNodeById = new Map(manifest.graph.nodes.map((node) => [node.id, node]));
  const rescueStartedByExecution = new Map<string, WorkflowRunEventV1>();
  const rescueFinishedExecutions = new Set<string>();
  const evaluatedGateExecutions = new Set<string>();
  const checkedEvidenceExecutions = new Set<string>();
  const deliberationReceiptByNode = new Map<string, WorkflowDeliberationStaffingReceipt>();
  const executionStartedSeq = new Map<string, number>();
  const terminalExecutionEvidence = new Map<string, {
    finishedSeq: number;
    routeCondition: "always" | "success" | "failure" | "evidence-supported" | "evidence-unsupported";
    output?: unknown;
  }>();
  let sawQueuedEvent = false;

  const fatal = (code: string, message: string): void => {
    state.diagnostics.push({ code, message, fatal: true });
  };

  const requireRunStatus = (
    event: WorkflowRunEventV1,
    allowed: WorkflowRunStatus[],
  ): boolean => {
    if (allowed.includes(state.status)) return true;
    fatal(
      "invalid-run-transition",
      `${event.type} cannot follow run status ${state.status}.`,
    );
    return false;
  };

  const executionForEvent = (
    event: WorkflowRunEventV1,
  ): WorkflowNodeExecutionState | undefined => {
    const execution = state.executions[event.executionId!];
    if (!execution) {
      fatal(
        "unknown-execution-id",
        `${event.type} refers to execution ${event.executionId}, which has not started.`,
      );
      return undefined;
    }
    const conflicts = executionIdentityConflicts(execution, event);
    if (conflicts.length > 0) {
      fatal(
        "execution-identity-conflict",
        `Execution ${event.executionId} changed ${conflicts.join(", ")}.`,
      );
      return undefined;
    }
    return execution;
  };

  const validateNewExecutionIdentity = (event: WorkflowRunEventV1): boolean => {
    const duplicateAttempt = Object.values(state.executions).find(
      (execution) => execution.nodeId === event.nodeId && execution.attempt === event.attempt,
    );
    if (duplicateAttempt) {
      fatal(
        "duplicate-node-attempt",
        `Node ${event.nodeId} attempt ${event.attempt} already uses execution ${duplicateAttempt.executionId}.`,
      );
      return false;
    }
    if (event.parentExecutionId) {
      const parent = state.executions[event.parentExecutionId];
      if (!parent || !["succeeded", "failed", "skipped"].includes(parent.status)) {
        fatal(
          "invalid-parent-execution",
          `Execution ${event.executionId} names a parent that has not completed.`,
        );
        return false;
      }
    }
    return true;
  };

  const observedInboundForExecution = (
    targetExecution: WorkflowNodeExecutionState,
  ): Array<{
    fromNodeId: string;
    executionId: string;
    artifacts: WorkflowArtifactReference[];
    output?: unknown;
  }> => {
    const executionStartSeq = executionStartedSeq.get(targetExecution.executionId) ??
      Number.MAX_SAFE_INTEGER;
    const latestCompletedByNode = new Map<string, WorkflowNodeExecutionState>();
    for (const candidate of Object.values(state.executions)) {
      if (
        candidate.executionId === targetExecution.executionId ||
        (candidate.status !== "succeeded" && candidate.status !== "failed") ||
        !terminalExecutionEvidence.has(candidate.executionId)
      ) continue;
      const terminalEvidence = terminalExecutionEvidence.get(candidate.executionId)!;
      if (terminalEvidence.finishedSeq >= executionStartSeq) continue;
      const current = latestCompletedByNode.get(candidate.nodeId);
      if (!current || candidate.attempt > current.attempt) {
        latestCompletedByNode.set(candidate.nodeId, candidate);
      }
    }

    const activations: Array<{
      edgeIndex: number;
      finishedSeq: number;
      fromNodeId: string;
      executionId: string;
      artifacts: WorkflowArtifactReference[];
      output?: unknown;
    }> = [];
    for (const candidate of latestCompletedByNode.values()) {
      const terminalEvidence = terminalExecutionEvidence.get(candidate.executionId)!;
      const outgoing = manifest.graph.edges
        .map((edge, edgeIndex) => ({ edge, edgeIndex }))
        .filter(({ edge }) => edge.from === candidate.nodeId);
      const always = outgoing.filter(({ edge }) => (edge.condition ?? "always") === "always");
      const selected = always.length > 0
        ? always
        : outgoing.filter(({ edge }) => edge.condition === terminalEvidence.routeCondition);
      for (const { edge, edgeIndex } of selected) {
        if (edge.to !== targetExecution.nodeId) continue;
        activations.push({
          edgeIndex,
          finishedSeq: terminalEvidence.finishedSeq,
          fromNodeId: candidate.nodeId,
          executionId: candidate.executionId,
          artifacts: candidate.artifacts.map((artifact) => structuredClone(artifact)),
          ...(terminalEvidence.output !== undefined
            ? { output: structuredClone(terminalEvidence.output) }
            : {}),
        });
      }
    }
    activations.sort((left, right) =>
      left.finishedSeq - right.finishedSeq || left.edgeIndex - right.edgeIndex
    );
    return activations.map(({ fromNodeId, executionId, artifacts, output }) => ({
      fromNodeId,
      executionId,
      artifacts,
      ...(output !== undefined ? { output } : {}),
    }));
  };

  for (const event of events) {
    if (event.runId !== manifest.id) {
      state.diagnostics.push({
        code: "run-id-mismatch",
        message: `Event ${event.eventId} belongs to ${event.runId}, not ${manifest.id}.`,
        fatal: true,
      });
      continue;
    }
    if (event.seq !== state.lastSeq + 1) {
      state.diagnostics.push({
        code: "event-sequence",
        message: `Expected event sequence ${state.lastSeq + 1}, received ${event.seq}.`,
        fatal: true,
      });
      continue;
    }
    if (seenEventIds.has(event.eventId)) {
      state.diagnostics.push({
        code: "duplicate-event-id",
        message: `Event id ${event.eventId} occurs more than once.`,
        fatal: true,
      });
      continue;
    }
    seenEventIds.add(event.eventId);
    state.lastSeq = event.seq;

    const contractError = staticEventContractError(event);
    if (contractError) {
      fatal("invalid-event-contract", `Event ${event.eventId}: ${contractError}`);
      continue;
    }
    if (event.nodeId && !graphNodeById.has(event.nodeId)) {
      fatal(
        "unknown-node-id",
        `Event ${event.eventId} refers to node ${event.nodeId}, which is absent from the run graph.`,
      );
      continue;
    }
    if (isTerminalWorkflowRunStatus(state.status) && event.type !== "store_repaired") {
      fatal(
        "event-after-terminal",
        `Event ${event.eventId} occurs after the run reached ${state.status}.`,
      );
      continue;
    }
    if (!sawQueuedEvent && event.type !== "run_queued") {
      fatal("missing-initial-event", `${event.type} occurred before run_queued.`);
      continue;
    }

    switch (event.type) {
      case "run_queued": {
        if (
          sawQueuedEvent ||
          event.seq !== 1 ||
          event.data?.workflowRevision !== manifest.workflowRevision
        ) {
          fatal(
            "invalid-run-transition",
            "run_queued must be the first event and match the manifest revision.",
          );
          break;
        }
        sawQueuedEvent = true;
        break;
      }
      case "run_started":
        if (!requireRunStatus(event, ["queued"])) break;
        state.status = "running";
        state.startedAt ??= event.ts;
        break;
      case "run_resumed":
        if (!requireRunStatus(event, ["waiting", "blocked", "paused", "interrupted"])) break;
        state.status = "running";
        state.startedAt ??= event.ts;
        break;
      case "run_waiting":
        if (!requireRunStatus(event, ["running"])) break;
        state.status = "waiting";
        break;
      case "run_blocked":
        if (!requireRunStatus(event, ["running", "waiting"])) break;
        state.status = "blocked";
        state.lastError = errorFromData(event.data);
        break;
      case "run_paused":
        if (!requireRunStatus(event, ["running", "waiting", "blocked"])) break;
        state.status = "paused";
        break;
      case "deliberation_staffing_bound": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        const receipt = event.data?.deliberationStaffingReceipt;
        if (!execution || execution.status !== "running") {
          if (execution) {
            fatal(
              "invalid-deliberation-transition",
              `deliberation_staffing_bound requires running execution ${event.executionId}.`,
            );
          }
          break;
        }
        if (!isDeliberationStaffingReceipt(receipt)) {
          fatal("invalid-deliberation-receipt", "Deliberation staffing receipt is malformed.");
          break;
        }
        if (deliberationReceiptByNode.has(event.nodeId!)) {
          fatal(
            "duplicate-deliberation-receipt",
            `Node ${event.nodeId} bound deliberation staffing more than once.`,
          );
          break;
        }
        execution.deliberationStaffingReceipt = structuredClone(receipt);
        deliberationReceiptByNode.set(event.nodeId!, structuredClone(receipt));
        break;
      }
      case "model_call_declared": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        const node = graphNodeById.get(event.nodeId!);
        const slot = event.data?.modelCallSlot;
        if (!execution || execution.status !== "running") {
          if (execution) {
            fatal(
              "invalid-node-transition",
              `model_call_declared requires running execution ${event.executionId}.`,
            );
          }
          break;
        }
        if (!node || !isModelCallSlot(slot)) {
          fatal("invalid-model-call-slot", `Execution ${event.executionId} declared an invalid model-call slot.`);
          break;
        }
        const configuredSlot = workflowModelCallSlotForNode(manifest.graph, node, slot.id);
        if (!configuredSlot || !jsonEqual(configuredSlot.request, slot.request)) {
          fatal(
            "model-call-slot-mismatch",
            `Execution ${event.executionId} declared model-call slot ${slot.id} absent from node ${event.nodeId}.`,
          );
          break;
        }
        if (execution.modelCallSlots[slot.id]) {
          fatal(
            "duplicate-model-call-slot",
            `Execution ${event.executionId} declared model-call slot ${slot.id} more than once.`,
          );
          break;
        }
        if (node.kind === "research-until-goal") {
          const iteration = Number(slot.id.slice("research-iteration-".length));
          if (iteration > 1 && !execution.modelCallSlots[`research-iteration-${iteration - 1}`]) {
            fatal(
              "model-call-slot-gap",
              `Research execution ${event.executionId} declared iteration ${iteration} before iteration ${iteration - 1}.`,
            );
            break;
          }
        }
        execution.modelCallSlots[slot.id] = structuredClone(slot);
        break;
      }
      case "model_resolved": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        const node = graphNodeById.get(event.nodeId!);
        const slotId = event.data?.modelCallSlotId;
        const receipt = event.data?.receipt;
        if (!execution || execution.status !== "running") {
          if (execution) {
            fatal(
              "invalid-node-transition",
              `model_resolved requires running execution ${event.executionId}.`,
            );
          }
          break;
        }
        const slot = typeof slotId === "string" ? execution.modelCallSlots[slotId] : undefined;
        if (
          !node ||
          !slot ||
          slot.receipt ||
          !isModelReceipt(receipt) ||
          !jsonEqual(slot.request, receipt.request) ||
          !receiptMatchesNode(manifest.graph, node, receipt)
        ) {
          fatal(
            "model-receipt-mismatch",
            `Execution ${event.executionId} reported an undeclared, duplicate, or mismatched resolution for slot ${String(slotId)}.`,
          );
          break;
        }
        slot.receipt = structuredClone(receipt);
        execution.modelReceipt = structuredClone(receipt);
        break;
      }
      case "node_started": {
        if (!requireRunStatus(event, ["running"])) break;
        const existing = state.executions[event.executionId!];
        if (existing) {
          const conflicts = executionIdentityConflicts(existing, event);
          if (conflicts.length > 0) {
            fatal(
              "execution-identity-conflict",
              `Execution ${event.executionId} changed ${conflicts.join(", ")}.`,
            );
            break;
          }
          if (existing.status !== "interrupted") {
            fatal(
              "invalid-node-transition",
              `node_started cannot follow execution status ${existing.status}.`,
            );
            break;
          }
          existing.status = "running";
          existing.startedAt ??= event.ts;
          executionStartedSeq.set(existing.executionId, event.seq);
          delete existing.finishedAt;
          break;
        }
        if (!validateNewExecutionIdentity(event)) break;
        if (event.attempt! > 1) {
          const rescueStarted = rescueStartedByExecution.get(event.executionId!);
          if (
            !rescueStarted ||
            rescueStarted.executionId !== event.executionId ||
            rescueStarted.nodeId !== event.nodeId ||
            rescueStarted.attempt !== event.attempt ||
            rescueStarted.parentExecutionId !== event.parentExecutionId ||
            rescueStarted.branchId !== event.branchId
          ) {
            fatal(
              "missing-rescue-start",
              `Node ${event.nodeId} attempt ${event.attempt} did not begin with rescue_started.`,
            );
            break;
          }
        }
        const execution = createExecution(event);
        execution.status = "running";
        execution.startedAt = event.ts;
        executionStartedSeq.set(execution.executionId, event.seq);
        state.executions[event.executionId!] = execution;
        break;
      }
      case "node_succeeded": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        if (!execution) break;
        if (execution.status !== "running") {
          fatal(
            "invalid-node-transition",
            `node_succeeded cannot follow execution status ${execution.status}.`,
          );
          break;
        }
        const node = graphNodeById.get(event.nodeId!);
        if (node?.kind === "evidence-gate") {
          const decision = execution.gateDecision;
          const expectedRoute = decision?.supported
            ? "evidence-supported"
            : "evidence-unsupported";
          if (
            !decision || event.data?.routeCondition !== expectedRoute ||
            (!decision.supported && node.onUnsupportedOutput !== "route")
          ) {
            fatal(
              "invalid-gate-transition",
              `Evidence-gate execution ${event.executionId} succeeded without a matching prior decision and route.`,
            );
            break;
          }
        }
        if (node && requiresWorkflowEvidencePolicyEvaluation(manifest.graph, node)) {
          const decision = execution.evidenceDecision;
          const policy = effectiveWorkflowEvidencePolicy(manifest.graph, node);
          const terminalArtifacts = artifactsFromData(event.data);
          const sourceCatalog = buildWorkflowEvidenceSourceCatalog(
            event.data?.output,
            observedInboundForExecution(execution),
          );
          const normalizedSourceIds = decision
            ? normalizeWorkflowEvidenceSourceIds(decision.sourceIds, sourceCatalog)
            : null;
          const sourceIdsMatch = decision !== undefined &&
            normalizedSourceIds !== null &&
            jsonEqual(normalizedSourceIds, decision.sourceIds);
          const artifactsMatch = decision !== undefined &&
            jsonEqual(decision.artifacts, terminalArtifacts);
          const supportedStructureComplete = decision !== undefined &&
            sourceIdsMatch && artifactsMatch &&
            decision.sourceIds.length >= policy.minimumIndependentSources &&
            (!policy.requireArtifactReferences || terminalArtifacts.length > 0);
          const expectedRoute = decision?.supported
            ? policy.onUnsupportedOutput === "route" ? "evidence-supported" : "success"
            : "evidence-unsupported";
          if (
            !decision || !sourceIdsMatch || !artifactsMatch ||
            (decision.supported && !supportedStructureComplete) ||
            (!decision.supported && policy.onUnsupportedOutput !== "route") ||
            event.data?.routeCondition !== expectedRoute
          ) {
            fatal(
              "evidence-decision-mismatch",
              `Execution ${event.executionId} succeeded without a matching replayable evidence decision, route, output, and artifact set.`,
            );
            break;
          }
          if (node.kind === "lean4") {
            const leanStatus = leanVerificationStatusFromData(event.data);
            if (
              !leanStatus ||
              (decision.supported && (
                leanStatus !== "verified" ||
                !hasCompleteTrustedLeanArtifacts(
                  manifest.id,
                  execution.executionId,
                  terminalArtifacts,
                )
              ))
            ) {
              fatal(
                "lean-success-receipt-mismatch",
                `Lean execution ${event.executionId} succeeded without a matching verified result and exact trusted artifact receipts.`,
              );
              break;
            }
          }
        } else if (node?.kind === "lean4") {
          const terminalArtifacts = artifactsFromData(event.data);
          if (
            execution.evidenceDecision ||
            leanVerificationStatusFromData(event.data) !== "verified" ||
            !hasCompleteTrustedLeanArtifacts(
              manifest.id,
              execution.executionId,
              terminalArtifacts,
            )
          ) {
            fatal(
              "lean-success-receipt-mismatch",
              `Lean execution ${event.executionId} succeeded without a verified result and both exact trusted artifact receipts.`,
            );
            break;
          }
        }
        const requiredSlots = node
          ? workflowModelCallSlotsForNode(manifest.graph, node)
          : [];
        const missingDeclarations = requiredSlots.filter(
          (slot) => !execution.modelCallSlots[slot.id],
        );
        const unresolvedSlots = Object.values(execution.modelCallSlots).filter(
          (slot) => !slot.receipt,
        );
        if (missingDeclarations.length > 0 || unresolvedSlots.length > 0) {
          fatal(
            "incomplete-model-call-slots",
            `Execution ${event.executionId} succeeded without all required model-call receipts.`,
          );
          break;
        }
        execution.status = "succeeded";
        execution.finishedAt = event.ts;
        execution.artifacts = artifactsFromData(event.data);
        terminalExecutionEvidence.set(execution.executionId, {
          finishedSeq: event.seq,
          routeCondition: event.data?.routeCondition as
            "always" | "success" | "failure" | "evidence-supported" | "evidence-unsupported",
          ...(event.data?.output !== undefined
            ? { output: structuredClone(event.data.output) }
            : {}),
        });
        delete execution.error;
        break;
      }
      case "node_failed": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        if (!execution) break;
        if (execution.status !== "running") {
          fatal(
            "invalid-node-transition",
            `node_failed cannot follow execution status ${execution.status}.`,
          );
          break;
        }
        const node = graphNodeById.get(event.nodeId!);
        const error = errorFromData(event.data);
        if (node?.kind === "evidence-gate") {
          const decision = execution.gateDecision;
          const isEvidenceUnsupported = error?.code === "EVIDENCE_UNSUPPORTED" ||
            error?.code === "WORKFLOW_EVIDENCE_UNSUPPORTED";
          if (
            (decision && (
              decision.supported || !isEvidenceUnsupported ||
              node.onUnsupportedOutput === "route"
            )) ||
            (!decision && isEvidenceUnsupported)
          ) {
            fatal(
              "invalid-gate-transition",
              `Evidence-gate execution ${event.executionId} failed without a matching prior unsupported decision.`,
            );
            break;
          }
        }
        const evidenceDecision = execution.evidenceDecision;
        const commonEvidenceRequired = node
          ? requiresWorkflowEvidencePolicyEvaluation(manifest.graph, node)
          : false;
        if (evidenceDecision) {
          const commonEvidenceFailure = commonEvidenceRequired &&
            !evidenceDecision.supported &&
            effectiveWorkflowEvidencePolicy(manifest.graph, node!).onUnsupportedOutput !== "route" &&
            (error?.code === "EVIDENCE_UNSUPPORTED" ||
              error?.code === "WORKFLOW_EVIDENCE_UNSUPPORTED");
          const leanFailure = !commonEvidenceRequired && node?.kind === "lean4" &&
            !evidenceDecision.supported &&
            error !== undefined && [
              "INVALID_LEAN_VERIFICATION_RESULT",
              "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE",
              "WORKFLOW_LEAN_VERIFICATION_FAILED",
            ].includes(error.code);
          if (evidenceDecision.supported || (!commonEvidenceFailure && !leanFailure)) {
            fatal(
              "evidence-decision-mismatch",
              `Execution ${event.executionId} failed without a matching prior unsupported evidence decision and failure code.`,
            );
            break;
          }
        } else if (
          commonEvidenceRequired &&
          (error?.code === "EVIDENCE_UNSUPPORTED" ||
            error?.code === "WORKFLOW_EVIDENCE_UNSUPPORTED")
        ) {
          fatal(
            "evidence-decision-mismatch",
            `Execution ${event.executionId} reported unsupported evidence without a prior evidence decision.`,
          );
          break;
        }
        execution.status = "failed";
        execution.finishedAt = event.ts;
        terminalExecutionEvidence.set(execution.executionId, {
          finishedSeq: event.seq,
          routeCondition: "failure",
        });
        execution.error = error;
        break;
      }
      case "node_skipped": {
        if (!requireRunStatus(event, ["running"])) break;
        if (event.attempt !== 1 || !validateNewExecutionIdentity(event)) {
          if (event.attempt !== 1) {
            fatal("invalid-node-transition", "Only a first node attempt may be skipped.");
          }
          break;
        }
        const execution = createExecution(event);
        execution.status = "skipped";
        execution.finishedAt = event.ts;
        state.executions[event.executionId!] = execution;
        break;
      }
      case "gate_evaluated": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        const node = graphNodeById.get(event.nodeId!);
        if (!execution || execution.status !== "running" || node?.kind !== "evidence-gate") {
          fatal(
            "invalid-gate-transition",
            `gate_evaluated requires a running evidence-gate execution.`,
          );
          break;
        }
        if (evaluatedGateExecutions.has(event.executionId!)) {
          fatal("duplicate-gate-decision", `Execution ${event.executionId} evaluated its gate twice.`);
          break;
        }
        const decision = gateDecisionFromData(event.data);
        const observedInbound = observedInboundForExecution(execution);
        const sourceCatalog = buildWorkflowEvidenceSourceCatalog(
          undefined,
          observedInbound,
        );
        const replayedSourceIds = normalizeWorkflowEvidenceSourceIds(
          decision.sourceIds,
          sourceCatalog,
        );
        const declaredArtifacts = new Map(
          (manifest.graph.artifacts ?? []).map((artifact) => [artifact.id, artifact]),
        );
        let gateReceiptMismatch = false;
        for (const receipt of decision.artifacts) {
          const definition = declaredArtifacts.get(receipt.artifactId);
          const priorWriterReceipt = observedInbound.some(
            (candidate) =>
              candidate.fromNodeId === receipt.writerNodeId &&
              candidate.artifacts.some((artifact) => jsonEqual(artifact, {
                path: receipt.path,
                size: receipt.size,
                sha256: receipt.sha256,
                ...(receipt.mediaType ? { mediaType: receipt.mediaType } : {}),
              })),
          );
          if (
            !node.artifactIds.includes(receipt.artifactId) ||
            definition?.writerNodeId !== receipt.writerNodeId ||
            definition.path !== receipt.path ||
            !priorWriterReceipt
          ) {
            gateReceiptMismatch = true;
            break;
          }
        }
        const policy = effectiveWorkflowEvidencePolicy(manifest.graph, node);
        const receivedArtifactIds = new Set(
          decision.artifacts.map((artifact) => artifact.artifactId),
        );
        const completeArtifactSet = node.artifactIds.every((artifactId) =>
          receivedArtifactIds.has(artifactId)
        );
        const supportedDecisionInvalid = decision.supported && (
          gateReceiptMismatch || !completeArtifactSet ||
          (node.checks.includes("artifact-exists") && node.artifactIds.length === 0) ||
          (policy.enabled && decision.sourceIds.length < policy.minimumIndependentSources) ||
          (policy.enabled && policy.requireArtifactReferences && decision.artifacts.length === 0)
        );
        if (replayedSourceIds === null || gateReceiptMismatch || supportedDecisionInvalid) {
          fatal(
            "gate-decision-mismatch",
            `Evidence-gate execution ${event.executionId} persisted forged or incomplete decision evidence.`,
          );
          break;
        }
        evaluatedGateExecutions.add(event.executionId!);
        execution.gateDecision = decision;
        break;
      }
      case "evidence_checked": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        const node = graphNodeById.get(event.nodeId!);
        const trustedLeanFailureReceipt = node?.kind === "lean4" &&
          (event.data as { supported?: unknown } | undefined)?.supported === false;
        if (
          !execution || execution.status !== "running" || !node ||
          (!requiresWorkflowEvidencePolicyEvaluation(manifest.graph, node) &&
            !trustedLeanFailureReceipt)
        ) {
          fatal(
            "invalid-evidence-transition",
            "evidence_checked requires enabled policy or a trusted failed Lean decision on a running execution.",
          );
          break;
        }
        if (checkedEvidenceExecutions.has(event.executionId!)) {
          fatal(
            "duplicate-evidence-decision",
            `Execution ${event.executionId} checked its evidence policy twice.`,
          );
          break;
        }
        checkedEvidenceExecutions.add(event.executionId!);
        execution.evidenceDecision = evidenceDecisionFromData(event.data);
        break;
      }
      case "rescue_started": {
        if (!requireRunStatus(event, ["running"])) break;
        if (event.attempt! <= 1 || rescueStartedByExecution.has(event.executionId!)) {
          fatal("invalid-rescue-transition", "rescue_started requires one new retry attempt.");
          break;
        }
        if (state.executions[event.executionId!]) {
          fatal("invalid-rescue-transition", "rescue_started must precede node_started.");
          break;
        }
        const previous = Object.values(state.executions).find(
          (execution) => execution.nodeId === event.nodeId && execution.attempt === event.attempt! - 1,
        );
        if (
          !previous ||
          previous.status !== "failed" ||
          !previous.error ||
          !jsonEqual(previous.error, event.data?.previousError)
        ) {
          fatal(
            "invalid-rescue-transition",
            `Node ${event.nodeId} rescue attempt ${event.attempt} does not match a failed prior attempt.`,
          );
          break;
        }
        rescueStartedByExecution.set(event.executionId!, event);
        break;
      }
      case "rescue_finished": {
        if (!requireRunStatus(event, ["running"])) break;
        const execution = executionForEvent(event);
        if (!execution || !rescueStartedByExecution.has(event.executionId!)) {
          fatal("invalid-rescue-transition", "rescue_finished has no matching rescue_started.");
          break;
        }
        if (rescueFinishedExecutions.has(event.executionId!)) {
          fatal("invalid-rescue-transition", "A rescue attempt finished more than once.");
          break;
        }
        const succeeded = event.data?.succeeded === true;
        if (
          (succeeded && execution.status !== "succeeded") ||
          (!succeeded && (
            execution.status !== "failed" || !jsonEqual(execution.error, event.data?.error)
          ))
        ) {
          fatal("invalid-rescue-transition", "rescue_finished disagrees with the node result.");
          break;
        }
        rescueFinishedExecutions.add(event.executionId!);
        break;
      }
      case "compaction_checked": {
        if (!requireRunStatus(event, ["running"])) break;
        if (event.executionId) {
          const execution = executionForEvent(event);
          if (!execution || execution.status !== "running") {
            fatal(
              "invalid-compaction-transition",
              "A node compaction check requires a running execution.",
            );
          }
        }
        break;
      }
      case "run_succeeded": {
        if (!requireRunStatus(event, ["running"])) break;
        const executions = Object.values(state.executions);
        if (
          !executions.some((execution) => execution.status === "succeeded") ||
          executions.some((execution) => ["pending", "running", "interrupted"].includes(execution.status))
        ) {
          fatal(
            "invalid-run-transition",
            "run_succeeded requires completed node work and no active or interrupted execution.",
          );
          break;
        }
        state.status = "succeeded";
        state.finishedAt = event.ts;
        break;
      }
      case "run_failed":
        if (!requireRunStatus(event, ["running", "blocked"])) break;
        state.status = "failed";
        state.finishedAt = event.ts;
        state.lastError = errorFromData(event.data);
        interruptRunningExecutions(state.executions, event.ts);
        break;
      case "run_cancelled":
        if (!requireRunStatus(event, ["queued", "running", "waiting", "blocked", "paused"])) break;
        state.status = "cancelled";
        state.finishedAt = event.ts;
        state.lastError = errorFromData(event.data);
        interruptRunningExecutions(state.executions, event.ts);
        break;
      case "run_interrupted":
        if (!requireRunStatus(event, ["running", "waiting", "blocked", "paused"])) break;
        if (event.data?.previousStatus !== state.status) {
          fatal(
            "invalid-run-transition",
            `run_interrupted previousStatus ${String(event.data?.previousStatus)} does not match ${state.status}.`,
          );
          break;
        }
        state.status = "interrupted";
        state.interruptedAt = event.ts;
        state.lastError = errorFromData(event.data);
        interruptRunningExecutions(state.executions, event.ts);
        break;
      case "store_repaired":
        state.diagnostics.push({
          code: "event-log-repaired",
          message: typeof event.data?.message === "string"
            ? event.data.message
            : "A torn workflow event-log tail was repaired.",
          fatal: false,
        });
        break;
      default: {
        const unsupported: never = event.type;
        state.diagnostics.push({
          code: "unknown-event-type",
          message: `Unsupported workflow event type: ${String(unsupported)}.`,
          fatal: true,
        });
      }
    }
  }

  if (state.diagnostics.some((diagnostic) => diagnostic.fatal)) {
    state.recoverable = false;
  } else if (isTerminalWorkflowRunStatus(state.status)) {
    state.recoverable = false;
  }
  return state;
}
