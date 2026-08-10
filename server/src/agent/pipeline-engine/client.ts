/**
 * Typed HTTP client for the vendored workflow engine (Pipeline engine, served from
 * server/vendor/pipeline-engine as the "Scientific DAG Workflow Designer").
 * The engine runs Pi (the same SDK Kady embeds) against OpenRouter, so a
 * pipeline node and a Kady chat turn deliberate the same way.
 *
 * Kady never re-implements the DAG engine; it drives it over this REST surface
 * (verified live against v0.4.1) and reconciles the spend the engine reports
 * back into Kady's own cost ledger. Everything here is a thin, defensive
 * wrapper around fetch — the engine's exact response shapes are kept as
 * `unknown`/loose records on purpose so a minor engine version change doesn't
 * break the proxy.
 */
import { PIPELINE_ENGINE_BASE_URL } from "../../config.ts";

export const PIPELINE_ENGINE_LIST_TIMEOUT_MS = 5_000;

interface PipelineEngineRequestLifecycle {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// One request to Pipeline engine. Surfaces the body on failure (Pipeline engine puts the real reason there)
// and tags errors so a sidecar-down case is recognisable upstream.
async function pipelineEngineFetch(
  path: string,
  init?: RequestInit,
  lifecycle?: PipelineEngineRequestLifecycle,
): Promise<unknown> {
  const controller = lifecycle ? new AbortController() : undefined;
  let abortCause: "external" | "timeout" | undefined;
  const abortRequest = (cause: "external" | "timeout"): void => {
    if (!controller || controller.signal.aborted) return;
    abortCause = cause;
    controller.abort();
  };
  const externalSignal = lifecycle?.signal;
  const onExternalAbort = (): void => abortRequest("external");
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = lifecycle?.timeoutMs === undefined
    ? undefined
    : setTimeout(() => abortRequest("timeout"), lifecycle.timeoutMs);
  let responseReceived = false;
  try {
    const res = await fetch(`${PIPELINE_ENGINE_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...(controller ? { signal: controller.signal } : {}),
    });
    responseReceived = true;
    if (!res.ok) {
      const body = await res.text().catch((error) => {
        if (abortCause) throw error;
        return "";
      });
      throw new Error(`Pipeline engine ${res.status} ${path}: ${body.slice(0, 400)}`);
    }
    // Some endpoints (204) have no body.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (abortCause === "timeout") {
      throw new PipelineEngineTimeoutError(
        `Pipeline engine request ${path} timed out after ${lifecycle?.timeoutMs}ms.`,
      );
    }
    if (abortCause === "external") {
      throw new PipelineEngineRequestAbortedError(
        `Pipeline engine request ${path} was aborted by its caller.`,
      );
    }
    if (responseReceived) throw err;
    // Connection refused / DNS — the sidecar is unreachable.
    throw new PipelineEngineUnavailableError(`Pipeline engine unreachable at ${PIPELINE_ENGINE_BASE_URL}: ${(err as Error).message}`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Distinct error type so the proxy can answer 503 (vs 500) when Pipeline engine is simply down. */
export class PipelineEngineUnavailableError extends Error {}

/** A bounded sidecar request exceeded its client-owned deadline. */
export class PipelineEngineTimeoutError extends PipelineEngineUnavailableError {}

/** The caller cancelled a sidecar request through its optional AbortSignal. */
export class PipelineEngineRequestAbortedError extends PipelineEngineUnavailableError {}

/** True when the sidecar answers /api/health — lets the UI degrade gracefully (item 94). */
export async function pipelineEngineHealthy(): Promise<boolean> {
  try {
    const h = (await pipelineEngineFetch("/api/health")) as { status?: string } | null;
    return h?.status === "ok";
  } catch {
    return false;
  }
}

// --- workflow CRUD ----------------------------------------------------------

export interface PipelineWorkflowScope {
  cwd: string;
  codebaseId: string;
}

function workflowScopeQuery(scope?: PipelineWorkflowScope): string {
  if (!scope) return "";
  const query = new URLSearchParams({ cwd: scope.cwd, codebaseId: scope.codebaseId });
  return `?${query.toString()}`;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value &&
    typeof value === "object" &&
    "aborted" in value &&
    typeof (value as AbortSignal).addEventListener === "function",
  );
}

export async function listWorkflows(
  scopeOrSignal?: PipelineWorkflowScope | AbortSignal,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const scope = isAbortSignal(scopeOrSignal) ? undefined : scopeOrSignal;
  const signal = isAbortSignal(scopeOrSignal) ? scopeOrSignal : externalSignal;
  return pipelineEngineFetch(`/api/workflows${workflowScopeQuery(scope)}`, undefined, {
    signal,
    timeoutMs: PIPELINE_ENGINE_LIST_TIMEOUT_MS,
  });
}
export async function getWorkflow(
  workflowId: string,
  scope?: PipelineWorkflowScope,
): Promise<unknown> {
  return pipelineEngineFetch(
    `/api/workflows/${encodeURIComponent(workflowId)}${workflowScopeQuery(scope)}`,
  );
}
export async function saveWorkflow(
  workflowId: string,
  definition: unknown,
  scope?: PipelineWorkflowScope,
): Promise<unknown> {
  return pipelineEngineFetch(
    `/api/workflows/${encodeURIComponent(workflowId)}${workflowScopeQuery(scope)}`,
    {
      method: "PUT",
      body: JSON.stringify(definition),
    },
  );
}
export async function deleteWorkflow(
  workflowId: string,
  scope?: PipelineWorkflowScope,
): Promise<unknown> {
  return pipelineEngineFetch(
    `/api/workflows/${encodeURIComponent(workflowId)}${workflowScopeQuery(scope)}`,
    { method: "DELETE" },
  );
}
export async function validateWorkflow(definition: unknown): Promise<unknown> {
  return pipelineEngineFetch("/api/workflows/validate", {
    method: "POST",
    body: JSON.stringify(definition),
  });
}

// --- codebase registration --------------------------------------------------

/** List the codebases (target repos) Pipeline engine knows about. Shape kept loose. */
export async function listCodebases(): Promise<unknown> {
  return pipelineEngineFetch("/api/codebases");
}

/**
 * Register a local repo path as a pipeline-engine codebase (idempotent). The engine's POST
 * /api/codebases rejects a duplicate path, so we first list and short-circuit if
 * a codebase already points at `localPath`. The list shape is loose, so we walk
 * each entry and treat any string field equal to `localPath` as a match.
 */
export async function registerCodebase(localPath: string): Promise<unknown> {
  const existing = await listCodebases();
  if (Array.isArray(existing)) {
    const alreadyRegistered = existing.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      return Object.values(entry as Record<string, unknown>).some(
        (value) => value === localPath,
      );
    });
    if (alreadyRegistered) return existing.find((entry) =>
      entry && typeof entry === "object" &&
      Object.values(entry as Record<string, unknown>).some((v) => v === localPath),
    );
  }
  return pipelineEngineFetch("/api/codebases", {
    method: "POST",
    body: JSON.stringify({ path: localPath }),
  });
}

// --- run lifecycle ----------------------------------------------------------

export async function runWorkflow(
  workflowId: string,
  body: unknown,
  scope?: PipelineWorkflowScope,
): Promise<unknown> {
  return pipelineEngineFetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/run${workflowScopeQuery(scope)}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...((body && typeof body === "object" && !Array.isArray(body)) ? body : {}),
        ...(scope ? { cwd: scope.cwd, codebaseId: scope.codebaseId, workflowId } : {}),
      }),
    },
  );
}
export async function listRuns(): Promise<unknown> {
  return pipelineEngineFetch("/api/dashboard/runs");
}
export async function getRun(runId: string): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}
/**
 * Resume a `failed`/`paused` run. NOTE (verified against Pipeline engine v0.4.1 routes):
 * Pipeline engine's resume endpoint takes NO request body — it replays the run's original
 * `user_message` and skips already-completed nodes. There is no seam to inject a
 * new prompt or pick a starting node, so `body` is accepted for call-site symmetry
 * but is effectively ignored by Pipeline engine. To restart with a *new* prompt (the rescue
 * path), start a fresh run via `runWorkflow`, or feed text through a paused gate via
 * `approveRun`/`rejectRun`.
 */
export async function resumeRun(runId: string, body?: unknown): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}
export async function cancelRun(runId: string): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}
/** Abandon a non-terminal run (marks it cancelled). No request body. */
export async function abandonRun(runId: string): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/abandon`, { method: "POST" });
}
/**
 * Approve a run paused at an approval/capture-response gate. The `comment` becomes
 * `$<node-id>.output` / `$LOOP_USER_INPUT` for the continuing run — the only seam
 * for injecting new text into an in-flight run (used by the rescue path).
 */
export async function approveRun(runId: string, comment?: string): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/approve`, {
    method: "POST",
    body: JSON.stringify(comment !== undefined ? { comment } : {}),
  });
}
/**
 * Reject a run paused at an approval gate. The `reason` becomes `$REJECTION_REASON`
 * for the node's `on_reject` retry prompt (up to maxAttempts, default 3).
 */
export async function rejectRun(runId: string, reason?: string): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/reject`, {
    method: "POST",
    body: JSON.stringify(reason !== undefined ? { reason } : {}),
  });
}
/** Delete a terminal run record. */
export async function deleteRun(runId: string): Promise<unknown> {
  return pipelineEngineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
}

// --- cost reconciliation ----------------------------------------------------

// Pipeline engine reports per-node spend in run events as `cost_usd` + token counts (verified in
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
