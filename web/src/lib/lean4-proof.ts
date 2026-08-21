import { apiFetch } from "@/lib/projects";

/**
 * Typed client for the Lean 4 proof-artifact surface
 * (`server/src/api/lean4.ts`). The wire shapes below are the published
 * contract in `interfaces/F4-lean4.md`; lane F6's inspector and lane F11's
 * skill surface both consume THIS module rather than re-deriving a Lean
 * receipt from the run event log.
 *
 * There is exactly one proof renderer and one client for it. If you find
 * yourself parsing `node_succeeded.data.output` for `kind: "lean4"` anywhere
 * else, that is the duplicate this module exists to prevent.
 */

export type Lean4VerificationStatus = "verified" | "failed" | "unavailable";
export type Lean4ExecutionPolicy = "disabled" | "unsandboxed-opt-in";
export type Lean4ArtifactKind = "proof" | "log";

/** Mirrors `WorkflowNodeExecutionStatus` in `server/src/workflows/run-state.ts`. */
export type Lean4ExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export interface Lean4ArtifactReceipt {
  kind: Lean4ArtifactKind;
  path: string;
  size: number;
  sha256: string | null;
  mediaType: string | null;
}

/**
 * Why provenance is absent, when it is. Mirrors `Lean4ProvenanceGap` in
 * `server/src/api/lean4.ts`.
 *
 * `discarded-on-failure` is a runtime gap in `server/src/workflows/runner.ts`,
 * not a verifier omission: node output is persisted only on `node_succeeded`,
 * so a REJECTED Lean verification loses its mathlib pin before it is stored.
 * The renderer says that, rather than the false "the verifier never reported
 * it".
 */
export type Lean4ProvenanceGap = "none" | "not-yet-executed" | "discarded-on-failure";

export interface Lean4ProofReceipt {
  runId: string;
  nodeId: string;
  nodeName: string;
  executionId: string;
  attempt: number;
  executionStatus: Lean4ExecutionStatus;
  /** `null` until the trusted verifier returned a receipt for this attempt. */
  status: Lean4VerificationStatus | null;
  summary: string | null;
  mode: "verify" | "solve";
  mathlibRequested: boolean;
  theoremName: string | null;
  normalizedStatement: string | null;
  executionPolicy: Lean4ExecutionPolicy | null;
  toolchain: string | null;
  /** The pinned Mathlib commit the verifier ran against. Provenance, row 10. */
  mathlibRevision: string | null;
  /** The pinned Mathlib tree object at that commit. Provenance, row 10. */
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
  runStatus: string;
  workflowId: string;
  truncated: boolean;
  proofs: Lean4ProofReceipt[];
}

export interface Lean4ProofSource {
  runId: string;
  executionId: string;
  artifact: Lean4ArtifactKind;
  path: string;
  size: number;
  sha256: string | null;
  truncated: boolean;
  text: string;
}

export class Lean4ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, detail: string, code?: string) {
    super(detail);
    this.name = "Lean4ApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseLean4Response<T>(response: Response): Promise<T> {
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
        : `Lean 4 proof request failed with status ${response.status}.`;
    const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
    throw new Lean4ApiError(response.status, detail, code);
  }
  return body as T;
}

export async function listLean4RunProofs(
  projectId: string,
  runId: string,
): Promise<Lean4ProofListResponse> {
  const response = await apiFetch(
    `/lean4/runs/${encodeURIComponent(runId)}/proofs`,
    {},
    projectId,
  );
  return parseLean4Response<Lean4ProofListResponse>(response);
}

export async function readLean4ProofSource(
  projectId: string,
  runId: string,
  executionId: string,
  artifact: Lean4ArtifactKind = "proof",
): Promise<Lean4ProofSource> {
  const query = new URLSearchParams({ artifact });
  const response = await apiFetch(
    `/lean4/runs/${encodeURIComponent(runId)}/proofs/${encodeURIComponent(executionId)}/source?${query}`,
    {},
    projectId,
  );
  return parseLean4Response<Lean4ProofSource>(response);
}

/**
 * The single place that decides what a receipt *means* for display, so the
 * inspector, the skill surface, and the renderer cannot disagree about it.
 *
 * `unavailable` is deliberately distinct from `errored`: the first is the
 * verifier reporting that it could not run (no toolchain, no pinned Mathlib),
 * the second is the node failing before any verifier receipt existed.
 */
export type Lean4DisplayState =
  | "verified"
  | "failed"
  | "unavailable"
  | "errored"
  | "running"
  | "pending";

export function lean4DisplayState(receipt: Lean4ProofReceipt): Lean4DisplayState {
  if (receipt.status !== null) return receipt.status;
  if (receipt.executionStatus === "failed" || receipt.executionStatus === "interrupted") {
    return "errored";
  }
  return receipt.executionStatus === "running" ? "running" : "pending";
}

/**
 * A verified Lean node MUST carry both host-owned receipts; the runner refuses
 * to record one without the other. A receipt that claims `verified` with an
 * incomplete artifact pair therefore describes a tampered event log, and the
 * renderer says so rather than showing a green result.
 */
export function lean4ReceiptPairComplete(receipt: Lean4ProofReceipt): boolean {
  return receipt.proofPath !== null && receipt.logPath !== null;
}

export function lean4ProvenanceComplete(receipt: Lean4ProofReceipt): boolean {
  return receipt.mathlibRevision !== null && receipt.mathlibTree !== null;
}

/** The honest reason a missing provenance field is missing. */
export function lean4MissingProvenanceReason(receipt: Lean4ProofReceipt): string {
  switch (receipt.provenanceGap) {
    case "not-yet-executed":
      return "This Lean node has not produced a verifier receipt yet.";
    case "discarded-on-failure":
      return "The run stored no verifier output for this attempt, so the Mathlib pin the verifier reported was not retained.";
    default:
      return "The verifier reported no value for this attempt.";
  }
}

/** A short, non-decorative object-id form. Never the only rendering of the id. */
export function shortGitObjectId(value: string): string {
  return /^[a-f0-9]{12,64}$/.test(value) ? value.slice(0, 12) : value;
}
