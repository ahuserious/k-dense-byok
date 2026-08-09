/**
 * Kady "Pipelines" routes: a thin proxy in front of the vendored workflow
 * engine (server/vendor/pipeline-engine, spawned by start.mjs — the "Scientific
 * DAG Workflow Designer"). The web app talks to Kady same-origin; Kady
 * forwards to the engine over its REST surface. Keeping it a proxy (rather
 * than re-implementing a second DAG engine in-process) is the whole point of
 * vendoring the engine — Kady owns the project/session/cost machinery, the
 * engine owns its workflow execution.
 *
 * Two Kady-specific responsibilities live here on top of the forwarding:
 *   - graceful degradation: if the engine is down, answer 503 (not a 500) so
 *     the UI can show "the workflow engine is not running" instead of a broken
 *     page;
 *   - cost reconciliation: durably reserve before dispatch, correlate the
 *     async engine run by an echoed admission label, and settle actual
 *     cap-counted usage after a terminal snapshot.
 *
 * PORT NOTE (E1): the reference tree additionally wired a background rescue
 * watchdog and a /verify-node adversarial-verification hook into these routes.
 * Both lean on reference-era agent code (pre-0.42 protocol) and belong to the
 * background-watch epic (E5); they are intentionally NOT ported here.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import * as pipelineEngine from "../agent/pipeline-engine/client.ts";
import { PipelineEngineUnavailableError, sumRunCost } from "../agent/pipeline-engine/client.ts";
import {
  billingForWorkflowResolution,
  declaredBillingModeMatches,
} from "../cost/billing.ts";
import { currentProjectId } from "../scope.ts";
import { corsResponseHeaders } from "../cors.ts";
import { resolvePaths } from "../projects.ts";
import { resolveWorkflowModel } from "../agent/workflow-model-resolution.ts";
import type { ModelRequest } from "../workflows/schema.ts";
import {
  persistPipelineAdmission,
  pipelineAdmissionCorrelationLabel,
  pipelineAdmissionIdFromEngineSnapshot,
  PIPELINE_ADMISSION_LABEL_PREFIX,
  recoverPipelineAdmission,
  reservePipelineNodeBudgets,
  updatePipelineAdmission,
  WorkflowBudgetError,
  type PipelineBudgetAdmission,
  type PipelineNodeBudgetHook,
} from "../workflows/budget.ts";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined;
}

function strictest(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

interface UnresolvedPipelineNodeBudgetHook {
  nodeId: string;
  maxTokens: number;
  maxCostUsd: number;
  declaredBillingMode: "inherit" | "api" | "subscription";
  modelRequest: ModelRequest;
}

function executablePipelineNode(node: Record<string, unknown>): boolean {
  return typeof node.command === "string" || typeof node.prompt === "string" ||
    recordOf(node.loop) !== undefined;
}

/** Extract complete settings-bearing hooks from the engine's real `{workflow}` response. */
export function unresolvedPipelineNodeBudgetHooks(
  definition: unknown,
): UnresolvedPipelineNodeBudgetHook[] {
  let root = recordOf(definition);
  for (const key of ["workflow", "definition", "data"] as const) {
    const nested = recordOf(root?.[key]);
    if (nested && Array.isArray(nested.nodes)) root = nested;
  }
  const nodes = root?.nodes;
  if (!Array.isArray(nodes)) {
    throw new WorkflowBudgetError(
      "INVALID_ARGUMENT",
      "Pipeline engine workflow response has no executable nodes array.",
    );
  }
  const workflowLimits = recordOf(root?.limits);
  const hooks: UnresolvedPipelineNodeBudgetHook[] = [];
  for (const [index, candidate] of nodes.entries()) {
    const node = recordOf(candidate);
    if (!node || !executablePipelineNode(node)) continue;
    const settings = recordOf(node?.settings);
    const budget = recordOf(settings?.budget);
    if (!settings || !budget) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Executable pipeline node ${String(node?.id ?? index)} has no settings.budget NodeSpec hook.`,
      );
    }
    if (positiveInteger(budget.maxTokens) === undefined) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has invalid budget.maxTokens.`,
      );
    }
    if (finiteNonNegative(budget.maxCostUsd) === undefined) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has invalid budget.maxCostUsd.`,
      );
    }
    const nodeLimits = recordOf(node?.limits);
    const maxTokens = strictest([
      positiveInteger(budget.maxTokens),
      positiveInteger(nodeLimits?.maxTokens),
      positiveInteger(workflowLimits?.maxTokens),
    ]);
    const maxCostUsd = strictest([
      finiteNonNegative(budget.maxCostUsd),
      finiteNonNegative(nodeLimits?.maxCostUsd),
      finiteNonNegative(workflowLimits?.maxCostUsd),
    ]);
    if (maxTokens === undefined || maxCostUsd === undefined) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has an incomplete NodeSpec budget; maxTokens and maxCostUsd must resolve before provider access.`,
      );
    }
    const configuredBillingMode = settings?.billingMode;
    if (
      configuredBillingMode !== undefined && configuredBillingMode !== "inherit" &&
      configuredBillingMode !== "api" && configuredBillingMode !== "subscription"
    ) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${String(node?.id ?? index)} has invalid settings.billingMode.`,
      );
    }
    const billingMode = configuredBillingMode ?? "inherit";
    const modelRequest = recordOf(settings.model);
    if (!modelRequest) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Executable pipeline node ${String(node?.id ?? index)} has no settings.model resolution request.`,
      );
    }
    hooks.push({
      nodeId: String(node?.id ?? `node-${index}`),
      maxTokens,
      maxCostUsd,
      declaredBillingMode: billingMode,
      modelRequest: modelRequest as ModelRequest,
    });
  }
  if (hooks.length === 0) {
    throw new WorkflowBudgetError(
      "INVALID_ARGUMENT",
      "Executable pipeline workflow produced no resolved NodeSpec budget hooks.",
    );
  }
  return hooks;
}

export async function pipelineNodeBudgetHooks(
  definition: unknown,
  context: { projectId: string; sessionId: string },
  resolveModel: typeof resolveWorkflowModel = resolveWorkflowModel,
): Promise<PipelineNodeBudgetHook[]> {
  const paths = resolvePaths(context.projectId);
  const unresolved = unresolvedPipelineNodeBudgetHooks(definition);
  return Promise.all(unresolved.map(async (hook) => {
    let resolution: Awaited<ReturnType<typeof resolveWorkflowModel>>;
    try {
      resolution = await resolveModel(hook.modelRequest, {
        manifest: { projectId: context.projectId, sessionId: context.sessionId },
        paths,
      });
    } catch (error) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${hook.nodeId} model could not be resolved before admission: ${(error as Error).message}`,
      );
    }
    const billing = billingForWorkflowResolution(resolution.receipt.resolved);
    if (!declaredBillingModeMatches(hook.declaredBillingMode, billing)) {
      throw new WorkflowBudgetError(
        "INVALID_ARGUMENT",
        `Pipeline node ${hook.nodeId} declares billingMode ${hook.declaredBillingMode}, but resolved ${billing.provider}/${billing.authType} is ${billing.billingMode}.`,
      );
    }
    return {
      nodeId: hook.nodeId,
      maxTokens: hook.maxTokens,
      maxCostUsd: hook.maxCostUsd,
      declaredBillingMode: hook.declaredBillingMode,
      billing,
    };
  }));
}

function mapPipelineRunError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof WorkflowBudgetError) {
    reply.code(error.code === "LIMIT_EXCEEDED" ? 402 : error.code === "INVALID_ARGUMENT" ? 400 : 409);
    return { detail: error.message, budget: "rejected", code: error.code };
  }
  return mapError(reply, error);
}

// Map an engine-call failure to the right HTTP status: 503 when the engine is simply
// down (recoverable — it just needs to start), 502 for any other upstream error.
function mapError(reply: FastifyReply, err: unknown): { detail: string; engine: "down" | "error" } {
  if (err instanceof PipelineEngineUnavailableError) {
    reply.code(503);
    return { detail: err.message, engine: "down" };
  }
  reply.code(502);
  return { detail: (err as Error).message, engine: "error" };
}

// --- run-status helpers (used by the SSE relay) ------------------------------
//
// The engine's run object reports status under `status` or `state` in snake/camel
// case and across versions; we read both and lowercase.
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** The engine's run JSON is `{ run, events }`; pull the top-level run status string. */
function runStatusOf(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "";
  const run = (snapshot as { run?: Record<string, unknown> }).run ?? {};
  return String(run.status ?? run.state ?? "").toLowerCase();
}

function isTerminalRunStatus(snapshot: unknown): boolean {
  return TERMINAL_RUN_STATUSES.has(runStatusOf(snapshot));
}

function engineSnapshotRun(snapshot: unknown): Record<string, unknown> | undefined {
  const root = recordOf(snapshot);
  return recordOf(root?.run) ?? root;
}

function pipelineRunCostForNodes(
  snapshot: unknown,
  includedNodeIds: readonly string[],
): ReturnType<typeof sumRunCost> {
  const includedNodes = new Set(includedNodeIds);
  const totals = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  for (const event of eventsOf(snapshot)) {
    const nodeId = event.step_name ?? event.stepName ?? event.node_id ?? event.nodeId;
    if (typeof nodeId !== "string" || !includedNodes.has(nodeId)) continue;
    const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
    if (eventType !== "node_completed") continue;
    const eventTotals = sumRunCost(recordOf(event.data) ?? event);
    totals.costUsd += eventTotals.costUsd;
    totals.tokensIn += eventTotals.tokensIn;
    totals.tokensOut += eventTotals.tokensOut;
  }
  return totals;
}

function pipelineUsageCompleteForStartedNodes(
  snapshot: unknown,
  admittedNodeIds: readonly string[],
): boolean {
  const admitted = new Set(admittedNodeIds);
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const event of eventsOf(snapshot)) {
    const nodeId = event.step_name ?? event.stepName ?? event.node_id ?? event.nodeId;
    if (typeof nodeId !== "string" || !admitted.has(nodeId)) continue;
    const type = String(event.event_type ?? event.type ?? "").toLowerCase();
    if (type === "node_started") started.add(nodeId);
    if (type === "node_completed") completed.add(nodeId);
  }
  return [...started].every((nodeId) => completed.has(nodeId));
}

// Read a run snapshot's events array defensively (the engine returns `{ run, events }`;
// `events` may be absent on an empty/just-started run).
function eventsOf(snapshot: unknown): Record<string, unknown>[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const events = (snapshot as { events?: unknown }).events;
  return Array.isArray(events) ? (events as Record<string, unknown>[]) : [];
}

// A stable per-event key so the SSE relay only emits each event ONCE across polls.
// The engine assigns an id/seq on most events; when it doesn't we fall back to a
// composite of the fields we read, so a re-polled identical event isn't re-sent.
function eventKey(ev: Record<string, unknown>, indexInPoll: number): string {
  const id = ev.id ?? ev.event_id ?? ev.seq ?? ev.sequence;
  if (id !== undefined && id !== null) return `id:${String(id)}`;
  const type = ev.type ?? ev.event_type ?? "";
  const node = ev.node_id ?? ev.nodeId ?? ev.node ?? "";
  const ts = ev.ts ?? ev.timestamp ?? ev.created_at ?? "";
  return `c:${String(type)}|${String(node)}|${String(ts)}|${indexInPoll}`;
}

// Pull the node id off an event (snake/camel/nested).
function eventNode(ev: Record<string, unknown>): string | undefined {
  const data = (ev.data as Record<string, unknown> | undefined) ?? undefined;
  const id = ev.node_id ?? ev.nodeId ?? ev.node ?? data?.node_id;
  return id !== undefined && id !== null ? String(id) : undefined;
}

// Classify an event type into the lifecycle bucket the relay surfaces. Returns
// "node" for ordinary node lifecycle, or the verify_*/rescue_* family when the
// engine tagged the event with one of those types. Unknown types fall through
// as a generic "node" frame so the UI still sees activity.
function eventType(ev: Record<string, unknown>): string {
  return String(ev.type ?? ev.event_type ?? "").toLowerCase();
}

export interface PipelineRouteOverrides {
  resolveBudgetHooks?: typeof pipelineNodeBudgetHooks;
}

export async function registerPipelineRoutes(
  app: FastifyInstance,
  overrides: PipelineRouteOverrides = {},
): Promise<void> {
  const resolveBudgetHooks = overrides.resolveBudgetHooks ?? pipelineNodeBudgetHooks;
  // Health: lets the UI decide whether to offer Pipelines or show setup help.
  app.get("/pipelines/health", async () => ({ healthy: await pipelineEngine.pipelineEngineHealthy() }));

  // --- workflow CRUD (proxied) ---
  app.get("/pipelines", async (_req, reply) => {
    try {
      return await pipelineEngine.listWorkflows();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get("/pipelines/runs", async (_req, reply) => {
    try {
      return await pipelineEngine.listRuns();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      return await pipelineEngine.getWorkflow(req.params.name);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.put<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      return await pipelineEngine.saveWorkflow(req.params.name, req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Params: { name: string } }>("/pipelines/:name", async (req, reply) => {
    try {
      return await pipelineEngine.deleteWorkflow(req.params.name);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post("/pipelines/validate", async (req, reply) => {
    try {
      return await pipelineEngine.validateWorkflow(req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  // --- run lifecycle (proxied) ---
  app.post<{ Params: { name: string } }>("/pipelines/:name/run", async (req, reply) => {
    let admission: PipelineBudgetAdmission | undefined;
    let ownershipPersisted = false;
    let dispatchAccepted = false;
    try {
      const body = recordOf(req.body) ?? {};
      const conversationId = body.conversationId;
      const message = body.message;
      if (typeof conversationId !== "string" || conversationId.length < 1) {
        throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline run requires conversationId.");
      }
      if (typeof message !== "string" || message.length < 1) {
        throw new WorkflowBudgetError("INVALID_ARGUMENT", "Pipeline run requires a non-empty message.");
      }
      if (message.includes(PIPELINE_ADMISSION_LABEL_PREFIX)) {
        throw new WorkflowBudgetError(
          "INVALID_ARGUMENT",
          "Pipeline run message contains a reserved Kady admission label.",
        );
      }
      const projectId = currentProjectId();
      const definition = await pipelineEngine.getWorkflow(req.params.name);
      const hooks = await resolveBudgetHooks(definition, {
        projectId,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : conversationId,
      });
      admission = await reservePipelineNodeBudgets({
        projectId,
        admissionId: crypto.randomUUID(),
        hooks,
      });
      persistPipelineAdmission(admission, req.params.name);
      ownershipPersisted = true;
      const correlationLabel = pipelineAdmissionCorrelationLabel(admission.admissionId);
      // If the client picked a Kady model (the chat-merged catalogue, an "openrouter/..."
      // ref), thread it into the engine's run options as `requestOptions.model` so its Pi
      // resolves the SAME model chat would. The body shape is otherwise loose/unknown, so
      // we pass it through untouched aside from lifting `model` into requestOptions.
      const { model, ...rest } = body;
      const baseRunBody =
        typeof model === "string" && model.length > 0
          ? {
              ...rest,
              requestOptions: {
                ...((rest.requestOptions as Record<string, unknown> | undefined) ?? {}),
                model,
              },
            }
          : body;
      const runBody = {
        ...baseRunBody,
        message: `${message}\n\n${correlationLabel}`,
        kadyAdmissionId: admission.admissionId,
      };
      const result = await pipelineEngine.runWorkflow(req.params.name, runBody);
      const resultRecord = recordOf(result);
      if (resultRecord?.accepted !== true || typeof resultRecord.status !== "string") {
        throw new WorkflowBudgetError(
          "CONFLICT",
          "Pipeline engine did not durably accept the correlated workflow invocation.",
        );
      }
      dispatchAccepted = true;
      try {
        updatePipelineAdmission(projectId, admission.admissionId, { status: "dispatched" });
      } catch (error) {
        // The already-fsynced `reserved` mapping proves ownership just as well.
        // Never release its reservation after the engine has accepted work.
        req.log.error({ error, admissionId: admission.admissionId }, "pipeline admission status update failed");
      }
      return { ...resultRecord, kadyAdmissionId: admission.admissionId };
    } catch (err) {
      if (admission && !dispatchAccepted) {
        try {
          await admission.handle.settle({
            status: "failed",
            reason: ownershipPersisted
              ? "pipeline engine did not accept the durable correlated invocation"
              : "pipeline admission ownership could not be persisted before dispatch",
          });
          if (ownershipPersisted) {
            updatePipelineAdmission(
              admission.handle.record.projectId,
              admission.admissionId,
              { status: "settled" },
            );
          }
        } catch (settlementError) {
          req.log.error(
            { settlementError, admissionId: admission.admissionId },
            "pipeline admission settlement failed closed",
          );
          return mapPipelineRunError(reply, settlementError);
        }
      }
      return mapPipelineRunError(reply, err);
    }
  });

  app.get<{ Params: { runId: string } }>("/pipelines/runs/:runId", async (req, reply) => {
    try {
      return await pipelineEngine.getRun(req.params.runId);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/pipelines/runs/:runId/resume", async (req, reply) => {
    try {
      return await pipelineEngine.resumeRun(req.params.runId, req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>("/pipelines/runs/:runId/cancel", async (req, reply) => {
    try {
      return await pipelineEngine.cancelRun(req.params.runId);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  // --- cost bridge ---
  // Only a durable Kady admission label may own reconciliation. Legacy runs
  // without that proof are rejected instead of taking a second ledger path.
  app.post<{ Params: { runId: string } }>(
    "/pipelines/runs/:runId/reconcile-cost",
    async (req, reply) => {
      try {
        const snapshot = await pipelineEngine.getRun(req.params.runId);
        if (!isTerminalRunStatus(snapshot)) {
          throw new WorkflowBudgetError(
            "CONFLICT",
            `Pipeline run ${req.params.runId} is ${runStatusOf(snapshot) || "nonterminal"}; cost reconciliation requires completed, failed, or cancelled.`,
          );
        }
        const run = engineSnapshotRun(snapshot);
        if (run?.id !== req.params.runId) {
          throw new WorkflowBudgetError("CONFLICT", "Pipeline snapshot does not own the requested engine run id.");
        }
        const admissionId = pipelineAdmissionIdFromEngineSnapshot(snapshot);
        if (!admissionId) {
          throw new WorkflowBudgetError(
            "NOT_FOUND",
            "Pipeline run has no durable Kady admission label; legacy ledger fallback is disabled.",
          );
        }
        const projectId = currentProjectId();
        let recovered = recoverPipelineAdmission(projectId, admissionId);
        if ((run.workflow_name ?? run.workflowName) !== recovered.record.workflowName) {
          throw new WorkflowBudgetError("CONFLICT", "Pipeline run workflow does not match its admission owner.");
        }
        updatePipelineAdmission(projectId, admissionId, {
          status: recovered.record.status === "settled" ? "settled" : "dispatched",
          engineRunId: req.params.runId,
        });
        recovered = recoverPipelineAdmission(projectId, admissionId);
        const tokenTotals = pipelineRunCostForNodes(snapshot, recovered.record.nodeIds);
        const capTotals = pipelineRunCostForNodes(snapshot, recovered.record.capCountedNodeIds);
        const status = runStatusOf(snapshot);
        const usageComplete = pipelineUsageCompleteForStartedNodes(
          snapshot,
          recovered.record.nodeIds,
        );
        const entry = await recovered.admission.handle.settle({
          status: status === "completed" ? "completed" : status === "cancelled" ? "aborted" : "failed",
          ...(usageComplete
            ? {
                usage: {
                  input: tokenTotals.tokensIn,
                  output: tokenTotals.tokensOut,
                  total: tokenTotals.tokensIn + tokenTotals.tokensOut,
                  cost: capTotals.costUsd,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              }
            : { reason: "pipeline engine terminal snapshot has incomplete started-node usage" }),
        });
        updatePipelineAdmission(projectId, admissionId, {
          status: "settled",
          engineRunId: req.params.runId,
        });
        return {
          reconciled: {
            costUsd: capTotals.costUsd,
            tokensIn: tokenTotals.tokensIn,
            tokensOut: tokenTotals.tokensOut,
          },
          entry,
          budgetAdmission: {
            admissionId,
            runId: recovered.admission.runId,
            nodeIds: recovered.record.nodeIds,
            capCountedNodeIds: recovered.record.capCountedNodeIds,
          },
        };
      } catch (err) {
        return mapPipelineRunError(reply, err);
      }
    },
  );

  // --- poll-backed SSE relay --------------------------------------------------
  // The engine has NO per-run SSE on the SQLite backend (its dashboard stream is
  // notification-only and lags ~10s), so we POLL getRun on an interval and
  // translate the diff into a text/event-stream the UI can consume same-origin.
  // We emit:
  //   - one `node` frame per NEW node lifecycle event (with the running cost delta,
  //     Kady-priced via sumRunCost on the whole snapshot),
  //   - `verify_*` / `rescue_*` frames for events the engine tags with those types,
  //   - a terminal `done` frame, then close, when the run reaches a terminal status.
  // Socket hygiene mirrors sessions.ts: hijack the reply, write the SSE head, and
  // raw.end() on every exit path (terminal, client close, error) so sockets don't
  // leak. The client-close handler aborts the poll loop.
  app.get<{ Params: { runId: string }; Querystring: { pollMs?: string } }>(
    "/pipelines/runs/:runId/stream",
    async (req, reply) => {
      const runId = req.params.runId;
      // Clamp the poll period to a sane band: fast enough to feel live, slow
      // enough not to hammer a flaky SQLite engine. Default 2s.
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

      // De-dupe across polls: emit each engine event exactly once. Cost is reported
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
            snapshot = await pipelineEngine.getRun(runId);
          } catch (err) {
            // Engine down or a flaky read. Surface it as an `error` frame; if the
            // engine is simply unavailable we close (no point polling a dead
            // engine), otherwise we keep polling through a transient blip.
            if (err instanceof PipelineEngineUnavailableError) {
              write({ type: "error", engine: "down", message: err.message });
              break;
            }
            write({ type: "error", engine: "error", message: (err as Error).message });
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
          // streaming tokens that the engine folds into the run total without a fresh
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
