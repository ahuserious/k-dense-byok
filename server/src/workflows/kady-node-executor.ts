import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  ModelRequest,
  WorkflowNode,
} from "./schema.ts";
import type {
  WorkflowArtifactReference,
  WorkflowGateArtifactReceipt,
  WorkflowModelCallSlot,
  WorkflowModelResolutionReceipt,
  WorkflowRunManifestV1,
} from "./run-state.ts";
import {
  verifyWorkflowArtifactReceipt,
  type WorkflowNodeInboundResult,
  type WorkflowNodeExecutor,
  type WorkflowNodeExecutorContext,
  type WorkflowNodeExecutorResult,
} from "./runner.ts";
import { workflowStore } from "./store.ts";
import { resolvePaths, type ProjectPaths } from "../projects.ts";
import {
  getOrCreateWorkflowDelegationSession,
} from "../agent/workflow-delegation-session.ts";
import { assertDagFusionPackageSeeded } from "../agent/dag-fusion-bridge.ts";
import {
  resolveWorkflowModel,
  type ResolvedWorkflowModel,
  type WorkflowModelResolutionContext,
} from "../agent/workflow-model-resolution.ts";
import { modelReference } from "../agent/models.ts";
import {
  buildHostedFusionConfig,
  runHostedOpenRouterFusion,
  type HostedFusionResolvedModels,
  type HostedOpenRouterFusionRequest,
  type HostedOpenRouterFusionResult,
} from "./hosted-fusion.ts";
import { executeAgentNode } from "./agent-node-executor.ts";
import type {
  DynamicWorkflowBudgetSettlement,
  DynamicWorkflowUsage,
} from "./dynamic-workflow-adapter.ts";
import {
  DagFusionCompactionAuditReadError,
  readTrustedDagFusionCompactionAudit,
  type TrustedDagFusionCompactionAudit,
} from "../../pi-packages/dag-fusion-drive/index.ts";
import {
  buildWorkflowEvidenceSourceCatalog,
  effectiveWorkflowEvidencePolicy,
  MAX_WORKFLOW_EVIDENCE_SOURCES,
  normalizeWorkflowEvidenceSourceIds,
  requiresWorkflowEvidencePolicyEvaluation,
  WORKFLOW_EVIDENCE_POLICY_SLOT_ID,
} from "./evidence-policy.ts";
import type {
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  DelegateDagFusionNodeOptions,
  OwnedDelegationRequest,
} from "../../pi-packages/dag-fusion-drive/index.ts";
import type {
  SupervisedWorkflowBudgetDescriptorV1,
} from "./supervised-budget.ts";

export const KADY_WORKFLOW_READ_ONLY_AGENT =
  "dag-workflow-readonly-executor" as const;

const MAX_TASK_BYTES = 96 * 1024;
const MAX_CALL_RESULT_BYTES = 48 * 1024;
const MAX_NODE_OUTPUT_BYTES = 14 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024;

type PlainRecord = Record<string, unknown>;
export interface KadySupervisedDelegateOptions extends DelegateDagFusionNodeOptions {
  /** Trusted local transport metadata; the embedded Dag Fusion host ignores it. */
  supervisedBudget?: SupervisedWorkflowBudgetDescriptorV1;
}

export interface KadyDelegationHostPort {
  delegate(
    request: OwnedDelegationRequest,
    options: KadySupervisedDelegateOptions,
  ): Promise<DagFusionDelegationReceipt>;
}

export interface KadyHostedFusionTransportOptions {
  /** Trusted local transport metadata; the embedded hosted runner ignores it. */
  supervisedBudget?: SupervisedWorkflowBudgetDescriptorV1;
}

type DelegationHost = KadyDelegationHostPort;
type HostedOpenRouterFusionNode = Extract<WorkflowNode, { kind: "fusion" }> & {
  fusion: Extract<
    Extract<WorkflowNode, { kind: "fusion" }>["fusion"],
    { mode: "openrouter-router" }
  >;
};
type ManifestIdentity = Pick<
  WorkflowRunManifestV1,
  "projectId" | "sessionId" | "workflowId" | "workflowRevision"
>;

export type KadyWorkflowNodeErrorCode =
  | "WORKFLOW_NODE_ABORTED"
  | "WORKFLOW_NODE_TIMEOUT"
  | "WORKFLOW_NODE_INVALID_CONTEXT"
  | "WORKFLOW_MODEL_SLOT_MISSING"
  | "WORKFLOW_MODEL_RESOLUTION_MISMATCH"
  | "WORKFLOW_DELEGATION_FAILED"
  | "WORKFLOW_DELEGATION_INVALID_RESULT"
  | "WORKFLOW_DELEGATION_LIMIT_INVALID"
  | "WORKFLOW_USAGE_RECONCILIATION_FAILED"
  | "WORKFLOW_PRE_COMPACTION_CHECK_FAILED"
  | "WORKFLOW_POST_COMPACTION_CHECK_FAILED"
  | "WORKFLOW_WRITABLE_ISOLATION_UNSUPPORTED"
  | "WORKFLOW_RESEARCH_GOAL_NOT_MET"
  | "WORKFLOW_EVIDENCE_UNSUPPORTED"
  | "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE"
  | "WORKFLOW_LEAN_VERIFICATION_FAILED"
  | "WORKFLOW_OPENROUTER_FUSION_UNSUPPORTED";

export class KadyWorkflowNodeError extends Error {
  constructor(
    readonly code: KadyWorkflowNodeErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KadyWorkflowNodeError";
  }
}

export interface KadyWorkflowUsageAdmission {
  projectId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  executionId: string;
  attempt: number;
  slotId: string;
  modelReceipt: WorkflowModelResolutionReceipt;
  maxTokens: number;
  maxCostUsd: number;
  /** Number of provider model calls charged to this reservation. */
  modelCallCount: number;
  /** Immutable whole-run ceilings used by the durable project budget. */
  runMaxTokens: number;
  runMaxCostUsd: number;
  runMaxModelCalls: number;
  timeoutMs: number;
}

export interface KadyWorkflowUsageReservation {
  /** Present on production reservations; test and alternate reservers may omit it. */
  descriptor?: SupervisedWorkflowBudgetDescriptorV1;
  /** Called exactly once for every admitted call, including pre-launch failure. */
  reconcile(settlement: DagFusionDelegationUsageSettlement): void | Promise<void>;
}

export type KadyWorkflowUsageReserver = (
  admission: KadyWorkflowUsageAdmission,
) => KadyWorkflowUsageReservation | Promise<KadyWorkflowUsageReservation>;

export interface TrustedLeanVerificationRequest {
  projectId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  executionId: string;
  goal: string;
  mode: "verify" | "solve";
  /** Exact proposition in solve mode; reviewed complete source in verify mode. */
  theorem: string;
  /** Solver-authored tactic/term body only. The host owns the declaration. */
  proofBody?: string;
  mathlib: boolean;
  skill: "byom-dag-fusion";
  paths: ProjectPaths;
  signal: AbortSignal;
}

export type TrustedLeanExecutionPolicy = "disabled" | "unsandboxed-opt-in";

export interface TrustedLeanPreflightRequest {
  projectId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  executionId: string;
  mathlib: boolean;
  paths: ProjectPaths;
  signal: AbortSignal;
}

export interface TrustedLeanPreflightResult {
  status: "ready" | "unavailable";
  summary: string;
  executionPolicy: TrustedLeanExecutionPolicy;
  mathlibRevision?: string;
  mathlibTree?: string;
}

export interface TrustedLeanVerificationResult {
  status: "verified" | "failed" | "unavailable";
  summary: string;
  theoremName?: string;
  normalizedStatement?: string;
  executionPolicy?: TrustedLeanExecutionPolicy;
  toolchain?: string;
  mathlibRevision?: string;
  mathlibTree?: string;
  assumptions?: string[];
  translationGaps?: string[];
  artifacts?: WorkflowArtifactReference[];
}

export interface TrustedLeanVerifier {
  (
    request: TrustedLeanVerificationRequest,
  ): TrustedLeanVerificationResult | Promise<TrustedLeanVerificationResult>;
  /** Production verifiers expose this so solve nodes fail before any paid call. */
  preflight?(
    request: TrustedLeanPreflightRequest,
  ): TrustedLeanPreflightResult | Promise<TrustedLeanPreflightResult>;
}

export interface KadyDelegationPolicy {
  maxTurns: number;
  graceTurns: number;
  toolSoftLimit: number;
  toolHardLimit: number;
}

export interface KadyNodeExecutorDependencies {
  pathsForProject(projectId: string): ProjectPaths;
  loadManifest(context: WorkflowNodeExecutorContext): ManifestIdentity | Promise<ManifestIdentity>;
  getDelegationSession(
    projectId: string,
    paths: ProjectPaths,
  ): Promise<{ host: DelegationHost }>;
  resolveModel(
    request: ModelRequest,
    context: WorkflowModelResolutionContext,
  ): Promise<ResolvedWorkflowModel>;
  runHostedFusion(
    request: HostedOpenRouterFusionRequest,
    transport?: KadyHostedFusionTransportOptions,
  ): Promise<HostedOpenRouterFusionResult>;
  assertChildRuntimeReady(paths: ProjectPaths): void;
  readCompactionAudit(sandboxRoot: string, childRunId: string): TrustedDagFusionCompactionAudit;
  now(): number;
}

interface KadyPreResolvedDelegation {
  slot: WorkflowModelCallSlot;
  resolution: ResolvedWorkflowModel;
}

interface KadyDelegationUsageBridge {
  descriptor?: SupervisedWorkflowBudgetDescriptorV1;
  reconcile(settlement: DagFusionDelegationUsageSettlement): Promise<void>;
}

export interface CreateKadyWorkflowNodeExecutorOptions {
  /** Required durable admission hook; reserves spend before every V2 dispatch. */
  reserveUsage: KadyWorkflowUsageReserver;
  /** Required only when a Lean node executes; omission fails visibly. */
  verifyLean?: TrustedLeanVerifier;
  delegationPolicy?: Partial<KadyDelegationPolicy>;
  dependencies?: Partial<KadyNodeExecutorDependencies>;
}

interface EffectiveNodeLimits {
  maxIterations: number;
  maxModelCalls: number;
  maxParallelism: number;
  maxSubagents: number;
  timeoutMs: number;
  maxTokens: number;
  maxCostUsd: number;
  maxRetries: number;
}

interface AnalysisResult {
  answer: string;
  evidence: string[];
  uncertainties: string[];
}

interface ResearchResult extends AnalysisResult {
  goalMet: boolean;
  remainingGaps: string[];
  criteria: Array<{ criterion: string; satisfied: boolean; evidence: string }>;
}

interface CouncilMemberResult {
  position: string;
  rationale: string;
  evidence: string[];
  concerns: string[];
}

interface MinorityReport {
  memberId: string;
  report: string;
}

interface CouncilChairResult {
  decision: string;
  rationale: string;
  consensus: boolean;
  minorityReports: MinorityReport[];
}

interface FusionMemberResult {
  analysis: string;
  evidence: string[];
  disagreements: string[];
}

interface FusionSynthesisResult {
  answer: string;
  rationale: string;
  consensus: boolean;
  minorityReports: MinorityReport[];
}

interface CandidateEvaluationResult {
  winner: number;
  rationale: string;
  scores: number[];
}

interface EvidenceEvaluationResult {
  supported: boolean;
  summary: string;
  sourceIds: string[];
  unsupportedClaims: string[];
}

interface EvidencePolicyEvaluationResult {
  supported: boolean;
  summary: string;
  sourceIds: string[];
  unsupportedClaims: string[];
}

interface LeanSolverResult {
  proofBody: string;
  translationNotes: string[];
}

const ANALYSIS_SCHEMA = objectSchema(
  {
    answer: stringSchema(1, 8_000),
    evidence: stringArraySchema(32, 1_024),
    uncertainties: stringArraySchema(16, 1_024),
  },
  ["answer", "evidence", "uncertainties"],
);

const RESEARCH_SCHEMA = objectSchema(
  {
    answer: stringSchema(1, 8_000),
    evidence: stringArraySchema(32, 1_024),
    uncertainties: stringArraySchema(16, 1_024),
    goalMet: { type: "boolean" },
    remainingGaps: stringArraySchema(32, 1_024),
    criteria: {
      type: "array",
      maxItems: 32,
      items: objectSchema(
        {
          criterion: stringSchema(1, 256),
          satisfied: { type: "boolean" },
          evidence: stringSchema(1, 1_024),
        },
        ["criterion", "satisfied", "evidence"],
      ),
    },
  },
  [
    "answer",
    "evidence",
    "uncertainties",
    "goalMet",
    "remainingGaps",
    "criteria",
  ],
);

const COUNCIL_MEMBER_SCHEMA = objectSchema(
  {
    position: stringSchema(1, 4_000),
    rationale: stringSchema(1, 4_000),
    evidence: stringArraySchema(24, 1_024),
    concerns: stringArraySchema(16, 1_024),
  },
  ["position", "rationale", "evidence", "concerns"],
);

const MINORITY_REPORT_SCHEMA = objectSchema(
  {
    memberId: stringSchema(1, 64),
    report: stringSchema(1, 512),
  },
  ["memberId", "report"],
);

const COUNCIL_CHAIR_SCHEMA = objectSchema(
  {
    decision: stringSchema(1, 6_000),
    rationale: stringSchema(1, 4_000),
    consensus: { type: "boolean" },
    minorityReports: {
      type: "array",
      maxItems: 16,
      items: MINORITY_REPORT_SCHEMA,
    },
  },
  ["decision", "rationale", "consensus", "minorityReports"],
);

const FUSION_MEMBER_SCHEMA = objectSchema(
  {
    analysis: stringSchema(1, 5_000),
    evidence: stringArraySchema(24, 1_024),
    disagreements: stringArraySchema(16, 1_024),
  },
  ["analysis", "evidence", "disagreements"],
);

const FUSION_SYNTHESIS_SCHEMA = objectSchema(
  {
    answer: stringSchema(1, 8_000),
    rationale: stringSchema(1, 4_000),
    consensus: { type: "boolean" },
    minorityReports: {
      type: "array",
      maxItems: 32,
      items: MINORITY_REPORT_SCHEMA,
    },
  },
  ["answer", "rationale", "consensus", "minorityReports"],
);

const CANDIDATE_EVALUATION_SCHEMA = objectSchema(
  {
    winner: { type: "integer", minimum: 1, maximum: 16 },
    rationale: stringSchema(1, 4_000),
    scores: {
      type: "array",
      minItems: 2,
      maxItems: 16,
      items: { type: "number", minimum: 0, maximum: 100 },
    },
  },
  ["winner", "rationale", "scores"],
);

const EVIDENCE_EVALUATION_SCHEMA = objectSchema(
  {
    supported: { type: "boolean" },
    summary: stringSchema(1, 4_000),
    sourceIds: {
      type: "array",
      maxItems: MAX_WORKFLOW_EVIDENCE_SOURCES,
      items: { type: "string", pattern: "^source-[0-9]{3}$" },
    },
    unsupportedClaims: stringArraySchema(32, 1_024),
  },
  ["supported", "summary", "sourceIds", "unsupportedClaims"],
);

const EVIDENCE_POLICY_EVALUATION_SCHEMA = objectSchema(
  {
    supported: { type: "boolean" },
    summary: stringSchema(1, 4_000),
    sourceIds: {
      type: "array",
      maxItems: MAX_WORKFLOW_EVIDENCE_SOURCES,
      items: { type: "string", pattern: "^source-[0-9]{3}$" },
    },
    unsupportedClaims: stringArraySchema(32, 1_024),
  },
  ["supported", "summary", "sourceIds", "unsupportedClaims"],
);

const LEAN_SOLVER_SCHEMA = objectSchema(
  {
    proofBody: stringSchema(1, 32_768),
    translationNotes: stringArraySchema(32, 1_024),
  },
  ["proofBody", "translationNotes"],
);

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringSchema(minLength: number, maxLength: number): Record<string, unknown> {
  return { type: "string", minLength, maxLength };
}

function stringArraySchema(maxItems: number, maxLength: number): Record<string, unknown> {
  return {
    type: "array",
    maxItems,
    items: stringSchema(1, maxLength),
  };
}

function fail(
  code: KadyWorkflowNodeErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new KadyWorkflowNodeError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause },
  );
}

function defaultLoadManifest(context: WorkflowNodeExecutorContext): ManifestIdentity {
  const run = workflowStore.readRun(context.projectId, context.runId);
  if (!run) {
    return fail(
      "WORKFLOW_NODE_INVALID_CONTEXT",
      `Workflow run ${context.runId} is unavailable while resolving node models.`,
    );
  }
  return run.manifest;
}

function dependenciesWithDefaults(
  overrides: Partial<KadyNodeExecutorDependencies> | undefined,
): KadyNodeExecutorDependencies {
  return {
    pathsForProject: resolvePaths,
    loadManifest: defaultLoadManifest,
    getDelegationSession: getOrCreateWorkflowDelegationSession,
    resolveModel: resolveWorkflowModel,
    // The embedded runner has its own dependency-injection second argument;
    // never let trusted transport metadata reach that testing seam.
    runHostedFusion: (request) => runHostedOpenRouterFusion(request),
    assertChildRuntimeReady: assertDagFusionPackageSeeded,
    readCompactionAudit: readTrustedDagFusionCompactionAudit,
    now: Date.now,
    ...overrides,
  };
}

function delegationPolicyWithDefaults(
  overrides: Partial<KadyDelegationPolicy> | undefined,
): KadyDelegationPolicy {
  const policy: KadyDelegationPolicy = {
    maxTurns: 12,
    graceTurns: 0,
    toolSoftLimit: 24,
    toolHardLimit: 32,
    ...overrides,
  };
  if (
    !Number.isSafeInteger(policy.maxTurns) || policy.maxTurns < 1 ||
    !Number.isSafeInteger(policy.graceTurns) || policy.graceTurns < 0 ||
    !Number.isSafeInteger(policy.toolSoftLimit) || policy.toolSoftLimit < 1 ||
    !Number.isSafeInteger(policy.toolHardLimit) || policy.toolHardLimit < 1 ||
    policy.toolSoftLimit > policy.toolHardLimit
  ) {
    fail(
      "WORKFLOW_DELEGATION_LIMIT_INVALID",
      "Kady workflow delegation turn/tool budgets must be positive bounded integers, with soft tools no greater than hard tools.",
    );
  }
  return policy;
}

function effectiveNodeLimits(context: WorkflowNodeExecutorContext): EffectiveNodeLimits {
  const graph = context.graph.limits;
  const node = context.node.limits;
  const budget = context.node.settings?.budget;
  return {
    maxIterations: Math.min(graph.maxIterations, node?.maxIterations ?? graph.maxIterations),
    maxModelCalls: Math.min(graph.maxModelCalls, node?.maxModelCalls ?? graph.maxModelCalls),
    maxParallelism: Math.min(graph.maxParallelism, node?.maxParallelism ?? graph.maxParallelism),
    maxSubagents: Math.min(graph.maxSubagents, node?.maxSubagents ?? graph.maxSubagents),
    timeoutMs: Math.min(graph.timeoutMs, node?.timeoutMs ?? graph.timeoutMs),
    maxTokens: Math.min(
      graph.maxTokens,
      node?.maxTokens ?? graph.maxTokens,
      budget?.maxTokens ?? graph.maxTokens,
    ),
    maxCostUsd: Math.min(
      graph.maxCostUsd,
      node?.maxCostUsd ?? graph.maxCostUsd,
      budget?.maxCostUsd ?? graph.maxCostUsd,
    ),
    maxRetries: Math.min(graph.maxRetries, node?.maxRetries ?? graph.maxRetries),
  };
}

function maximumModelCalls(
  context: WorkflowNodeExecutorContext,
  limits: EffectiveNodeLimits,
): number {
  const node = context.node;
  let coreCalls: number;
  switch (node.kind) {
    case "research-until-goal":
      coreCalls = limits.maxIterations;
      break;
    case "council":
      coreCalls = (node.members.length + 1) * node.rounds;
      break;
    case "fusion":
      coreCalls = node.fusion.mode === "openrouter-router"
        ? node.fusion.members.length + 2
        : node.fusion.members.length * node.fusion.rounds + 1;
      break;
    case "best-of-n":
      coreCalls = (node.candidateCount ?? node.candidateModels?.length ?? 2) + 1;
      break;
    case "evidence-gate":
      coreCalls = node.evaluator || node.checks.some((check) => check !== "artifact-exists")
        ? 1
        : 0;
      break;
    case "lean4":
      coreCalls = node.mode === "solve" ? 1 : 0;
      break;
    case "agent":
      coreCalls = 1;
      break;
  }
  return coreCalls + (requiresWorkflowEvidencePolicyEvaluation(context.graph, node) ? 1 : 0);
}

function assertReadOnlyWorkspace(node: WorkflowNode): void {
  if (node.workspace.isolation !== "read-only" || node.workspace.writePaths.length > 0) {
    fail(
      "WORKFLOW_WRITABLE_ISOLATION_UNSUPPORTED",
      `Node ${node.id} requests ${node.workspace.isolation} workspace access, but Kady does not yet have a real writable isolation mechanism for DAG subagents.`,
    );
  }
}

function manifestForContext(
  context: WorkflowNodeExecutorContext,
  manifest: ManifestIdentity,
): ManifestIdentity {
  if (
    manifest.projectId !== context.projectId ||
    manifest.workflowId !== context.workflowId ||
    manifest.workflowRevision !== context.workflowRevision
  ) {
    fail(
      "WORKFLOW_NODE_INVALID_CONTEXT",
      `Node ${context.node.id} does not match the immutable manifest for run ${context.runId}.`,
    );
  }
  return manifest;
}

function createNodeSignal(
  callerSignal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) onAbort();
  else callerSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Workflow node timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onAbort);
    },
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 40);
  return `${prefix}_${digest}`;
}

function boundedJson(value: unknown, maximumBytes: number, label: string): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    return fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      `${label} is not JSON serializable.`,
      false,
      error,
    );
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      `${label} exceeds its ${maximumBytes}-byte JSON bound.`,
    );
  }
  return structuredClone(value);
}

function boundedContext(value: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return "[context unavailable: not JSON serializable]";
  }
  if (Buffer.byteLength(encoded, "utf8") <= MAX_CONTEXT_BYTES) return encoded;
  return `${encoded.slice(0, MAX_CONTEXT_BYTES - 64)}…[bounded by Kady]`;
}

function boundedTask(lines: string[]): string {
  const task = lines.join("\n").trim();
  if (!task) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "A DAG delegation task cannot be empty.");
  }
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      `The compiled DAG delegation task exceeds ${MAX_TASK_BYTES} bytes.`,
    );
  }
  return task;
}

function baseTaskContext(context: WorkflowNodeExecutorContext): string[] {
  const lines = [
    `Workflow: ${context.workflowId} revision ${context.workflowRevision}`,
    `Node: ${context.node.id} (${context.node.name})`,
    `Run goal and variables: ${boundedContext(context.runInput)}`,
    `Verified inbound node records: ${boundedContext(context.inbound)}`,
  ];
  if (context.previousError) {
    lines.push(
      `Verified previous failure: ${boundedContext({
        code: context.previousError.code,
        message: context.previousError.message,
        retryable: context.previousError.retryable,
      })}`,
      `Rescue attempt ${context.attempt}: diagnose and correct this failure without changing the graph or its limits.`,
    );
  }
  lines.push(
    "Work read-only. Base claims only on files you inspect or evidence supplied above. Return exactly the requested structured result.",
  );
  return lines;
}

function compactionFailureCode(
  phase: "pre" | "post",
): Extract<
  KadyWorkflowNodeErrorCode,
  "WORKFLOW_PRE_COMPACTION_CHECK_FAILED" | "WORKFLOW_POST_COMPACTION_CHECK_FAILED"
> {
  return phase === "pre"
    ? "WORKFLOW_PRE_COMPACTION_CHECK_FAILED"
    : "WORKFLOW_POST_COMPACTION_CHECK_FAILED";
}

function failCompactionCheck(
  context: WorkflowNodeExecutorContext,
  phase: "pre" | "post",
  reason: string,
  cause?: unknown,
): never {
  const code = compactionFailureCode(phase);
  const message = `Trusted ${phase}-compaction audit failed (${reason}).`;
  context.recordCompactionCheck({
    phase,
    passed: false,
    error: { code, message, retryable: true },
  });
  return fail(code, message, true, cause);
}

function recordDelegationCompactionAudit(
  context: WorkflowNodeExecutorContext,
  sandboxRoot: string,
  receipt: DagFusionDelegationReceipt,
  reader: KadyNodeExecutorDependencies["readCompactionAudit"],
): void {
  if (receipt.response.status === "invalid_request") return;
  const childRunId = receipt.response.runId;
  if (!childRunId) {
    // A pre-launch rejection has no child session to audit. Once the host saw
    // a child start (and on every completion), lack of its run id is unsafe.
    if (!receipt.progress.started && receipt.response.status !== "completed") return;
    return failCompactionCheck(context, "pre", "CHILD_RUN_ID_MISSING");
  }

  let audit: TrustedDagFusionCompactionAudit;
  try {
    audit = reader(sandboxRoot, childRunId);
  } catch (error) {
    const phase = error instanceof DagFusionCompactionAuditReadError
      ? error.phase
      : "pre";
    const reason = error instanceof DagFusionCompactionAuditReadError
      ? error.code
      : "AUDIT_READER_FAILED";
    return failCompactionCheck(context, phase, reason, error);
  }

  for (const check of audit.checks) {
    if (check.passed) {
      context.recordCompactionCheck({ phase: check.phase, passed: true });
      continue;
    }
    return failCompactionCheck(
      context,
      check.phase,
      check.errorCode ?? "AUDIT_CHECK_FAILED",
    );
  }
}

function recordOf(value: unknown): PlainRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as PlainRecord
    : undefined;
}

function onlyKeys(record: PlainRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function boundedStrings(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems &&
    value.every((item) => boundedString(item, maximumLength));
}

function parseAnalysis(value: unknown): AnalysisResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["answer", "evidence", "uncertainties"]) ||
    !boundedString(record.answer, 8_000) ||
    !boundedStrings(record.evidence, 32, 1_024) ||
    !boundedStrings(record.uncertainties, 16, 1_024)
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Agent returned an invalid analysis result.");
  }
  return record as unknown as AnalysisResult;
}

function parseResearch(value: unknown, criteria: readonly string[]): ResearchResult {
  const record = recordOf(value);
  if (
    !record ||
    !onlyKeys(record, [
      "answer", "evidence", "uncertainties", "goalMet", "remainingGaps", "criteria",
    ]) ||
    !boundedString(record.answer, 8_000) ||
    !boundedStrings(record.evidence, 32, 1_024) ||
    !boundedStrings(record.uncertainties, 16, 1_024) ||
    typeof record.goalMet !== "boolean" ||
    !boundedStrings(record.remainingGaps, 32, 1_024) ||
    !Array.isArray(record.criteria) || record.criteria.length !== criteria.length
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Research agent returned an invalid completion result.");
  }
  for (const [index, valueAtIndex] of record.criteria.entries()) {
    const item = recordOf(valueAtIndex);
    if (
      !item || !onlyKeys(item, ["criterion", "satisfied", "evidence"]) ||
      item.criterion !== criteria[index] || typeof item.satisfied !== "boolean" ||
      !boundedString(item.evidence, 1_024)
    ) {
      fail(
        "WORKFLOW_DELEGATION_INVALID_RESULT",
        "Research agent changed or omitted a declared completion criterion.",
      );
    }
  }
  if (record.goalMet && record.criteria.some((item) => !recordOf(item)?.satisfied)) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "Research agent claimed the goal was met while a completion criterion remained unsatisfied.",
    );
  }
  return record as unknown as ResearchResult;
}

function parseCouncilMember(value: unknown): CouncilMemberResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["position", "rationale", "evidence", "concerns"]) ||
    !boundedString(record.position, 4_000) || !boundedString(record.rationale, 4_000) ||
    !boundedStrings(record.evidence, 24, 1_024) ||
    !boundedStrings(record.concerns, 16, 1_024)
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Council member returned an invalid position.");
  }
  return record as unknown as CouncilMemberResult;
}

function parseMinorityReports(
  value: unknown,
  allowedMembers: ReadonlySet<string>,
  maximumItems: number,
): MinorityReport[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "A minority-report list is invalid.");
  }
  const reports: MinorityReport[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const report = recordOf(raw);
    if (
      !report || !onlyKeys(report, ["memberId", "report"]) ||
      !boundedString(report.memberId, 64) || !allowedMembers.has(report.memberId) ||
      !boundedString(report.report, 512) || seen.has(report.memberId)
    ) {
      fail("WORKFLOW_DELEGATION_INVALID_RESULT", "A minority report has an invalid member identity or body.");
    }
    seen.add(report.memberId);
    reports.push(report as unknown as MinorityReport);
  }
  return reports;
}

function parseCouncilChair(
  value: unknown,
  allowedMembers: ReadonlySet<string>,
  preserveMinority: boolean,
): CouncilChairResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["decision", "rationale", "consensus", "minorityReports"]) ||
    !boundedString(record.decision, 6_000) || !boundedString(record.rationale, 4_000) ||
    typeof record.consensus !== "boolean"
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Council chair returned an invalid decision.");
  }
  const reports = parseMinorityReports(record.minorityReports, allowedMembers, 16);
  if (preserveMinority && !record.consensus && reports.length === 0) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "Council chair reported disagreement without the required minority report.",
    );
  }
  return { ...record, minorityReports: reports } as CouncilChairResult;
}

function parseFusionMember(value: unknown): FusionMemberResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["analysis", "evidence", "disagreements"]) ||
    !boundedString(record.analysis, 5_000) ||
    !boundedStrings(record.evidence, 24, 1_024) ||
    !boundedStrings(record.disagreements, 16, 1_024)
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Fusion member returned an invalid analysis.");
  }
  return record as unknown as FusionMemberResult;
}

function parseFusionSynthesis(
  value: unknown,
  allowedMembers: ReadonlySet<string>,
  preserveMinority: boolean,
): FusionSynthesisResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["answer", "rationale", "consensus", "minorityReports"]) ||
    !boundedString(record.answer, 8_000) || !boundedString(record.rationale, 4_000) ||
    typeof record.consensus !== "boolean"
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Fusion synthesizer returned an invalid result.");
  }
  const reports = parseMinorityReports(record.minorityReports, allowedMembers, 32);
  if (preserveMinority && !record.consensus && reports.length === 0) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "Fusion synthesizer reported disagreement without the required minority report.",
    );
  }
  return { ...record, minorityReports: reports } as FusionSynthesisResult;
}

function parseCandidateEvaluation(value: unknown, count: number): CandidateEvaluationResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["winner", "rationale", "scores"]) ||
    !Number.isSafeInteger(record.winner) || (record.winner as number) < 1 ||
    (record.winner as number) > count || !boundedString(record.rationale, 4_000) ||
    !Array.isArray(record.scores) || record.scores.length !== count ||
    !record.scores.every((score) =>
      typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100
    )
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Best-of-N evaluator returned an invalid winner or score vector.");
  }
  return record as unknown as CandidateEvaluationResult;
}

function parseEvidenceEvaluation(value: unknown): EvidenceEvaluationResult {
  const record = recordOf(value);
  if (
    !record ||
    !onlyKeys(record, ["supported", "summary", "sourceIds", "unsupportedClaims"]) ||
    typeof record.supported !== "boolean" || !boundedString(record.summary, 4_000) ||
    !boundedStrings(record.sourceIds, MAX_WORKFLOW_EVIDENCE_SOURCES, 10) ||
    !(record.sourceIds as string[]).every((sourceId) => /^source-[0-9]{3}$/.test(sourceId)) ||
    !boundedStrings(record.unsupportedClaims, 32, 1_024)
  ) {
    fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Evidence evaluator returned an invalid verdict.");
  }
  return record as unknown as EvidenceEvaluationResult;
}

function parseEvidencePolicyEvaluation(
  value: unknown,
  allowedSourceIds: ReadonlySet<string>,
): EvidencePolicyEvaluationResult {
  const record = recordOf(value);
  if (
    !record ||
    !onlyKeys(record, ["supported", "summary", "sourceIds", "unsupportedClaims"]) ||
    typeof record.supported !== "boolean" || !boundedString(record.summary, 4_000) ||
    !boundedStrings(record.sourceIds, MAX_WORKFLOW_EVIDENCE_SOURCES, 10) ||
    !boundedStrings(record.unsupportedClaims, 32, 1_024)
  ) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "Evidence-policy evaluator returned an invalid bounded verdict.",
    );
  }
  const sourceIds = normalizeWorkflowEvidenceSourceIds(
    record.sourceIds,
    [...allowedSourceIds].map((id) => ({ id, origin: "", text: "" })),
  );
  if (!sourceIds) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "Evidence-policy evaluator cited a source outside the bounded node catalog.",
    );
  }
  return {
    supported: record.supported,
    summary: record.summary,
    sourceIds,
    unsupportedClaims: record.unsupportedClaims,
  } as EvidencePolicyEvaluationResult;
}

function parseLeanSolver(value: unknown): LeanSolverResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, ["proofBody", "translationNotes"]) ||
    !boundedString(record.proofBody, 32_768) ||
    !boundedStrings(record.translationNotes, 32, 1_024)
  ) {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "Lean solver must return only a bounded proof body and translation notes.",
    );
  }
  return record as unknown as LeanSolverResult;
}

function validateTerminalStructured<T>(
  receipt: DagFusionDelegationReceipt,
  parse: (value: unknown) => T,
): T {
  if (receipt.response.status !== "completed") {
    const detail = "error" in receipt.response && typeof receipt.response.error === "string"
      ? `: ${receipt.response.error.slice(0, 1_024)}`
      : "";
    fail(
      "WORKFLOW_DELEGATION_FAILED",
      `Pi subagent delegation ended with ${receipt.response.status}${detail}.`,
      ["failed", "timed_out", "turn_budget_exhausted", "tool_budget_exhausted"].includes(
        receipt.response.status,
      ),
    );
  }
  if (!receipt.resolved || receipt.response.result?.kind !== "structured") {
    fail(
      "WORKFLOW_DELEGATION_INVALID_RESULT",
      "A completed Pi subagent delegation omitted its exact launch receipt or structured result.",
    );
  }
  boundedJson(receipt.response.result.value, MAX_CALL_RESULT_BYTES, "Delegation result");
  return parse(receipt.response.result.value);
}

function assertResolutionIntegrity(
  slot: WorkflowModelCallSlot,
  resolution: ResolvedWorkflowModel,
): void {
  const { model, receipt } = resolution;
  if (
    !isDeepStrictEqual(receipt.request, slot.request) ||
    receipt.resolved.provider !== model.provider ||
    receipt.resolved.model !== model.id
  ) {
    fail(
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
      `Model resolver changed the provider/model identity for slot ${slot.id}.`,
    );
  }
  const supportedThinkingLevels = getSupportedThinkingLevels(model);
  if (!supportedThinkingLevels.includes(receipt.resolved.reasoning)) {
    fail(
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
        `Model resolver claimed unsupported reasoning ${receipt.resolved.reasoning} for ` +
        `slot ${slot.id}; ${model.provider}/${model.id} supports ` +
        `${supportedThinkingLevels.join(", ")}.`,
    );
  }
  const candidates = [slot.request.requested].concat(
    slot.request.resolution.mode === "explicit-fallback"
      ? slot.request.resolution.alternatives
      : [],
  );
  const matchingCandidate = candidates.find((candidate) =>
    candidate.source === "fixed"
      ? candidate.provider === receipt.resolved.provider &&
        candidate.model === receipt.resolved.model &&
        candidate.auth.kind === receipt.resolved.auth.kind &&
        candidate.auth.profile === receipt.resolved.auth.profile &&
        candidate.reasoning === receipt.resolved.reasoning
      : candidate.reasoning === receipt.resolved.reasoning
  );
  if (!matchingCandidate) {
    fail(
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
      `Model resolver silently changed auth ownership or reasoning for slot ${slot.id}.`,
    );
  }
  const shouldBeFallback = matchingCandidate !== candidates[0];
  if (receipt.fallbackUsed !== shouldBeFallback) {
    fail(
      "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
      `Model resolver returned an inconsistent fallback receipt for slot ${slot.id}.`,
    );
  }
}

function slotById(
  context: WorkflowNodeExecutorContext,
  slotId: string,
  declareDynamic = false,
): WorkflowModelCallSlot {
  const slot = declareDynamic
    ? context.declareModelCallSlot(slotId)
    : context.expectedModelCallSlots.find((candidate) => candidate.id === slotId);
  if (!slot) {
    fail(
      "WORKFLOW_MODEL_SLOT_MISSING",
      `Node ${context.node.id} has no declared model-call slot ${slotId}.`,
    );
  }
  return slot;
}

function verifyEvidenceGateArtifacts(
  node: Extract<WorkflowNode, { kind: "evidence-gate" }>,
  declaredArtifacts: WorkflowNodeExecutorContext["graph"]["artifacts"],
  inbound: readonly WorkflowNodeInboundResult[],
  paths: ProjectPaths,
): {
  artifacts: WorkflowGateArtifactReceipt[];
  checks: Array<{
    artifactId: string;
    writerNodeId?: string;
    path?: string;
    exists: boolean;
    reason?: string;
  }>;
} {
  const definitions = new Map((declaredArtifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const artifacts: WorkflowGateArtifactReceipt[] = [];
  const checks: Array<{
    artifactId: string;
    writerNodeId?: string;
    path?: string;
    exists: boolean;
    reason?: string;
  }> = [];

  for (const artifactId of node.artifactIds) {
    const definition = definitions.get(artifactId);
    if (!definition || !definition.path) {
      checks.push({
        artifactId,
        ...(definition ? { writerNodeId: definition.writerNodeId } : {}),
        exists: false,
        reason: definition
          ? "The artifact declaration has no exact file path."
          : "The artifact declaration is unavailable.",
      });
      continue;
    }

    const exactCandidates = inbound.flatMap((entry) =>
      entry.fromNodeId === definition.writerNodeId
        ? entry.artifacts.filter((artifact) => artifact.path === definition.path)
        : []
    );
    let verifiedReceipt: WorkflowGateArtifactReceipt | undefined;
    for (const candidate of exactCandidates) {
      if (!candidate.sha256) continue;
      try {
        const verified = verifyWorkflowArtifactReceipt(paths, candidate);
        if (!verified.sha256) continue;
        verifiedReceipt = {
          artifactId,
          writerNodeId: definition.writerNodeId,
          ...verified,
          sha256: verified.sha256,
        };
        break;
      } catch {
        // A stale, replaced, linked, or otherwise mismatched receipt is not evidence.
      }
    }
    if (verifiedReceipt) {
      artifacts.push(verifiedReceipt);
      checks.push({
        artifactId,
        writerNodeId: definition.writerNodeId,
        path: definition.path,
        exists: true,
      });
    } else {
      checks.push({
        artifactId,
        writerNodeId: definition.writerNodeId,
        path: definition.path,
        exists: false,
        reason: "No current inbound receipt from the declared writer matched this exact file.",
      });
    }
  }
  return { artifacts, checks };
}

function compactMinorityReports(reports: MinorityReport[]): MinorityReport[] {
  const merged = new Map<string, string>();
  for (const report of reports) {
    if (!merged.has(report.memberId)) merged.set(report.memberId, report.report.slice(0, 256));
  }
  return [...merged.entries()].slice(0, 32).map(([memberId, report]) => ({
    memberId,
    report,
  }));
}

function compactText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function parseTrustedLeanVerification(value: unknown): TrustedLeanVerificationResult {
  const record = recordOf(value);
  if (
    !record ||
    !["verified", "failed", "unavailable"].includes(String(record.status)) ||
    !boundedString(record.summary, 8_000) ||
    (record.theoremName !== undefined && !boundedString(record.theoremName, 256)) ||
    (record.normalizedStatement !== undefined &&
      !boundedString(record.normalizedStatement, 8_000)) ||
    (record.executionPolicy !== undefined &&
      !["disabled", "unsandboxed-opt-in"].includes(String(record.executionPolicy))) ||
    (record.toolchain !== undefined && !boundedString(record.toolchain, 1_024)) ||
    (record.mathlibRevision !== undefined &&
      !boundedString(record.mathlibRevision, 1_024)) ||
    (record.mathlibTree !== undefined && !/^[a-f0-9]{40,64}$/.test(String(record.mathlibTree))) ||
    (record.assumptions !== undefined && !boundedStrings(record.assumptions, 64, 1_024)) ||
    (record.translationGaps !== undefined &&
      !boundedStrings(record.translationGaps, 64, 1_024)) ||
    (record.artifacts !== undefined &&
      (!Array.isArray(record.artifacts) || record.artifacts.length > 16))
  ) {
    fail(
      "WORKFLOW_LEAN_VERIFICATION_FAILED",
      "The trusted Lean verifier returned a malformed or unbounded receipt.",
    );
  }
  return record as unknown as TrustedLeanVerificationResult;
}

function parseTrustedLeanPreflight(value: unknown): TrustedLeanPreflightResult {
  const record = recordOf(value);
  if (
    !record || !onlyKeys(record, [
      "status",
      "summary",
      "executionPolicy",
      "mathlibRevision",
      "mathlibTree",
    ]) ||
    !["ready", "unavailable"].includes(String(record.status)) ||
    !boundedString(record.summary, 8_000) ||
    !["disabled", "unsandboxed-opt-in"].includes(String(record.executionPolicy)) ||
    (record.mathlibRevision !== undefined &&
      !/^[a-f0-9]{40,64}$/.test(String(record.mathlibRevision))) ||
    (record.mathlibTree !== undefined && !/^[a-f0-9]{40,64}$/.test(String(record.mathlibTree))) ||
    (record.status === "ready" &&
      (record.mathlibRevision === undefined || record.mathlibTree === undefined))
  ) {
    fail(
      "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE",
      "The trusted Lean verifier returned an invalid preflight receipt.",
    );
  }
  return record as unknown as TrustedLeanPreflightResult;
}

function checkedOutput(value: unknown): unknown {
  return boundedJson(value, MAX_NODE_OUTPUT_BYTES, "Workflow node output");
}

function isCompleteHostedFusionUsage(
  value: unknown,
): value is NonNullable<DagFusionDelegationUsageSettlement["usage"]> {
  const usage = recordOf(value);
  if (!usage) return false;
  const integerFields = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.turns,
    usage.toolCalls,
    usage.durationMs,
  ];
  return integerFields.every((field) =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= 0
  ) && typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0;
}

function dynamicUsageFromDelegation(
  usage: NonNullable<DagFusionDelegationUsageSettlement["usage"]>,
): DynamicWorkflowUsage & { cacheRead: number; cacheWrite: number } {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.input + usage.output,
    cost: usage.cost,
  };
}

function dynamicUsageMatchesDelegation(
  dynamicUsage: DynamicWorkflowUsage,
  delegationUsage: NonNullable<DagFusionDelegationUsageSettlement["usage"]>,
): boolean {
  return isDeepStrictEqual(
    dynamicUsage,
    dynamicUsageFromDelegation(delegationUsage),
  );
}

/**
 * Build the production Kady DAG node executor. Ordinary agent nodes compile
 * through the pinned dynamic-workflows kernel; all model work still leaves
 * Kady only through the dedicated Pi session's owned Delegation V2 host.
 */
export function createKadyWorkflowNodeExecutor(
  options: CreateKadyWorkflowNodeExecutorOptions,
): WorkflowNodeExecutor {
  if (!options || typeof options.reserveUsage !== "function") {
    return fail(
      "WORKFLOW_DELEGATION_LIMIT_INVALID",
      "A Kady workflow node executor requires a durable pre-delegation usage reserver.",
    );
  }
  const dependencies = dependenciesWithDefaults(options.dependencies);
  const policy = delegationPolicyWithDefaults(options.delegationPolicy);

  return async (context): Promise<WorkflowNodeExecutorResult> => {
    assertReadOnlyWorkspace(context.node);
    const limits = effectiveNodeLimits(context);
    const callCeiling = maximumModelCalls(context, limits);
    const configuredRounds = context.node.kind === "council"
      ? context.node.rounds
      : context.node.kind === "fusion" && context.node.fusion.mode === "kady-panel"
        ? context.node.fusion.rounds
        : 1;
    if (configuredRounds > limits.maxIterations) {
      fail(
        "WORKFLOW_DELEGATION_LIMIT_INVALID",
        `Node ${context.node.id} requires ${configuredRounds} rounds but its effective iteration limit is ${limits.maxIterations}.`,
      );
    }
    const hostedFusionWithoutPolicyEvaluator =
      context.node.kind === "fusion" &&
      context.node.fusion.mode === "openrouter-router" &&
      !requiresWorkflowEvidencePolicyEvaluation(context.graph, context.node);
    const requiresPiSubagent = callCeiling > 0 && !hostedFusionWithoutPolicyEvaluator;
    if (
      callCeiling > limits.maxModelCalls ||
      (requiresPiSubagent && limits.maxSubagents < 1)
    ) {
      fail(
        "WORKFLOW_DELEGATION_LIMIT_INVALID",
        `Node ${context.node.id} requires ${callCeiling} model calls but its effective model/subagent limits do not admit them.`,
      );
    }
    if (callCeiling > 0 && limits.maxTokens < callCeiling) {
      fail(
        "WORKFLOW_DELEGATION_LIMIT_INVALID",
        `Node ${context.node.id} has fewer token units than its ${callCeiling} bounded model calls.`,
      );
    }
    const perCallMaxTokens = callCeiling > 0
      ? Math.floor(limits.maxTokens / callCeiling)
      : 0;
    const perCallMaxCostUsd = callCeiling > 0
      ? limits.maxCostUsd / callCeiling
      : 0;

    const paths = dependencies.pathsForProject(context.projectId);
    const manifest = manifestForContext(context, await dependencies.loadManifest(context));
    const nodeSignal = createNodeSignal(context.signal, limits.timeoutMs);
    const deadline = dependencies.now() + limits.timeoutMs;
    let sessionPromise: Promise<{ host: DelegationHost }> | undefined;
    if (requiresPiSubagent) {
      sessionPromise = dependencies.getDelegationSession(context.projectId, paths);
      await sessionPromise;
      dependencies.assertChildRuntimeReady(paths);
    }

    const delegate = async <T>(input: {
      slotId: string;
      task: string;
      schema: Record<string, unknown>;
      parse(value: unknown): T;
      declareDynamic?: boolean;
      skill?: "byom-dag-fusion";
      preResolved?: KadyPreResolvedDelegation;
      usageBridge?: KadyDelegationUsageBridge;
      signal?: AbortSignal;
    }): Promise<T> => {
      const delegationSignal = input.signal ?? nodeSignal.signal;
      if (delegationSignal.aborted) {
        fail(
          nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
          nodeSignal.didTimeout()
            ? `Node ${context.node.id} exceeded its ${limits.timeoutMs}ms deadline.`
            : `Node ${context.node.id} was aborted.`,
        );
      }
      const slot = input.preResolved?.slot ??
        slotById(context, input.slotId, input.declareDynamic);
      if (slot.id !== input.slotId) {
        fail(
          "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
          `Pre-resolved model slot ${slot.id} does not match requested slot ${input.slotId}.`,
        );
      }
      const resolution = input.preResolved?.resolution ??
        await dependencies.resolveModel(slot.request, {
          manifest,
          paths,
        });
      assertResolutionIntegrity(slot, resolution);
      if (!input.preResolved) {
        // This durable receipt must precede the provider call. The host then
        // verifies the actual child launch against this exact model/thinking pair.
        context.recordModelResolution(slot.id, resolution.receipt);
      }
      if (delegationSignal.aborted) {
        fail(
          nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
          `Node ${context.node.id} stopped after model resolution and before delegation.`,
        );
      }

      const remainingMs = Math.floor(deadline - dependencies.now());
      if (remainingMs < 1) {
        fail(
          "WORKFLOW_NODE_TIMEOUT",
          `Node ${context.node.id} exceeded its ${limits.timeoutMs}ms deadline before delegation.`,
        );
      }
      const admittedPerCallMaxCostUsd = ["local", "custom"].includes(
          resolution.receipt.resolved.runtime,
        )
        ? 0
        : perCallMaxCostUsd;
      if (
        !["local", "custom"].includes(resolution.receipt.resolved.runtime) &&
        admittedPerCallMaxCostUsd <= 0
      ) {
        fail(
          "WORKFLOW_DELEGATION_LIMIT_INVALID",
          `Paid or subscription-backed slot ${slot.id} has no positive pre-delegation cost envelope.`,
        );
      }
      const request: OwnedDelegationRequest = {
        requestId: stableId("dagcall", context.runId, context.executionId, slot.id),
        ownerRunId: context.runId,
        nodeId: `${context.executionId}:${slot.id}`,
        agent: KADY_WORKFLOW_READ_ONLY_AGENT,
        task: input.task,
        context: "fresh",
        cwd: paths.sandbox,
        model: modelReference(resolution.model),
        thinking: resolution.receipt.resolved.reasoning,
        timeoutMs: remainingMs,
        turnBudget: {
          maxTurns: policy.maxTurns,
          graceTurns: policy.graceTurns,
        },
        toolBudget: {
          soft: policy.toolSoftLimit,
          hard: policy.toolHardLimit,
          block: "*",
        },
        skill: input.skill ?? false,
        artifacts: false,
        result: { kind: "structured", schema: input.schema },
      };
      sessionPromise ??= dependencies.getDelegationSession(context.projectId, paths);
      const host = (await sessionPromise).host as DelegationHost;
      // Re-read the child package/trust contract immediately before budget
      // admission so a settings edit cannot silently disable the audit hooks.
      dependencies.assertChildRuntimeReady(paths);
      const reservation = input.usageBridge
        ? undefined
        : await options.reserveUsage({
            projectId: context.projectId,
            runId: context.runId,
            workflowId: context.workflowId,
            nodeId: context.node.id,
            executionId: context.executionId,
            attempt: context.attempt,
            slotId: slot.id,
            modelReceipt: structuredClone(resolution.receipt),
            maxTokens: perCallMaxTokens,
            maxCostUsd: admittedPerCallMaxCostUsd,
            modelCallCount: 1,
            runMaxTokens: context.graph.limits.maxTokens,
            runMaxCostUsd: context.graph.limits.maxCostUsd,
            runMaxModelCalls: context.graph.limits.maxModelCalls,
            timeoutMs: remainingMs,
          });
      if (
        !input.usageBridge &&
        (!reservation || typeof reservation.reconcile !== "function")
      ) {
        fail(
          "WORKFLOW_DELEGATION_LIMIT_INVALID",
          `Usage admission for slot ${slot.id} returned no reconciliable reservation.`,
        );
      }
      const reconcileUsage = input.usageBridge
        ? (settlement: DagFusionDelegationUsageSettlement) =>
            input.usageBridge!.reconcile(settlement)
        : (settlement: DagFusionDelegationUsageSettlement) =>
            reservation!.reconcile(settlement);
      let reconciliationStarted = false;
      const supervisedBudget = input.usageBridge?.descriptor ?? reservation?.descriptor;
      const delegateOptions: KadySupervisedDelegateOptions = {
        limits: {
          maxTokens: perCallMaxTokens,
          maxCostUsd: admittedPerCallMaxCostUsd,
        },
        signal: delegationSignal,
        ...(supervisedBudget === undefined
          ? {}
          : { supervisedBudget: structuredClone(supervisedBudget) }),
        reconcileUsage: (settlement) => {
          reconciliationStarted = true;
          return reconcileUsage(settlement);
        },
      };
      try {
        const receipt = await host.delegate(request, delegateOptions);
        if (!reconciliationStarted) {
          reconciliationStarted = true;
          try {
            await reconcileUsage({
              identity: receipt.identity,
              reason: "terminal-response",
              responseStatus: receipt.response.status,
              ...(receipt.response.status !== "invalid_request" && receipt.response.usage
                ? { usage: receipt.response.usage }
                : {}),
              progress: receipt.progress,
            });
          } catch (reconciliationError) {
            fail(
              "WORKFLOW_USAGE_RECONCILIATION_FAILED",
              `The terminal hold for slot ${slot.id} could not be reconciled.`,
              false,
              reconciliationError,
            );
          }
        }
        recordDelegationCompactionAudit(
          context,
          paths.sandbox,
          receipt,
          dependencies.readCompactionAudit,
        );
        return validateTerminalStructured(receipt, input.parse);
      } catch (error) {
        if (!reconciliationStarted) {
          reconciliationStarted = true;
          try {
            await reconcileUsage({
              identity: {
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
              },
              reason: delegationSignal.aborted ? "caller-aborted" : "protocol-error",
              progress: {
                started: false,
                tokens: 0,
                toolCalls: 0,
                durationMs: 0,
              },
            });
          } catch (reconciliationError) {
            fail(
              "WORKFLOW_USAGE_RECONCILIATION_FAILED",
              `The pre-delegation hold for slot ${slot.id} could not be reconciled.`,
              false,
              reconciliationError,
            );
          }
        }
        if (delegationSignal.aborted) {
          fail(
            nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
            nodeSignal.didTimeout()
              ? `Node ${context.node.id} exceeded its ${limits.timeoutMs}ms deadline.`
              : `Node ${context.node.id} was aborted.`,
            false,
            error,
          );
        }
        throw error;
      }
    };

    const applyCommonEvidencePolicy = async (
      result: WorkflowNodeExecutorResult,
    ): Promise<WorkflowNodeExecutorResult> => {
      if (!requiresWorkflowEvidencePolicyEvaluation(context.graph, context.node)) {
        return result;
      }
      const policy = effectiveWorkflowEvidencePolicy(context.graph, context.node);
      const sourceCatalog = buildWorkflowEvidenceSourceCatalog(result.output, context.inbound);
      const allowedSourceIds = new Set(sourceCatalog.map((entry) => entry.id));
      const evaluation = await delegate({
        slotId: WORKFLOW_EVIDENCE_POLICY_SLOT_ID,
        task: boundedTask([
          ...baseTaskContext(context),
          `Completed node output: ${boundedContext(result.output ?? null)}`,
          `Bounded source catalog: ${boundedContext(sourceCatalog)}`,
          `Minimum independent sources: ${policy.minimumIndependentSources}`,
          `Normalized artifact receipt required: ${String(policy.requireArtifactReferences)}`,
          "Perform a model-assisted support check, not a proof of truth. Treat the completed answer as a claim under review.",
          "Return only sourceIds from the supplied catalog. Do not invent identifiers or count repeated descriptions as independent provenance.",
          "The trusted runner separately checks actual normalized artifact receipts and the source-count threshold.",
        ]),
        schema: EVIDENCE_POLICY_EVALUATION_SCHEMA,
        parse: (value) => parseEvidencePolicyEvaluation(value, allowedSourceIds),
      });
      const trustedDecision = result.evidence;
      const supported = (trustedDecision?.supported ?? true) && evaluation.supported;
      const summary = compactText(
        [trustedDecision?.summary, evaluation.summary]
          .filter((part): part is string => Boolean(part))
          .join(" "),
        2_048,
      );
      return {
        ...result,
        evidence: {
          supported,
          summary,
          sourceIds: evaluation.sourceIds,
        },
      };
    };

    const executeDynamicAgent = async (
      node: Extract<WorkflowNode, { kind: "agent" }>,
    ): Promise<WorkflowNodeExecutorResult> => {
      const slot = slotById(context, "agent");
      const expectedIdentity = {
        requestId: stableId("dagcall", context.runId, context.executionId, slot.id),
        ownerRunId: context.runId,
        nodeId: `${context.executionId}:${slot.id}`,
      };
      let resolvedDelegation: KadyPreResolvedDelegation | undefined;
      let durableModelReceipt: WorkflowModelResolutionReceipt | undefined;
      let budgetReservation: KadyWorkflowUsageReservation | undefined;
      let observedSettlement: DagFusionDelegationUsageSettlement | undefined;
      let reconciliationPromise: Promise<void> | undefined;
      let transportError: unknown;

      const reconcileOnce = (
        settlement: DagFusionDelegationUsageSettlement,
      ): Promise<void> => {
        if (!isDeepStrictEqual(settlement.identity, expectedIdentity)) {
          fail(
            "WORKFLOW_USAGE_RECONCILIATION_FAILED",
            "Dynamic agent usage did not match its durable Kady reservation owner.",
          );
        }
        if (reconciliationPromise) {
          if (!isDeepStrictEqual(observedSettlement, settlement)) {
            fail(
              "WORKFLOW_USAGE_RECONCILIATION_FAILED",
              "Dynamic agent usage was reconciled more than once with different evidence.",
            );
          }
          return reconciliationPromise;
        }
        if (!budgetReservation) {
          fail(
            "WORKFLOW_USAGE_RECONCILIATION_FAILED",
            "Dynamic agent usage arrived before Kady admitted its budget.",
          );
        }
        observedSettlement = structuredClone(settlement);
        reconciliationPromise = (async () => {
          await budgetReservation!.reconcile(settlement);
        })();
        return reconciliationPromise;
      };

      const reserveDynamicBudget = async (request: {
        runId: string;
        maxTokens: number;
        maxCostUsd: number;
        initialUsage?: DynamicWorkflowUsage;
      }) => {
        if (budgetReservation) {
          fail(
            "WORKFLOW_DELEGATION_LIMIT_INVALID",
            "The dynamic kernel attempted to admit the same agent node more than once.",
          );
        }
        if (
          request.runId !== `kernel_${context.executionId}` ||
          request.maxTokens !== perCallMaxTokens ||
          request.maxCostUsd !== perCallMaxCostUsd ||
          request.initialUsage !== undefined
        ) {
          fail(
            "WORKFLOW_DELEGATION_LIMIT_INVALID",
            "The dynamic kernel changed Kady's run identity or effective node budget.",
          );
        }
        if (!durableModelReceipt) {
          fail(
            "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
            "The dynamic agent budget was requested before its durable model receipt.",
          );
        }
        const isLocal = ["local", "custom"].includes(
          durableModelReceipt.resolved.runtime,
        );
        const admittedCostUsd = isLocal ? 0 : request.maxCostUsd;
        if (!isLocal && admittedCostUsd <= 0) {
          fail(
            "WORKFLOW_DELEGATION_LIMIT_INVALID",
            `Paid or subscription-backed slot ${slot.id} has no positive pre-delegation cost envelope.`,
          );
        }
        const remainingMs = Math.floor(deadline - dependencies.now());
        if (remainingMs < 1 || nodeSignal.signal.aborted) {
          fail(
            nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
            `Node ${node.id} stopped before dynamic-workflow budget admission.`,
          );
        }
        budgetReservation = await options.reserveUsage({
          projectId: context.projectId,
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId: node.id,
          executionId: context.executionId,
          attempt: context.attempt,
          slotId: slot.id,
          modelReceipt: structuredClone(durableModelReceipt),
          maxTokens: request.maxTokens,
          maxCostUsd: admittedCostUsd,
          modelCallCount: 1,
          runMaxTokens: context.graph.limits.maxTokens,
          runMaxCostUsd: context.graph.limits.maxCostUsd,
          runMaxModelCalls: context.graph.limits.maxModelCalls,
          timeoutMs: remainingMs,
        });
        if (!budgetReservation || typeof budgetReservation.reconcile !== "function") {
          fail(
            "WORKFLOW_DELEGATION_LIMIT_INVALID",
            `Usage admission for slot ${slot.id} returned no reconciliable reservation.`,
          );
        }

        return {
          settle: async (settlement: DynamicWorkflowBudgetSettlement) => {
            const missingHostSettlement = !reconciliationPromise;
            if (missingHostSettlement) {
              await reconcileOnce({
                identity: expectedIdentity,
                reason: settlement.status === "aborted"
                  ? "caller-aborted"
                  : settlement.status === "timed-out"
                    ? "host-timeout"
                    : "protocol-error",
                progress: {
                  started: false,
                  tokens: settlement.usage?.total ?? 0,
                  toolCalls: 0,
                  durationMs: 0,
                },
              });
            } else {
              await reconciliationPromise;
            }

            if (missingHostSettlement && settlement.status === "completed") {
              fail(
                "WORKFLOW_USAGE_RECONCILIATION_FAILED",
                "The dynamic kernel completed without a Delegation V2 usage settlement.",
              );
            }
            if (
              settlement.usage &&
              observedSettlement?.usage &&
              !dynamicUsageMatchesDelegation(
                settlement.usage,
                observedSettlement.usage,
              )
            ) {
              fail(
                "WORKFLOW_USAGE_RECONCILIATION_FAILED",
                "The dynamic kernel's cumulative usage differs from the Delegation V2 receipt.",
              );
            }
            if (
              settlement.status === "completed" &&
              (
                observedSettlement?.reason !== "terminal-response" ||
                observedSettlement.responseStatus !== "completed" ||
                observedSettlement.usage === undefined
              )
            ) {
              fail(
                "WORKFLOW_USAGE_RECONCILIATION_FAILED",
                "The dynamic kernel completed without an auditable completed provider receipt.",
              );
            }
          },
        };
      };

      try {
        const dynamicCallLimits = {
          ...context.graph.limits,
          maxIterations: 1,
          maxModelCalls: 1,
          maxParallelism: 1,
          maxSubagents: 1,
          maxTokens: perCallMaxTokens,
          maxCostUsd: perCallMaxCostUsd,
          maxRetries: 0,
        };
        const dynamicNode = {
          ...node,
          model: structuredClone(slot.request),
          limits: { ...dynamicCallLimits },
        };
        const dynamicResult = await executeAgentNode({
          graph: {
            id: context.graph.id,
            defaultModel: context.graph.defaultModel,
            limits: dynamicCallLimits,
          },
          node: dynamicNode,
          projectCwd: paths.sandbox,
          runCwd: paths.sandbox,
          runId: context.runId,
          executionId: context.executionId,
          attempt: context.attempt,
          parentExecutionId: context.parentExecutionId,
          branchId: context.branchId,
          signal: nodeSignal.signal,
          resolveModel: async (request) => {
            if (!isDeepStrictEqual(request, slot.request)) {
              fail(
                "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
                "The dynamic agent compiler changed Kady's declared model request.",
              );
            }
            const resolution = await dependencies.resolveModel(slot.request, {
              manifest,
              paths,
            });
            assertResolutionIntegrity(slot, resolution);
            resolvedDelegation = { slot, resolution };
            return structuredClone(resolution.receipt.resolved);
          },
          createAgent: ({ modelReceipt }) => {
            if (
              !resolvedDelegation ||
              !isDeepStrictEqual(resolvedDelegation.resolution.receipt, modelReceipt)
            ) {
              fail(
                "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
                "The dynamic agent compiler changed Kady's exact model/auth/reasoning receipt.",
              );
            }
            // Persist the Kady-owned receipt before the kernel reserves spend
            // or the injected Delegation V2 transport can reach a provider.
            context.recordModelResolution(slot.id, modelReceipt);
            durableModelReceipt = structuredClone(modelReceipt);

            return {
              async run(prompt, runOptions) {
                if (prompt !== node.prompt) {
                  fail(
                    "WORKFLOW_NODE_INVALID_CONTEXT",
                    "The dynamic kernel changed the compiled agent prompt.",
                  );
                }
                let usageReported = false;
                const usageBridge: KadyDelegationUsageBridge = {
                  ...(budgetReservation?.descriptor === undefined
                    ? {}
                    : {
                        descriptor: structuredClone(
                          budgetReservation.descriptor,
                        ),
                      }),
                  reconcile: async (settlement) => {
                    if (settlement.usage && !usageReported) {
                      runOptions?.onUsage?.(
                        dynamicUsageFromDelegation(settlement.usage),
                      );
                      usageReported = true;
                    }
                    await reconcileOnce(settlement);
                  },
                };
                try {
                  const result = await delegate({
                    slotId: slot.id,
                    task: boundedTask([
                      ...baseTaskContext(context),
                      `Task: ${prompt}`,
                      "Return answer, traceable evidence, and explicit uncertainties.",
                    ]),
                    schema: ANALYSIS_SCHEMA,
                    parse: parseAnalysis,
                    preResolved: resolvedDelegation,
                    usageBridge,
                    signal: runOptions?.signal,
                  });
                  runOptions?.onModelResolved?.(String(runOptions.model));
                  return result;
                } catch (error) {
                  transportError = error;
                  throw error;
                }
              },
            };
          },
          reserveBudget: reserveDynamicBudget,
        });
        return {
          output: checkedOutput({
            kind: "agent",
            runtime: "pi-dynamic-workflows",
            kernelRunId: dynamicResult.kernelRunId,
            ...parseAnalysis(dynamicResult.output),
          }),
        };
      } catch (error) {
        if (nodeSignal.signal.aborted) {
          fail(
            nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
            nodeSignal.didTimeout()
              ? `Node ${node.id} exceeded its ${limits.timeoutMs}ms deadline.`
              : `Node ${node.id} was aborted.`,
            false,
            transportError ?? error,
          );
        }
        if (transportError !== undefined) throw transportError;
        throw error;
      }
    };

    const executeHostedFusion = async (
      node: HostedOpenRouterFusionNode,
    ): Promise<WorkflowNodeExecutorResult> => {
      const resolveHostedSlot = async (
        slotId: string,
      ): Promise<WorkflowModelResolutionReceipt> => {
        if (nodeSignal.signal.aborted) {
          fail(
            nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
            `Hosted Fusion node ${node.id} stopped before resolving slot ${slotId}.`,
          );
        }
        const slot = slotById(context, slotId);
        const resolution = await dependencies.resolveModel(slot.request, {
          manifest,
          paths,
        });
        assertResolutionIntegrity(slot, resolution);
        const hostedReceipt: WorkflowModelResolutionReceipt = {
          ...structuredClone(resolution.receipt),
          resolved: {
            ...structuredClone(resolution.receipt.resolved),
            runtime: "openrouter-fusion",
          },
        };
        // All panel and both billed judge identities are durable before the
        // single opaque router call can leave this process.
        context.recordModelResolution(slot.id, hostedReceipt);
        return hostedReceipt;
      };

      const resolvedMembers: HostedFusionResolvedModels["members"] = [];
      for (const member of node.fusion.members) {
        resolvedMembers.push({
          memberId: member.id,
          role: member.role,
          receipt: await resolveHostedSlot(`fusion-panel-${member.id}`),
        });
      }
      const resolved: HostedFusionResolvedModels = {
        members: resolvedMembers,
        judgeDeliberation: await resolveHostedSlot("fusion-judge-deliberation"),
        judgeFinal: await resolveHostedSlot("fusion-judge-final"),
      };

      // Recheck exact router, shared reasoning, and every immutable receipt at
      // the runtime boundary before reserving spend or creating a Pi session.
      buildHostedFusionConfig(node.fusion, resolved);
      const routerRequested = node.fusion.router.requested;
      if (routerRequested.source !== "fixed") {
        fail(
          "WORKFLOW_MODEL_RESOLUTION_MISMATCH",
          "Hosted Fusion router was not a fixed OpenRouter model after runtime validation.",
        );
      }
      const routerReceipt: WorkflowModelResolutionReceipt = {
        request: structuredClone(node.fusion.router),
        resolved: {
          provider: routerRequested.provider,
          model: routerRequested.model,
          auth: { kind: routerRequested.auth.kind },
          reasoning: routerRequested.reasoning,
          runtime: "openrouter-fusion",
        },
        fallbackUsed: false,
      };

      const remainingMs = Math.floor(deadline - dependencies.now());
      if (remainingMs < 1 || nodeSignal.signal.aborted) {
        fail(
          nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
          `Hosted Fusion node ${node.id} stopped after resolution and before budget admission.`,
        );
      }
      if (limits.maxCostUsd <= 0) {
        fail(
          "WORKFLOW_DELEGATION_LIMIT_INVALID",
          `Hosted Fusion node ${node.id} has no positive compound cost envelope.`,
        );
      }

      const compoundSlotId = "fusion-hosted-compound";
      const compoundModelCallCount = node.fusion.members.length + 2;
      const compoundMaxTokens = perCallMaxTokens * compoundModelCallCount;
      const compoundMaxCostUsd = perCallMaxCostUsd * compoundModelCallCount;
      const identity = {
        requestId: stableId("dagfusion", context.runId, context.executionId),
        ownerRunId: context.runId,
        nodeId: `${context.executionId}:${compoundSlotId}`,
      };
      const reservation = await options.reserveUsage({
        projectId: context.projectId,
        runId: context.runId,
        workflowId: context.workflowId,
        nodeId: node.id,
        executionId: context.executionId,
        attempt: context.attempt,
        slotId: compoundSlotId,
        modelReceipt: routerReceipt,
        maxTokens: compoundMaxTokens,
        maxCostUsd: compoundMaxCostUsd,
        modelCallCount: compoundModelCallCount,
        runMaxTokens: context.graph.limits.maxTokens,
        runMaxCostUsd: context.graph.limits.maxCostUsd,
        runMaxModelCalls: context.graph.limits.maxModelCalls,
        timeoutMs: remainingMs,
      });
      if (!reservation || typeof reservation.reconcile !== "function") {
        fail(
          "WORKFLOW_DELEGATION_LIMIT_INVALID",
          "Hosted Fusion usage admission returned no reconciliable compound reservation.",
        );
      }

      let reconciliationStarted = false;
      const reconcile = async (
        settlement: DagFusionDelegationUsageSettlement,
      ): Promise<void> => {
        reconciliationStarted = true;
        await reservation.reconcile(settlement);
      };
      const reconcileMissing = async (reason: "caller-aborted" | "protocol-error") => {
        reconciliationStarted = true;
        try {
          await reservation.reconcile({
            identity,
            reason,
            progress: {
              started: false,
              tokens: 0,
              toolCalls: 0,
              durationMs: 0,
            },
          });
        } catch (reconciliationError) {
          fail(
            "WORKFLOW_USAGE_RECONCILIATION_FAILED",
            "Hosted Fusion's compound reservation could not be reconciled.",
            false,
            reconciliationError,
          );
        }
      };

      try {
        const result = await dependencies.runHostedFusion(
          {
            projectId: context.projectId,
            paths,
            identity,
            fusion: node.fusion,
            resolved,
            task: boundedTask([
              ...baseTaskContext(context),
              `Hosted Fusion goal: ${node.goal}`,
              `Panel roles: ${boundedContext(node.fusion.members.map((member) => ({
                memberId: member.id,
                role: member.role,
              })))}`,
              "Return the strongest fused answer. Preserve material disagreement in prose when the hosted panel exposes it.",
            ]),
            maxTokens: compoundMaxTokens,
            maxCostUsd: compoundMaxCostUsd,
            timeoutMs: remainingMs,
            signal: nodeSignal.signal,
            reconcileUsage: reconcile,
          },
          reservation.descriptor === undefined
            ? undefined
            : {
                supervisedBudget: structuredClone(reservation.descriptor),
              },
        );
        if (
          !result || typeof result.text !== "string" || result.text.trim().length === 0 ||
          typeof result.textTruncated !== "boolean" ||
          !isCompleteHostedFusionUsage(result.usage)
        ) {
          if (!reconciliationStarted) await reconcileMissing("protocol-error");
          fail(
            "WORKFLOW_DELEGATION_INVALID_RESULT",
            "Hosted Fusion returned no bounded answer or complete usage receipt.",
          );
        }
        if (!reconciliationStarted) {
          reconciliationStarted = true;
          try {
            await reservation.reconcile({
              identity,
              reason: "terminal-response",
              responseStatus: "completed",
              usage: result.usage,
              progress: {
                started: true,
                model: "openrouter/openrouter/fusion",
                tokens: result.usage.input + result.usage.output,
                toolCalls: result.usage.toolCalls,
                durationMs: result.usage.durationMs,
              },
            });
          } catch (reconciliationError) {
            fail(
              "WORKFLOW_USAGE_RECONCILIATION_FAILED",
              "Hosted Fusion's terminal compound usage could not be reconciled.",
              false,
              reconciliationError,
            );
          }
        }

        return {
          output: checkedOutput({
            kind: "openrouter-hosted-fusion",
            runtime: "openrouter-fusion",
            answer: result.text,
            answerTruncated: result.textTruncated,
            router: {
              provider: routerReceipt.resolved.provider,
              model: routerReceipt.resolved.model,
              auth: routerReceipt.resolved.auth.kind,
              reasoning: routerReceipt.resolved.reasoning,
            },
            panel: resolved.members.map((member) => ({
              memberId: member.memberId,
              role: compactText(member.role, 128),
              provider: member.receipt.resolved.provider,
              model: member.receipt.resolved.model,
              reasoning: member.receipt.resolved.reasoning,
            })),
            judge: {
              provider: resolved.judgeFinal.resolved.provider,
              model: resolved.judgeFinal.resolved.model,
              reasoning: resolved.judgeFinal.resolved.reasoning,
              billedCalls: 2,
            },
            usage: result.usage,
            minorityReportsRequested: node.preserveMinorityReports,
            minorityStructureVerified: false,
            limitation:
              "The hosted router returns an opaque fused answer; Kady records every requested participant but cannot mechanically verify its internal minority-report structure.",
          }),
        };
      } catch (error) {
        if (!reconciliationStarted) {
          await reconcileMissing(nodeSignal.signal.aborted ? "caller-aborted" : "protocol-error");
        }
        if (nodeSignal.signal.aborted) {
          fail(
            nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
            nodeSignal.didTimeout()
              ? `Hosted Fusion node ${node.id} exceeded its ${limits.timeoutMs}ms deadline.`
              : `Hosted Fusion node ${node.id} was aborted.`,
            false,
            error,
          );
        }
        throw error;
      }
    };

    try {
      const node = context.node;
      if (node.kind === "agent") {
        // Ordinary model work exercises the pinned dynamic-workflows kernel.
        // Kady still owns graph state, receipts, and the one durable budget
        // reservation; the injected agent is only a bounded Delegation V2 leaf.
        return await applyCommonEvidencePolicy(await executeDynamicAgent(node));
      }

      if (node.kind === "research-until-goal") {
        let last: ResearchResult | undefined;
        for (let iteration = 1; iteration <= limits.maxIterations; iteration += 1) {
          const slotId = `research-iteration-${iteration}`;
          last = await delegate({
            slotId,
            declareDynamic: iteration > 1,
            task: boundedTask([
              ...baseTaskContext(context),
              `Research goal: ${node.goal}`,
              `Completion criteria in exact order: ${boundedContext(node.completionCriteria)}`,
              `Iteration: ${iteration} of ${limits.maxIterations}`,
              `Prior iteration: ${boundedContext(last ?? null)}`,
              "Continue inspecting evidence until every criterion is supported. goalMet may be true only when every criterion is satisfied.",
            ]),
            schema: RESEARCH_SCHEMA,
            parse: (value) => parseResearch(value, node.completionCriteria),
          });
          if (last.goalMet) {
            return await applyCommonEvidencePolicy({
              output: checkedOutput({
                kind: "research-until-goal",
                goalMet: true,
                iterations: iteration,
                answer: last.answer,
                evidence: last.evidence,
                uncertainties: last.uncertainties,
                remainingGaps: last.remainingGaps,
                criteria: last.criteria,
              }),
            });
          }
        }
        fail(
          "WORKFLOW_RESEARCH_GOAL_NOT_MET",
          `Research node ${node.id} exhausted ${limits.maxIterations} iterations without meeting every completion criterion.`,
          true,
        );
      }

      if (node.kind === "council") {
        const memberIds = new Set(node.members.map((member) => member.id));
        const minorityReports: MinorityReport[] = [];
        const roundDecisions: string[] = [];
        let latestPositions: Array<{
          memberId: string;
          role: string;
          position: string;
          evidence: string[];
        }> = [];
        let previousChair: CouncilChairResult | undefined;
        for (let round = 1; round <= node.rounds; round += 1) {
          const positions: Array<{ memberId: string; role: string; result: CouncilMemberResult }> = [];
          for (const member of node.members) {
            const result = await delegate({
              slotId: `council-round-${round}-member-${member.id}`,
              task: boundedTask([
                ...baseTaskContext(context),
                `Council goal: ${node.goal}`,
                `You are council member ${member.id}; assigned role: ${member.role}.`,
                `Round: ${round} of ${node.rounds}`,
                `Prior chair decision: ${boundedContext(previousChair ?? null)}`,
                "Give an independent position before seeing this round's other members. Do not erase disagreement.",
              ]),
              schema: COUNCIL_MEMBER_SCHEMA,
              parse: parseCouncilMember,
            });
            positions.push({ memberId: member.id, role: member.role, result });
          }
          latestPositions = positions.map((position) => ({
            memberId: position.memberId,
            role: compactText(position.role, 128),
            // Preserve every final-round voice mechanically. Minority reports
            // add the chair's semantic classification without replacing this record.
            position: compactText(position.result.position, 256),
            evidence: position.result.evidence.slice(0, 8).map((item) =>
              compactText(item, 256)
            ),
          }));
          const chair = await delegate({
            slotId: `council-round-${round}-chair`,
            task: boundedTask([
              ...baseTaskContext(context),
              `Council goal: ${node.goal}`,
              `Round: ${round} of ${node.rounds}`,
              `Member positions: ${boundedContext(positions.map((position) => ({
                memberId: position.memberId,
                role: compactText(position.role, 128),
                position: compactText(position.result.position, 1_024),
                rationale: compactText(position.result.rationale, 512),
                evidence: position.result.evidence.slice(0, 8).map((item) =>
                  compactText(item, 256)
                ),
                concerns: position.result.concerns.slice(0, 8).map((item) =>
                  compactText(item, 256)
                ),
              })))}`,
              `Prior chair decision: ${boundedContext(previousChair ?? null)}`,
              node.preserveMinorityReports
                ? "Preserve every materially dissenting view as a member-addressed minority report. Set consensus=false when material disagreement remains."
                : "Report whether consensus exists; minority reports may be empty.",
            ]),
            schema: COUNCIL_CHAIR_SCHEMA,
            parse: (value) => parseCouncilChair(value, memberIds, node.preserveMinorityReports),
          });
          previousChair = chair;
          minorityReports.push(...chair.minorityReports);
          roundDecisions.push(compactText(chair.decision, 128));
        }
        if (!previousChair) {
          fail("WORKFLOW_DELEGATION_INVALID_RESULT", "Council completed without a chair decision.");
        }
        return await applyCommonEvidencePolicy({
          output: checkedOutput({
            kind: "council",
            rounds: node.rounds,
            decision: compactText(previousChair.decision, 2_048),
            rationale: compactText(previousChair.rationale, 2_048),
            consensus: previousChair.consensus,
            minorityReports: node.preserveMinorityReports
              ? compactMinorityReports(minorityReports)
              : [],
            memberPositions: latestPositions,
            roundDecisions,
          }),
        });
      }

      if (node.kind === "fusion") {
        if (node.fusion.mode === "openrouter-router") {
          // Await inside this try so the enclosing finally retains the node's
          // timeout/caller-abort bridge for the full hosted provider request.
          return await applyCommonEvidencePolicy(
            await executeHostedFusion(node as HostedOpenRouterFusionNode),
          );
        }
        const memberIds = new Set(node.fusion.members.map((member) => member.id));
        const history: Array<{
          round: number;
          members: Array<{ memberId: string; role: string; result: FusionMemberResult }>;
        }> = [];
        for (let round = 1; round <= node.fusion.rounds; round += 1) {
          const members: Array<{ memberId: string; role: string; result: FusionMemberResult }> = [];
          for (const member of node.fusion.members) {
            const result = await delegate({
              slotId: `fusion-round-${round}-member-${member.id}`,
              task: boundedTask([
                ...baseTaskContext(context),
                `Fusion goal: ${node.goal}`,
                `You are fusion member ${member.id}; assigned role: ${member.role}.`,
                `Round: ${round} of ${node.fusion.rounds}`,
                `Prior-round panel record: ${boundedContext(
                  (history.at(-1)?.members ?? []).map((prior) => ({
                    memberId: prior.memberId,
                    role: compactText(prior.role, 128),
                    analysis: compactText(prior.result.analysis, 1_024),
                    disagreements: prior.result.disagreements.slice(0, 8).map((item) =>
                      compactText(item, 256)
                    ),
                  })),
                )}`,
                "Produce an independent analysis, cite evidence, and name disagreements rather than averaging them away.",
              ]),
              schema: FUSION_MEMBER_SCHEMA,
              parse: parseFusionMember,
            });
            members.push({ memberId: member.id, role: member.role, result });
          }
          history.push({ round, members });
        }
        const latestMembers = history.at(-1)?.members ?? [];
        const synthesis = await delegate({
          slotId: "fusion-synthesizer",
          task: boundedTask([
            ...baseTaskContext(context),
            `Fusion goal: ${node.goal}`,
            `Final-round panel record: ${boundedContext(latestMembers.map((member) => ({
              memberId: member.memberId,
              role: compactText(member.role, 128),
              analysis: compactText(member.result.analysis, 1_500),
              evidence: member.result.evidence.slice(0, 8).map((item) =>
                compactText(item, 256)
              ),
              disagreements: member.result.disagreements.slice(0, 8).map((item) =>
                compactText(item, 256)
              ),
            })))}`,
            node.preserveMinorityReports
              ? "Synthesize the strongest supported answer while preserving each material dissent as a member-addressed minority report."
              : "Synthesize the strongest supported answer and state whether consensus exists.",
          ]),
          schema: FUSION_SYNTHESIS_SCHEMA,
          parse: (value) => parseFusionSynthesis(value, memberIds, node.preserveMinorityReports),
        });
        return await applyCommonEvidencePolicy({
          output: checkedOutput({
            kind: "kady-panel-fusion",
            rounds: node.fusion.rounds,
            answer: compactText(synthesis.answer, 4_000),
            rationale: compactText(synthesis.rationale, 2_048),
            consensus: synthesis.consensus,
            minorityReports: node.preserveMinorityReports
              ? compactMinorityReports(synthesis.minorityReports)
              : [],
            memberAnalyses: latestMembers.map((member) => ({
              memberId: member.memberId,
              role: compactText(member.role, 128),
              analysis: compactText(member.result.analysis, 256),
              evidence: member.result.evidence.slice(0, 8).map((item) =>
                compactText(item, 256)
              ),
            })),
          }),
        });
      }

      if (node.kind === "best-of-n") {
        const count = node.candidateCount ?? node.candidateModels?.length ?? 2;
        const candidates: AnalysisResult[] = [];
        for (let index = 1; index <= count; index += 1) {
          candidates.push(await delegate({
            slotId: `candidate-${index}`,
            task: boundedTask([
              ...baseTaskContext(context),
              `Goal: ${node.goal}`,
              `Candidate path: ${index} of ${count}`,
              "Develop a genuinely independent way to reach the goal. Return the proposed answer, evidence, and uncertainties.",
            ]),
            schema: ANALYSIS_SCHEMA,
            parse: parseAnalysis,
          }));
        }
        const evaluation = await delegate({
          slotId: "candidate-evaluator",
          task: boundedTask([
            ...baseTaskContext(context),
            `Goal: ${node.goal}`,
            `Candidate answers: ${boundedContext(candidates.map((candidate, index) => ({
              candidate: index + 1,
              answer: compactText(candidate.answer, 3_000),
              evidence: candidate.evidence.slice(0, 8).map((item) =>
                compactText(item, 256)
              ),
              uncertainties: candidate.uncertainties.slice(0, 8).map((item) =>
                compactText(item, 256)
              ),
            })))}`,
            "Score every candidate from 0 to 100 against the goal and evidence. Select exactly one 1-based winner; do not invent another answer.",
          ]),
          schema: CANDIDATE_EVALUATION_SCHEMA,
          parse: (value) => parseCandidateEvaluation(value, count),
        });
        const winner = candidates[evaluation.winner - 1];
        return await applyCommonEvidencePolicy({
          output: checkedOutput({
            kind: "best-of-n",
            candidateCount: count,
            winner: evaluation.winner,
            scores: evaluation.scores,
            rationale: compactText(evaluation.rationale, 2_048),
            answer: compactText(winner.answer, 6_000),
            evidence: winner.evidence,
            uncertainties: winner.uncertainties,
          }),
        });
      }

      if (node.kind === "evidence-gate") {
        const evidencePolicy = effectiveWorkflowEvidencePolicy(context.graph, node);
        // Disabling the common policy removes its source-count and artifact-
        // reference augmentation. The explicitly authored gate checks and its
        // onUnsupportedOutput behavior still run.
        const minimumIndependentSources = evidencePolicy.enabled
          ? evidencePolicy.minimumIndependentSources
          : 0;
        const requireArtifactReferences = evidencePolicy.enabled &&
          evidencePolicy.requireArtifactReferences;
        const sourceCatalog = buildWorkflowEvidenceSourceCatalog(undefined, context.inbound);
        const artifactVerification = verifyEvidenceGateArtifacts(
          node,
          context.graph.artifacts,
          context.inbound,
          paths,
        );
        const allDeclaredArtifactsVerified =
          artifactVerification.artifacts.length === node.artifactIds.length;
        const deterministicSupported =
          (!node.checks.includes("artifact-exists") ||
            (node.artifactIds.length > 0 && allDeclaredArtifactsVerified)) &&
          allDeclaredArtifactsVerified &&
          (!requireArtifactReferences || artifactVerification.artifacts.length > 0);
        const usesModel = node.evaluator !== undefined ||
          node.checks.some((check) => check !== "artifact-exists");
        let evaluation: EvidenceEvaluationResult = {
          supported: deterministicSupported,
          summary: deterministicSupported
            ? "Deterministic artifact requirements passed."
            : "A deterministic artifact requirement failed.",
          sourceIds: [],
          unsupportedClaims: [],
        };
        if (usesModel) {
          evaluation = await delegate({
            slotId: "evidence-evaluator",
            task: boundedTask([
              ...baseTaskContext(context),
              `Checks: ${node.checks.join(", ")}`,
              `Deterministic artifact checks: ${boundedContext(artifactVerification.checks)}`,
              `Minimum independent sources: ${minimumIndependentSources}`,
              `Allowed observed source catalog: ${boundedContext(sourceCatalog)}`,
              "Evaluate only observed support. Cite only sourceIds from the allowed catalog and return false for unverifiable, fabricated, or materially unsupported claims.",
            ]),
            schema: EVIDENCE_EVALUATION_SCHEMA,
            parse: parseEvidenceEvaluation,
          });
        }
        const normalizedSourceIds = normalizeWorkflowEvidenceSourceIds(
          evaluation.sourceIds,
          sourceCatalog,
        );
        const sourceIds = normalizedSourceIds ?? [];
        const supported = deterministicSupported && evaluation.supported &&
          normalizedSourceIds !== null &&
          sourceIds.length >= minimumIndependentSources;
        const summary = supported
          ? evaluation.summary
          : [
              evaluation.summary,
              ...artifactVerification.checks.filter((check) => !check.exists).map((check) =>
                `Artifact ${check.artifactId} lacks a current verified inbound receipt.`
              ),
              ...(normalizedSourceIds === null
                ? ["The evaluator cited identifiers outside the observed source catalog."]
                : []),
              ...(sourceIds.length < minimumIndependentSources
                ? [`Found ${sourceIds.length} catalogued sources; ${minimumIndependentSources} required.`]
                : []),
            ].join(" ");
        const boundedSummary = compactText(summary, 2_048);
        return {
          evidence: {
            supported,
            summary: boundedSummary,
            sourceIds,
            artifacts: artifactVerification.artifacts,
          },
          output: checkedOutput({
            kind: "evidence-gate",
            supported,
            summary: boundedSummary,
            artifactChecks: artifactVerification.checks,
            sourceIds,
            unsupportedClaims: evaluation.unsupportedClaims,
          }),
        };
      }

      if (node.kind === "lean4") {
        if (!options.verifyLean) {
          fail(
            "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE",
            "Lean node execution requires an injected trusted byom-dag-fusion verifier; no model judgment may substitute for it.",
          );
        }
        if (options.verifyLean.preflight) {
          const preflight = parseTrustedLeanPreflight(await Promise.resolve(
            options.verifyLean.preflight({
              projectId: context.projectId,
              runId: context.runId,
              workflowId: context.workflowId,
              nodeId: node.id,
              executionId: context.executionId,
              mathlib: node.mathlib,
              paths,
              signal: nodeSignal.signal,
            }),
          ));
          if (preflight.status !== "ready") {
            fail(
              "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE",
              compactText(preflight.summary, 2_048),
            );
          }
          // Git integrity inspection is deliberately synchronous and bounded.
          // Yield once so a node deadline that elapsed during that inspection
          // is observed before model resolution, reservation, or dispatch.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (nodeSignal.signal.aborted) {
            fail(
              nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
              `Lean preflight for node ${node.id} was interrupted before model dispatch.`,
            );
          }
        }
        let proposal: LeanSolverResult | undefined;
        if (node.mode === "solve") {
          proposal = await delegate({
            slotId: "lean-solver",
            task: boundedTask([
              ...baseTaskContext(context),
              `Mathematical goal: ${node.goal}`,
              `Exact proposition to prove: ${node.theorem}`,
              `Mathlib enabled: ${String(node.mathlib)}`,
              "Return only the Lean tactic or term body that belongs after the host-owned `:= by`; do not return imports, a declaration, theorem name, proposition, or `by` wrapper.",
              "Do not weaken or rewrite the proposition. The trusted host constructs the exact declaration, and the local verifier, not your confidence, decides success.",
            ]),
            schema: LEAN_SOLVER_SCHEMA,
            parse: parseLeanSolver,
            skill: "byom-dag-fusion",
          });
        }
        let verification: TrustedLeanVerificationResult;
        try {
          // The production verifier owns cancellation and settles only after its
          // process group closes. An outer Promise.race here would let a retry
          // overlap a still-running same-user Lean process.
          verification = parseTrustedLeanVerification(await Promise.resolve(
            options.verifyLean({
              projectId: context.projectId,
              runId: context.runId,
              workflowId: context.workflowId,
              nodeId: node.id,
              executionId: context.executionId,
              goal: node.goal,
              mode: node.mode,
              theorem: node.theorem,
              ...(proposal ? { proofBody: proposal.proofBody } : {}),
              mathlib: node.mathlib,
              skill: node.skill,
              paths,
              signal: nodeSignal.signal,
            }),
          ));
        } catch (error) {
          if (error instanceof KadyWorkflowNodeError) throw error;
          if (nodeSignal.signal.aborted) {
            fail(
              nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
              `Lean verification for node ${node.id} was interrupted.`,
              false,
              error,
            );
          }
          fail(
            "WORKFLOW_LEAN_VERIFICATION_FAILED",
            `Trusted Lean verification failed: ${
              error instanceof Error ? error.message.slice(0, 1_024) : "unknown verifier error"
            }`,
            false,
            error,
          );
        }
        if (nodeSignal.signal.aborted) {
          fail(
            nodeSignal.didTimeout() ? "WORKFLOW_NODE_TIMEOUT" : "WORKFLOW_NODE_ABORTED",
            `Lean verification for node ${node.id} was interrupted.`,
          );
        }
        return await applyCommonEvidencePolicy({
          artifacts: verification.artifacts,
          evidence: {
            supported: verification.status === "verified",
            summary: compactText(verification.summary, 2_048),
            sourceIds: [],
          },
          output: checkedOutput({
            kind: "lean4",
            status: verification.status,
            summary: compactText(verification.summary, 2_048),
            ...(verification.theoremName
              ? { theoremName: verification.theoremName }
              : {}),
            ...(verification.normalizedStatement
              ? { normalizedStatement: verification.normalizedStatement }
              : {}),
            ...(verification.executionPolicy
              ? { executionPolicy: verification.executionPolicy }
              : {}),
            ...(verification.toolchain ? { toolchain: verification.toolchain } : {}),
            ...(verification.mathlibRevision
              ? { mathlibRevision: verification.mathlibRevision }
              : {}),
            ...(verification.mathlibTree ? { mathlibTree: verification.mathlibTree } : {}),
            assumptions: verification.assumptions ?? [],
            translationGaps: [
              ...(proposal?.translationNotes ?? []),
              ...(verification.translationGaps ?? []),
            ],
          }),
        });
      }

      return fail(
        "WORKFLOW_NODE_INVALID_CONTEXT",
        `Kady has no executor for workflow node ${(node as { kind?: unknown }).kind as string}.`,
      );
    } finally {
      nodeSignal.dispose();
    }
  };
}
