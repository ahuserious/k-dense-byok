import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDurabilityRoutes } from "../src/api/durability.ts";
import { DEFAULT_PROJECT_ID } from "../src/config.ts";
import {
  MemoryDurabilitySettingsStore,
  defaultDurabilitySettings,
  durabilitySignalDescriptor,
  parseDurabilitySettings,
  DurabilitySettingsError,
} from "../src/workflows/durability-settings.ts";
import { MemoryDurabilityJournal } from "../src/workflows/durability-journal.ts";
import { resolveDurabilityModels } from "../src/workflows/durability-model-policy.ts";
import { WorkflowRunControllerError } from "../src/workflows/controller.ts";
import type { ContextEngineeringProduction } from
  "../src/workflows/context-watcher-production.ts";

const RUN_ID = "wrun_cccccccccccccccccccccccccccccccc";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/**
 * A thin stand-in for the composition root that keeps the SAME settings parsing
 * and the SAME model resolution as production, so this test exercises the route
 * contract rather than a parallel one.
 */
function contextEngineering(options: {
  stopRun?: (projectId: string, runId: string, reason: string) => unknown;
} = {}) {
  const settings = new MemoryDurabilitySettingsStore();
  const journal = new MemoryDurabilityJournal();
  return {
    settings,
    journal,
    production: {
      durabilityState(projectId: string) {
        const stored = settings.read(projectId);
        return {
          settings: stored,
          resolution: resolveDurabilityModels(stored),
          watchedRuns: [{
            runId: RUN_ID,
            status: "paused",
            lastSeq: 7,
            lastObservedAt: 1_700_000_000_000,
            firedSignals: [],
            stops: 0,
          }],
          stopPolicy: stored.stopPolicy,
          stopAvailability: [{ runId: RUN_ID, canStop: true }],
        };
      },
      writeDurabilitySettings(projectId: string, patch: unknown) {
        return settings.write(projectId, parseDurabilitySettings(patch, settings.read(projectId)));
      },
      durabilityTimeline(
        projectId: string,
        runId: string,
        pageOptions?: { after?: number; limit?: number },
      ) {
        return journal.read(projectId, runId, pageOptions);
      },
      stopRun: options.stopRun ?? ((_projectId: string, runId: string, reason: string) => ({
        runId,
        stopped: true,
        terminalStatus: "cancelled" as const,
        stoppedBy: "operator" as const,
        reason,
        distinguishedInRunEvents: true,
        detail: "stopped",
      })),
    } as unknown as ContextEngineeringProduction,
  };
}

async function appWith(harness = contextEngineering()) {
  const app = Fastify();
  apps.push(app);
  await registerDurabilityRoutes(app, harness.production);
  return { app, ...harness };
}

describe("durability API", () => {
  it("serves the signal catalogue with an honest observability flag per signal", async () => {
    const { app } = await appWith();
    const response = await app.inject({ method: "GET", url: "/durability/signals" });

    expect(response.statusCode).toBe(200);
    const { signals } = response.json();
    expect(signals).toHaveLength(6);
    const skillFire = signals.find((signal: { id: string }) => signal.id === "failed-skill-fire");
    expect(skillFire).toMatchObject({ observable: false, observability: "none" });
    expect(skillFire.unobservableReason)
      .toBe(durabilitySignalDescriptor("failed-skill-fire").unobservableReason);
    const scriptRun = signals.find((signal: { id: string }) => signal.id === "failed-script-run");
    expect(scriptRun).toMatchObject({ observability: "partial" });
    expect(scriptRun.unobservableReason).toContain("no CI integration");
  });

  it("returns settings alongside how the models resolve right now", async () => {
    const { app } = await appWith();
    const response = await app.inject({ method: "GET", url: "/durability/settings" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settings).toEqual(defaultDurabilitySettings());
    // BOTH slots fail closed with a reason the UI renders verbatim. The watcher
    // default is unset because the owner's model is absent from this build's
    // pricing catalogue and would silently disable the project spend cap.
    expect(body.resolution.watcher.status).toBe("unset");
    expect(body.resolution.watcher.reason).toContain("pricing catalogue");
    expect(body.resolution.watcher.nextAction).toContain("watcher model");
    expect(body.resolution.rescue.status).toBe("unset");
    expect(body.resolution.rescue.reason).toContain("GPT-5.6 Pro");
  });

  it("saves a partial settings patch and returns the merged result", async () => {
    const { app, settings } = await appWith();
    const response = await app.inject({
      method: "PUT",
      url: "/durability/settings",
      payload: {
        enabled: true,
        rescueModel: { kind: "direct", ref: "openrouter/openai/gpt-5.6-sol-pro", effort: "xhigh" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings.enabled).toBe(true);
    expect(response.json().resolution.rescue).toMatchObject({
      status: "resolved",
      ref: "openrouter/openai/gpt-5.6-sol-pro",
      effort: "xhigh",
    });
    expect(settings.read(DEFAULT_PROJECT_ID).enabled).toBe(true);
  });

  it("refuses to enable an unobservable signal, and says why", async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: "PUT",
      url: "/durability/settings",
      payload: { signals: { "failed-skill-fire": { enabled: true } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "SIGNAL_NOT_OBSERVABLE" });
    expect(response.json().detail)
      .toBe(durabilitySignalDescriptor("failed-skill-fire").unobservableReason);
  });

  it("rejects a non-object signal value with a 400 naming the field, not a silent 200", async () => {
    const { app, settings } = await appWith();
    const response = await app.inject({
      method: "PUT",
      url: "/durability/settings",
      payload: { signals: { compaction: "yes" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain("signals.compaction must be an object");
    // ...and nothing was written.
    expect(settings.read(DEFAULT_PROJECT_ID)).toEqual(defaultDurabilitySettings());
  });

  it("rejects a malformed patch with a 400 that names the fix, and no path", async () => {
    const { app } = await appWith();
    const response = await app.inject({
      method: "PUT",
      url: "/durability/settings",
      payload: { watcherModel: { kind: "direct", ref: "not-a-ref" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain("provider-qualified model reference");
    expect(response.json().detail).not.toMatch(/[/\\](Users|home|var|tmp)[/\\]/);
  });

  it("serves the run timeline and validates its cursor", async () => {
    const { app, journal } = await appWith();
    journal.append(DEFAULT_PROJECT_ID, {
      name: "durability.signal.fired",
      runId: RUN_ID,
      runLastSeq: 7,
      signal: "paused-no-progress",
      detail: "Paused with no progress fired.",
    });

    const page = await app.inject({
      method: "GET",
      url: `/durability/runs/${RUN_ID}/timeline`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().events).toHaveLength(1);
    expect(page.json().events[0]).toMatchObject({ seq: 1, name: "durability.signal.fired" });

    const badCursor = await app.inject({
      method: "GET",
      url: `/durability/runs/${RUN_ID}/timeline?after=-3`,
    });
    expect(badCursor.statusCode).toBe(400);

    const badRun = await app.inject({ method: "GET", url: "/durability/runs/nope/timeline" });
    expect(badRun.statusCode).toBe(400);
    expect(badRun.json().detail).toBe("Open a durability timeline from a workflow run.");
  });

  it("stops a run on request, and refuses without a reason", async () => {
    const stopRun = vi.fn().mockReturnValue({
      runId: RUN_ID,
      stopped: true,
      terminalStatus: "cancelled",
      stoppedBy: "operator",
      reason: "Operator stopped it",
      distinguishedInRunEvents: true,
      detail: "stopped",
    });
    const { app } = await appWith(contextEngineering({ stopRun }));

    const stopped = await app.inject({
      method: "POST",
      url: `/durability/runs/${RUN_ID}/stop`,
      payload: { reason: "Operator stopped it" },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ terminalStatus: "cancelled", stoppedBy: "operator" });
    expect(stopRun).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, RUN_ID, "Operator stopped it");

    const noReason = await app.inject({
      method: "POST",
      url: `/durability/runs/${RUN_ID}/stop`,
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().detail).toContain("Say why this run is being stopped");
  });

  it("turns a controller refusal into a legible 404 or 409, never a 500", async () => {
    const notFound = contextEngineering({
      stopRun: () => {
        throw new WorkflowRunControllerError("RUN_NOT_FOUND", "No such workflow run.");
      },
    });
    const { app } = await appWith(notFound);
    const response = await app.inject({
      method: "POST",
      url: `/durability/runs/${RUN_ID}/stop`,
      payload: { reason: "Stop it" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("refuses to serve settings it cannot render, rather than emitting a malformed 200 (#62)", async () => {
    const broken = contextEngineering();
    (broken.production as unknown as {
      durabilityState(projectId: string): unknown;
    }).durabilityState = () => ({
      settings: { ...defaultDurabilitySettings(), signals: {} },
      resolution: resolveDurabilityModels(defaultDurabilitySettings()),
      watchedRuns: [],
    });
    const { app } = await appWith(broken);

    const response = await app.inject({ method: "GET", url: "/durability/settings" });
    expect(response.statusCode).toBe(500);
    expect(response.json().detail).toContain("reset them in Pipeline options");
  });

  it("never echoes a raw error message from a generic catch (#71)", async () => {
    // An ErrnoException's `message` carries an absolute path. Round 1's
    // generic catches returned `error.message` verbatim on three routes.
    const leaky = () => {
      const error = new Error(
        "ENOENT: no such file or directory, open '/Users/someone/projects/p/durability/settings.json'",
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    for (const [url, method] of [
      ["/durability/settings", "GET"],
      ["/durability/state", "GET"],
    ] as const) {
      const harness = contextEngineering();
      (harness.production as unknown as {
        durabilityState(projectId: string): unknown;
      }).durabilityState = leaky;
      const { app } = await appWith(harness);
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(500);
      expect(
        response.json().detail,
        `${method} ${url} leaked: ${response.json().detail}`,
      ).not.toMatch(/[/\\](Users|home|var|tmp|private)[/\\]/);
      expect(response.json().detail).not.toContain("ENOENT");
    }

    // ...and the stop route's generic catch.
    const stopping = contextEngineering({ stopRun: leaky });
    const { app } = await appWith(stopping);
    const stop = await app.inject({
      method: "POST",
      url: `/durability/runs/${RUN_ID}/stop`,
      payload: { reason: "Stop it" },
    });
    expect(stop.statusCode).toBe(409);
    expect(stop.json().detail).toBe("This run could not be stopped. Reload the run and try again.");
    expect(stop.json().detail).not.toMatch(/[/\\](Users|home|var|tmp|private)[/\\]/);
  });

  it("reports watcher state for the runs it is observing", async () => {
    const { app } = await appWith();
    const response = await app.inject({ method: "GET", url: "/durability/state" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: false });
    expect(response.json().watchedRuns[0]).toMatchObject({ runId: RUN_ID, status: "paused" });
    // §6.7: F6 must be able to disable a Stop control WITH A REASON before the
    // click, not learn the refusal from a 409 after it.
    expect(response.json().stopPolicy).toEqual({ allowStop: true, maxStopsPerRun: 1 });
    expect(response.json().stopAvailability[0]).toMatchObject({ runId: RUN_ID, canStop: true });
  });

  it("says why a run cannot be stopped, before the operator clicks Stop", async () => {
    const harness = contextEngineering();
    // Stopping switched off, and a run that has already used its stop budget.
    (harness.production as unknown as {
      durabilityState(projectId: string): unknown;
    }).durabilityState = () => {
      const stored = {
        ...defaultDurabilitySettings(),
        stopPolicy: { allowStop: false, maxStopsPerRun: 1 },
      };
      return {
        settings: stored,
        resolution: resolveDurabilityModels(stored),
        watchedRuns: [{
          runId: RUN_ID,
          status: "running",
          lastSeq: 7,
          lastObservedAt: 1_700_000_000_000,
          firedSignals: [],
          stops: 1,
        }],
        stopPolicy: stored.stopPolicy,
        stopAvailability: [{
          runId: RUN_ID,
          canStop: false,
          reason: "Stopping runs is switched off. Turn on Pipeline options ▸ Durability ▸ Allow stop.",
        }],
      };
    };
    const { app } = await appWith(harness);

    const response = await app.inject({ method: "GET", url: "/durability/state" });
    expect(response.statusCode).toBe(200);
    const availability = response.json().stopAvailability[0];
    expect(availability.canStop).toBe(false);
    expect(availability.reason).toContain("Allow stop");
    expect(availability.reason).not.toMatch(/[/\\](Users|home|var|tmp|private)[/\\]/);
  });
});

describe("durability settings error surface", () => {
  it("keeps the settings error type available to callers", () => {
    expect(() => parseDurabilitySettings({ stallMs: 1 })).toThrow(DurabilitySettingsError);
  });
});
