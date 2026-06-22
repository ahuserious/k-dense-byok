/**
 * Typed HTTP client for the Archon sidecar — the Bun service that is danbot-byok's
 * "Pipelines" workflow engine. Archon runs Pi (the same SDK Kady embeds) against
 * OpenRouter, so a pipeline node and a Kady chat turn deliberate the same way.
 *
 * Kady never re-implements the DAG engine; it drives Archon over this REST/SSE surface
 * (verified live against v0.4.1) and reconciles the spend Archon reports back into Kady's
 * own cost ledger. Everything here is a thin, defensive wrapper around fetch — Archon's
 * exact response shapes are kept as `unknown`/loose records on purpose so a minor Archon
 * version change doesn't break the proxy.
 */
import { ARCHON_BASE_URL } from "../../config.ts";

// One request to Archon. Surfaces the body on failure (Archon puts the real reason there)
// and tags errors so a sidecar-down case is recognisable upstream.
async function archonFetch(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${ARCHON_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // Connection refused / DNS / abort — the sidecar is unreachable.
    throw new ArchonUnavailableError(`Archon unreachable at ${ARCHON_BASE_URL}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Archon ${res.status} ${path}: ${body.slice(0, 400)}`);
  }
  // Some endpoints (204) have no body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Distinct error type so the proxy can answer 503 (vs 500) when Archon is simply down. */
export class ArchonUnavailableError extends Error {}

/** True when the sidecar answers /api/health — lets the UI degrade gracefully (item 94). */
export async function archonHealthy(): Promise<boolean> {
  try {
    const h = (await archonFetch("/api/health")) as { status?: string } | null;
    return h?.status === "ok";
  } catch {
    return false;
  }
}

// --- workflow CRUD ----------------------------------------------------------

export async function listWorkflows(): Promise<unknown> {
  return archonFetch("/api/workflows");
}
export async function getWorkflow(name: string): Promise<unknown> {
  return archonFetch(`/api/workflows/${encodeURIComponent(name)}`);
}
export async function saveWorkflow(name: string, definition: unknown): Promise<unknown> {
  return archonFetch(`/api/workflows/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(definition),
  });
}
export async function deleteWorkflow(name: string): Promise<unknown> {
  return archonFetch(`/api/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
}
export async function validateWorkflow(definition: unknown): Promise<unknown> {
  return archonFetch("/api/workflows/validate", {
    method: "POST",
    body: JSON.stringify(definition),
  });
}

// --- run lifecycle ----------------------------------------------------------

export async function runWorkflow(name: string, body: unknown): Promise<unknown> {
  return archonFetch(`/api/workflows/${encodeURIComponent(name)}/run`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}
export async function listRuns(): Promise<unknown> {
  return archonFetch("/api/dashboard/runs");
}
export async function getRun(runId: string): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}
/**
 * Resume a `failed`/`paused` run. NOTE (verified against Archon v0.4.1 routes):
 * Archon's resume endpoint takes NO request body — it replays the run's original
 * `user_message` and skips already-completed nodes. There is no seam to inject a
 * new prompt or pick a starting node, so `body` is accepted for call-site symmetry
 * but is effectively ignored by Archon. To restart with a *new* prompt (the rescue
 * path), start a fresh run via `runWorkflow`, or feed text through a paused gate via
 * `approveRun`/`rejectRun`.
 */
export async function resumeRun(runId: string, body?: unknown): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}
export async function cancelRun(runId: string): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}
/** Abandon a non-terminal run (marks it cancelled). No request body. */
export async function abandonRun(runId: string): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/abandon`, { method: "POST" });
}
/**
 * Approve a run paused at an approval/capture-response gate. The `comment` becomes
 * `$<node-id>.output` / `$LOOP_USER_INPUT` for the continuing run — the only seam
 * for injecting new text into an in-flight run (used by the rescue path).
 */
export async function approveRun(runId: string, comment?: string): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/approve`, {
    method: "POST",
    body: JSON.stringify(comment !== undefined ? { comment } : {}),
  });
}
/**
 * Reject a run paused at an approval gate. The `reason` becomes `$REJECTION_REASON`
 * for the node's `on_reject` retry prompt (up to maxAttempts, default 3).
 */
export async function rejectRun(runId: string, reason?: string): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/reject`, {
    method: "POST",
    body: JSON.stringify(reason !== undefined ? { reason } : {}),
  });
}
/** Delete a terminal run record. */
export async function deleteRun(runId: string): Promise<unknown> {
  return archonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
}

// --- cost reconciliation ----------------------------------------------------

// Archon reports per-node spend in run events as `cost_usd` + token counts (verified in
// dag-executor.ts:1472). We don't trust a single fixed field name across versions, so we
// walk the run JSON and sum every `cost_usd`/`costUsd` and token figure we find. The
// result feeds a `role:'workflow'` ledger row so Kady budgets stay accurate even though
// the spend happened out-of-process. Returns zeros when nothing is reported (which is
// "no usage reported", not "free" — the caller decides how to treat that).
export interface RunCostTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}
export function sumRunCost(run: unknown): RunCostTotals {
  const totals: RunCostTotals = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const cost = rec.cost_usd ?? rec.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) totals.costUsd += cost;
    const tin = rec.tokensIn ?? rec.input_tokens ?? rec.inputTokens;
    if (typeof tin === "number" && Number.isFinite(tin)) totals.tokensIn += tin;
    const tout = rec.tokensOut ?? rec.output_tokens ?? rec.outputTokens;
    if (typeof tout === "number" && Number.isFinite(tout)) totals.tokensOut += tout;
    for (const value of Object.values(rec)) visit(value);
  };
  visit(run);
  return totals;
}
