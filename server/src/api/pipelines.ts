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
      return await archon.runWorkflow(req.params.name, runBody);
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
        return { reconciled: totals, entry };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );
}
