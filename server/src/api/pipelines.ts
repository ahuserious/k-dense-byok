/**
 * Kady "Pipelines" routes: a thin proxy in front of the Archon sidecar (the workflow
 * engine). The web app talks to Kady same-origin; Kady forwards to Archon over its REST
 * surface. Keeping it a proxy (rather than re-implementing a DAG engine) is the whole
 * point of adopting Archon — Kady owns the project/session/cost machinery, Archon owns
 * the workflow execution.
 *
 * Two Kady-specific responsibilities live here on top of the forwarding:
 *   - graceful degradation: if the sidecar is down, answer 503 (not a 500) so the UI can
 *     show "start the Pipelines engine" instead of a broken page (checklist 94);
 *   - cost reconciliation: pull a finished run's reported spend and write a
 *     `role:'workflow'` ledger row so project budgets stay honest even though the spend
 *     happened out-of-process (checklist 89).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import * as archon from "../agent/archon/client.ts";
import { ArchonUnavailableError, sumRunCost } from "../agent/archon/client.ts";
import { recordRun } from "../cost/ledger.ts";
import { startRun as indexStartRun } from "../agent/runs-index.ts";
import { currentProjectId } from "../scope.ts";
import { corsResponseHeaders } from "../cors.ts";
import { watchRun, type RescueEvent } from "../agent/rescue-watchdog.ts";
import { runAdversarialVerification } from "../agent/verify.ts";

// Map an Archon-call failure to the right HTTP status: 503 when the sidecar is simply
// down (recoverable — the user just needs to start it), 502 for any other upstream error.
function mapError(reply: FastifyReply, err: unknown): { detail: string; archon: "down" | "error" } {
  if (err instanceof ArchonUnavailableError) {
    reply.code(503);
    return { detail: err.message, archon: "down" };
  }
  reply.code(502);
  return { detail: (err as Error).message, archon: "error" };
}

// --- run-status helpers (shared by the SSE relay + watchdog teardown) -------
//
// Archon's run object reports status under `status` or `state` in snake/camel
// case and across versions; we read both and lowercase. These mirror the
// terminal/active sets the rescue-watchdog uses against the SAME getRun shape,
// so the SSE relay closes on exactly the states the watchdog treats as done.
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "succeeded",
  "success",
  "failed",
  "cancelled",
  "canceled",
  "abandoned",
]);

/** The Archon run JSON is `{ run, events }`; pull the top-level run status string. */
function runStatusOf(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "";
  const run = (snapshot as { run?: Record<string, unknown> }).run ?? {};
  return String(run.status ?? run.state ?? "").toLowerCase();
}

function isTerminalRunStatus(snapshot: unknown): boolean {
  return TERMINAL_RUN_STATUSES.has(runStatusOf(snapshot));
}

// Read a run snapshot's events array defensively (Archon returns `{ run, events }`;
// `events` may be absent on an empty/just-started run).
function eventsOf(snapshot: unknown): Record<string, unknown>[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const events = (snapshot as { events?: unknown }).events;
  return Array.isArray(events) ? (events as Record<string, unknown>[]) : [];
}

// A stable per-event key so the SSE relay only emits each event ONCE across polls.
// Archon assigns an id/seq on most events; when it doesn't we fall back to a
// composite of the fields we read, so a re-polled identical event isn't re-sent.
function eventKey(ev: Record<string, unknown>, indexInPoll: number): string {
  const id = ev.id ?? ev.event_id ?? ev.seq ?? ev.sequence;
  if (id !== undefined && id !== null) return `id:${String(id)}`;
  const type = ev.type ?? ev.event_type ?? "";
  const node = ev.node_id ?? ev.nodeId ?? ev.node ?? "";
  const ts = ev.ts ?? ev.timestamp ?? ev.created_at ?? "";
  return `c:${String(type)}|${String(node)}|${String(ts)}|${indexInPoll}`;
}

// Pull the node id off an event (snake/camel/nested), matching the watchdog's reader.
function eventNode(ev: Record<string, unknown>): string | undefined {
  const data = (ev.data as Record<string, unknown> | undefined) ?? undefined;
  const id = ev.node_id ?? ev.nodeId ?? ev.node ?? data?.node_id;
  return id !== undefined && id !== null ? String(id) : undefined;
}

// Classify an event type into the lifecycle bucket the relay surfaces. Returns
// "node" for ordinary node lifecycle, or the verify_*/rescue_* family when Archon
// (or a Kady verify node) tagged the event with one of those types. Unknown types
// fall through as a generic "node" frame so the UI still sees activity.
function eventType(ev: Record<string, unknown>): string {
  return String(ev.type ?? ev.event_type ?? "").toLowerCase();
}

// The slice of a Fastify logger this module uses. Kept minimal so the watchdog
// helper can be called from anywhere with `req.log`.
interface MinimalLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

// Track in-flight watchdogs per runId so we never attach two for the same run and
// can abort one if needed. The watchdog tears itself down on terminal status (it
// returns with stoppedReason 'terminal'), at which point we drop the entry. This
// map is process-local — a single Kady instance owns its watchdogs; it is not
// shared across instances (the watchdog is best-effort, not a guarantee).
const activeWatchdogs = new Map<string, AbortController>();

/**
 * Fire-and-forget the background-rescue watchdog for one run. Best-effort and
 * abortable:
 *   - Skips if a watchdog is already attached for this runId (idempotent).
 *   - Runs watchRun() detached; it polls getRun and returns on terminal status,
 *     so it tears itself down — we just drop the AbortController when it settles.
 *   - Any error from the watch loop is logged, never thrown (this is detached;
 *     an unhandled rejection here would otherwise be a process-level warning).
 *
 * We pass the workflowName so the watchdog's default restart can start a NEW run
 * (the only Archon seam for injecting a re-grounding prompt on a failed/stuck
 * node). rescue/restart default to the live council + Archon calls, so this is a
 * real intervention path when the flag is on.
 */
function startRescueWatchdog(
  workflowName: string,
  runId: string,
  projectId: string,
  log: MinimalLogger,
): void {
  if (activeWatchdogs.has(runId)) return;
  const controller = new AbortController();
  activeWatchdogs.set(runId, controller);
  log.info({ runId, workflowName }, "rescue watchdog attached");

  // Detached: the run already started; the watchdog observes it out of band.
  void watchRun({
    runId,
    projectId,
    workflowName,
    signal: controller.signal,
    onEvent: (event: RescueEvent) => {
      // Watchdog lifecycle is surfaced to the run's SSE stream via the runs-index
      // (the rescue rows it writes), and logged here. We don't hold the SSE socket
      // open from this path — the /stream relay reads those rows/events on its poll.
      log.info({ runId, tag: event.tag, divergence: event.divergence }, "rescue watchdog event");
    },
  })
    .catch((err) => {
      log.warn({ err, runId }, "rescue watchdog loop errored");
    })
    .finally(() => {
      activeWatchdogs.delete(runId);
    });
}

export async function registerPipelineRoutes(app: FastifyInstance): Promise<void> {
  // Health: lets the UI decide whether to offer Pipelines or show setup help.
  app.get("/pipelines/health", async () => ({ healthy: await archon.archonHealthy() }));

  // --- workflow CRUD (proxied) ---
  app.get("/pipelines", async (_req, reply) => {
    try {
      return await archon.listWorkflows();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get("/pipelines/runs", async (_req, reply) => {
    try {
      return await archon.listRuns();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      return await archon.getWorkflow(req.params.name);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.put<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      return await archon.saveWorkflow(req.params.name, req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      return await archon.deleteWorkflow(req.params.name);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post("/pipelines/validate", async (req, reply) => {
    try {
      return await archon.validateWorkflow(req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  // --- run lifecycle (proxied) ---
  app.post<{ Params: { name: string } }>("/pipelines/:name/run", async (req, reply) => {
    try {
      // If the client picked a Kady model (the chat-merged catalogue, a "openrouter/..."
      // ref), thread it into Archon's run options as `requestOptions.model` so Archon Pi
      // resolves the SAME model chat would. The body shape is otherwise loose/unknown, so
      // we pass it through untouched aside from lifting `model` into requestOptions.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { model, ...rest } = body;
      const runBody =
        typeof model === "string" && model.length > 0
          ? {
              ...rest,
              requestOptions: {
                ...((rest.requestOptions as Record<string, unknown> | undefined) ?? {}),
                model,
              },
            }
          : body;
      const started = await archon.runWorkflow(req.params.name, runBody);

      // Best-effort: launch the background-rescue watchdog for this run. OFF by
      // default — it only attaches when KADY_RESCUE_WATCHDOG=1 (global) OR the
      // run body carries `rescueWatchdog: true` (per-run opt-in) — so a watchdog
      // restart never surprises a user who didn't ask for one. We never block or
      // fail the /run response on the watchdog: a missing runId or a watcher error
      // is logged and swallowed (the run itself already started fine).
      try {
        const perRunFlag = body.rescueWatchdog === true;
        const globalFlag = process.env.KADY_RESCUE_WATCHDOG === "1";
        if (perRunFlag || globalFlag) {
          // Probe the run response for the run id under the keys Archon uses
          // across versions; the response shape is `unknown` on purpose.
          const startedObj = (started ?? {}) as Record<string, unknown>;
          const runId =
            (typeof startedObj.runId === "string" && startedObj.runId) ||
            (typeof startedObj.run_id === "string" && startedObj.run_id) ||
            (typeof startedObj.id === "string" && startedObj.id) ||
            (startedObj.run && typeof startedObj.run === "object"
              ? (() => {
                  const r = startedObj.run as Record<string, unknown>;
                  return (
                    (typeof r.id === "string" && r.id) ||
                    (typeof r.run_id === "string" && r.run_id) ||
                    undefined
                  );
                })()
              : undefined);
          if (runId) {
            startRescueWatchdog(req.params.name, runId, currentProjectId(), req.log);
          } else {
            req.log.warn(
              { started },
              "rescue watchdog requested but no runId found on run response; not attached",
            );
          }
        }
      } catch (err) {
        req.log.warn({ err }, "failed to start rescue watchdog (run is unaffected)");
      }

      return started;
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Params: { runId: string } }>("/pipelines/runs/:runId", async (req, reply) => {
    try {
      return await archon.getRun(req.params.runId);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/pipelines/runs/:runId/resume", async (req, reply) => {
    try {
      return await archon.resumeRun(req.params.runId, req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/pipelines/runs/:runId/cancel", async (req, reply) => {
    try {
      return await archon.cancelRun(req.params.runId);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  // --- cost bridge ---
  // Fetch a finished run, sum the spend Archon reported, and record it against the active
  // project as a `role:'workflow'` row. Called when a run finishes; sessionId is derived
  // from the runId so re-calling overwrites the same logical run rather than double-billing
  // a fresh session each time.
  app.post<{ Params: { runId: string } }>(
    "/pipelines/runs/:runId/reconcile-cost",
    async (req, reply) => {
      try {
        const run = await archon.getRun(req.params.runId);
        const totals = sumRunCost(run);
        const sessionId = `pipeline-${req.params.runId}`.replace(/[^A-Za-z0-9._-]/g, "-");
        const entry = recordRun({
          sessionId,
          model: "archon-pipeline",
          role: "workflow",
          before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
          after: {
            costUsd: totals.costUsd,
            input: totals.tokensIn,
            output: totals.tokensOut,
            cacheRead: 0,
            total: totals.tokensIn + totals.tokensOut,
          },
        });

        // Backfill a runs-index row alongside the ledger row so the console shows
        // workflow runs too. role 'workflow', loopId null; task is the workflow
        // name when the Archon run object exposes one, else the runId. The run
        // object is typed `unknown` (the client doesn't trust a fixed field name
        // across Archon versions), so we probe a couple of likely keys defensively.
        // Single terminal 'completed' row: reconcile-cost runs after the workflow
        // finishes. Best-effort — never fail the reconcile on an index write.
        try {
          const runObj = (run ?? {}) as Record<string, unknown>;
          const workflowName =
            typeof runObj.workflowName === "string"
              ? runObj.workflowName
              : typeof runObj.name === "string"
                ? runObj.name
                : req.params.runId;
          indexStartRun(currentProjectId(), {
            sessionId,
            loopId: null,
            iteration: 0,
            task: workflowName,
            role: "workflow",
            status: "completed",
            model: "archon-pipeline",
            costUsd: totals.costUsd,
            tokensIn: totals.tokensIn,
            tokensOut: totals.tokensOut,
          });
        } catch (err) {
          req.log.warn({ err }, "failed to write runs-index workflow row");
        }
        return { reconciled: totals, entry };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // --- post-node VERIFY hook --------------------------------------------------
  // Run the 3x adversarial verifier against ONE node's output and return the
  // verdict. The pipeline BUILDER auto-injects verify NODES into generated
  // pipelines; this hook is the safety net for HAND-AUTHORED pipelines (which
  // have no verify node) and for the rescue watchdog to call before trusting a
  // node's asserted output. It does NOT touch Archon — verification is a pure
  // OpenRouter deliberation ledgered as `verify` rows by runAdversarialVerification,
  // so it works even when the sidecar is down (no ArchonUnavailableError path here).
  app.post<{
    Params: { runId: string };
    Body: { nodeId?: string; goal?: string; output?: string; passes?: number; model?: string };
  }>("/pipelines/runs/:runId/verify-node", async (req, reply) => {
    const body = (req.body ?? {}) as {
      nodeId?: string;
      goal?: string;
      output?: string;
      passes?: number;
      model?: string;
    };
    // goal + output are the load-bearing inputs; without them there is nothing to
    // verify. Fail with a 400 (a request problem) rather than running an empty gate.
    if (!body.goal || !body.goal.trim() || !body.output || !body.output.trim()) {
      reply.code(400);
      return { detail: "goal and output are required to verify a node" };
    }
    try {
      // sessionId clusters the verify ledger rows under this run (mirrors the
      // reconcile-cost route's `pipeline-<runId>` derivation, with the node id so
      // multiple node verifications on one run stay distinguishable).
      const nodeSuffix = body.nodeId ? `-${body.nodeId}` : "";
      const sessionId = `pipeline-${req.params.runId}${nodeSuffix}`.replace(
        /[^A-Za-z0-9._-]/g,
        "-",
      );
      const result = await runAdversarialVerification({
        goal: body.goal,
        output: body.output,
        projectId: currentProjectId(),
        sessionId,
        passes: body.passes,
        model: body.model,
      });
      return {
        runId: req.params.runId,
        nodeId: body.nodeId ?? null,
        passed: result.passed,
        passes: result.passes,
        costUsd: result.costUsd,
      };
    } catch (err) {
      // The verifier calls OpenRouter, not Archon — a failure here is an upstream
      // model/provider error, so 502 (mapError handles ArchonUnavailableError too
      // in case a future chat path surfaces it).
      return mapError(reply, err);
    }
  });

  // --- poll-backed SSE relay --------------------------------------------------
  // Archon has NO per-run SSE on the SQLite backend (its dashboard stream is
  // notification-only and lags ~10s — see rescue-watchdog.ts), so we POLL getRun
  // on an interval and translate the diff into a text/event-stream the UI can
  // consume same-origin. We emit:
  //   - one `node` frame per NEW node lifecycle event (with the running cost delta,
  //     Kady-priced via sumRunCost on the whole snapshot),
  //   - `verify_*` / `rescue_*` frames for events Archon (or a Kady verify node /
  //     the watchdog's runs-index trail) tags with those types,
  //   - a terminal `done` frame, then close, when the run reaches a terminal status.
  // Socket hygiene mirrors sessions.ts: hijack the reply, write the SSE head, and
  // raw.end() on every exit path (terminal, client close, error) so sockets don't
  // leak. The client-close handler aborts the poll loop.
  app.get<{ Params: { runId: string }; Querystring: { pollMs?: string } }>(
    "/pipelines/runs/:runId/stream",
    async (req, reply) => {
      const runId = req.params.runId;
      // Clamp the poll period to a sane band: fast enough to feel live, slow
      // enough not to hammer a flaky SQLite Archon. Default 2s.
      const requestedPollMs = Number(req.query.pollMs);
      const pollMs = Number.isFinite(requestedPollMs)
        ? Math.min(Math.max(requestedPollMs, 500), 15_000)
        : 2_000;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...corsResponseHeaders(req.headers.origin),
      });
      const write = (frame: unknown): void => {
        if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      };

      // Client gone -> stop polling. `closed` is read by the loop between awaits so
      // an in-flight getRun resolves and then the loop exits without writing to a
      // dead socket.
      let closed = false;
      req.raw.on("close", () => {
        closed = true;
      });

      // De-dupe across polls: emit each Archon event exactly once. Cost is reported
      // as a DELTA off the prior poll's Kady-priced total so the UI can attribute
      // spend incrementally (the absolute total is sent too).
      const seenEvents = new Set<string>();
      let lastCostUsd = 0;

      try {
        // Guard the loop with a hard iteration cap as a backstop against a run that
        // never terminates AND a client that never disconnects (e.g. a hung proxy).
        // 2s polls * 5400 = ~3h ceiling; the normal exit is terminal-status or close.
        const MAX_POLLS = 5_400;
        for (let poll = 0; poll < MAX_POLLS && !closed; poll++) {
          let snapshot: unknown;
          try {
            snapshot = await archon.getRun(runId);
          } catch (err) {
            // Sidecar down or a flaky read. Surface it as an `error` frame; if the
            // sidecar is simply unavailable we close (no point polling a dead
            // sidecar), otherwise we keep polling through a transient blip.
            if (err instanceof ArchonUnavailableError) {
              write({ type: "error", archon: "down", message: err.message });
              break;
            }
            write({ type: "error", archon: "error", message: (err as Error).message });
            // transient: wait one period and retry.
            await delay(pollMs, () => closed);
            continue;
          }

          if (closed) break;

          // Emit NEW events only. Cost delta is computed once per poll off the whole
          // snapshot (sumRunCost walks the run JSON; cheap relative to the model work).
          const totalCostUsd = sumRunCost(snapshot).costUsd;
          const costDeltaUsd = totalCostUsd - lastCostUsd;
          lastCostUsd = totalCostUsd;

          const events = eventsOf(snapshot);
          // Attribute the poll's whole cost delta to the FIRST new event we emit
          // this poll, so the UI's running sum of per-frame deltas equals the run
          // total. `costDeltaUnattributed` flips false once we've placed it.
          let costDeltaUnattributed = true;
          for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const key = eventKey(ev, i);
            if (seenEvents.has(key)) continue;
            seenEvents.add(key);

            const type = eventType(ev);
            // verify_* / rescue_* tags pass through with their family preserved so
            // the UI can badge them distinctly; everything else is a `node` frame.
            const family =
              type.startsWith("verify_") || type.startsWith("rescue_") ? type : "node";
            const frameCostDeltaUsd = costDeltaUnattributed ? costDeltaUsd : 0;
            costDeltaUnattributed = false;
            write({
              type: family,
              event: type || "node",
              nodeId: eventNode(ev) ?? null,
              // The poll's whole cost delta rides the first new frame; the absolute
              // Kady-priced total rides every frame for display.
              costDeltaUsd: frameCostDeltaUsd,
              totalCostUsd,
              data: ev.data ?? null,
            });
          }
          // If nothing new this poll but cost moved (e.g. a node still running and
          // streaming tokens that Archon folds into the run total without a fresh
          // event), surface the delta so spend stays live.
          if (costDeltaUnattributed && costDeltaUsd !== 0) {
            write({ type: "cost", costDeltaUsd, totalCostUsd });
          }

          if (isTerminalRunStatus(snapshot)) {
            write({
              type: "done",
              status: runStatusOf(snapshot),
              totalCostUsd,
            });
            break;
          }

          await delay(pollMs, () => closed);
        }
      } catch (err) {
        // Last-resort: a write/JSON/anything failure inside the loop. Try to tell
        // the client, then fall through to the socket close below.
        write({ type: "error", message: (err as Error).message });
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    },
  );
}

// Sleep `ms`, but resolve early if `shouldStop()` flips true (checked on a short
// inner tick) so a client disconnect mid-wait ends the SSE loop promptly rather
// than after a full poll period.
function delay(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stepMs = Math.min(ms, 250);
    let elapsed = 0;
    const tick = (): void => {
      if (shouldStop() || elapsed >= ms) {
        resolve();
        return;
      }
      elapsed += stepMs;
      setTimeout(tick, stepMs);
    };
    setTimeout(tick, stepMs);
  });
}
