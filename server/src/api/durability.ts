import type { FastifyInstance } from "fastify";
import { currentProjectId } from "../scope.ts";
import {
  DURABILITY_SIGNALS,
  DurabilitySettingsError,
  type DurabilitySettingsV1,
} from "../workflows/durability-settings.ts";
import {
  isDurabilityJournalRunId,
  MAX_DURABILITY_TIMELINE_PAGE,
} from "../workflows/durability-journal.ts";
import type { DurabilityResolutionReport } from "../workflows/durability-model-policy.ts";
import type { ContextEngineeringProduction } from
  "../workflows/context-watcher-production.ts";
import { WorkflowRunControllerError } from "../workflows/controller.ts";

/**
 * The durability API is what the pipeline-options UI and the workflow
 * supervisor skill both read. Two rules bind every response here:
 *
 *  - It is validated before it is sent (#62). A panel reading this endpoint
 *    must never receive a malformed 200, because a malformed 200 takes the app
 *    down in the render phase.
 *  - No error body names a filesystem path (#71); every error names what the
 *    user should do next.
 */

interface TimelineQuery {
  after?: string;
  limit?: string;
}

function boundedReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_048) return undefined;
  return trimmed;
}

/**
 * Reject our own malformed output before it reaches a renderer. This is not
 * belt-and-braces: #62 is a live defect where a malformed-but-200 response
 * throws in the render phase, and this endpoint feeds a new panel.
 */
function assertRenderableSettings(
  settings: DurabilitySettingsV1,
  resolution: DurabilityResolutionReport,
): void {
  const signalsPresent = DURABILITY_SIGNALS.every((descriptor) => {
    const setting = settings.signals[descriptor.id];
    return setting && typeof setting.enabled === "boolean" &&
      typeof setting.action === "string" && Number.isSafeInteger(setting.threshold);
  });
  const resolutionLegible = (["watcher", "rescue"] as const).every((slot) => {
    const entry = resolution[slot];
    return entry.status === "resolved"
      ? typeof entry.ref === "string" && entry.ref.length > 0
      : typeof entry.reason === "string" && entry.reason.length > 0;
  });
  if (!signalsPresent || !resolutionLegible) {
    throw new Error(
      "Durability settings could not be read. Reset them in Pipeline options ▸ Durability.",
    );
  }
}

export async function registerDurabilityRoutes(
  app: FastifyInstance,
  contextEngineering: ContextEngineeringProduction,
): Promise<void> {
  const readState = () => {
    const state = contextEngineering.durabilityState(currentProjectId());
    assertRenderableSettings(state.settings, state.resolution);
    return state;
  };

  /** The static signal catalogue. Safe to render before settings have loaded. */
  app.get("/durability/signals", async () => ({ signals: DURABILITY_SIGNALS }));

  app.get("/durability/settings", async (_request, reply) => {
    try {
      const state = readState();
      return { settings: state.settings, resolution: state.resolution };
    } catch (error) {
      reply.code(500);
      return { detail: error instanceof Error ? error.message : "Durability settings are unavailable." };
    }
  });

  app.put<{ Body: unknown }>("/durability/settings", async (request, reply) => {
    const projectId = currentProjectId();
    try {
      contextEngineering.writeDurabilitySettings(projectId, request.body);
    } catch (error) {
      if (error instanceof DurabilitySettingsError) {
        reply.code(400);
        return { detail: error.message, code: error.code };
      }
      reply.code(500);
      return { detail: "Durability settings could not be saved. Try again." };
    }
    const state = readState();
    return { settings: state.settings, resolution: state.resolution };
  });

  app.get("/durability/state", async (_request, reply) => {
    try {
      const state = readState();
      return {
        enabled: state.settings.enabled,
        resolution: state.resolution,
        watchedRuns: state.watchedRuns,
      };
    } catch (error) {
      reply.code(500);
      return { detail: error instanceof Error ? error.message : "Durability state is unavailable." };
    }
  });

  app.get<{ Params: { runId: string }; Querystring: TimelineQuery }>(
    "/durability/runs/:runId/timeline",
    async (request, reply) => {
      const { runId } = request.params;
      if (!isDurabilityJournalRunId(runId)) {
        reply.code(400);
        return { detail: "Open a durability timeline from a workflow run." };
      }
      const after = request.query.after === undefined ? 0 : Number(request.query.after);
      const limit = request.query.limit === undefined
        ? MAX_DURABILITY_TIMELINE_PAGE
        : Number(request.query.limit);
      if (!Number.isSafeInteger(after) || after < 0) {
        reply.code(400);
        return { detail: "The timeline cursor must be a whole number of events." };
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DURABILITY_TIMELINE_PAGE) {
        reply.code(400);
        return { detail: `Request between 1 and ${MAX_DURABILITY_TIMELINE_PAGE} timeline events.` };
      }
      return contextEngineering.durabilityTimeline(currentProjectId(), runId, { after, limit });
    },
  );

  app.post<{ Params: { runId: string }; Body: { reason?: unknown } | null }>(
    "/durability/runs/:runId/stop",
    async (request, reply) => {
      const { runId } = request.params;
      if (!isDurabilityJournalRunId(runId)) {
        reply.code(400);
        return { detail: "Stop a run from its run view." };
      }
      const reason = boundedReason(request.body?.reason);
      if (!reason) {
        reply.code(400);
        return { detail: "Say why this run is being stopped, in 2048 characters or fewer." };
      }
      try {
        return contextEngineering.stopRun(currentProjectId(), runId, reason);
      } catch (error) {
        if (error instanceof WorkflowRunControllerError) {
          reply.code(error.code === "RUN_NOT_FOUND" ? 404 : 409);
          return { detail: error.message, code: error.code };
        }
        reply.code(409);
        return {
          detail: error instanceof Error
            ? error.message
            : "This run could not be stopped. Reload the run and try again.",
        };
      }
    },
  );
}
