import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

import { currentProjectId } from "../scope.ts";
import { isWithin } from "../path-containment.ts";
import { resolvePaths } from "../projects.ts";
import {
  isTrustedLeanArtifactPath,
  trustedLeanArtifactPaths,
} from "../workflows/lean4-artifacts.ts";
import {
  MAX_WORKFLOW_EVENT_PAGE_SIZE,
  WorkflowStoreError,
  workflowStore,
  type WorkflowArtifactReference,
  type WorkflowNodeExecutionState,
  type WorkflowNodeExecutionStatus,
  type WorkflowRunEventV1,
  type WorkflowRunRecord,
} from "../workflows/index.ts";

/**
 * `GET /lean4/runs/:runId/proofs` and
 * `GET /lean4/runs/:runId/proofs/:executionId/source` — the read-only surface
 * that carries an executed Lean node's proof artifact and its Mathlib
 * provenance to a browser.
 *
 * Three decisions worth stating once, because each looks like an omission:
 *
 *   * **Nothing here recomputes provenance.** `mathlibRevision` and
 *     `mathlibTree` are produced exactly once, by
 *     `inspectPinnedMathlibCheckout()` in `workflows/lean4-verifier.ts`, which
 *     also proves the checkout is detached, clean, and equal to its Lake
 *     manifest. The executor puts them in the node's output
 *     (`kady-node-executor.ts` `lean4` branch) and the runner persists that
 *     output on `node_succeeded`. This module *projects* that receipt. A second
 *     computation would be a second source of truth for one commit id, and the
 *     two could disagree. (A REJECTED verification loses the output before it
 *     is persisted — see `Lean4ProvenanceGap` below; that gap is in
 *     `runner.ts`, not here, and is reported rather than papered over.)
 *   * **The trust boundary is reused, not widened.** A source read is refused
 *     unless `isTrustedLeanArtifactPath(runId, executionId, candidate)` accepts
 *     the path — an exact-string test against the two host-owned files, not a
 *     prefix test. `KADY_LEAN_ARTIFACT_ROOT` is untouched.
 *   * **A run with no Lean node is a successful, empty answer** (`200
 *     {proofs: []}`), not a 404. 4xx is reserved for an unknown run, a
 *     malformed request, and a refused path.
 *
 * No error body carries a filesystem path, an `errno`, or a stack: the only
 * path any response contains is the sandbox-relative artifact path the caller
 * already supplied or already received.
 */

/** Hard cap on returned proof/log text. Larger artifacts answer `truncated: true`. */
export const LEAN4_SOURCE_MAX_BYTES = 256 * 1024;
/** Hard cap on projected receipts per run, so one run cannot produce an unbounded response. */
export const LEAN4_MAX_PROOFS_PER_RUN = 64;
/** Hard cap on event pages walked per request. 500 * 40 = 20 000 events. */
const MAX_EVENT_PAGES = 40;
const MAX_SUMMARY_CHARS = 2_048;
const MAX_STATEMENT_CHARS = 4_096;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_CHARS = 1_024;
const MAX_IDENTIFIER_CHARS = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type Lean4VerificationStatus = "verified" | "failed" | "unavailable";
export type Lean4ExecutionPolicy = "disabled" | "unsandboxed-opt-in";
export type Lean4ArtifactKind = "proof" | "log";

export interface Lean4ArtifactReceipt {
  /** `proof` is `Proof.lean`; `log` is `verification.log`. Both are host-owned. */
  kind: Lean4ArtifactKind;
  /** Sandbox-relative path under `workflow_artifacts/dag-workflows/lean/…`. */
  path: string;
  size: number;
  sha256: string | null;
  mediaType: string | null;
}

/**
 * Why provenance is absent, when it is.
 *
 * `discarded-on-failure` is a REAL runtime gap, not a client problem:
 * `workflows/runner.ts` persists node output only on `node_succeeded`
 * (`data: nodeResultData(output, artifacts, routeCondition)`), while a REJECTED
 * Lean verification throws and lands on `node_failed`, whose `data` is
 * `{error, routeCondition}`. The mathlib pin the executor produced therefore
 * never reaches the event log for a rejected proof. `runner.ts` is not lane
 * F4's file; the finding is recorded in `INTEGRATION.md` for its owner. Until
 * it is fixed, this field lets the renderer say "the runtime dropped it"
 * instead of the false "the verifier never reported it".
 */
export type Lean4ProvenanceGap = "none" | "not-yet-executed" | "discarded-on-failure";

export interface Lean4ProofReceipt {
  runId: string;
  nodeId: string;
  nodeName: string;
  executionId: string;
  attempt: number;
  /** The durable node-execution status from the run reducer. */
  executionStatus: WorkflowNodeExecutionStatus;
  /** `null` until the trusted verifier has returned a receipt for this attempt. */
  status: Lean4VerificationStatus | null;
  summary: string | null;
  /** Authored on the node, read back from the run's frozen graph — not from the live definition. */
  mode: "verify" | "solve";
  mathlibRequested: boolean;
  theoremName: string | null;
  normalizedStatement: string | null;
  executionPolicy: Lean4ExecutionPolicy | null;
  toolchain: string | null;
  mathlibRevision: string | null;
  mathlibTree: string | null;
  assumptions: string[];
  translationGaps: string[];
  artifacts: Lean4ArtifactReceipt[];
  proofPath: string | null;
  logPath: string | null;
  provenanceGap: Lean4ProvenanceGap;
  error: { code: string; message: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Lean4ProofListResponse {
  runId: string;
  runStatus: WorkflowRunRecord["state"]["status"];
  workflowId: string;
  /** True when the run carried more Lean executions than `LEAN4_MAX_PROOFS_PER_RUN`. */
  truncated: boolean;
  proofs: Lean4ProofReceipt[];
}

export interface Lean4ProofSourceResponse {
  runId: string;
  executionId: string;
  artifact: Lean4ArtifactKind;
  path: string;
  /** Bytes on disk, which may exceed `text`'s byte length when `truncated`. */
  size: number;
  sha256: string | null;
  /** True when the artifact exceeded `LEAN4_SOURCE_MAX_BYTES` and `text` is a prefix. */
  truncated: boolean;
  text: string;
}

export type Lean4ErrorCode =
  | "LEAN4_INVALID_REQUEST"
  | "LEAN4_RUN_NOT_FOUND"
  | "LEAN4_PROOF_NOT_FOUND"
  | "LEAN4_ARTIFACT_UNTRUSTED"
  | "LEAN4_ARTIFACT_MISSING"
  | "LEAN4_ARTIFACT_UNREADABLE";

export interface Lean4ErrorResponse {
  code: Lean4ErrorCode;
  detail: string;
}

class Lean4RouteError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: Lean4ErrorCode;

  constructor(status: 400 | 403 | 404 | 409, code: Lean4ErrorCode, detail: string) {
    super(detail);
    this.name = "Lean4RouteError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function boundedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const bounded = boundedString(entry, MAX_LIST_ITEM_CHARS);
    if (bounded !== null) items.push(bounded);
    if (items.length >= MAX_LIST_ITEMS) break;
  }
  return items;
}

function verificationStatus(value: unknown): Lean4VerificationStatus | null {
  return value === "verified" || value === "failed" || value === "unavailable" ? value : null;
}

function executionPolicy(value: unknown): Lean4ExecutionPolicy | null {
  return value === "disabled" || value === "unsandboxed-opt-in" ? value : null;
}

/**
 * A single artifact reference, classified by the ONE thing that is allowed to
 * classify it: equality with the host-owned path for this run and execution.
 * An entry that is neither is dropped rather than reported under a guessed
 * kind — the runner already refuses to persist one, so its presence would mean
 * the event log was edited underneath us.
 */
function classifyArtifact(
  runId: string,
  executionId: string,
  artifact: WorkflowArtifactReference,
): Lean4ArtifactReceipt | null {
  if (!isTrustedLeanArtifactPath(runId, executionId, artifact.path)) return null;
  const expected = trustedLeanArtifactPaths(runId, executionId);
  const kind: Lean4ArtifactKind = artifact.path === expected.proof ? "proof" : "log";
  const size = Number.isSafeInteger(artifact.size) && artifact.size >= 0 ? artifact.size : 0;
  const sha256 = typeof artifact.sha256 === "string" && SHA256_PATTERN.test(artifact.sha256)
    ? artifact.sha256
    : null;
  return {
    kind,
    path: artifact.path,
    size,
    sha256,
    mediaType: boundedString(artifact.mediaType, 128),
  };
}

/**
 * Every artifact reference the reducer holds for one execution, in one place.
 *
 * There are two, and only a successful node uses the first:
 * `WorkflowNodeExecutionState.artifacts` is populated from `node_succeeded`,
 * while a REJECTED Lean verification's receipts land on
 * `evidenceDecision.artifacts` from the `evidence_checked` event the runner
 * appends before it throws. Reading only the first is what makes a failed
 * proof look receiptless — which it is not, and the failed proof is exactly the
 * one a user most needs to open.
 */
function leanArtifactReferences(
  execution: WorkflowNodeExecutionState,
): WorkflowArtifactReference[] {
  const seen = new Set<string>();
  const references: WorkflowArtifactReference[] = [];
  for (const artifact of [
    ...execution.artifacts,
    ...(execution.evidenceDecision?.artifacts ?? []),
  ]) {
    if (seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    references.push(artifact);
  }
  return references;
}

interface TerminalLeanEvent {
  output: Record<string, unknown> | undefined;
  error: { code: string; message: string } | null;
  /** The runner's own decision summary, which survives a rejection when output does not. */
  evidenceSummary: string | null;
}

/**
 * A Lean node whose verification was REJECTED fails with a specific code, so
 * the verdict survives even though the executor's output object does not.
 * `INVALID_LEAN_VERIFICATION_RESULT` is deliberately absent: it means the
 * receipt itself was inconsistent, which is not a verification verdict.
 */
const LEAN_ERROR_STATUS: Record<string, Lean4VerificationStatus> = {
  WORKFLOW_LEAN_VERIFICATION_FAILED: "failed",
  WORKFLOW_LEAN_VERIFIER_UNAVAILABLE: "unavailable",
};

/**
 * Walk the durable event log once and index the terminal event per execution.
 *
 * The Lean provenance is NOT in `WorkflowRunState`: `WorkflowNodeExecutionState`
 * carries artifacts (paths, sizes, hashes) but no node output. `mathlibRevision`
 * and `mathlibTree` live in the `node_succeeded`/`node_failed` event's
 * `data.output`, which is where the runner persisted the executor's receipt.
 */
function terminalEventsByExecution(
  projectId: string,
  runId: string,
): Map<string, TerminalLeanEvent> {
  const terminal = new Map<string, TerminalLeanEvent>();
  let after = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const events = workflowStore.readRunEvents(projectId, runId, {
      after,
      limit: MAX_WORKFLOW_EVENT_PAGE_SIZE,
    });
    for (const event of events.events) {
      indexTerminalEvent(terminal, event);
    }
    const last = events.events.at(-1);
    if (!last || !events.hasMore) break;
    after = last.seq;
  }
  return terminal;
}

function indexTerminalEvent(
  terminal: Map<string, TerminalLeanEvent>,
  event: WorkflowRunEventV1,
): void {
  if (!event.executionId) return;
  const existing = terminal.get(event.executionId);

  // `evidence_checked` precedes the terminal event and is the ONLY place a
  // rejected Lean verification's summary is persisted, so it is folded in
  // rather than replaced by the later `node_failed`.
  if (event.type === "evidence_checked") {
    const summary = boundedString(event.data?.summary, MAX_SUMMARY_CHARS);
    terminal.set(event.executionId, {
      output: existing?.output,
      error: existing?.error ?? null,
      evidenceSummary: summary ?? existing?.evidenceSummary ?? null,
    });
    return;
  }
  if (event.type !== "node_succeeded" && event.type !== "node_failed") return;

  const output = isRecord(event.data?.output) ? event.data.output : undefined;
  const rawError = event.data?.error;
  const error = rawError && typeof rawError.code === "string"
    ? {
      code: boundedString(rawError.code, 64) ?? "NODE_EXECUTION_FAILED",
      message: boundedString(rawError.message, MAX_SUMMARY_CHARS) ??
        "The node executor failed without a message.",
    }
    : null;
  terminal.set(event.executionId, {
    output,
    error,
    evidenceSummary: existing?.evidenceSummary ?? null,
  });
}

/**
 * Project every Lean node execution of a run into the wire receipt.
 *
 * `mode` and `mathlibRequested` are read from `manifest.graph` — the exact
 * normalized graph this run executed — and not from the current stored
 * definition, which a later edit may have changed.
 */
export function projectLean4Proofs(run: WorkflowRunRecord, projectId: string): {
  proofs: Lean4ProofReceipt[];
  truncated: boolean;
} {
  const leanNodes = new Map(
    run.manifest.graph.nodes
      .filter((node) => node.kind === "lean4")
      .map((node) => [node.id, node] as const),
  );
  if (leanNodes.size === 0) return { proofs: [], truncated: false };

  const terminal = terminalEventsByExecution(projectId, run.manifest.id);
  const executions = Object.values(run.state.executions)
    .filter((execution) => leanNodes.has(execution.nodeId))
    .sort((left, right) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
      left.executionId.localeCompare(right.executionId)
    );
  const truncated = executions.length > LEAN4_MAX_PROOFS_PER_RUN;

  const proofs = executions.slice(0, LEAN4_MAX_PROOFS_PER_RUN).map((execution) => {
    const node = leanNodes.get(execution.nodeId)!;
    const receipt = terminal.get(execution.executionId);
    const output = receipt?.output?.kind === "lean4" ? receipt.output : undefined;
    const artifacts = leanArtifactReferences(execution)
      .map((artifact) => classifyArtifact(run.manifest.id, execution.executionId, artifact))
      .filter((artifact): artifact is Lean4ArtifactReceipt => artifact !== null);
    const error = receipt?.error ?? execution.error ?? null;
    const status = verificationStatus(output?.status) ??
      (error ? LEAN_ERROR_STATUS[error.code] ?? null : null);
    const executionSettled = execution.status === "succeeded" ||
      execution.status === "failed" || execution.status === "interrupted";
    const provenanceGap: Lean4ProvenanceGap = output !== undefined
      ? "none"
      : executionSettled
        ? "discarded-on-failure"
        : "not-yet-executed";
    return {
      runId: run.manifest.id,
      nodeId: execution.nodeId,
      nodeName: boundedString(node.name, MAX_IDENTIFIER_CHARS) ?? execution.nodeId,
      executionId: execution.executionId,
      attempt: execution.attempt,
      executionStatus: execution.status,
      status,
      summary: boundedString(output?.summary, MAX_SUMMARY_CHARS) ??
        receipt?.evidenceSummary ?? null,
      mode: node.mode,
      mathlibRequested: node.mathlib,
      theoremName: boundedString(output?.theoremName, MAX_IDENTIFIER_CHARS),
      normalizedStatement: boundedString(output?.normalizedStatement, MAX_STATEMENT_CHARS),
      executionPolicy: executionPolicy(output?.executionPolicy),
      toolchain: boundedString(output?.toolchain, MAX_IDENTIFIER_CHARS),
      mathlibRevision: boundedString(output?.mathlibRevision, MAX_IDENTIFIER_CHARS),
      mathlibTree: boundedString(output?.mathlibTree, MAX_IDENTIFIER_CHARS),
      assumptions: boundedStringList(output?.assumptions),
      translationGaps: boundedStringList(output?.translationGaps),
      artifacts,
      proofPath: artifacts.find((artifact) => artifact.kind === "proof")?.path ?? null,
      logPath: artifacts.find((artifact) => artifact.kind === "log")?.path ?? null,
      provenanceGap,
      error,
      startedAt: execution.startedAt ?? null,
      finishedAt: execution.finishedAt ?? null,
    } satisfies Lean4ProofReceipt;
  });
  return { proofs, truncated };
}

/**
 * Validate the projection before it is serialized (#62). A receipt that cannot
 * satisfy its own contract is a bug in this module, not a client problem, so it
 * fails loudly here rather than reaching a renderer that then has to defend
 * against it.
 */
function assertProjectedReceipt(receipt: Lean4ProofReceipt): void {
  const problems: string[] = [];
  if (receipt.mathlibRevision !== null && !/^[a-f0-9]{7,64}$/.test(receipt.mathlibRevision)) {
    problems.push("mathlibRevision is not a git object id");
  }
  if (receipt.mathlibTree !== null && !/^[a-f0-9]{7,64}$/.test(receipt.mathlibTree)) {
    problems.push("mathlibTree is not a git object id");
  }
  for (const artifact of receipt.artifacts) {
    if (!isTrustedLeanArtifactPath(receipt.runId, receipt.executionId, artifact.path)) {
      problems.push("an artifact escaped the trusted Lean artifact paths");
    }
  }
  if (receipt.artifacts.length > 2) problems.push("more than two host-owned artifacts");
  if (problems.length > 0) {
    throw new Lean4RouteError(
      409,
      "LEAN4_PROOF_NOT_FOUND",
      `The stored Lean receipt for ${receipt.executionId} is inconsistent: ${problems.join("; ")}.`,
    );
  }
}

function readRunOrThrow(projectId: string, runId: string): WorkflowRunRecord {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 128) {
    throw new Lean4RouteError(400, "LEAN4_INVALID_REQUEST", "A run id is required.");
  }
  let run: WorkflowRunRecord | null;
  try {
    run = workflowStore.readRun(projectId, runId);
  } catch (error) {
    // The store's own messages may name a path, so none of them is forwarded.
    // A malformed id is the caller's fault; anything else (a corrupt or
    // unreadable event log) is not, and must not be reported as a bad request.
    if (error instanceof WorkflowStoreError && error.code === "INVALID_ID") {
      throw new Lean4RouteError(
        400,
        "LEAN4_INVALID_REQUEST",
        "The run id is not a canonical run id.",
      );
    }
    throw new Lean4RouteError(
      404,
      "LEAN4_ARTIFACT_UNREADABLE",
      `The stored run record for ${runId} could not be read.`,
    );
  }
  if (!run) {
    throw new Lean4RouteError(404, "LEAN4_RUN_NOT_FOUND", `No such workflow run: ${runId}`);
  }
  return run;
}

function requestedArtifactKind(value: unknown): Lean4ArtifactKind {
  if (value === undefined || value === "proof") return "proof";
  if (value === "log") return "log";
  throw new Lean4RouteError(
    400,
    "LEAN4_INVALID_REQUEST",
    "artifact must be either proof or log.",
  );
}

/**
 * Read a bounded prefix of a host-owned Lean artifact.
 *
 * The path is derived, never accepted: the caller names a run and an execution,
 * and `trustedLeanArtifactPaths` produces the only two paths that may be read.
 * The `isTrustedLeanArtifactPath` re-check below is therefore redundant by
 * construction and kept deliberately, so that a future change to path
 * derivation cannot silently widen what this route serves.
 */
function readBoundedArtifact(
  projectId: string,
  runId: string,
  executionId: string,
  kind: Lean4ArtifactKind,
): { path: string; size: number; text: string; truncated: boolean } {
  let relativePath: string;
  try {
    const expected = trustedLeanArtifactPaths(runId, executionId);
    relativePath = kind === "proof" ? expected.proof : expected.log;
  } catch {
    throw new Lean4RouteError(
      400,
      "LEAN4_INVALID_REQUEST",
      "The run id and execution id must be canonical workflow identities.",
    );
  }
  if (!isTrustedLeanArtifactPath(runId, executionId, relativePath)) {
    throw new Lean4RouteError(
      403,
      "LEAN4_ARTIFACT_UNTRUSTED",
      "That artifact is not a host-owned Lean artifact for this execution.",
    );
  }

  const sandbox = path.resolve(resolvePaths(projectId).sandbox);
  const components = relativePath.split("/");
  const absolute = path.resolve(sandbox, ...components);
  if (!isWithin(sandbox, absolute)) {
    // Unreachable while the path is derived rather than accepted, and asserted
    // anyway: this is the check that must survive a change to the derivation.
    throw new Lean4RouteError(
      403,
      "LEAN4_ARTIFACT_UNTRUSTED",
      "That artifact is not a host-owned Lean artifact for this execution.",
    );
  }
  let handle: number | undefined;
  try {
    // Refuse a symlinked component anywhere on the way down. The sandbox is
    // user-writable (uploads, `PUT /sandbox/file`), so "the path is derived"
    // bounds the NAME, not what the name resolves to. `runner.ts`
    // (`verifyWorkflowArtifactReceipt`) refuses symlinked components for the
    // same reason on the write side; the reader must not be the one place that
    // does not.
    let current = sandbox;
    for (const component of components) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Lean4RouteError(
          403,
          "LEAN4_ARTIFACT_UNTRUSTED",
          "That artifact path passes through a symbolic link and is not trusted.",
        );
      }
    }
    // `open` before `fstat` so size and bytes describe one opened file, and the
    // final component cannot be swapped for a link between the two calls.
    handle = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) {
      throw new Lean4RouteError(
        404,
        "LEAN4_ARTIFACT_MISSING",
        "The Lean artifact for that execution is not a regular file.",
      );
    }
    const readable = Math.min(stat.size, LEAN4_SOURCE_MAX_BYTES);
    const buffer = Buffer.alloc(readable);
    let filled = 0;
    while (filled < readable) {
      const read = fs.readSync(handle, buffer, filled, readable - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return {
      path: relativePath,
      size: stat.size,
      text: buffer.subarray(0, filled).toString("utf-8"),
      truncated: stat.size > readable,
    };
  } catch (error) {
    if (error instanceof Lean4RouteError) throw error;
    // Deliberately opaque: no absolute path, no errno, no syscall (#71).
    throw new Lean4RouteError(
      404,
      "LEAN4_ARTIFACT_MISSING",
      "No Lean artifact is stored for that execution.",
    );
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // A close failure cannot change the answer already computed.
      }
    }
  }
}

function errorResponse(reply: FastifyReply, error: unknown): Lean4ErrorResponse {
  if (error instanceof Lean4RouteError) {
    reply.code(error.status);
    return { code: error.code, detail: error.message };
  }
  reply.code(404);
  return {
    code: "LEAN4_ARTIFACT_UNREADABLE",
    detail: "The Lean proof receipt for that run could not be read.",
  };
}

export function registerLean4Routes(app: FastifyInstance): void {
  app.get<{ Params: { runId: string } }>(
    "/lean4/runs/:runId/proofs",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const run = readRunOrThrow(projectId, request.params.runId);
        const projection = projectLean4Proofs(run, projectId);
        for (const receipt of projection.proofs) assertProjectedReceipt(receipt);
        reply.header("Cache-Control", "no-store");
        return {
          runId: run.manifest.id,
          runStatus: run.state.status,
          workflowId: run.manifest.workflowId,
          truncated: projection.truncated,
          proofs: projection.proofs,
        } satisfies Lean4ProofListResponse;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.get<{
    Params: { runId: string; executionId: string };
    Querystring: { artifact?: string };
  }>("/lean4/runs/:runId/proofs/:executionId/source", async (request, reply) => {
    try {
      const projectId = currentProjectId();
      const run = readRunOrThrow(projectId, request.params.runId);
      const kind = requestedArtifactKind(request.query.artifact);
      const execution = run.state.executions[request.params.executionId];
      const node = execution
        ? run.manifest.graph.nodes.find((candidate) => candidate.id === execution.nodeId)
        : undefined;
      if (!execution || node?.kind !== "lean4") {
        throw new Lean4RouteError(
          404,
          "LEAN4_PROOF_NOT_FOUND",
          "That execution is not a Lean node execution of this run.",
        );
      }
      const stored = leanArtifactReferences(execution).find((artifact) =>
        isTrustedLeanArtifactPath(run.manifest.id, execution.executionId, artifact.path) &&
        artifact.path.endsWith(kind === "proof" ? "/Proof.lean" : "/verification.log")
      );
      // Serve only what the run DURABLY ACCEPTED. A file sitting at a trusted
      // path that the runner refused (or never received a receipt for) is not
      // this run's evidence, and reading it anyway would let a refused artifact
      // be presented as one the pipeline verified.
      if (!stored) {
        throw new Lean4RouteError(
          404,
          "LEAN4_ARTIFACT_MISSING",
          "No Lean artifact is stored for that execution.",
        );
      }
      const artifact = readBoundedArtifact(
        projectId,
        run.manifest.id,
        execution.executionId,
        kind,
      );
      reply.header("Cache-Control", "no-store");
      return {
        runId: run.manifest.id,
        executionId: execution.executionId,
        artifact: kind,
        path: artifact.path,
        size: artifact.size,
        sha256: typeof stored.sha256 === "string" && SHA256_PATTERN.test(stored.sha256)
          ? stored.sha256
          : null,
        truncated: artifact.truncated,
        text: artifact.text,
      } satisfies Lean4ProofSourceResponse;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
}
