// danbot-byok — web/src/lib/console.ts
//
// Client for the Kady "Agent Console" API, ported from agent-control-plane's
// frontend/src/api.ts. ACP talked to a standalone Bun backend on :8787 via
// Vite's import.meta.env; here the console is served same-origin by the Kady
// backend under /console/*, so this client uses the shared `apiFetch` wrapper
// (which prepends API_BASE and injects X-Project-Id) exactly like lib/pipelines.ts.

import { apiFetch } from "./projects";
import type { Loop, LoopDetail, LoopMode, Run } from "./console-types";

function jsonPost(body?: unknown): RequestInit {
  // The backend only parses a body as JSON when the content-type says so, so set
  // it explicitly. Pause/stop carry no body; resume forwards extraIterations.
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `${label} ${res.status}`);
  }
  return (await res.json()) as T;
}

/** List every goal loop the console knows about. */
export async function listLoops(): Promise<Loop[]> {
  return readJson<Loop[]>(await apiFetch("/console/loops"), "listLoops");
}

/** Fetch a single loop plus its runs. */
export async function getLoop(id: string): Promise<LoopDetail> {
  return readJson<LoopDetail>(
    await apiFetch(`/console/loops/${encodeURIComponent(id)}`),
    "getLoop",
  );
}

/** List every recorded run (loop iterations plus chat/council/workflow rows). */
export async function listRuns(): Promise<Run[]> {
  return readJson<Run[]>(await apiFetch("/console/runs"), "listRuns");
}

/** Start a new goal loop. */
export async function startLoop(
  goal: string,
  maxIterations: number,
  mode: LoopMode,
): Promise<Loop> {
  return readJson<Loop>(
    await apiFetch("/console/loops", jsonPost({ goal, mode, maxIterations })),
    "startLoop",
  );
}

/**
 * Resume a paused / awaiting-approval loop. extraIterations preserves ACP's
 * "approve N more rounds" semantics; the console backend reads it from the body.
 */
export async function resumeLoop(
  id: string,
  extraIterations: number,
): Promise<Loop> {
  return readJson<Loop>(
    await apiFetch(
      `/console/loops/${encodeURIComponent(id)}/resume`,
      jsonPost({ extraIterations }),
    ),
    "resumeLoop",
  );
}

/** Pause a running loop. */
export async function pauseLoop(id: string): Promise<Loop> {
  return readJson<Loop>(
    await apiFetch(`/console/loops/${encodeURIComponent(id)}/pause`, jsonPost()),
    "pauseLoop",
  );
}

/** Stop a loop for good. */
export async function stopLoop(id: string): Promise<Loop> {
  return readJson<Loop>(
    await apiFetch(`/console/loops/${encodeURIComponent(id)}/stop`, jsonPost()),
    "stopLoop",
  );
}
