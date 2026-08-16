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

  constructor(status: number, detail: string, code?: string) {
    super(detail);
    this.name = "DagWorkflowApiError";
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
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
  const body = await parseResponse<{
    outcome: DagWorkflowSaveOutcome;
    definition: StoredDagWorkflowDefinition;
  }>(response);
  if (!isRecord(body) || !isRecord(body.definition) || typeof body.outcome !== "string") {
    throw new DagWorkflowApiError(
      response.status,
      "The workflow definition write returned no {outcome, definition} envelope.",
      "MALFORMED_SAVE_RESPONSE",
    );
  }
  return {
    outcome: body.outcome,
    definition: body.definition,
    etag: response.headers.get("ETag"),
  };
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
