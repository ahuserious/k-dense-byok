/**
 * Agent Console HTTP API.
 *
 * Serves the Kady "Agent Console" (web/src/lib/console.ts) same-origin under
 * /console/*. The console observes long-running goal loops and the runs they —
 * plus chat/subagent/workflow turns — spawn, all read out of the file-backed
 * run/loop index (agent/runs-index.ts).
 *
 * Shape mapping: runs-index stores camelCase records (RunRecord / LoopRecord);
 * the frontend types (web/src/lib/console-types.ts) are snake_case and carry a
 * couple of nullable fields the internal records don't (started_at vs ts, etc.).
 * The two `toClient*` helpers below are the single translation layer between the
 * storage format and the wire format, so the rest of the file works in storage
 * terms.
 *
 * IMPORTANT — loop EXECUTION is not wired here. The upstream agent-control-plane
 * drove loops with an in-process orchestrator (backend/src/loop.ts → a
 * `goal-loop.ts` port that does not yet exist in this server). Until that engine
 * lands, the lifecycle routes below operate on the PERSISTED loop doc only
 * (create / pause / resume / stop change status + iteration cap via runs-index);
 * a created loop is recorded and observable but no agent runs are dispatched for
 * it. The read routes (runs / loops listing) are fully functional today and
 * surface every recorded run — chat turns, subagents, and workflow rows — which
 * is the backfill goal. See the TODO on startLoopHandler.
 */
import type { FastifyInstance } from "fastify";
import { currentProjectId } from "../scope.ts";
import {
  getLoop,
  listLoops,
  listRuns,
  listRunsForLoop,
  type LoopMode,
  type LoopRecord,
  type RunRecord,
} from "../agent/runs-index.ts";
import { pauseLoop, resumeLoop, startLoop, stopLoop } from "../agent/goal-loop.ts";

// How many runs the unfiltered /console/runs feed returns. The store sorts
// newest-first, so this is the most-recent N. Matches the spirit of ACP's
// listRuns() default page.
const DEFAULT_RUN_LIMIT = 200;

/**
 * Coerce a maybe-missing numeric body field into an int within [min, max],
 * falling back when absent/invalid. Local copy of agent-control-plane's
 * util.clampInt (there's no shared util module in this server yet). Treats
 * null/undefined as "absent" so the fallback wins instead of clamping to min.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---- Storage → wire mapping -----------------------------------------------

// runs-index RunStatus is a subset of the wire status union; both are the same
// three strings, so this is a straight pass-through kept explicit for clarity.
function toClientRun(record: RunRecord): Record<string, unknown> {
  const startedAtIso = new Date(record.ts * 1000).toISOString();
  // A terminal row (completed/failed) carries the finish ts; a still-running row
  // has no completion. We only persist a single ts per row, so for terminal rows
  // we report it as both started_at and completed_at (the original start ts is
  // not retained after finishRun folds to the latest row). Loop iterations that
  // need precise start/finish should be revisited once the loop engine lands.
  const completedAtIso =
    record.status === "running" ? null : startedAtIso;
  return {
    id: record.id,
    loop_id: record.loopId,
    iteration: record.iteration,
    task: record.task,
    role: record.role,
    parent_run_id: record.parentRunId ?? null,
    reasoning: record.reasoning ?? null,
    status: record.status,
    output: record.output ?? null,
    model: record.model ?? null,
    cost_usd: record.costUsd ?? null,
    input_tokens: record.tokensIn ?? null,
    output_tokens: record.tokensOut ?? null,
    num_turns: record.numTurns ?? null,
    session_id: record.sessionId ?? null,
    started_at: startedAtIso,
    completed_at: completedAtIso,
  };
}

function toClientLoop(record: LoopRecord): Record<string, unknown> {
  return {
    id: record.id,
    goal: record.goal,
    status: record.status,
    mode: record.mode,
    max_iterations: record.maxIterations,
    iterations: record.iteration,
    // The persisted loop doc has no model/workspace columns; the wire type allows
    // null for both. They were ACP loop.ts concerns (Pi model + workspace dir).
    model: null,
    workspace: null,
    last_error: record.lastError ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

// ---- Routes ----------------------------------------------------------------

export async function registerConsoleRoutes(app: FastifyInstance): Promise<void> {
  // --- runs (history feed) ---
  // Every recorded run for the active project, newest first: loop iterations
  // plus the backfilled chat / subagent / workflow rows.
  app.get("/console/runs", async () => {
    return listRuns(currentProjectId(), DEFAULT_RUN_LIMIT).map(toClientRun);
  });

  // --- loops ---
  app.get("/console/loops", async () => {
    return listLoops(currentProjectId()).map(toClientLoop);
  });

  app.get<{ Params: { id: string } }>("/console/loops/:id", async (req, reply) => {
    const projectId = currentProjectId();
    const loop = getLoop(projectId, req.params.id);
    if (!loop) {
      reply.code(404);
      return { detail: "No such loop" };
    }
    const runs = listRunsForLoop(projectId, loop.id).map(toClientRun);
    return { ...toClientLoop(loop), runs };
  });

  app.post<{ Body: { goal?: string; mode?: string; maxIterations?: unknown } }>(
    "/console/loops",
    startLoopHandler,
  );

  app.post<{ Params: { id: string }; Body: { extraIterations?: unknown } }>(
    "/console/loops/:id/resume",
    async (req, reply) => {
      const projectId = currentProjectId();
      const existing = getLoop(projectId, req.params.id);
      if (!existing) {
        reply.code(404);
        return { detail: "No such loop" };
      }
      // Preserve ACP's "approve N more rounds" semantics: resumeLoop lifts the
      // iteration cap by extraIterations and re-kicks the engine.
      const extraIterations = clampInt((req.body ?? {}).extraIterations, 1, 100, 5);
      const updated = resumeLoop(projectId, req.params.id, extraIterations);
      return toClientLoop(updated ?? existing);
    },
  );

  app.post<{ Params: { id: string } }>("/console/loops/:id/pause", async (req, reply) => {
    const projectId = currentProjectId();
    const updated = pauseLoop(projectId, req.params.id);
    if (!updated) {
      reply.code(404);
      return { detail: "No such loop" };
    }
    return toClientLoop(updated);
  });

  app.post<{ Params: { id: string } }>("/console/loops/:id/stop", async (req, reply) => {
    const projectId = currentProjectId();
    const updated = stopLoop(projectId, req.params.id);
    if (!updated) {
      reply.code(404);
      return { detail: "No such loop" };
    }
    return toClientLoop(updated);
  });
}

/**
 * Create a goal loop and start the engine. startLoop (agent/goal-loop.ts, the port
 * of agent-control-plane's loop.ts) mints the loop doc, sets status 'running', and
 * dispatches orchestrator/worker (or ralph) runs against Kady's in-process Pi. It
 * captures projectId explicitly and passes it into the detached runLoop, so the
 * async execution does not depend on the request's AsyncLocalStorage scope (which
 * is gone once this handler returns).
 */
async function startLoopHandler(
  req: { body?: { goal?: string; mode?: string; maxIterations?: unknown } },
  reply: { code(status: number): unknown },
): Promise<Record<string, unknown>> {
  const body = req.body ?? {};
  const goal = String(body.goal ?? "").trim();
  if (!goal) {
    reply.code(400);
    return { detail: "goal is required" };
  }
  const maxIterations = clampInt(body.maxIterations, 1, 100, 10);
  const mode: LoopMode = body.mode === "ralph" ? "ralph" : "orchestrated";
  const loop = startLoop({ projectId: currentProjectId(), goal, mode, maxIterations });
  reply.code(201);
  return toClientLoop(loop);
}
