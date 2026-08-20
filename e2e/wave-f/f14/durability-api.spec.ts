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
  pricing?: "priced" | "unpriced" | "unknown";
  warning?: string;
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

test("@live @live-alt reports the three signals this build cannot fully observe, with a reason the UI renders", async ({
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

  // `run_paused` and `run_blocked` have NO emitter anywhere in the server tree,
  // so a signal labelled "Paused with no progress" can never fire on a paused
  // run and never on a blocked one. It is partial, not full.
  const stalled = byId.get("paused-no-progress")!;
  expect(stalled.observability).toBe("partial");
  expect(stalled.unobservableReason).toContain("run_paused");
  expect(stalled.unobservableReason).toContain("run_blocked");
  expect(stalled.firesWhen).toContain("waiting");

  const tally = { full: 0, partial: 0, none: 0 } as Record<string, number>;
  for (const signal of observed.body.signals) tally[signal.observability] += 1;
  expect(tally).toEqual({ full: 3, partial: 2, none: 1 });

  // The honest reason must name what the user can do, and never a path on disk.
  for (const signal of [skillFire, scriptRun, stalled]) {
    expect(
      signal.unobservableReason,
      `${signal.id} reason must not leak a filesystem path.`,
    ).not.toMatch(/[/\\](Users|home|var|tmp|private)[/\\]/);
  }
});

test("@live @live-alt fails closed on BOTH model defaults, instead of guessing or spending unpriced", async ({
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
  // The owner's named watcher model resolves live on OpenRouter but is absent
  // from this build's pricing catalogue, so its calls would record $0 and the
  // project spend cap would never accrue. A shipped default that silently
  // disables a budget control is not made safe by a field the UI may render, so
  // it ships unset with a reason — the same standard as the rescue slot.
  expect(
    watcher.status,
    `The watcher slot reported ${JSON.stringify(watcher)}; an unpriced default must fail closed.`,
  ).toBe("unset");
  expect(watcher.ref).toBeUndefined();
  expect(watcher.reason).toContain("pricing catalogue");
  expect(watcher.reason).toContain("openrouter/qwen/qwen3.8-27b");
  expect(watcher.nextAction).toContain("watcher model");

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
    `LIVE_VALUES durability_watcher_status=${watcher.status} rescue_status=${rescue.status}`,
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
      watcherModel: { kind: "direct", ref: "openrouter/qwen/qwen3.6-27b", effort: "high" },
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
    pricing: "priced",
  });
  // An operator-chosen PRICED watcher model resolves, so the spend cap accrues.
  expect(saved.body.resolution.watcher).toMatchObject({
    status: "resolved",
    ref: "openrouter/qwen/qwen3.6-27b",
    pricing: "priced",
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
  // Chromium logs the deliberate refusal as a console error, so the fixture's
  // runtime-error guard needs it declared as an exact multiset — one 400 here.
  liveWorkspace.expectRefusedResourceStatus(400);
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
  // Three deliberate refusals below, each of which Chromium logs as a console
  // error; the guard is an exact multiset, so all three must be declared.
  for (let refusal = 0; refusal < 3; refusal += 1) {
    liveWorkspace.expectRefusedResourceStatus(400);
  }
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
    stopPolicy: { allowStop: boolean; maxStopsPerRun: number };
    stopAvailability: Array<{ runId: string; canStop: boolean; reason?: string }>;
  }>(liveWorkspace, { path: "/durability/state" });

  expect(
    observed.status,
    `GET ${observed.url} returned ${observed.status} with ${JSON.stringify(observed.body)}.`,
  ).toBe(200);
  expect(typeof observed.body.enabled).toBe("boolean");
  expect(Array.isArray(observed.body.watchedRuns)).toBe(true);
  // §6.7: the reason a Stop control must be rendered disabled, supplied BEFORE
  // the click. One entry per watched run, and a false always carries a reason.
  expect(typeof observed.body.stopPolicy.allowStop).toBe("boolean");
  expect(Array.isArray(observed.body.stopAvailability)).toBe(true);
  expect(observed.body.stopAvailability).toHaveLength(observed.body.watchedRuns.length);
  for (const availability of observed.body.stopAvailability) {
    if (!availability.canStop) expect(availability.reason).toBeTruthy();
  }
  // #62: a panel reading this endpoint must never get a malformed 200. Every
  // resolution slot is either resolved with a ref, or carries a legible reason.
  for (const slot of ["watcher", "rescue"] as const) {
    const resolution = observed.body.resolution[slot];
    if (resolution.status === "resolved") expect(resolution.ref).toBeTruthy();
    else expect(resolution.reason).toBeTruthy();
  }
});
