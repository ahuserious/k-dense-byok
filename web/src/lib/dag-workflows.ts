"use client";

import { apiFetch } from "@/lib/projects";

export type WorkflowReasoningLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type WorkflowAuthKind = "api-key" | "oauth" | "local" | "custom";

export interface FixedRequestedModel {
  source: "fixed";
  provider: string;
  model: string;
  auth: {
    kind: WorkflowAuthKind;
    profile?: string;
  };
  reasoning: WorkflowReasoningLevel;
}

export interface KadyCurrentRequestedModel {
  source: "kady-current";
  auth: { kind: "kady-current" };
  reasoning: WorkflowReasoningLevel;
}

export type WorkflowRequestedModel =
  | FixedRequestedModel
  | KadyCurrentRequestedModel;

export type WorkflowModelRequest = {
  requested: WorkflowRequestedModel;
  resolution:
    | { mode: "exact" }
    | {
        mode: "explicit-fallback";
        alternatives: WorkflowRequestedModel[];
        reason: string;
      };
};

export interface WorkflowLimits {
  maxIterations: number;
  maxModelCalls: number;
  maxParallelism: number;
  maxSubagents: number;
  timeoutMs: number;
  maxTokens: number;
  maxCostUsd: number;
  maxRetries: number;
}

export type WorkflowNodeLimits = Partial<WorkflowLimits>;

export type WorkflowRescueTrigger =
  | "failure"
  | "stalled"
  | "unsupported-output"
  | "pre-compaction"
  | "post-compaction";

export interface WorkflowRescuePolicy {
  enabled: boolean;
  maxAttempts: number;
  triggers: WorkflowRescueTrigger[];
}

export interface WorkflowEvidencePolicy {
  enabled: boolean;
  minimumIndependentSources: number;
  requireArtifactReferences: boolean;
  onUnsupportedOutput: "fail" | "rescue" | "route";
  evaluator?: WorkflowModelRequest;
}

export interface WorkflowNodeWorkspace {
  isolation: "read-only" | "isolated-worktree" | "exclusive-project";
  writePaths: string[];
}

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

/** The CLI harness a node's work is dispatched to. Mirrors schema.ts HarnessSchema. */
export type WorkflowNodeHarness =
  | "pi"
  | "claude-code"
  | "codex"
  | "opencode"
  | "copilot";

/**
 * The persisted per-node NodeSpec v1.
 *
 * Only the fields the Kady host reads are named. The open index signature is
 * deliberate: the host must round-trip every other NodeSpec key untouched, and
 * a closed type would invite a well-meaning rebuild that drops one. The host
 * never reconstructs a node from the canvas (see typed-canvas-adapter.ts), so
 * preservation is structural rather than a matter of listing every key here.
 */
export interface WorkflowNodeSpecV1 {
  version?: 1;
  harness?: WorkflowNodeHarness;
  model?: WorkflowModelRequest;
  reasoningEffort?: WorkflowReasoningLevel;
  databases?: string[];
  autonomy?: "strict" | "loose";
  [key: string]: unknown;
}

/**
 * Where a node or document came from. Additive and optional; carried for
 * import/stitch provenance and excluded from validation semantics.
 */
export interface WorkflowProvenance {
  source: string;
  id: string;
  sha256?: string;
}

/** Flatten provenance for a node that came from a stitched-in subgraph. */
export interface WorkflowNodeCompositeOrigin {
  kind: string;
  sourceId: string;
  sourceGraphSha256?: string;
  label?: string;
}

export interface WorkflowNodeMeta {
  compositeOf?: WorkflowNodeCompositeOrigin;
}

interface CommonWorkflowNode {
  id: string;
  name: string;
  description?: string;
  terminal: boolean;
  workspace: WorkflowNodeWorkspace;
  position?: WorkflowNodePosition;
  limits?: WorkflowNodeLimits;
  rescue?: WorkflowRescuePolicy;
  evidence?: WorkflowEvidencePolicy;
  settings?: WorkflowNodeSpecV1;
  meta?: WorkflowNodeMeta;
  provenance?: WorkflowProvenance;
}

interface ModelDrivenWorkflowNode extends CommonWorkflowNode {
  model?: WorkflowModelRequest;
}

export interface AgentWorkflowNode extends ModelDrivenWorkflowNode {
  kind: "agent";
  prompt: string;
}

export interface ResearchUntilGoalWorkflowNode extends ModelDrivenWorkflowNode {
  kind: "research-until-goal";
  goal: string;
  completionCriteria: string[];
}

export interface WorkflowPanelMember {
  id: string;
  role: string;
  model: WorkflowModelRequest;
}

export interface CouncilWorkflowNode extends CommonWorkflowNode {
  kind: "council";
  goal: string;
  members: WorkflowPanelMember[];
  chair: WorkflowModelRequest;
  rounds: number;
  preserveMinorityReports: boolean;
}

export type WorkflowFusionConfiguration =
  | {
      mode: "openrouter-router";
      router: WorkflowModelRequest;
      members: WorkflowPanelMember[];
      judge: WorkflowModelRequest;
    }
  | {
      mode: "kady-panel";
      members: WorkflowPanelMember[];
      synthesizer: WorkflowModelRequest;
      rounds: number;
    };

export interface FusionWorkflowNode extends CommonWorkflowNode {
  kind: "fusion";
  goal: string;
  fusion: WorkflowFusionConfiguration;
  preserveMinorityReports: boolean;
}

export interface BestOfNWorkflowNode extends ModelDrivenWorkflowNode {
  kind: "best-of-n";
  goal: string;
  candidateCount?: number;
  candidateModels?: WorkflowModelRequest[];
  evaluator?: WorkflowModelRequest;
}

export type WorkflowEvidenceCheck =
  | "citations"
  | "artifact-exists"
  | "claim-support"
  | "unsupported-output";

export interface EvidenceGateWorkflowNode extends CommonWorkflowNode {
  kind: "evidence-gate";
  checks: WorkflowEvidenceCheck[];
  artifactIds: string[];
  evaluator?: WorkflowModelRequest;
  onUnsupportedOutput: "fail" | "rescue" | "route";
}

export interface Lean4WorkflowNode extends CommonWorkflowNode {
  kind: "lean4";
  goal: string;
  theorem: string;
  mode: "verify" | "solve";
  solverModel?: WorkflowModelRequest;
  mathlib: boolean;
  skill: "byom-dag-fusion";
}

export type WorkflowGraphNode =
  | AgentWorkflowNode
  | ResearchUntilGoalWorkflowNode
  | CouncilWorkflowNode
  | FusionWorkflowNode
  | BestOfNWorkflowNode
  | EvidenceGateWorkflowNode
  | Lean4WorkflowNode;

export type WorkflowEdgeCondition =
  | "always"
  | "success"
  | "failure"
  | "evidence-supported"
  | "evidence-unsupported";

export interface WorkflowGraphEdge {
  id: string;
  from: string;
  to: string;
  condition?: WorkflowEdgeCondition;
}

export interface WorkflowArtifact {
  id: string;
  name: string;
  kind: "file" | "directory" | "dataset" | "report" | "proof" | "log";
  writerNodeId: string;
  path?: string;
}

export interface ScientificWorkflowPreconditions {
  requiredInputs: Array<{ key: string; label: string }>;
  requiredFiles: Array<{ key: string; label: string; minimumCount: number }>;
  requiredCapabilities: Array<"prompt-analysis" | "read-uploaded-files">;
}

export interface WorkflowGraphDocument {
  schemaVersion: "1.0";
  id: string;
  name: string;
  description?: string;
  entryNodeId: string;
  defaultModel?: WorkflowModelRequest;
  limits: WorkflowLimits;
  rescue?: WorkflowRescuePolicy;
  evidence: WorkflowEvidencePolicy;
  artifacts?: WorkflowArtifact[];
  preconditions?: ScientificWorkflowPreconditions;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  provenance?: WorkflowProvenance;
}

export interface DagWorkflowDefinitionSummary {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  graphSha256: string;
  schemaVersion: string;
  name: string;
  description: string | null;
  nodeCount: number;
  edgeCount: number;
}

export interface StoredDagWorkflowDefinition {
  storageVersion: 1;
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  graphSha256: string;
  graph: WorkflowGraphDocument;
}

export interface VersionedDagWorkflowDefinition {
  definition: StoredDagWorkflowDefinition;
  etag: string | null;
}

export type DagWorkflowSaveOutcome = "created" | "unchanged" | "updated";

/**
 * The caller's explicit definition intent. There is no inferred intent: a
 * create sends `If-None-Match: *`, an update sends `If-Match: "<revision>"`,
 * and an expected revision of `0` is a legal update precondition that can only
 * reach the server's missing-record conflict path.
 */
export type DagWorkflowSaveIntent =
  | { kind: "create" }
  | { kind: "update"; expectedRevision: number };

export interface SavedDagWorkflowDefinition extends VersionedDagWorkflowDefinition {
  outcome: DagWorkflowSaveOutcome;
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

export interface WorkflowRunErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WorkflowRunDiagnostic {
  code: string;
  message: string;
  fatal: boolean;
  line?: number;
}

export interface WorkflowRunState {
  runId: string;
  status: WorkflowRunStatus;
  lastSeq: number;
  executions: Record<string, unknown>;
  startedAt?: number;
  finishedAt?: number;
  interruptedAt?: number;
  lastError?: WorkflowRunErrorInfo;
  recoverable: boolean;
  diagnostics: WorkflowRunDiagnostic[];
}

export interface WorkflowRunManifest {
  storageVersion: 1;
  id: string;
  projectId: string;
  workflowId: string;
  workflowRevision: number;
  graphSha256: string;
  requestId: string;
  requestSha256: string;
  sessionId?: string;
  createdAt: number;
  requestedBy: "user" | "agent" | "api";
  input: {
    goal?: string;
    variables?: Record<string, unknown>;
    files?: Record<string, string[]>;
  };
  effectiveLimits: Record<string, unknown>;
  graph: WorkflowGraphDocument;
}

export interface WorkflowRunRecord {
  manifest: WorkflowRunManifest;
  state: WorkflowRunState;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  workflowRevision: number;
  graphSha256: string;
  sessionId: string | null;
  createdAt: number;
  requestedBy: "user" | "agent" | "api";
  status: WorkflowRunStatus;
  lastSeq: number;
  startedAt: number | null;
  finishedAt: number | null;
  interruptedAt: number | null;
  recoverable: boolean;
  lastError: WorkflowRunErrorInfo | null;
  diagnostics: WorkflowRunDiagnostic[];
}

export interface WorkflowRunBudgetSummary {
  runId: string;
  reservationCount: number;
  ceilings: {
    maxCostUsd: number;
    maxTokens: number;
    maxModelCalls: number;
  } | null;
  modelCallCount: number;
  activeReservationCount: number;
  activeReservedMaximumUsd: number;
  activeReservedMaximumTokens: number;
  settledReservationCount: number;
  settledChargedUsd: number;
  observedUsageTokens: number;
  /** Persisted maximum envelope, not observed token consumption. */
  missingUsageMaximumTokens: number;
  staleReservationCount: number;
  fullChargeReservationCount: number;
}

export interface WorkflowRunEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  seq: number;
  ts: number;
  type: string;
  executionId?: string;
  nodeId?: string;
  attempt?: number;
  parentExecutionId?: string;
  branchId?: string;
  data?: Record<string, unknown>;
}

export interface WorkflowRunEventPage {
  events: WorkflowRunEvent[];
  lastSeq: number;
  hasMore: boolean;
  diagnostics: WorkflowRunDiagnostic[];
}

export interface CreateWorkflowRunInput {
  requestId: string;
  expectedWorkflowRevision?: number;
  sessionId?: string;
  input?: {
    goal?: string;
    variables?: Record<string, unknown>;
    files?: Record<string, string[]>;
  };
}

export interface RescueWorkflowRunInput {
  requestId: string;
}

export const MAX_WORKFLOW_RUN_GOAL_LENGTH = 32_768;

export class DagWorkflowApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly code?: string;
  /**
   * On a definition-write conflict, the revision the SERVER compared against —
   * when it published one. `undefined` on every other failure, and `null` when
   * the conflict carried no usable ETag, which is the case where a conditional
   * retry cannot be offered at all.
   */
  readonly currentRevision?: number | null;

  constructor(
    status: number,
    detail: string,
    code?: string,
    currentRevision?: number | null,
  ) {
    super(detail);
    this.name = "DagWorkflowApiError";
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

/**
 * A definition write lost its conditional precondition.
 *
 * The typed store answers a failed `If-Match`/`If-None-Match` with `409` and
 * re-publishes the compared revision as an ETag; a malformed or absent
 * precondition is a `400`/`428` and never reaches here. `422` is included
 * because the store's own `PRECONDITION_FAILED` code maps there, and a client
 * that only handled one of the two would drop the other on the floor.
 */
const DEFINITION_CONFLICT_STATUSES: readonly number[] = [409, 412, 422];

function isDefinitionConflictStatus(status: number): boolean {
  return DEFINITION_CONFLICT_STATUSES.includes(status);
}

/** `"<revision>"` → revision. Anything else (weak, padded, absent) → null. */
function parseRevisionEtag(value: string | null): number | null {
  if (value === null) return null;
  const match = /^"(0|[1-9]\d*)"$/.exec(value.trim());
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

/**
 * A definition write that lost its precondition, carrying the revision the
 * server compared against.
 *
 * `currentRevision === null` means the caller may offer Reload or Save-as-copy
 * but MUST NOT offer force-overwrite: there is no revision to make the retry
 * conditional with, and an unconditional write is not something this client can
 * express.
 */
export interface DagWorkflowConflict extends DagWorkflowApiError {
  currentRevision: number | null;
}

export function isDagWorkflowConflict(error: unknown): error is DagWorkflowConflict {
  return (
    error instanceof DagWorkflowApiError
    && error.currentRevision !== undefined
    && isDefinitionConflictStatus(error.status)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const responseText = await response.text();
  let body: unknown = null;
  if (responseText) {
    try {
      body = JSON.parse(responseText) as unknown;
    } catch {
      body = responseText;
    }
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.detail === "string"
      ? body.detail
      : typeof body === "string" && body.trim()
        ? body
        : `DAG workflow request failed with status ${response.status}.`;
    const code = isRecord(body) && typeof body.code === "string"
      ? body.code
      : undefined;
    throw new DagWorkflowApiError(response.status, detail, code);
  }
  return body as T;
}

function positiveBoundedInteger(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

/**
 * Definition update preconditions accept every non-negative safe integer,
 * including `0`. `0` never means "create": it is a precondition no persisted
 * definition can satisfy, so the server answers 409.
 */
function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

const DAG_WORKFLOW_SAVE_OUTCOMES: readonly string[] = ["created", "unchanged", "updated"];

/**
 * The minimum a caller may rely on from a definition write: a known outcome and
 * the two fields of the `StoredDagWorkflowDefinition` interface above that
 * callers read back — `id` to address the workflow and `revision` to seed the
 * next update precondition. An unknown outcome or an absent revision would
 * flow on as `undefined` and surface as a RangeError on the *next* save, far
 * from the malformed response that caused it. The remaining stored fields stay
 * trusted, as everywhere else in this client.
 */
function isSavedDefinitionEnvelope(body: unknown): body is {
  outcome: DagWorkflowSaveOutcome;
  definition: StoredDagWorkflowDefinition;
} {
  if (!isRecord(body) || !isRecord(body.definition)) return false;
  if (typeof body.outcome !== "string" || !DAG_WORKFLOW_SAVE_OUTCOMES.includes(body.outcome)) {
    return false;
  }
  const { id, revision } = body.definition;
  return (
    typeof id === "string"
    && typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0
  );
}

export async function listDagWorkflowDefinitions(
  projectId: string,
): Promise<DagWorkflowDefinitionSummary[]> {
  const response = await apiFetch("/dag-workflows", {}, projectId);
  const body = await parseResponse<{ workflows: DagWorkflowDefinitionSummary[] }>(response);
  return body.workflows;
}

export async function readDagWorkflowDefinition(
  projectId: string,
  workflowId: string,
): Promise<VersionedDagWorkflowDefinition> {
  const response = await apiFetch(
    `/dag-workflows/${encodeURIComponent(workflowId)}`,
    {},
    projectId,
  );
  const definition = await parseResponse<StoredDagWorkflowDefinition>(response);
  return { definition, etag: response.headers.get("ETag") };
}

export async function saveDagWorkflowDefinition(
  projectId: string,
  workflowId: string,
  graph: WorkflowGraphDocument,
  intent: DagWorkflowSaveIntent,
): Promise<SavedDagWorkflowDefinition> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (intent.kind === "create") {
    headers.set("If-None-Match", "*");
  } else {
    headers.set(
      "If-Match",
      `"${nonNegativeSafeInteger(intent.expectedRevision, "Expected revision")}"`,
    );
  }
  const response = await apiFetch(
    `/dag-workflows/${encodeURIComponent(workflowId)}`,
    { method: "PUT", headers, body: JSON.stringify(graph) },
    projectId,
  );
  let body: unknown;
  try {
    body = await parseResponse<unknown>(response);
  } catch (error) {
    // A CAS conflict is the one failure the caller can act on, and the only
    // way to act on it safely is with the revision the SERVER just compared
    // against. Force-overwrite is offered only when that ETag is present, so a
    // retry is still a conditional write and a blind overwrite is unreachable.
    if (error instanceof DagWorkflowApiError && isDefinitionConflictStatus(error.status)) {
      throw new DagWorkflowApiError(
        error.status,
        error.detail,
        error.code,
        parseRevisionEtag(response.headers.get("ETag")),
      );
    }
    throw error;
  }
  if (!isSavedDefinitionEnvelope(body)) {
    throw new DagWorkflowApiError(
      response.status,
      "The workflow definition write returned no valid {outcome, definition} envelope.",
      "MALFORMED_SAVE_RESPONSE",
    );
  }
  return {
    outcome: body.outcome,
    definition: body.definition,
    etag: response.headers.get("ETag"),
  };
}

export interface DagWorkflowValidationIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export type DagWorkflowValidationResult =
  | {
      ok: true;
      document: WorkflowGraphDocument;
      graphSha256: string;
      warnings: DagWorkflowValidationIssue[];
    }
  | { ok: false; issues: DagWorkflowValidationIssue[] };

function isValidationEnvelope(body: unknown): body is DagWorkflowValidationResult {
  if (!isRecord(body) || typeof body.ok !== "boolean") return false;
  if (body.ok === false) return Array.isArray(body.issues);
  return (
    isRecord(body.document)
    && typeof body.graphSha256 === "string"
    && Array.isArray(body.warnings)
  );
}

/**
 * Validate a typed document without writing anything.
 *
 * An invalid document is a SUCCESSFUL evaluation — HTTP 200 with `ok:false`.
 * A non-2xx from this call is transport, auth, size, or an unparseable body,
 * never "your workflow has a problem", and is raised as DagWorkflowApiError.
 */
export async function validateDagWorkflowDocument(
  projectId: string,
  document: WorkflowGraphDocument,
): Promise<DagWorkflowValidationResult> {
  const response = await apiFetch(
    "/dag-workflows/validate",
    {
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ document }),
    },
    projectId,
  );
  const body = await parseResponse<unknown>(response);
  if (!isValidationEnvelope(body)) {
    throw new DagWorkflowApiError(
      response.status,
      "The workflow validation route returned no valid {ok,…} envelope.",
      "MALFORMED_VALIDATION_RESPONSE",
    );
  }
  return body;
}

export async function createDagWorkflowRun(
  projectId: string,
  workflowId: string,
  input: CreateWorkflowRunInput,
): Promise<WorkflowRunRecord> {
  if (
    input.input?.goal !== undefined &&
    input.input.goal.length > MAX_WORKFLOW_RUN_GOAL_LENGTH
  ) {
    throw new RangeError(
      `Workflow run goal must be at most ${MAX_WORKFLOW_RUN_GOAL_LENGTH} characters.`,
    );
  }
  const response = await apiFetch(
    `/dag-workflows/${encodeURIComponent(workflowId)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    projectId,
  );
  return parseResponse<WorkflowRunRecord>(response);
}

async function controlDagWorkflowRun(
  projectId: string,
  runId: string,
  action: "cancel" | "resume",
): Promise<WorkflowRunRecord> {
  const response = await apiFetch(
    `/dag-workflow-runs/${encodeURIComponent(runId)}/${action}`,
    { method: "POST" },
    projectId,
  );
  return parseResponse<WorkflowRunRecord>(response);
}

export async function cancelDagWorkflowRun(
  projectId: string,
  runId: string,
): Promise<WorkflowRunRecord> {
  return controlDagWorkflowRun(projectId, runId, "cancel");
}

export async function resumeDagWorkflowRun(
  projectId: string,
  runId: string,
): Promise<WorkflowRunRecord> {
  return controlDagWorkflowRun(projectId, runId, "resume");
}

export async function rescueDagWorkflowRun(
  projectId: string,
  runId: string,
  input: RescueWorkflowRunInput,
): Promise<WorkflowRunRecord> {
  const response = await apiFetch(
    `/dag-workflow-runs/${encodeURIComponent(runId)}/rescue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    projectId,
  );
  return parseResponse<WorkflowRunRecord>(response);
}

export async function listDagWorkflowRuns(
  projectId: string,
  limit = 100,
): Promise<WorkflowRunSummary[]> {
  const boundedLimit = positiveBoundedInteger(limit, 200, "Run list limit");
  const response = await apiFetch(
    `/dag-workflow-runs?limit=${boundedLimit}`,
    {},
    projectId,
  );
  const body = await parseResponse<{ runs: WorkflowRunSummary[] }>(response);
  return body.runs;
}

export async function readDagWorkflowRun(
  projectId: string,
  runId: string,
): Promise<WorkflowRunRecord> {
  const response = await apiFetch(
    `/dag-workflow-runs/${encodeURIComponent(runId)}`,
    {},
    projectId,
  );
  return parseResponse<WorkflowRunRecord>(response);
}

export async function readDagWorkflowRunBudget(
  projectId: string,
  runId: string,
): Promise<WorkflowRunBudgetSummary> {
  const response = await apiFetch(
    `/dag-workflow-runs/${encodeURIComponent(runId)}/budget`,
    {},
    projectId,
  );
  return parseResponse<WorkflowRunBudgetSummary>(response);
}

export async function pageDagWorkflowRunEvents(
  projectId: string,
  runId: string,
  options: { after?: number; limit?: number } = {},
): Promise<WorkflowRunEventPage> {
  const after = options.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new RangeError("Event cursor must be a non-negative integer.");
  }
  const limit = positiveBoundedInteger(options.limit ?? 200, 500, "Event page limit");
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  const response = await apiFetch(
    `/dag-workflow-runs/${encodeURIComponent(runId)}/events?${query}`,
    {},
    projectId,
  );
  return parseResponse<WorkflowRunEventPage>(response);
}
