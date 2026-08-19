import {
  expect,
  test,
  type LiveWorkspace,
} from "../../live-fixtures";
import { e2eServiceOrigin } from "../../service-origins";

/**
 * Lane F14 — the durability watcher, server side (matrix rows 23, 24, 44-server).
 *
 * These items drive the REAL backend from the browser, not a mocked boundary
 * (`e2e/fixtures.ts:35` mocks the boundary for every other spec, which proves
 * nothing about the server). They assert on the durability API's contract with
 * lane F6's pipeline-options UI: the signal catalogue and its honest
 * observability flags, the settings round trip, the fail-closed rescue model,
 * and the refusal to enable a signal this build cannot observe.
 *
 * Gate U for rows 23/24 — the Durability panel itself — is lane F6's and is NOT
 * delivered here. What is delivered here is the contract F6 renders.
 */

interface DurabilitySignalDescriptor {
  id: string;
  label: string;
  observable: boolean;
  observability: "full" | "partial" | "none";
  unobservableReason?: string;
  observationSource: string;
  firesWhen: string;
  supportedActions: string[];
  thresholdLabel: string;
}

interface DurabilityModelResolution {
  status: "resolved" | "unset" | "unresolvable";
  ref?: string;
  effort?: string;
  contextWindow?: number;
  pricing?: "priced" | "unpriced";
  reason?: string;
  nextAction?: string;
}

interface DurabilitySettingsResponse {
  settings: {
    version: number;
    enabled: boolean;
    watcherModel: Record<string, unknown>;
    rescueModel: Record<string, unknown>;
    rescueEffort: string;
    minRescueContextWindow: number;
    stallMs: number;
    stopPolicy: { allowStop: boolean; maxStopsPerRun: number };
    signals: Record<string, { enabled: boolean; action: string; threshold: number }>;
  };
  resolution: { watcher: DurabilityModelResolution; rescue: DurabilityModelResolution };
}

interface ObservedResponse<T> {
  status: number;
  url: string;
  body: T;
}

/** Call the backend from inside the live browser, with the workspace project. */
async function backendJson<T>(
  workspace: LiveWorkspace,
  request: { path: string; method?: string; payload?: unknown },
): Promise<ObservedResponse<T>> {
  return workspace.page.evaluate(async ({ origin, path, method, payload, projectId }) => {
    const response = await fetch(`${origin}${path}`, {
      method: method ?? "GET",
      headers: {
        "X-Project-Id": projectId,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Reported verbatim so a failure names exactly what arrived.
    }
    return { status: response.status, url: response.url, body };
  }, {
    origin: e2eServiceOrigin("backend"),
    path: request.path,
    method: request.method ?? "GET",
    payload: request.payload,
    projectId: workspace.project.id,
  }) as Promise<ObservedResponse<T>>;
}

test("@live @live-alt serves a six-signal durability catalogue with an honest observability flag per signal", async ({
  liveWorkspace,
}) => {
  const observed = await backendJson<{ signals: DurabilitySignalDescriptor[] }>(
    liveWorkspace,
    { path: "/durability/signals" },
  );
  expect(
    observed.status,
    `GET ${observed.url} returned ${observed.status} with ${JSON.stringify(observed.body)}.`,
  ).toBe(200);
  expect(new URL(observed.url).origin).toBe(e2eServiceOrigin("backend"));

  const signals = observed.body.signals;
  expect(signals.map((signal) => signal.id)).toEqual([
    "compaction",
    "context-rot",
    "hallucination",
    "paused-no-progress",
    "failed-script-run",
    "failed-skill-fire",
  ]);
  for (const signal of signals) {
    expect(signal.observationSource.length, `${signal.id} must name its source of truth.`)
      .toBeGreaterThan(0);
    expect(signal.firesWhen.length, `${signal.id} must state its firing condition.`)
      .toBeGreaterThan(0);
    expect(signal.supportedActions.length).toBeGreaterThan(0);
  }
  console.log(
    `LIVE_VALUES durability_signals=${signals.map((s) => `${s.id}:${s.observability}`).join(",")}`,
  );
});

test("@live @live-alt reports the two signals this build cannot fully observe, with a reason the UI renders", async ({
  liveWorkspace,
}) => {
  const observed = await backendJson<{ signals: DurabilitySignalDescriptor[] }>(
    liveWorkspace,
    { path: "/durability/signals" },
  );
  const byId = new Map(observed.body.signals.map((signal) => [signal.id, signal]));

  const skillFire = byId.get("failed-skill-fire")!;
  expect(
    skillFire.observable,
    `failed-skill-fire reported ${JSON.stringify(skillFire)}; this build has no skill-invocation event.`,
  ).toBe(false);
  expect(skillFire.observability).toBe("none");
  expect(skillFire.unobservableReason).toContain("SKILL.md");
  expect(skillFire.supportedActions).toEqual(["observe"]);

  const scriptRun = byId.get("failed-script-run")!;
  expect(scriptRun.observability).toBe("partial");
  expect(scriptRun.unobservableReason).toContain("no CI integration");

  // The honest reason must name what the user can do, and never a path on disk.
  for (const signal of [skillFire, scriptRun]) {
    expect(
      signal.unobservableReason,
      `${signal.id} reason must not leak a filesystem path.`,
    ).not.toMatch(/[/\\](Users|home|var|tmp|private)[/\\]/);
  }
});

test("@live @live-alt fails closed on the rescue model the owner named, instead of guessing one of three", async ({
  liveWorkspace,
}) => {
  const observed = await backendJson<DurabilitySettingsResponse>(
    liveWorkspace,
    { path: "/durability/settings" },
  );
  expect(
    observed.status,
    `GET ${observed.url} returned ${observed.status} with ${JSON.stringify(observed.body)}.`,
  ).toBe(200);

  const { watcher, rescue } = observed.body.resolution;
  // The watcher default resolves; it is also absent from this build's pricing
  // catalogue, which the API reports rather than hides.
  expect(watcher.status).toBe("resolved");
  expect(watcher.ref).toBe("openrouter/qwen/qwen3.8-27b");
  expect(watcher.effort).toBe("high");
  expect(watcher.pricing).toBe("unpriced");

  // "GPT-5.6 Pro" matches three live OpenRouter ids, so nothing is chosen.
  expect(
    rescue.status,
    `The rescue slot reported ${JSON.stringify(rescue)}; it must fail closed, not pick one.`,
  ).toBe("unset");
  expect(rescue.ref).toBeUndefined();
  expect(rescue.reason).toContain("GPT-5.6 Luna Pro");
  expect(rescue.reason).toContain("GPT-5.6 Terra Pro");
  expect(rescue.reason).toContain("GPT-5.6 Sol Pro");
  expect(rescue.nextAction).toContain("Pipeline options");
  console.log(
    `LIVE_VALUES durability_watcher=${String(watcher.ref)} pricing=${String(watcher.pricing)} ` +
      `rescue_status=${rescue.status}`,
  );
});

test("@live @live-alt round-trips a durability settings change through the server", async ({
  liveWorkspace,
}) => {
  const before = await backendJson<DurabilitySettingsResponse>(
    liveWorkspace,
    { path: "/durability/settings" },
  );
  expect(before.status).toBe(200);

  const saved = await backendJson<DurabilitySettingsResponse>(liveWorkspace, {
    path: "/durability/settings",
    method: "PUT",
    payload: {
      enabled: true,
      rescueModel: {
        kind: "direct",
        ref: "openrouter/openai/gpt-5.6-sol-pro",
        effort: "xhigh",
      },
      signals: { "paused-no-progress": { enabled: true, action: "restart", threshold: 2 } },
    },
  });
  expect(
    saved.status,
    `PUT ${saved.url} returned ${saved.status} with ${JSON.stringify(saved.body)}.`,
  ).toBe(200);
  expect(saved.body.settings.enabled).toBe(true);
  expect(saved.body.settings.signals["paused-no-progress"])
    .toEqual({ enabled: true, action: "restart", threshold: 2 });
  expect(saved.body.resolution.rescue).toMatchObject({
    status: "resolved",
    ref: "openrouter/openai/gpt-5.6-sol-pro",
    effort: "xhigh",
  });
  // A resolved rescue model must clear the 1M-context floor the row demands.
  expect(saved.body.resolution.rescue.contextWindow)
    .toBeGreaterThanOrEqual(saved.body.settings.minRescueContextWindow);

  // The change survives an independent read, so it was persisted, not echoed.
  const persisted = await backendJson<DurabilitySettingsResponse>(
    liveWorkspace,
    { path: "/durability/settings" },
  );
  expect(persisted.body.settings).toEqual(saved.body.settings);

  // Put the project back the way it was found.
  const restored = await backendJson<DurabilitySettingsResponse>(liveWorkspace, {
    path: "/durability/settings",
    method: "PUT",
    payload: before.body.settings,
  });
  expect(restored.status).toBe(200);
  expect(restored.body.settings).toEqual(before.body.settings);
});

test("@live @live-alt refuses to enable a signal it cannot observe, and says why", async ({
  liveWorkspace,
}) => {
  const refused = await backendJson<{ detail: string; code: string }>(liveWorkspace, {
    path: "/durability/settings",
    method: "PUT",
    payload: { signals: { "failed-skill-fire": { enabled: true } } },
  });
  expect(
    refused.status,
    `PUT ${refused.url} returned ${refused.status} with ${JSON.stringify(refused.body)}.`,
  ).toBe(400);
  expect(refused.body.code).toBe("SIGNAL_NOT_OBSERVABLE");
  expect(refused.body.detail).toContain("SKILL.md");

  // The refusal must not have changed anything.
  const after = await backendJson<DurabilitySettingsResponse>(
    liveWorkspace,
    { path: "/durability/settings" },
  );
  expect(after.body.settings.signals["failed-skill-fire"].enabled).toBe(false);
});

test("@live @live-alt refuses a malformed model reference and a malformed timeline cursor without leaking a path", async ({
  liveWorkspace,
}) => {
  const badModel = await backendJson<{ detail: string }>(liveWorkspace, {
    path: "/durability/settings",
    method: "PUT",
    payload: { watcherModel: { kind: "direct", ref: "qwen3.8-27b" } },
  });
  expect(badModel.status).toBe(400);
  expect(badModel.body.detail).toContain("provider-qualified model reference");

  const badRun = await backendJson<{ detail: string }>(
    liveWorkspace,
    { path: "/durability/runs/not-a-run/timeline" },
  );
  expect(badRun.status).toBe(400);
  expect(badRun.body.detail).toBe("Open a durability timeline from a workflow run.");

  const badCursor = await backendJson<{ detail: string }>(liveWorkspace, {
    path: "/durability/runs/wrun_00000000000000000000000000000000/timeline?after=-1",
  });
  expect(badCursor.status).toBe(400);

  for (const refusal of [badModel, badRun, badCursor]) {
    expect(
      refusal.body.detail,
      `A refusal must name the user's next action and no filesystem path (#71): ${refusal.body.detail}`,
    ).not.toMatch(/[/\\](Users|home|var|tmp|private)[/\\]/);
  }
});

test("@live @live-alt reports watcher state the pipeline-options panel can render without a run", async ({
  liveWorkspace,
}) => {
  const observed = await backendJson<{
    enabled: boolean;
    resolution: { watcher: DurabilityModelResolution; rescue: DurabilityModelResolution };
    watchedRuns: Array<{ runId: string; status: string; stops: number }>;
  }>(liveWorkspace, { path: "/durability/state" });

  expect(
    observed.status,
    `GET ${observed.url} returned ${observed.status} with ${JSON.stringify(observed.body)}.`,
  ).toBe(200);
  expect(typeof observed.body.enabled).toBe("boolean");
  expect(Array.isArray(observed.body.watchedRuns)).toBe(true);
  // #62: a panel reading this endpoint must never get a malformed 200. Every
  // resolution slot is either resolved with a ref, or carries a legible reason.
  for (const slot of ["watcher", "rescue"] as const) {
    const resolution = observed.body.resolution[slot];
    if (resolution.status === "resolved") expect(resolution.ref).toBeTruthy();
    else expect(resolution.reason).toBeTruthy();
  }
});
