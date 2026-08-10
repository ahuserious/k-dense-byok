import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolvePaths } from "../projects.ts";
import { isWithin } from "../sandbox-fs.ts";
import type {
  RescuePolicy,
  WorkflowEdge,
  WorkflowGraphDocument,
  WorkflowNode,
} from "./schema.ts";
import {
  workflowModelCallSlotForNode,
  workflowModelCallSlotsForNode,
  type WorkflowArtifactReference,
  type WorkflowDeliberationStaffingReceipt,
  type WorkflowGateArtifactReceipt,
  type WorkflowModelCallSlot,
  type WorkflowModelResolutionReceipt,
  type WorkflowRunErrorInfo,
  type WorkflowRunEventInput,
  type WorkflowRunEventV1,
  type WorkflowRunManifestV1,
} from "./run-state.ts";
import {
  DEFAULT_WORKFLOW_RUN_LEASE_MS,
  MAX_WORKFLOW_RUN_LEASE_MS,
  MIN_WORKFLOW_RUN_LEASE_MS,
  WorkflowStore,
  WorkflowStoreError,
  workflowStore,
  type WorkflowRunLeaseClaim,
  type WorkflowRunRecord,
} from "./store.ts";
import {
  DEFAULT_WORKFLOW_RESCUE_POLICY,
  normalizeWorkflowProjectPath,
  resolveNodeSpecV1,
} from "./validate.ts";
import { assertS4NodeConditions } from "../agent/workflow-delegation-session.ts";
import { promptOptimizationArtifactPath } from "./prompt-opt-artifact-path.ts";
import {
  buildWorkflowEvidenceSourceCatalog,
  effectiveWorkflowEvidencePolicy,
  normalizeWorkflowEvidenceSourceIds,
  requiresWorkflowEvidencePolicyEvaluation,
} from "./evidence-policy.ts";
import {
  isTrustedLeanArtifactPath,
  trustedLeanArtifactPaths,
} from "./lean4-artifacts.ts";

export const MAX_PERSISTED_WORKFLOW_NODE_OUTPUT_BYTES = 16 * 1024;
export const MAX_PERSISTED_WORKFLOW_NODE_ARTIFACTS = 16;
export const MAX_VERIFIED_WORKFLOW_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_WORKFLOW_CANCELLATION_POLL_MS = 250;

export type WorkflowJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };

export interface WorkflowNodeEvidenceResult {
  supported: boolean;
  summary?: string;
  /** IDs from the runner-reconstructable bounded source catalog. */
  sourceIds?: string[];
  /** Executor-side gate receipts; the runner independently reconstructs them. */
  artifacts?: WorkflowGateArtifactReceipt[];
}

export interface WorkflowNodeExecutorResult {
  /** Bounded, JSON-safe data made available to downstream nodes and resumes. */
  output?: unknown;
  artifacts?: WorkflowArtifactReference[];
  modelReceipt?: WorkflowModelResolutionReceipt;
  /** Required for evidence gates and enabled common evidence policies. */
  evidence?: WorkflowNodeEvidenceResult;
}

export interface WorkflowNodeInboundResult {
  edgeId: string;
  fromNodeId: string;
  condition: NonNullable<WorkflowEdge["condition"]>;
  executionId: string;
  artifacts: WorkflowArtifactReference[];
  output?: WorkflowJsonValue;
  error?: WorkflowRunErrorInfo;
}

export interface WorkflowCompactionCheckResult {
  phase: "pre" | "post";
  passed: boolean;
  error?: WorkflowRunErrorInfo;
}

export interface WorkflowNodeExecutorContext {
  projectId: string;
  runId: string;
  workflowId: string;
  workflowRevision: number;
  graph: Pick<
    WorkflowGraphDocument,
    "id" | "settings" | "defaultModel" | "limits" | "rescue" | "evidence" | "artifacts"
  >;
  node: WorkflowNode;
  runInput: WorkflowRunManifestV1["input"];
  attempt: number;
  executionId: string;
  parentExecutionId?: string;
  branchId: string;
  resumed: boolean;
  previousError?: WorkflowRunErrorInfo;
  inbound: WorkflowNodeInboundResult[];
  /** Slots fixed by the immutable graph and already durably declared by Kady. */
  expectedModelCallSlots: readonly WorkflowModelCallSlot[];
  /** Declare the next bounded dynamic slot immediately before its provider call. */
  declareModelCallSlot: (slotId: string) => WorkflowModelCallSlot;
  /** Persist actual resolution evidence before provider streaming or other work continues. */
  recordModelResolution: (
    slotId: string,
    receipt: WorkflowModelResolutionReceipt,
  ) => void;
  /** Immutable run/node staffing receipt restored before retries or resumes. */
  deliberationStaffingReceipt?: WorkflowDeliberationStaffingReceipt;
  /** Persist staffing provenance before any deliberation provider call. */
  recordDeliberationStaffingReceipt?: (
    receipt: WorkflowDeliberationStaffingReceipt,
  ) => void;
  /** Persist a trusted child-session compaction check while this node is running. */
  recordCompactionCheck: (check: WorkflowCompactionCheckResult) => void;
  signal: AbortSignal;
}

export type WorkflowNodeExecutor = (
  context: WorkflowNodeExecutorContext,
) => WorkflowNodeExecutorResult | Promise<WorkflowNodeExecutorResult>;

export type WorkflowDagRunnerErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_ALREADY_ACTIVE"
  | "RUN_NOT_RUNNABLE"
  | "RUN_CORRUPT"
  | "RUNNER_CONTRACT_ERROR";

export class WorkflowDagRunnerError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowDagRunnerErrorCode,
  ) {
    super(message);
    this.name = "WorkflowDagRunnerError";
  }
}

export class WorkflowDagNodeError extends Error {
  constructor(
    message: string,
    readonly code = "NODE_EXECUTION_FAILED",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkflowDagNodeError";
  }
}

export type WorkflowRunAbortCode = "USER_CANCELLED" | "CONTROLLER_SHUTDOWN";

/** A typed controller-to-runner abort; untyped AbortSignals are interruptions. */
export class WorkflowRunAbortError extends Error {
  constructor(
    readonly code: WorkflowRunAbortCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRunAbortError";
  }
}

export interface RunWorkflowDagOptions {
  projectId: string;
  runId: string;
  executeNode: WorkflowNodeExecutor;
  signal?: AbortSignal;
  store?: WorkflowStore;
  leaseDurationMs?: number;
}

type RouteCondition = NonNullable<WorkflowEdge["condition"]>;

interface NodeOutcome {
  nodeId: string;
  executionId: string;
  attempt: number;
  status: "succeeded" | "failed" | "interrupted";
  branchId: string;
  parentExecutionId?: string;
  routeCondition: RouteCondition;
  output?: WorkflowJsonValue;
  artifacts: WorkflowArtifactReference[];
  error?: WorkflowRunErrorInfo;
}

interface NodeActivation {
  edgeId: string;
  fromNodeId: string;
  condition: RouteCondition;
  executionId: string;
  artifacts: WorkflowArtifactReference[];
  output?: WorkflowJsonValue;
  error?: WorkflowRunErrorInfo;
}

interface AttemptResult {
  kind: "completed" | "cancelled";
  outcome?: NodeOutcome;
}

type RunnerEventInput = Omit<WorkflowRunEventInput, "eventId">;

const activeRuns = new Set<string>();

function runnerError(message: string, code: WorkflowDagRunnerErrorCode): never {
  throw new WorkflowDagRunnerError(message, code);
}

function stableDigest(...parts: Array<string | number>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex").slice(0, 32);
}

function stableEventId(label: string, ...parts: Array<string | number>): string {
  return `dag_${label}_${stableDigest(...parts)}`;
}

/** Stable across restart and independent of which inbound branch activated a merge first. */
export function workflowNodeExecutionId(
  runId: string,
  nodeId: string,
  attempt = 1,
): string {
  if (!runId || !nodeId || !Number.isInteger(attempt) || attempt < 1) {
    runnerError(
      "A workflow node execution id needs non-empty run/node ids and a positive attempt.",
      "RUNNER_CONTRACT_ERROR",
    );
  }
  return `dagx_${stableDigest(runId, nodeId, attempt)}`;
}

function normalizeJsonValue(value: unknown, depth = 0): WorkflowJsonValue {
  if (depth > 64) {
    throw new WorkflowDagNodeError(
      "Node output exceeds the maximum JSON nesting depth.",
      "INVALID_NODE_OUTPUT",
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowDagNodeError(
        "Node output contains a non-finite number.",
        "INVALID_NODE_OUTPUT",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new WorkflowDagNodeError(
      "Node output must contain only JSON values.",
      "INVALID_NODE_OUTPUT",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowDagNodeError(
      "Node output must contain only plain JSON objects.",
      "INVALID_NODE_OUTPUT",
    );
  }
  const normalized: Record<string, WorkflowJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) {
      throw new WorkflowDagNodeError(
        `Node output field ${key} is undefined.`,
        "INVALID_NODE_OUTPUT",
      );
    }
    normalized[key] = normalizeJsonValue(item, depth + 1);
  }
  return normalized;
}

function boundedJsonValue(value: unknown, maximumBytes: number): WorkflowJsonValue {
  let normalized: WorkflowJsonValue;
  try {
    normalized = normalizeJsonValue(value);
  } catch (error) {
    if (error instanceof WorkflowDagNodeError) throw error;
    throw new WorkflowDagNodeError(
      "Node output is not JSON serializable.",
      "INVALID_NODE_OUTPUT",
    );
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf-8") > maximumBytes) {
    throw new WorkflowDagNodeError(
      `Node output exceeds ${maximumBytes} persisted bytes.`,
      "NODE_OUTPUT_TOO_LARGE",
    );
  }
  return normalized;
}

function boundedText(value: string | undefined, maximum = 2_048): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function leanVerificationStatus(
  output: WorkflowJsonValue | undefined,
): "verified" | "failed" | "unavailable" | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  if (output.kind !== "lean4") return undefined;
  return output.status === "verified" || output.status === "failed" || output.status === "unavailable"
    ? output.status
    : undefined;
}

function hasCompleteTrustedLeanArtifactReceipt(
  runId: string,
  executionId: string,
  artifacts: WorkflowArtifactReference[],
): boolean {
  const expected = trustedLeanArtifactPaths(runId, executionId);
  const paths = new Set(artifacts.map((artifact) => artifact.path));
  return artifacts.length === 2 && paths.has(expected.proof) && paths.has(expected.log);
}

function normalizeError(error: unknown): WorkflowRunErrorInfo {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; retryable?: unknown }
    : undefined;
  const rawCode = typeof candidate?.code === "string" ? candidate.code : "NODE_EXECUTION_FAILED";
  const code = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(rawCode)
    ? rawCode
    : "NODE_EXECUTION_FAILED";
  const rawMessage = typeof candidate?.message === "string"
    ? candidate.message
    : typeof error === "string"
      ? error
      : "The node executor failed without a message.";
  return {
    code,
    message: boundedText(rawMessage) ?? "The node executor failed.",
    retryable: candidate?.retryable === true,
  };
}

function sameArtifactFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  // Node reports zero device/inode values on platforms where it cannot expose
  // a stable file-handle identity. Treat that as unavailable, not as a match:
  // metadata-only equality cannot prove that the path still names the opened
  // file when another process replaces it during hashing.
  return before.dev !== 0 && before.ino !== 0 &&
    after.dev !== 0 && after.ino !== 0 &&
    before.dev === after.dev && before.ino === after.ino;
}

function sameArtifactFileSnapshot(before: fs.Stats, after: fs.Stats): boolean {
  return sameArtifactFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

export function verifyWorkflowArtifactReceipt(
  paths: Pick<ReturnType<typeof resolvePaths>, "sandbox">,
  artifact: WorkflowArtifactReference,
): WorkflowArtifactReference {
  const sandbox = path.resolve(paths.sandbox);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(sandbox);
  } catch {
    throw new WorkflowDagNodeError(
      "The project sandbox is unavailable while verifying node artifacts.",
      "ARTIFACT_SANDBOX_UNAVAILABLE",
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new WorkflowDagNodeError(
      "The project sandbox is not a real managed directory.",
      "ARTIFACT_SANDBOX_UNAVAILABLE",
    );
  }

  const components = artifact.path.split("/");
  const target = path.resolve(sandbox, ...components);
  if (!isWithin(sandbox, target)) {
    throw new WorkflowDagNodeError(
      `Artifact ${artifact.path} escaped the project sandbox.`,
      "INVALID_NODE_ARTIFACT",
    );
  }
  const componentSnapshots: Array<{ file: string; stat: fs.Stats }> = [];
  let current = sandbox;
  let targetBefore: fs.Stats | undefined;
  for (const component of components) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} does not exist in the project sandbox.`,
        "UNVERIFIED_NODE_ARTIFACT",
      );
    }
    if (stat.isSymbolicLink()) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} traverses a symbolic link.`,
        "UNVERIFIED_NODE_ARTIFACT",
      );
    }
    if (stat.dev === 0 || stat.ino === 0) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} cannot be verified because this platform does not expose stable file identities.`,
        "UNVERIFIED_NODE_ARTIFACT",
      );
    }
    componentSnapshots.push({ file: current, stat });
    targetBefore = stat;
  }
  if (!targetBefore?.isFile()) {
    throw new WorkflowDagNodeError(
      `Artifact ${artifact.path} is not a regular file.`,
      "UNVERIFIED_NODE_ARTIFACT",
    );
  }

  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (!noFollow) {
    throw new WorkflowDagNodeError(
      `Artifact ${artifact.path} cannot be opened with no-follow semantics on this platform.`,
      "UNVERIFIED_NODE_ARTIFACT",
    );
  }
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new WorkflowDagNodeError(
      `Artifact ${artifact.path} could not be opened without following links.`,
      "UNVERIFIED_NODE_ARTIFACT",
    );
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameArtifactFileSnapshot(targetBefore, opened)) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} changed while it was being opened.`,
        "UNVERIFIED_NODE_ARTIFACT",
      );
    }
    if (!Number.isSafeInteger(opened.size) || opened.size > MAX_VERIFIED_WORKFLOW_ARTIFACT_BYTES) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} exceeds the ${MAX_VERIFIED_WORKFLOW_ARTIFACT_BYTES}-byte verification limit.`,
        "NODE_ARTIFACT_TOO_LARGE",
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let offset = 0;
    while (offset < opened.size) {
      const read = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, opened.size - offset),
        offset,
      );
      if (read <= 0) {
        throw new WorkflowDagNodeError(
          `Artifact ${artifact.path} ended during verification.`,
          "UNVERIFIED_NODE_ARTIFACT",
        );
      }
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(fd);
    let targetAfter: fs.Stats | undefined;
    for (const snapshot of componentSnapshots) {
      const componentStat = fs.lstatSync(snapshot.file);
      if (componentStat.isSymbolicLink()) {
        throw new WorkflowDagNodeError(
          `Artifact ${artifact.path} changed to traverse a symbolic link.`,
          "UNVERIFIED_NODE_ARTIFACT",
        );
      }
      if (!sameArtifactFileSnapshot(snapshot.stat, componentStat)) {
        throw new WorkflowDagNodeError(
          `Artifact ${artifact.path} changed one of its path components during verification.`,
          "UNVERIFIED_NODE_ARTIFACT",
        );
      }
      targetAfter = componentStat;
    }
    if (
      !sameArtifactFileSnapshot(opened, after) ||
      !targetAfter ||
      !sameArtifactFileSnapshot(opened, targetAfter) ||
      !isWithin(fs.realpathSync(sandbox), fs.realpathSync(target)) ||
      targetAfter.size !== opened.size ||
      targetAfter.mtimeMs !== opened.mtimeMs ||
      targetAfter.ctimeMs !== opened.ctimeMs
    ) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} changed during verification.`,
        "UNVERIFIED_NODE_ARTIFACT",
      );
    }
    const sha256 = digest.digest("hex");
    if (artifact.size !== opened.size || (artifact.sha256 && artifact.sha256 !== sha256)) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} does not match the executor's size or digest claim.`,
        "ARTIFACT_RECEIPT_MISMATCH",
      );
    }
    return { ...artifact, size: opened.size, sha256 };
  } catch (error) {
    if (error instanceof WorkflowDagNodeError) throw error;
    throw new WorkflowDagNodeError(
      `Artifact ${artifact.path} could not be verified from the project sandbox.`,
      "UNVERIFIED_NODE_ARTIFACT",
    );
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeArtifacts(
  projectId: string,
  runId: string,
  executionId: string,
  attempt: number,
  node: WorkflowNode,
  declaredArtifacts: WorkflowGraphDocument["artifacts"],
  artifacts: WorkflowArtifactReference[] | undefined,
): WorkflowArtifactReference[] {
  if (!artifacts) return [];
  if (artifacts.length > MAX_PERSISTED_WORKFLOW_NODE_ARTIFACTS) {
    throw new WorkflowDagNodeError(
      `A node may report at most ${MAX_PERSISTED_WORKFLOW_NODE_ARTIFACTS} artifacts per attempt.`,
      "TOO_MANY_NODE_ARTIFACTS",
    );
  }
  return artifacts.map((artifact) => {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      artifact.path.length < 1 ||
      artifact.path.length > 1_024 ||
      normalizeWorkflowProjectPath(artifact.path) !== artifact.path ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifact.sha256)) ||
      (artifact.mediaType !== undefined && (
        typeof artifact.mediaType !== "string" || artifact.mediaType.length > 256
      ))
    ) {
      throw new WorkflowDagNodeError(
        "A node returned an invalid artifact reference.",
        "INVALID_NODE_ARTIFACT",
      );
    }
    const declaredForNode = declaredArtifacts?.some(
      (declared) => declared.writerNodeId === node.id && (declared.path === artifact.path || (node.kind === "prompt-optimization" && declared.path !== undefined && promptOptimizationArtifactPath({ declaredPath: declared.path, runId, nodeId: node.id, attempt }) === artifact.path)),
    ) ?? false;
    const trustedLeanArtifact = node.kind === "lean4" &&
      isTrustedLeanArtifactPath(runId, executionId, artifact.path);
    if (!declaredForNode && !trustedLeanArtifact) {
      throw new WorkflowDagNodeError(
        `Artifact ${artifact.path} is not declared for writer node ${node.id}.`,
        "UNDECLARED_NODE_ARTIFACT",
      );
    }
    return verifyWorkflowArtifactReceipt(resolvePaths(projectId), artifact);
  });
}

function verifyEvidenceGateArtifacts(
  projectId: string,
  node: Extract<WorkflowNode, { kind: "evidence-gate" }>,
  declaredArtifacts: WorkflowGraphDocument["artifacts"],
  inbound: readonly WorkflowNodeInboundResult[],
): { artifacts: WorkflowGateArtifactReceipt[]; failures: string[] } {
  const definitions = new Map((declaredArtifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const artifacts: WorkflowGateArtifactReceipt[] = [];
  const failures: string[] = [];
  const paths = resolvePaths(projectId);

  for (const artifactId of node.artifactIds) {
    const definition = definitions.get(artifactId);
    if (!definition) {
      failures.push(`Artifact ${artifactId} has no declaration.`);
      continue;
    }
    if (!definition.path) {
      failures.push(`Artifact ${artifactId} has no exact regular-file path.`);
      continue;
    }
    const exactCandidates = inbound.flatMap((entry) =>
      entry.fromNodeId === definition.writerNodeId
        ? entry.artifacts.filter((artifact) => artifact.path === definition.path)
        : []
    );
    let receipt: WorkflowGateArtifactReceipt | undefined;
    for (const candidate of exactCandidates) {
      // Inbound artifacts are expected to be runner-owned receipts. Requiring
      // the digest prevents a caller from turning a weak size-only claim into
      // gate evidence by asking the verifier to fill in the missing field.
      if (!candidate.sha256) continue;
      try {
        const verified = verifyWorkflowArtifactReceipt(paths, candidate);
        if (!verified.sha256) continue;
        receipt = {
          artifactId,
          writerNodeId: definition.writerNodeId,
          ...verified,
          sha256: verified.sha256,
        };
        break;
      } catch {
        // Try another exact inbound receipt, if one exists. Stale, replaced,
        // symlinked, wrong-size, and wrong-digest candidates all fail closed.
      }
    }
    if (receipt) artifacts.push(receipt);
    else {
      failures.push(
        `Artifact ${artifactId} has no current verified inbound receipt from ${definition.writerNodeId} at ${definition.path}.`,
      );
    }
  }
  return { artifacts, failures };
}

function normalizeReceipt(
  receipt: WorkflowModelResolutionReceipt | undefined,
): WorkflowModelResolutionReceipt | undefined {
  if (!receipt) return undefined;
  return boundedJsonValue(receipt, 32 * 1024) as unknown as WorkflowModelResolutionReceipt;
}

function isRepairableDiagnostic(code: string): boolean {
  return code === "torn-event-tail";
}

function effectiveRescuePolicy(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
): RescuePolicy {
  return node.rescue ?? graph.rescue ?? DEFAULT_WORKFLOW_RESCUE_POLICY;
}

function rescueTrigger(error: WorkflowRunErrorInfo): RescuePolicy["triggers"][number] {
  if (
    error.code === "WORKFLOW_EVIDENCE_UNSUPPORTED" ||
    error.code === "EVIDENCE_UNSUPPORTED"
  ) return "unsupported-output";
  if (error.code === "WORKFLOW_PRE_COMPACTION_CHECK_FAILED") return "pre-compaction";
  if (error.code === "WORKFLOW_POST_COMPACTION_CHECK_FAILED") return "post-compaction";
  if (error.code === "WORKFLOW_RESEARCH_GOAL_NOT_MET") return "stalled";
  return "failure";
}

function canRescue(
  graph: WorkflowGraphDocument,
  node: WorkflowNode,
  outcome: NodeOutcome,
): boolean {
  if (outcome.status !== "failed" || !outcome.error || !outcome.error.retryable) return false;
  const policy = effectiveRescuePolicy(graph, node);
  const completedRescueAttempts = Math.max(0, outcome.attempt - 1);
  const retryLimit = Math.min(
    graph.limits.maxRetries,
    node.limits?.maxRetries ?? graph.limits.maxRetries,
  );
  return (
    policy.enabled &&
    completedRescueAttempts < policy.maxAttempts &&
    completedRescueAttempts < retryLimit &&
    policy.triggers.includes(rescueTrigger(outcome.error))
  );
}

async function readAllRunEvents(
  store: WorkflowStore,
  projectId: string,
  runId: string,
): Promise<WorkflowRunEventV1[]> {
  const events: WorkflowRunEventV1[] = [];
  let after = 0;
  for (;;) {
    const page = store.readRunEvents(projectId, runId, { after, limit: 500 });
    events.push(...page.events);
    if (!page.hasMore) return events;
    const nextAfter = page.events.at(-1)?.seq;
    if (nextAfter === undefined || nextAfter <= after) {
      runnerError("Workflow event pagination made no progress.", "RUN_CORRUPT");
    }
    after = nextAfter;
  }
}

class EventWriter {
  constructor(
    private readonly store: WorkflowStore,
    private readonly projectId: string,
    private readonly runId: string,
    private readonly events: WorkflowRunEventV1[],
    private lastSeq: number,
    private readonly lease: WorkflowRunLeaseClaim,
  ) {}

  append(label: string, identity: Array<string | number>, input: RunnerEventInput): WorkflowRunEventV1 {
    let event: WorkflowRunEventV1;
    try {
      event = this.store.appendRunEvent(
        this.projectId,
        this.runId,
        {
          eventId: stableEventId(label, this.runId, ...identity),
          ...input,
        },
        this.lastSeq,
        this.lease,
      );
    } catch (error) {
      if (error instanceof WorkflowStoreError && error.code === "CONFLICT") {
        runnerError(
          `Workflow run ${this.runId} lost its durable owner lease: ${error.message}`,
          "RUN_ALREADY_ACTIVE",
        );
      }
      throw error;
    }
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    if (!this.events.some((existing) => existing.eventId === event.eventId)) {
      this.events.push(event);
    }
    return event;
  }

  count(type: WorkflowRunEventV1["type"], executionId?: string): number {
    return this.events.filter(
      (event) => event.type === type && (
        executionId === undefined || event.executionId === executionId
      ),
    ).length;
  }

  forExecution(executionId: string): WorkflowRunEventV1[] {
    return this.events.filter((event) => event.executionId === executionId);
  }

  forNode(nodeId: string): WorkflowRunEventV1[] {
    return this.events.filter((event) => event.nodeId === nodeId);
  }
}

class DeliberationStaffingTracker {
  readonly receipt: WorkflowDeliberationStaffingReceipt | undefined;

  constructor(
    private readonly node: WorkflowNode,
    private readonly executionId: string,
    private readonly attempt: number,
    private readonly parentExecutionId: string | undefined,
    private readonly branchId: string,
    private readonly writer: EventWriter,
  ) {
    const receipts = writer.forNode(node.id)
      .filter((event) => event.type === "deliberation_staffing_bound")
      .map((event) => event.data?.deliberationStaffingReceipt)
      .filter((receipt): receipt is WorkflowDeliberationStaffingReceipt => receipt !== undefined);
    if (receipts.length > 1) {
      throw new WorkflowDagNodeError(
        `Node ${node.id} has multiple durable deliberation staffing receipts.`,
        "DELIBERATION_RECEIPT_CONFLICT",
      );
    }
    this.receipt = receipts[0] ? structuredClone(receipts[0]) : undefined;
  }

  record(receipt: WorkflowDeliberationStaffingReceipt): void {
    const normalized = structuredClone(receipt);
    if (this.receipt) {
      if (!isDeepStrictEqual(this.receipt, normalized)) {
        throw new WorkflowDagNodeError(
          `Node ${this.node.id} attempted to change its durable deliberation staffing receipt.`,
          "DELIBERATION_RECEIPT_CONFLICT",
        );
      }
      return;
    }
    this.writer.append("deliberation-staffing-bound", [this.node.id], {
      type: "deliberation_staffing_bound",
      executionId: this.executionId,
      nodeId: this.node.id,
      attempt: this.attempt,
      ...(this.parentExecutionId ? { parentExecutionId: this.parentExecutionId } : {}),
      branchId: this.branchId,
      data: { deliberationStaffingReceipt: normalized },
    });
  }
}

class ModelCallTracker {
  private readonly declared = new Map<
    string,
    { slot: WorkflowModelCallSlot; receipt?: WorkflowModelResolutionReceipt }
  >();

  readonly expectedModelCallSlots: readonly WorkflowModelCallSlot[];

  constructor(
    private readonly manifest: WorkflowRunManifestV1,
    private readonly node: WorkflowNode,
    private readonly executionId: string,
    private readonly attempt: number,
    private readonly parentExecutionId: string | undefined,
    private readonly branchId: string,
    private readonly writer: EventWriter,
  ) {
    for (const event of writer.forExecution(executionId)) {
      if (event.type === "model_call_declared") {
        const slot = event.data?.modelCallSlot as WorkflowModelCallSlot | undefined;
        if (slot) this.declared.set(slot.id, { slot: structuredClone(slot) });
      } else if (event.type === "model_resolved") {
        const slotId = event.data?.modelCallSlotId;
        const receipt = event.data?.receipt as WorkflowModelResolutionReceipt | undefined;
        const declared = typeof slotId === "string" ? this.declared.get(slotId) : undefined;
        if (declared && receipt) declared.receipt = structuredClone(receipt);
      }
    }

    this.expectedModelCallSlots = workflowModelCallSlotsForNode(
      manifest.graph,
      node,
    ).map((slot) => structuredClone(slot));
    for (const slot of this.expectedModelCallSlots) this.declare(slot.id);
  }

  declare(slotId: string): WorkflowModelCallSlot {
    const configured = workflowModelCallSlotForNode(this.manifest.graph, this.node, slotId);
    if (!configured) {
      throw new WorkflowDagNodeError(
        `Node ${this.node.id} cannot declare model-call slot ${slotId}.`,
        "INVALID_MODEL_CALL_SLOT",
      );
    }
    const existing = this.declared.get(slotId);
    if (existing) {
      if (!isDeepStrictEqual(existing.slot.request, configured.request)) {
        throw new WorkflowDagNodeError(
          `Model-call slot ${slotId} changed its requested model during replay.`,
          "MODEL_CALL_SLOT_MISMATCH",
        );
      }
      return structuredClone(existing.slot);
    }
    const slot = structuredClone(configured);
    this.writer.append("model-call-declared", [this.node.id, this.attempt, slot.id], {
      type: "model_call_declared",
      executionId: this.executionId,
      nodeId: this.node.id,
      attempt: this.attempt,
      ...(this.parentExecutionId ? { parentExecutionId: this.parentExecutionId } : {}),
      branchId: this.branchId,
      data: { modelCallSlot: slot },
    });
    this.declared.set(slot.id, { slot });
    return structuredClone(slot);
  }

  record(slotId: string, value: WorkflowModelResolutionReceipt): void {
    const declared = this.declared.get(slotId);
    if (!declared) {
      throw new WorkflowDagNodeError(
        `Model resolution for ${slotId} arrived before its durable declaration.`,
        "UNDECLARED_MODEL_CALL_SLOT",
      );
    }
    const receipt = normalizeReceipt(value);
    if (!receipt || !isDeepStrictEqual(receipt.request, declared.slot.request)) {
      throw new WorkflowDagNodeError(
        `Model resolution for ${slotId} does not match its requested model.`,
        "MODEL_CALL_RECEIPT_MISMATCH",
      );
    }
    if (declared.receipt) {
      if (!isDeepStrictEqual(declared.receipt, receipt)) {
        throw new WorkflowDagNodeError(
          `Model-call slot ${slotId} resolved differently during replay.`,
          "MODEL_CALL_RECEIPT_MISMATCH",
        );
      }
      return;
    }
    this.writer.append("model-resolved", [this.node.id, this.attempt, slotId], {
      type: "model_resolved",
      executionId: this.executionId,
      nodeId: this.node.id,
      attempt: this.attempt,
      ...(this.parentExecutionId ? { parentExecutionId: this.parentExecutionId } : {}),
      branchId: this.branchId,
      data: { modelCallSlotId: slotId, receipt },
    });
    declared.receipt = receipt;
  }

  recordSingleResultReceipt(receipt: WorkflowModelResolutionReceipt | undefined): void {
    if (!receipt) return;
    if (this.expectedModelCallSlots.length !== 1) {
      throw new WorkflowDagNodeError(
        `Node ${this.node.id} cannot use one generic receipt for ${this.expectedModelCallSlots.length} model-call slots.`,
        "INCOMPLETE_MODEL_CALL_RECEIPTS",
      );
    }
    this.record(this.expectedModelCallSlots[0].id, receipt);
  }

  assertComplete(): void {
    const missing = [...this.declared.entries()]
      .filter(([, state]) => !state.receipt)
      .map(([slotId]) => slotId);
    if (missing.length > 0) {
      throw new WorkflowDagNodeError(
        `Node ${this.node.id} completed without model receipts for: ${missing.join(", ")}.`,
        "INCOMPLETE_MODEL_CALL_RECEIPTS",
      );
    }
  }
}

function routeConditionFromEvent(
  event: WorkflowRunEventV1 | undefined,
  fallback: RouteCondition,
): RouteCondition {
  const condition = event?.data?.routeCondition;
  return condition === "always" ||
      condition === "success" ||
      condition === "failure" ||
      condition === "evidence-supported" ||
      condition === "evidence-unsupported"
    ? condition
    : fallback;
}

function outcomesFromHistory(
  manifest: WorkflowRunManifestV1,
  record: WorkflowRunRecord,
  events: WorkflowRunEventV1[],
): Map<string, NodeOutcome> {
  const terminalEventByExecution = new Map<string, WorkflowRunEventV1>();
  for (const event of events) {
    if (
      event.executionId &&
      (event.type === "node_succeeded" || event.type === "node_failed")
    ) {
      terminalEventByExecution.set(event.executionId, event);
    }
  }

  const outcomes = new Map<string, NodeOutcome>();
  for (const execution of Object.values(record.state.executions)) {
    if (
      execution.status !== "succeeded" &&
      execution.status !== "failed" &&
      execution.status !== "interrupted"
    ) {
      continue;
    }
    const expectedExecutionId = workflowNodeExecutionId(
      manifest.id,
      execution.nodeId,
      execution.attempt,
    );
    if (execution.executionId !== expectedExecutionId) {
      runnerError(
        `Execution ${execution.executionId} does not match the runner identity for ${execution.nodeId} attempt ${execution.attempt}.`,
        "RUN_CORRUPT",
      );
    }
    const current = outcomes.get(execution.nodeId);
    if (current && current.attempt === execution.attempt && current.executionId !== execution.executionId) {
      runnerError(
        `Node ${execution.nodeId} has two executions for attempt ${execution.attempt}.`,
        "RUN_CORRUPT",
      );
    }
    if (current && current.attempt > execution.attempt) continue;

    const terminalEvent = terminalEventByExecution.get(execution.executionId);
    const defaultCondition: RouteCondition = execution.status === "failed" ? "failure" : "success";
    const storedOutput = terminalEvent?.data?.output;
    const output = storedOutput === undefined
      ? undefined
      : boundedJsonValue(storedOutput, MAX_PERSISTED_WORKFLOW_NODE_OUTPUT_BYTES);
    outcomes.set(execution.nodeId, {
      nodeId: execution.nodeId,
      executionId: execution.executionId,
      attempt: execution.attempt,
      status: execution.status,
      branchId: execution.branchId ?? "entry",
      ...(execution.parentExecutionId
        ? { parentExecutionId: execution.parentExecutionId }
        : {}),
      routeCondition: routeConditionFromEvent(terminalEvent, defaultCondition),
      ...(output !== undefined ? { output } : {}),
      artifacts: execution.artifacts.map((artifact) => ({ ...artifact })),
      ...(execution.error ? { error: { ...execution.error } } : {}),
    });
  }
  return outcomes;
}

function repairCompletedRescueEvents(
  events: WorkflowRunEventV1[],
  writer: EventWriter,
): void {
  const started = new Set<string>();
  const finished = new Set<string>();
  const terminal = new Map<string, WorkflowRunEventV1>();
  for (const event of events) {
    if (!event.nodeId || !event.attempt) continue;
    const key = `${event.nodeId}\0${event.attempt}`;
    if (event.type === "rescue_started") started.add(key);
    if (event.type === "rescue_finished") finished.add(key);
    if (event.type === "node_succeeded" || event.type === "node_failed") {
      terminal.set(key, event);
    }
  }
  for (const key of started) {
    if (finished.has(key)) continue;
    const terminalEvent = terminal.get(key);
    if (!terminalEvent || !terminalEvent.nodeId || !terminalEvent.attempt) continue;
    writer.append("rescue_finished", [terminalEvent.nodeId, terminalEvent.attempt], {
      type: "rescue_finished",
      executionId: terminalEvent.executionId,
      nodeId: terminalEvent.nodeId,
      attempt: terminalEvent.attempt,
      parentExecutionId: terminalEvent.parentExecutionId,
      branchId: terminalEvent.branchId,
      data: {
        succeeded: terminalEvent.type === "node_succeeded",
        ...(terminalEvent.type === "node_failed" && terminalEvent.data?.error
          ? { error: terminalEvent.data.error }
          : {}),
      },
    });
  }
}

function selectRoutes(
  node: WorkflowNode,
  outcome: NodeOutcome,
  outgoingEdges: WorkflowEdge[],
): WorkflowEdge[] {
  const always = outgoingEdges.filter((edge) => (edge.condition ?? "always") === "always");
  if (always.length > 0) return always;
  return outgoingEdges.filter((edge) => edge.condition === outcome.routeCondition);
}

function nodeResultData(
  output: WorkflowJsonValue | undefined,
  artifacts: WorkflowArtifactReference[],
  routeCondition: RouteCondition,
): Record<string, unknown> {
  return {
    routeCondition,
    ...(output !== undefined ? { output } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function firstActivation(
  nodeId: string,
  activations: Map<string, NodeActivation[]>,
): NodeActivation | undefined {
  return activations.get(nodeId)?.[0];
}

async function executeNodeLifecycle(
  manifest: WorkflowRunManifestV1,
  node: WorkflowNode,
  initialOutcome: NodeOutcome | undefined,
  activations: Map<string, NodeActivation[]>,
  executeNode: WorkflowNodeExecutor,
  signal: AbortSignal,
  writer: EventWriter,
): Promise<AttemptResult> {
  let attempt = initialOutcome?.status === "failed"
    ? initialOutcome.attempt + 1
    : initialOutcome?.status === "interrupted"
      ? initialOutcome.attempt
      : 1;
  let previousError = initialOutcome?.status === "failed" ? initialOutcome.error : undefined;
  let isRescueAttempt = initialOutcome?.status === "failed" || attempt > 1;
  const activation = firstActivation(node.id, activations);
  const branchId = initialOutcome?.branchId ?? activation?.edgeId ?? "entry";
  const parentExecutionId = initialOutcome?.parentExecutionId ?? activation?.executionId;

  for (;;) {
    if (signal.aborted) return { kind: "cancelled" };
    const executionId = workflowNodeExecutionId(manifest.id, node.id, attempt);
    if (isRescueAttempt && previousError) {
      writer.append("rescue_started", [node.id, attempt], {
        type: "rescue_started",
        executionId,
        attempt,
        nodeId: node.id,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        branchId,
        data: {
          trigger: rescueTrigger(previousError),
          previousError,
        },
      });
    }
    // A recovered execution keeps its executionId and attempt, but needs a new
    // transition event. Including the occurrence prevents the idempotency key
    // from collapsing a post-restart node_started into the original event.
    const nodeStartOccurrence = writer.count("node_started", executionId) + 1;
    writer.append("node_started", [node.id, attempt, nodeStartOccurrence], {
      type: "node_started",
      executionId,
      nodeId: node.id,
      attempt,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      branchId,
    });

    let outcome: NodeOutcome;
    try {
      const inbound = (activations.get(node.id) ?? []).map((item) => ({
        ...item,
        artifacts: item.artifacts.map((artifact) => ({ ...artifact })),
        ...(item.output !== undefined ? { output: structuredClone(item.output) } : {}),
        ...(item.error ? { error: { ...item.error } } : {}),
      }));
      assertS4NodeConditions(resolveNodeSpecV1(manifest.graph, node), { runInput: manifest.input, attempt, resumed: initialOutcome?.status === "interrupted" && attempt === initialOutcome.attempt, inbound }, resolvePaths(manifest.projectId).sandbox);
      const modelCalls = new ModelCallTracker(
        manifest,
        node,
        executionId,
        attempt,
        parentExecutionId,
        branchId,
        writer,
      );
      const deliberationStaffing = new DeliberationStaffingTracker(
        node,
        executionId,
        attempt,
        parentExecutionId,
        branchId,
        writer,
      );
      const result = await executeNode({
        projectId: manifest.projectId,
        runId: manifest.id,
        workflowId: manifest.workflowId,
        workflowRevision: manifest.workflowRevision,
        graph: structuredClone({
          id: manifest.graph.id,
          settings: manifest.graph.settings,
          defaultModel: manifest.graph.defaultModel,
          limits: manifest.graph.limits,
          rescue: manifest.graph.rescue,
          evidence: manifest.graph.evidence,
          artifacts: manifest.graph.artifacts,
        }),
        node: structuredClone(node),
        runInput: structuredClone(manifest.input),
        attempt,
        executionId,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        branchId,
        resumed: initialOutcome?.status === "interrupted" && attempt === initialOutcome.attempt,
        ...(previousError ? { previousError: { ...previousError } } : {}),
        inbound,
        expectedModelCallSlots: modelCalls.expectedModelCallSlots.map(
          (slot) => structuredClone(slot),
        ),
        declareModelCallSlot: (slotId) => modelCalls.declare(slotId),
        recordModelResolution: (slotId, receipt) => modelCalls.record(slotId, receipt),
        ...(deliberationStaffing.receipt
          ? { deliberationStaffingReceipt: structuredClone(deliberationStaffing.receipt) }
          : {}),
        recordDeliberationStaffingReceipt: (receipt) => deliberationStaffing.record(receipt),
        recordCompactionCheck: (check) => {
          if (
            (check.phase !== "pre" && check.phase !== "post") ||
            typeof check.passed !== "boolean" ||
            (check.passed ? check.error !== undefined : check.error === undefined)
          ) {
            throw new WorkflowDagNodeError(
              "The node executor returned an invalid compaction check.",
              "INVALID_COMPACTION_CHECK",
            );
          }
          const occurrence = writer.count("compaction_checked", executionId) + 1;
          writer.append("compaction-checked", [node.id, attempt, occurrence], {
            type: "compaction_checked",
            executionId,
            nodeId: node.id,
            attempt,
            ...(parentExecutionId ? { parentExecutionId } : {}),
            branchId,
            data: {
              phase: check.phase,
              passed: check.passed,
              ...(check.error ? { error: structuredClone(check.error) } : {}),
            },
          });
        },
        ...(node.kind === "prompt-optimization" ? { writeDurableEvent: ({ eventId, ...event }: WorkflowRunEventInput) => { writer.append("prompt-optimization-event", [node.id, attempt, eventId], event); } } : {}),
        signal,
      });
      if (signal.aborted) return { kind: "cancelled" };
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new WorkflowDagNodeError(
          "The node executor returned an invalid result envelope.",
          "INVALID_NODE_RESULT",
        );
      }
      const output = result.output === undefined
        ? undefined
        : boundedJsonValue(result.output, MAX_PERSISTED_WORKFLOW_NODE_OUTPUT_BYTES);
      const artifacts = normalizeArtifacts(
        manifest.projectId,
        manifest.id,
        executionId,
        attempt,
        node,
        manifest.graph.artifacts,
        result.artifacts,
      );
      const trustedLeanStatus = node.kind === "lean4"
        ? leanVerificationStatus(output)
        : undefined;
      if (node.kind === "lean4" && !trustedLeanStatus) {
        throw new WorkflowDagNodeError(
          `Lean node ${node.id} did not return a trusted verification status.`,
          "INVALID_LEAN_VERIFICATION_RESULT",
        );
      }
      const trustedLeanArtifactsComplete = node.kind !== "lean4" ||
        hasCompleteTrustedLeanArtifactReceipt(manifest.id, executionId, artifacts);
      modelCalls.recordSingleResultReceipt(result.modelReceipt);
      modelCalls.assertComplete();

      let routeCondition: RouteCondition = "success";
      if (node.kind === "evidence-gate") {
        if (!result.evidence || typeof result.evidence.supported !== "boolean") {
          throw new WorkflowDagNodeError(
            `Evidence gate ${node.id} did not return an explicit supported decision.`,
            "INVALID_GATE_RESULT",
          );
        }
        const policy = effectiveWorkflowEvidencePolicy(manifest.graph, node);
        const sourceCatalog = buildWorkflowEvidenceSourceCatalog(undefined, inbound);
        const normalizedSourceIds = normalizeWorkflowEvidenceSourceIds(
          result.evidence.sourceIds,
          sourceCatalog,
        );
        const sourceIds = normalizedSourceIds ?? [];
        const artifactVerification = verifyEvidenceGateArtifacts(
          manifest.projectId,
          node,
          manifest.graph.artifacts,
          inbound,
        );
        const executorArtifactReceipts = result.evidence.artifacts ?? [];
        const executorArtifactsMatch = Array.isArray(executorArtifactReceipts) &&
          isDeepStrictEqual(executorArtifactReceipts, artifactVerification.artifacts);
        const sourceRequirementPassed = !policy.enabled ||
          sourceIds.length >= policy.minimumIndependentSources;
        const allDeclaredArtifactsVerified =
          artifactVerification.artifacts.length === node.artifactIds.length;
        const artifactCheckPassed = !node.checks.includes("artifact-exists") ||
          (node.artifactIds.length > 0 && allDeclaredArtifactsVerified);
        const artifactReferenceRequirementPassed = !policy.enabled ||
          !policy.requireArtifactReferences || artifactVerification.artifacts.length > 0;
        const supported = result.evidence.supported &&
          normalizedSourceIds !== null &&
          sourceRequirementPassed &&
          allDeclaredArtifactsVerified &&
          artifactCheckPassed &&
          artifactReferenceRequirementPassed &&
          executorArtifactsMatch;
        const executorSummary = typeof result.evidence.summary === "string"
          ? boundedText(result.evidence.summary)
          : undefined;
        const summary = boundedText([
          executorSummary,
          ...(normalizedSourceIds === null
            ? ["The executor cited identifiers outside the observed source catalog."]
            : []),
          ...(!sourceRequirementPassed
            ? [`Found ${sourceIds.length} catalogued sources; ${policy.minimumIndependentSources} required.`]
            : []),
          ...artifactVerification.failures,
          ...(!artifactCheckPassed && node.artifactIds.length === 0
            ? ["The artifact-exists check has no declared artifact to verify."]
            : []),
          ...(!artifactReferenceRequirementPassed
            ? ["The gate has no verified declared artifact receipt."]
            : []),
          ...(!executorArtifactsMatch
            ? ["The executor's artifact receipts disagree with independent runner verification."]
            : []),
        ].filter((part): part is string => Boolean(part)).join(" ")) ??
          (supported
            ? "The evidence gate passed its bounded checks."
            : "The evidence gate did not pass its bounded checks.");
        writer.append("gate_evaluated", [node.id, attempt], {
          type: "gate_evaluated",
          executionId,
          nodeId: node.id,
          attempt,
          ...(parentExecutionId ? { parentExecutionId } : {}),
          branchId,
          data: {
            supported,
            sourceIds,
            artifacts: artifactVerification.artifacts.map((artifact) => ({ ...artifact })),
            summary,
          },
        });
        routeCondition = supported
          ? "evidence-supported"
          : "evidence-unsupported";
        if (!supported && node.onUnsupportedOutput !== "route") {
          throw new WorkflowDagNodeError(
            summary,
            "EVIDENCE_UNSUPPORTED",
            node.onUnsupportedOutput === "rescue",
          );
        }
      } else if (requiresWorkflowEvidencePolicyEvaluation(manifest.graph, node)) {
        if (!result.evidence || typeof result.evidence.supported !== "boolean") {
          throw new WorkflowDagNodeError(
            `Node ${node.id} did not return its enabled evidence-policy decision.`,
            "INVALID_EVIDENCE_RESULT",
          );
        }
        const policy = effectiveWorkflowEvidencePolicy(manifest.graph, node);
        const sourceCatalog = buildWorkflowEvidenceSourceCatalog(output, inbound);
        const sourceIds = normalizeWorkflowEvidenceSourceIds(
          result.evidence.sourceIds,
          sourceCatalog,
        );
        if (!sourceIds) {
          throw new WorkflowDagNodeError(
            `Node ${node.id} returned evidence identifiers outside its bounded source catalog.`,
            "INVALID_EVIDENCE_RESULT",
          );
        }
        const sourceRequirementPassed = sourceIds.length >= policy.minimumIndependentSources;
        const artifactRequirementPassed = !policy.requireArtifactReferences || artifacts.length > 0;
        const supported = trustedLeanStatus !== "failed" &&
          trustedLeanStatus !== "unavailable" && trustedLeanArtifactsComplete &&
          result.evidence.supported &&
          sourceRequirementPassed && artifactRequirementPassed;
        const evidenceSummary = boundedText([
          result.evidence.summary,
          ...(!sourceRequirementPassed
            ? [`Found ${sourceIds.length} catalogued sources; ${policy.minimumIndependentSources} required.`]
            : []),
          ...(!artifactRequirementPassed
            ? ["No normalized artifact receipt was returned by this node."]
            : []),
          ...(node.kind === "lean4" && trustedLeanStatus === "verified" &&
              !trustedLeanArtifactsComplete
            ? ["Trusted Lean success requires both exact host-owned proof and verification-log receipts."]
            : []),
        ].filter((part): part is string => Boolean(part)).join(" "));
        writer.append("evidence-checked", [node.id, attempt], {
          type: "evidence_checked",
          executionId,
          nodeId: node.id,
          attempt,
          ...(parentExecutionId ? { parentExecutionId } : {}),
          branchId,
          data: {
            supported,
            sourceIds,
            ...(artifacts.length > 0
              ? { artifacts: artifacts.map((artifact) => ({ ...artifact })) }
              : {}),
            ...(evidenceSummary ? { summary: evidenceSummary } : {}),
          },
        });
        if (policy.onUnsupportedOutput === "route") {
          routeCondition = supported ? "evidence-supported" : "evidence-unsupported";
        } else if (!supported) {
          throw new WorkflowDagNodeError(
            evidenceSummary ?? `Node ${node.id} failed its enabled evidence policy.`,
            "EVIDENCE_UNSUPPORTED",
            policy.onUnsupportedOutput === "rescue",
          );
        }
      } else if (
        trustedLeanStatus === "failed" || trustedLeanStatus === "unavailable" ||
        (trustedLeanStatus === "verified" && !trustedLeanArtifactsComplete)
      ) {
        const missingSuccessReceipt = trustedLeanStatus === "verified" &&
          !trustedLeanArtifactsComplete;
        const evidenceSummary = boundedText(
          missingSuccessReceipt
            ? "Trusted Lean success requires both exact host-owned proof and verification-log receipts."
            : result.evidence?.summary ??
              `Trusted Lean verification returned ${trustedLeanStatus}.`,
        );
        writer.append("evidence-checked", [node.id, attempt], {
          type: "evidence_checked",
          executionId,
          nodeId: node.id,
          attempt,
          ...(parentExecutionId ? { parentExecutionId } : {}),
          branchId,
          data: {
            supported: false,
            sourceIds: [],
            ...(artifacts.length > 0
              ? { artifacts: artifacts.map((artifact) => ({ ...artifact })) }
              : {}),
            ...(evidenceSummary ? { summary: evidenceSummary } : {}),
          },
        });
        throw new WorkflowDagNodeError(
          evidenceSummary ?? `Trusted Lean verification returned ${trustedLeanStatus}.`,
          missingSuccessReceipt
            ? "INVALID_LEAN_VERIFICATION_RESULT"
            : trustedLeanStatus === "unavailable"
              ? "WORKFLOW_LEAN_VERIFIER_UNAVAILABLE"
              : "WORKFLOW_LEAN_VERIFICATION_FAILED",
        );
      }

      writer.append("node_succeeded", [node.id, attempt], {
        type: "node_succeeded",
        executionId,
        nodeId: node.id,
        attempt,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        branchId,
        data: nodeResultData(output, artifacts, routeCondition),
      });
      outcome = {
        nodeId: node.id,
        executionId,
        attempt,
        status: "succeeded",
        branchId,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        routeCondition,
        ...(output !== undefined ? { output } : {}),
        artifacts,
      };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      const normalizedError = normalizeError(error);
      writer.append("node_failed", [node.id, attempt], {
        type: "node_failed",
        executionId,
        nodeId: node.id,
        attempt,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        branchId,
        data: { error: normalizedError, routeCondition: "failure" },
      });
      outcome = {
        nodeId: node.id,
        executionId,
        attempt,
        status: "failed",
        branchId,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        routeCondition: "failure",
        artifacts: [],
        error: normalizedError,
      };
    }

    if (isRescueAttempt) {
      writer.append("rescue_finished", [node.id, attempt], {
        type: "rescue_finished",
        executionId,
        nodeId: node.id,
        attempt,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        branchId,
        data: {
          succeeded: outcome.status === "succeeded",
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      });
    }
    if (outcome.status === "succeeded" || !canRescue(manifest.graph, node, outcome)) {
      return { kind: "completed", outcome };
    }

    previousError = outcome.error;
    attempt += 1;
    isRescueAttempt = true;
  }
}

function appendTerminalEvent(
  writer: EventWriter,
  type: "run_succeeded" | "run_failed" | "run_cancelled",
  error?: WorkflowRunErrorInfo,
): void {
  writer.append(type, [type], {
    type,
    ...(error ? { data: { error } } : {}),
  });
}

function abortError(reason: unknown): WorkflowRunErrorInfo {
  if (reason instanceof WorkflowRunAbortError) {
    return {
      code: reason.code,
      message: boundedText(reason.message) ?? "Workflow execution was interrupted.",
      retryable: reason.code !== "USER_CANCELLED",
    };
  }
  return {
    code: "RUN_INTERRUPTED",
    message: "Workflow execution was interrupted by its caller.",
    retryable: true,
  };
}

function appendAbortEvent(
  writer: EventWriter,
  store: WorkflowStore,
  projectId: string,
  runId: string,
  reason: unknown,
): void {
  const error = abortError(reason);
  if (error.code === "USER_CANCELLED") {
    appendTerminalEvent(writer, "run_cancelled", error);
    return;
  }
  const status = finalRecord(store, projectId, runId).state.status;
  if (!["running", "waiting", "blocked", "paused"].includes(status)) {
    runnerError(
      `Workflow run ${runId} cannot be interrupted from ${status}.`,
      "RUN_NOT_RUNNABLE",
    );
  }
  writer.append("run-interrupted", ["run-interrupted"], {
    type: "run_interrupted",
    data: {
      previousStatus: status as "running" | "waiting" | "blocked" | "paused",
      error,
    },
  });
}

function finalRecord(store: WorkflowStore, projectId: string, runId: string): WorkflowRunRecord {
  const record = store.readRun(projectId, runId);
  if (!record) runnerError(`No such workflow run: ${runId}`, "RUN_NOT_FOUND");
  return record;
}

/**
 * Execute the immutable graph snapshot stored in a workflow run manifest.
 *
 * The outer graph uses explicit fan-out and any-ready merges: the first
 * activated inbound edge schedules a node, later inbound results are attached
 * to its activation record but never create a second node execution.
 */
export async function runWorkflowDag(
  options: RunWorkflowDagOptions,
): Promise<WorkflowRunRecord> {
  if (typeof options.executeNode !== "function") {
    runnerError("A workflow node executor is required.", "RUNNER_CONTRACT_ERROR");
  }
  const store = options.store ?? workflowStore;
  let initialRecord: WorkflowRunRecord;
  try {
    const record = store.readRun(options.projectId, options.runId);
    if (!record) runnerError(`No such workflow run: ${options.runId}`, "RUN_NOT_FOUND");
    initialRecord = record;
  } catch (error) {
    if (error instanceof WorkflowDagRunnerError) throw error;
    if (error instanceof WorkflowStoreError) {
      runnerError(error.message, "RUN_CORRUPT");
    }
    throw error;
  }

  const activeKey = `${options.projectId}\0${options.runId}`;
  if (activeRuns.has(activeKey)) {
    runnerError(`Workflow run ${options.runId} is already owned by this process.`, "RUN_ALREADY_ACTIVE");
  }
  if (
    initialRecord.state.diagnostics.some(
      (diagnostic) => diagnostic.fatal && !isRepairableDiagnostic(diagnostic.code),
    )
  ) {
    runnerError(`Workflow run ${options.runId} has corrupt history.`, "RUN_CORRUPT");
  }
  if (
    initialRecord.state.status !== "queued" &&
    initialRecord.state.status !== "interrupted"
  ) {
    runnerError(
      `Workflow run ${options.runId} cannot start from ${initialRecord.state.status}.`,
      "RUN_NOT_RUNNABLE",
    );
  }
  if (Object.values(initialRecord.state.executions).some((execution) => execution.status === "running")) {
    runnerError(`Workflow run ${options.runId} still has actively owned nodes.`, "RUN_ALREADY_ACTIVE");
  }

  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_WORKFLOW_RUN_LEASE_MS;
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < MIN_WORKFLOW_RUN_LEASE_MS ||
    leaseDurationMs > MAX_WORKFLOW_RUN_LEASE_MS
  ) {
    runnerError(
      `Workflow lease duration must be ${MIN_WORKFLOW_RUN_LEASE_MS}-${MAX_WORKFLOW_RUN_LEASE_MS} ms.`,
      "RUNNER_CONTRACT_ERROR",
    );
  }
  let lease: WorkflowRunLeaseClaim;
  try {
    lease = store.acquireRunLease(options.projectId, options.runId, leaseDurationMs);
  } catch (error) {
    if (error instanceof WorkflowStoreError && error.code === "CONFLICT") {
      runnerError(`Workflow run ${options.runId} already has a live owner.`, "RUN_ALREADY_ACTIVE");
    }
    throw error;
  }

  activeRuns.add(activeKey);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let leaseFailure: unknown;
  let cancellationPollFailure: unknown;
  const heartbeat = setInterval(() => {
    if (leaseFailure) return;
    try {
      Object.assign(
        lease,
        store.renewRunLease(options.projectId, lease, leaseDurationMs),
      );
    } catch (error) {
      leaseFailure = error;
      controller.abort(error);
    }
  }, Math.max(250, Math.floor(leaseDurationMs / 3)));
  heartbeat.unref();
  const observeCancellation = () => {
    if (controller.signal.aborted || cancellationPollFailure) return;
    try {
      const intent = store.readRunCancellationIntent(options.projectId, options.runId);
      if (intent) {
        controller.abort(new WorkflowRunAbortError(intent.code, intent.message));
      }
    } catch (error) {
      cancellationPollFailure = error;
      controller.abort(error);
    }
  };
  observeCancellation();
  const cancellationPoll = setInterval(
    observeCancellation,
    DEFAULT_WORKFLOW_CANCELLATION_POLL_MS,
  );
  cancellationPoll.unref();
  let writer: EventWriter | undefined;

  try {
    const ownedRecord = store.readRun(options.projectId, options.runId);
    if (!ownedRecord) runnerError(`No such workflow run: ${options.runId}`, "RUN_NOT_FOUND");
    initialRecord = ownedRecord;
    if (
      initialRecord.state.status !== "queued" &&
      initialRecord.state.status !== "interrupted"
    ) {
      runnerError(
        `Workflow run ${options.runId} changed to ${initialRecord.state.status} before lease acquisition.`,
        "RUN_NOT_RUNNABLE",
      );
    }
    if (Object.values(initialRecord.state.executions).some((execution) => execution.status === "running")) {
      runnerError(`Workflow run ${options.runId} still has actively owned nodes.`, "RUN_ALREADY_ACTIVE");
    }
    const manifest = initialRecord.manifest;
    const graph = manifest.graph;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, WorkflowEdge[]>();
    for (const node of graph.nodes) outgoing.set(node.id, []);
    for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge);

    const events = await readAllRunEvents(store, options.projectId, options.runId);
    writer = new EventWriter(
      store,
      options.projectId,
      options.runId,
      events,
      initialRecord.state.lastSeq,
      lease,
    );
    if (initialRecord.state.status === "queued") {
      writer.append("run_started", ["start"], { type: "run_started" });
    } else {
      const resumeNumber = events.filter((event) => event.type === "run_resumed").length + 1;
      writer.append("run_resumed", [resumeNumber], {
        type: "run_resumed",
        data: { resumeNumber },
      });
    }
    repairCompletedRescueEvents(events, writer);

    if (controller.signal.aborted) {
      if (leaseFailure) {
        runnerError(
          `Workflow run ${options.runId} lost its durable owner lease.`,
          "RUN_ALREADY_ACTIVE",
        );
      }
      if (cancellationPollFailure) throw cancellationPollFailure;
      appendAbortEvent(
        writer,
        store,
        options.projectId,
        options.runId,
        controller.signal.reason,
      );
      return finalRecord(store, options.projectId, options.runId);
    }

    const projectedRecord = finalRecord(store, options.projectId, options.runId);
    const outcomes = outcomesFromHistory(manifest, projectedRecord, events);
    const activations = new Map<string, NodeActivation[]>();
    activations.set(graph.entryNodeId, []);
    const propagated = new Set<string>();
    const active = new Map<
      string,
      Promise<{ nodeId: string; result?: AttemptResult; error?: unknown }>
    >();
    let fatalError: WorkflowRunErrorInfo | undefined;

    const activateEdge = (edge: WorkflowEdge, parent: NodeOutcome): void => {
      const existing = activations.get(edge.to) ?? [];
      if (!existing.some((activation) => activation.edgeId === edge.id)) {
        existing.push({
          edgeId: edge.id,
          fromNodeId: edge.from,
          condition: edge.condition ?? "always",
          executionId: parent.executionId,
          artifacts: parent.artifacts.map((artifact) => ({ ...artifact })),
          ...(parent.output !== undefined ? { output: parent.output } : {}),
          ...(parent.error ? { error: parent.error } : {}),
        });
      }
      activations.set(edge.to, existing);
    };

    const propagateCompletedNodes = (): void => {
      let changed = true;
      while (changed && !fatalError) {
        changed = false;
        for (const node of graph.nodes) {
          if (!activations.has(node.id) || propagated.has(node.id)) continue;
          const outcome = outcomes.get(node.id);
          if (!outcome || outcome.status === "interrupted") continue;
          if (outcome.status === "failed" && canRescue(graph, node, outcome)) continue;

          const routes = selectRoutes(node, outcome, outgoing.get(node.id) ?? []);
          if (routes.length === 0) {
            if (node.terminal && outcome.status === "succeeded") {
              propagated.add(node.id);
              changed = true;
              continue;
            }
            fatalError = {
              code: "UNHANDLED_NODE_OUTCOME",
              message: `Node ${node.id} produced ${outcome.routeCondition} with no matching route.`,
              retryable: false,
            };
            break;
          }
          for (const edge of routes) activateEdge(edge, outcome);
          propagated.add(node.id);
          changed = true;
        }
      }
    };

    for (;;) {
      if (leaseFailure) {
        runnerError(
          `Workflow run ${options.runId} lost its durable owner lease.`,
          "RUN_ALREADY_ACTIVE",
        );
      }
      if (cancellationPollFailure) throw cancellationPollFailure;
      if (controller.signal.aborted) {
        await Promise.all(active.values());
        appendAbortEvent(
          writer,
          store,
          options.projectId,
          options.runId,
          controller.signal.reason,
        );
        return finalRecord(store, options.projectId, options.runId);
      }

      propagateCompletedNodes();
      if (!fatalError) {
        for (const executedNodeId of outcomes.keys()) {
          if (!activations.has(executedNodeId)) {
            fatalError = {
              code: "CORRUPT_RUNNER_HISTORY",
              message: `Node ${executedNodeId} executed without an activated graph path.`,
              retryable: false,
            };
            break;
          }
        }
      }
      if (fatalError) {
        controller.abort(fatalError);
        await Promise.all(active.values());
        appendTerminalEvent(writer, "run_failed", fatalError);
        return finalRecord(store, options.projectId, options.runId);
      }

      for (const node of graph.nodes) {
        if (active.size >= graph.limits.maxParallelism) break;
        if (!activations.has(node.id) || propagated.has(node.id) || active.has(node.id)) continue;
        const existingOutcome = outcomes.get(node.id);
        if (
          existingOutcome?.status === "succeeded" ||
          (existingOutcome?.status === "failed" && !canRescue(graph, node, existingOutcome))
        ) {
          continue;
        }
        const promise = executeNodeLifecycle(
          manifest,
          node,
          existingOutcome,
          activations,
          options.executeNode,
          controller.signal,
          writer,
        ).then(
          (result) => ({ nodeId: node.id, result }),
          (error: unknown) => ({ nodeId: node.id, error }),
        );
        active.set(node.id, promise);
      }

      if (active.size === 0) {
        const unresolved = graph.nodes.filter(
          (node) => activations.has(node.id) && !propagated.has(node.id),
        );
        if (unresolved.length > 0) {
          appendTerminalEvent(writer, "run_failed", {
            code: "WORKFLOW_DEADLOCK",
            message: `Workflow stopped with unresolved nodes: ${unresolved.map((node) => node.id).join(", ")}.`,
            retryable: false,
          });
        } else {
          appendTerminalEvent(writer, "run_succeeded");
        }
        return finalRecord(store, options.projectId, options.runId);
      }

      const settled = await Promise.race(active.values());
      active.delete(settled.nodeId);
      if (settled.error) {
        controller.abort(settled.error);
        await Promise.all(active.values());
        throw settled.error;
      }
      if (settled.result?.kind === "completed" && settled.result.outcome) {
        outcomes.set(settled.nodeId, settled.result.outcome);
      }
    }
  } catch (error) {
    if (
      error instanceof WorkflowStoreError &&
      error.code === "CANCEL_REQUESTED"
    ) {
      controller.abort(new WorkflowRunAbortError(
        "USER_CANCELLED",
        "Workflow execution was cancelled by the user.",
      ));
      const current = finalRecord(store, options.projectId, options.runId);
      if (current.state.status === "cancelled") return current;
      if (!writer) {
        const events = await readAllRunEvents(store, options.projectId, options.runId);
        writer = new EventWriter(
          store,
          options.projectId,
          options.runId,
          events,
          current.state.lastSeq,
          lease,
        );
      }
      appendTerminalEvent(writer, "run_cancelled", {
        code: "USER_CANCELLED",
        message: "Workflow execution was cancelled by the user.",
        retryable: false,
      });
      return finalRecord(store, options.projectId, options.runId);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancellationPoll);
    options.signal?.removeEventListener("abort", forwardAbort);
    activeRuns.delete(activeKey);
    try {
      store.releaseRunLease(options.projectId, lease);
    } catch (error) {
      if (!(error instanceof WorkflowStoreError) || error.code !== "CONFLICT") throw error;
    }
  }
}
