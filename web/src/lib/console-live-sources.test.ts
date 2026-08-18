import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dagWorkflowsApi from "@/lib/dag-workflows";
import * as projectsApi from "@/lib/projects";

import {
  ACTIVE_IDLE_POLL_MS,
  ACTIVE_RUNNING_POLL_MS,
  appendFrames,
  applySessionRunStates,
  assignPollRanks,
  BACKGROUND_POLL_MS,
  dagRunSources,
  deepLinkSearch,
  describeEmptyState,
  describeUnresolvedDeepLink,
  discoveryNotices,
  filterLiveSources,
  formatElapsed,
  isProjectBusy,
  isRecentlyActive,
  liveSourceKey,
  LIST_POLL_MS,
  matchDeepLink,
  MAX_BACKOFF_MS,
  MAX_CONCURRENT_SESSION_POLLERS,
  MAX_SWEPT_PROJECTS,
  mergeLiveSources,
  nextPollDelayMs,
  openChatTabsFromStorage,
  openTabSources,
  parseDeepLink,
  parseSessionRunSnapshot,
  parseSessionWorkflowRunLink,
  PROJECT_SWEEP_CACHE_MS,
  RECENT_ACTIVITY_WINDOW_MS,
  SELECTED_IDLE_POLL_MS,
  SELECTED_RUNNING_POLL_MS,
  sessionProbeCoverage,
  sessionProbeNotice,
  sessionsToProbe,
  sessionSources,
  SOURCE_FRAME_RING,
  toEpochMs,
  useOpenWork,
  useSessionRunStates,
  type LiveSource,
} from "./console-live-sources";
import type { WorkflowRunSummary } from "./dag-workflows";
import { WORKSPACE_SCHEMA_VERSION } from "./workspace-persistence";
import type { SessionFrame } from "./session-dag-projection";

const NOW = 1_787_008_600_000;

function runSummary(
  id: string,
  status: WorkflowRunSummary["status"],
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return {
    id,
    workflowId: "rna-seq",
    workflowRevision: 1,
    graphSha256: "sha",
    sessionId: null,
    createdAt: NOW - 10_000,
    requestedBy: "user",
    status,
    lastSeq: 4,
    startedAt: NOW - 5_000,
    finishedAt: null,
    interruptedAt: null,
    recoverable: false,
    lastError: null,
    diagnostics: [],
    ...overrides,
  };
}

describe("timestamp tolerance", () => {
  it("accepts both wire spellings of created/modified", () => {
    // The live backend serializes Date -> ISO string; the mocked Playwright
    // tier returns epoch numbers. A parser that assumed one drops every row in
    // the other tier.
    expect(toEpochMs(NOW)).toBe(NOW);
    expect(toEpochMs("2026-08-18T00:56:40.000Z")).toBe(Date.parse("2026-08-18T00:56:40.000Z"));
    expect(toEpochMs(null)).toBe(0);
    expect(toEpochMs("not a date")).toBe(0);
  });

  it("formats elapsed labels down to the right unit", () => {
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatElapsed(3 * 3_600_000)).toBe("3h");
    expect(formatElapsed(50 * 3_600_000)).toBe("2d");
    expect(formatElapsed(-1)).toBe("—");
  });
});

describe("discovery inputs", () => {
  it("(a) lists only queued/running typed runs", () => {
    const sources = dagRunSources(
      [
        runSummary("wrun_1", "running"),
        runSummary("wrun_2", "queued"),
        runSummary("wrun_3", "succeeded"),
        runSummary("wrun_4", "cancelled"),
      ],
      "default",
      "Default",
    );
    expect(sources.map((source) => source.id)).toEqual(["wrun_1", "wrun_2"]);
    expect(sources[0].live).toBe(true);
    expect(sources[1].live).toBe(false);
    expect(sources[0].key).toBe(liveSourceKey("dag-run", "default", "wrun_1"));
  });

  it("(d) keeps only sessions touched inside the 30 minute window", () => {
    const sources = sessionSources(
      [
        { id: "fresh", name: "Fresh chat", modified: NOW - 60_000 },
        { id: "stale", name: "Stale chat", modified: NOW - RECENT_ACTIVITY_WINDOW_MS - 1 },
        { id: "iso", modified: new Date(NOW - 1_000).toISOString(), firstMessage: "Cluster the counts" },
      ],
      "default",
      "Default",
      NOW,
    );
    expect(sources.map((source) => source.id)).toEqual(["fresh", "iso"]);
    expect(sources[0].title).toBe("Fresh chat");
    // No name -> the first message is the readable title, not the raw id.
    expect(sources[1].title).toBe("Cluster the counts");
    expect(isRecentlyActive(NOW - RECENT_ACTIVITY_WINDOW_MS + 1, NOW)).toBe(true);
    expect(isRecentlyActive(0, NOW)).toBe(false);
  });

  it("(c) reads this browser's open chat tabs out of the workspace snapshot", () => {
    const snapshot = JSON.stringify({
      version: WORKSPACE_SCHEMA_VERSION,
      screen: "workspace",
      openedProjectIds: ["default", "other"],
      projects: {
        default: {
          tabs: [
            { id: "tab-1", title: "Chat 1", sessionId: "session-a" },
            { id: "tab-2", title: "Chat 2" },
          ],
          activeTabId: "tab-1",
        },
        other: {
          tabs: [{ id: "tab-3", title: "Chat 3", sessionId: "session-b" }],
          activeTabId: "tab-3",
        },
      },
    });
    const tabs = openChatTabsFromStorage(snapshot);
    expect(tabs).toEqual([
      { projectId: "default", sessionId: "session-a", title: "Chat 1" },
      { projectId: "other", sessionId: "session-b", title: "Chat 3" },
    ]);

    const sources = openTabSources(tabs, new Map([["other", "Other project"]]), NOW);
    expect(sources[1].projectName).toBe("Other project");
    // An open tab counts as here-now even when its transcript is old.
    expect(sources[0].lastActivityAt).toBe(NOW);
  });

  it("(c) survives a corrupt or absent snapshot", () => {
    expect(openChatTabsFromStorage(null)).toEqual([]);
    expect(openChatTabsFromStorage("{not json")).toEqual([]);
    expect(openChatTabsFromStorage(JSON.stringify({ version: 99 }))).toEqual([]);
  });
});

describe("merge", () => {
  it("dedupes one session discovered twice and unions its origins", () => {
    const recent = sessionSources(
      [{ id: "session-a", name: "Chat 1", modified: NOW - 120_000 }],
      "default",
      "Default",
      NOW,
    );
    const openTab = openTabSources(
      [{ projectId: "default", sessionId: "session-a", title: "Chat 1" }],
      new Map([["default", "Default"]]),
      NOW,
    );
    const merged = mergeLiveSources([recent, openTab]);
    expect(merged).toHaveLength(1);
    expect(merged[0].origins).toEqual(["open-tab", "recent"]);
    // The freshest activity wins, so an open tab floats to the top of the rail.
    expect(merged[0].lastActivityAt).toBe(NOW);
  });

  it("orders live work first, then by recency, then stably by key", () => {
    const merged = mergeLiveSources([
      dagRunSources([runSummary("wrun_q", "queued")], "default", "Default"),
      sessionSources(
        [
          { id: "older", modified: NOW - 600_000 },
          { id: "newer", modified: NOW - 1_000 },
        ],
        "default",
        "Default",
        NOW,
      ),
      dagRunSources([runSummary("wrun_r", "running")], "default", "Default"),
    ]);
    // Live first; everything else strictly by recency, so a queued run that
    // started five seconds ago sits below a session touched one second ago.
    expect(merged.map((source) => source.id)).toEqual(["wrun_r", "newer", "wrun_q", "older"]);
  });

  it("filters by title, id, and project name", () => {
    const sources = mergeLiveSources([
      sessionSources([{ id: "session-a", name: "RNA clustering", modified: NOW }], "p1", "Genomics", NOW),
      sessionSources([{ id: "session-b", name: "Docs", modified: NOW }], "p2", "Writing", NOW),
    ]);
    expect(filterLiveSources(sources, "rna").map((source) => source.id)).toEqual(["session-a"]);
    expect(filterLiveSources(sources, "session-b").map((source) => source.id)).toEqual(["session-b"]);
    expect(filterLiveSources(sources, "writing").map((source) => source.id)).toEqual(["session-b"]);
    expect(filterLiveSources(sources, "  ")).toHaveLength(2);
  });

  it("names both empty reasons instead of spinning, and scopes the session claim", () => {
    const message = describeEmptyState(null);
    expect(message).toContain("no queued or running DAG workflow runs");
    expect(message).toContain("last 30 minutes");
    // A chat tab whose session has no transcript yet is invisible to
    // GET /sessions, so the copy must not claim "no chat sessions open".
    expect(message).toContain("no chat session with a saved transcript");
    expect(describeEmptyState("Genomics")).toContain("in Genomics");
  });

  it("says so when a deep link names something discovery cannot see", () => {
    expect(describeUnresolvedDeepLink({ kind: "dag-run", id: "wrun_x" })).toContain(
      "wrun_x",
    );
    expect(describeUnresolvedDeepLink({ kind: "dag-run", id: "wrun_x" })).toContain(
      "finished",
    );
    expect(describeUnresolvedDeepLink({ kind: "session", id: "session-x" })).toContain(
      "saved transcript",
    );
    expect(describeUnresolvedDeepLink(null)).toBeNull();
  });

  it("counts only work happening now as busy", () => {
    expect(isProjectBusy({ running: 1, needsInput: 0 })).toBe(true);
    expect(isProjectBusy({ running: 0, needsInput: 2 })).toBe(true);
    expect(isProjectBusy({ running: 0, needsInput: 0 })).toBe(false);
    expect(isProjectBusy(null)).toBe(false);
    // `errors` is a historical outcome and `blocked` is a spend-limit flag;
    // neither means the project is doing anything right now.
    const staleAndOverBudget = { running: 0, needsInput: 0, errors: 9, blocked: 1, done: 3 };
    expect(isProjectBusy(staleAndOverBudget)).toBe(false);
  });

  it("names what discovery could not do, instead of truncating silently", () => {
    expect(
      discoveryNotices({
        failedProjectIds: [],
        busyProjectCount: 0,
        sweptBusyProjectCount: 0,
        activitySweepFailed: false,
      }),
    ).toEqual([]);
    expect(
      discoveryNotices({
        failedProjectIds: ["broken"],
        busyProjectCount: 30,
        sweptBusyProjectCount: 19,
        activitySweepFailed: true,
      }),
    ).toEqual([
      "couldn't read 1 project",
      "showing 19 of 30 busy projects",
      "cross-project sweep unavailable",
    ]);
    expect(
      discoveryNotices({
        failedProjectIds: ["a", "b"],
        busyProjectCount: 2,
        sweptBusyProjectCount: 2,
        activitySweepFailed: false,
      }),
    ).toEqual(["couldn't read 2 projects"]);
  });
});

describe("polling cadence", () => {
  it("gives the selected source the fast cadence", () => {
    expect(
      nextPollDelayMs({ selected: true, running: true, rank: 0, consecutiveErrors: 0, documentHidden: false }),
    ).toBe(SELECTED_RUNNING_POLL_MS);
    expect(
      nextPollDelayMs({ selected: true, running: false, rank: 0, consecutiveErrors: 0, documentHidden: false }),
    ).toBe(SELECTED_IDLE_POLL_MS);
  });

  it("caps concurrent fast pollers at eight and slows the rest", () => {
    const inside = nextPollDelayMs({
      selected: false,
      running: true,
      rank: MAX_CONCURRENT_SESSION_POLLERS - 1,
      consecutiveErrors: 0,
      documentHidden: false,
    });
    const outside = nextPollDelayMs({
      selected: false,
      running: true,
      rank: MAX_CONCURRENT_SESSION_POLLERS,
      consecutiveErrors: 0,
      documentHidden: false,
    });
    expect(inside).toBe(ACTIVE_RUNNING_POLL_MS);
    expect(outside).toBe(BACKGROUND_POLL_MS);
    expect(
      nextPollDelayMs({ selected: false, running: false, rank: 0, consecutiveErrors: 0, documentHidden: false }),
    ).toBe(ACTIVE_IDLE_POLL_MS);
  });

  it("doubles after three consecutive errors and stops at the ceiling", () => {
    const at = (consecutiveErrors: number) =>
      nextPollDelayMs({ selected: true, running: true, rank: 0, consecutiveErrors, documentHidden: false });
    expect(at(0)).toBe(SELECTED_RUNNING_POLL_MS);
    expect(at(2)).toBe(SELECTED_RUNNING_POLL_MS);
    expect(at(3)).toBe(SELECTED_RUNNING_POLL_MS * 2);
    expect(at(4)).toBe(SELECTED_RUNNING_POLL_MS * 4);
    expect(at(9)).toBe(MAX_BACKOFF_MS);
    expect(at(50)).toBe(MAX_BACKOFF_MS);
  });

  it("pauses entirely while the document is hidden", () => {
    expect(
      nextPollDelayMs({ selected: true, running: true, rank: 0, consecutiveErrors: 0, documentHidden: true }),
    ).toBeNull();
  });

  it("ranks the selected source first, then live work, then recency", () => {
    const sources: LiveSource[] = mergeLiveSources([
      dagRunSources([runSummary("wrun_1", "running")], "default", "Default"),
      sessionSources(
        [
          { id: "quiet", modified: NOW - 400_000 },
          { id: "chatty", modified: NOW - 1_000 },
          { id: "picked", modified: NOW - 900_000 },
        ],
        "default",
        "Default",
        NOW,
      ),
    ]);
    const ranks = assignPollRanks(sources, liveSourceKey("session", "default", "picked"));
    // DAG runs are not session pollers, so they take no rank at all.
    expect(ranks.has(liveSourceKey("dag-run", "default", "wrun_1"))).toBe(false);
    expect(ranks.get(liveSourceKey("session", "default", "picked"))).toBe(0);
    expect(ranks.get(liveSourceKey("session", "default", "chatty"))).toBe(1);
    expect(ranks.get(liveSourceKey("session", "default", "quiet"))).toBe(2);
  });
});

describe("frame ring buffer", () => {
  const frame = (seq: number): SessionFrame => ({ seq, type: "text_delta", delta: "x" });

  it("appends without duplicating and keeps the newest 500", () => {
    const first = appendFrames([], [frame(1), frame(2), frame(3)]);
    const second = appendFrames(first, [frame(2), frame(3), frame(4)]);
    expect(second.map((item) => item.seq)).toEqual([1, 2, 3, 4]);

    const long = appendFrames(
      [],
      Array.from({ length: SOURCE_FRAME_RING + 10 }, (_, index) => frame(index + 1)),
    );
    expect(long).toHaveLength(SOURCE_FRAME_RING);
    expect(long[0].seq).toBe(11);
    expect(long.at(-1)?.seq).toBe(SOURCE_FRAME_RING + 10);
  });

  it("ignores frames without a usable sequence", () => {
    const kept = appendFrames([], [frame(1), { seq: Number.NaN, type: "bogus" }]);
    expect(kept.map((item) => item.seq)).toEqual([1]);
  });
});

describe("run-state parsing", () => {
  it("reads the captured fresh-session body as no run", () => {
    // Verbatim from the hermetic preview: GET /sessions/:id/run/state.
    const snapshot = parseSessionRunSnapshot(JSON.parse('{"status":"none"}'));
    expect(snapshot).toEqual({ status: "none", runId: null, frames: [], lastSeq: 0 });
  });

  it("reads a retained run's frames and cursor", () => {
    const snapshot = parseSessionRunSnapshot({
      status: "running",
      run: {
        runId: "run-1",
        prompt: "Cluster the counts",
        images: [],
        baseline: { messages: [], contextUsage: null },
        frames: [
          { seq: 1, type: "run_start", runId: "run-1" },
          { seq: 2, type: "turn_start" },
          { type: "no-seq" },
          "junk",
        ],
        lastSeq: 2,
      },
    });
    expect(snapshot.status).toBe("running");
    expect(snapshot.runId).toBe("run-1");
    expect(snapshot.frames.map((item) => item.seq)).toEqual([1, 2]);
    expect(snapshot.lastSeq).toBe(2);
  });

  it("treats a malformed body as no run rather than throwing", () => {
    expect(parseSessionRunSnapshot(null).status).toBe("none");
    expect(parseSessionRunSnapshot({ status: "wat" }).status).toBe("none");
    expect(parseSessionRunSnapshot({ status: "running", run: null }).frames).toEqual([]);
  });
});

describe("deep links", () => {
  it("parses ?run= and ?session=, preferring the run", () => {
    expect(parseDeepLink("?run=wrun_1")).toEqual({ kind: "dag-run", id: "wrun_1" });
    expect(parseDeepLink("session=session-a")).toEqual({ kind: "session", id: "session-a" });
    expect(parseDeepLink("?run=wrun_1&session=session-a")).toEqual({
      kind: "dag-run",
      id: "wrun_1",
    });
    expect(parseDeepLink("")).toBeNull();
  });

  it("writes the selection back without clobbering unrelated params", () => {
    const source = dagRunSources([runSummary("wrun_1", "running")], "default", "Default")[0];
    expect(deepLinkSearch("?tab=console&session=old", source)).toBe("?tab=console&run=wrun_1");
    expect(deepLinkSearch("?run=wrun_1", null)).toBe("");
  });

  it("resolves a link only once discovery has the source", () => {
    const sources = dagRunSources([runSummary("wrun_1", "running")], "default", "Default");
    expect(matchDeepLink(sources, { kind: "dag-run", id: "wrun_1" })?.id).toBe("wrun_1");
    expect(matchDeepLink(sources, { kind: "dag-run", id: "wrun_missing" })).toBeNull();
    expect(matchDeepLink(sources, { kind: "session", id: "wrun_1" })).toBeNull();
    expect(matchDeepLink(sources, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The discovery hook itself. Round 1 tested only the pure helpers, so the
// /projects/activity sweep — the whole of discovery input (b) — was executed by
// no test at all, and neither were the 3s tick, the visibility pause, the
// per-project cache, or the effect teardown.
// ---------------------------------------------------------------------------

interface FakeProject {
  id: string;
  name: string;
}

function project(id: string): FakeProject {
  return { id, name: `Project ${id}` };
}

/** One `apiFetch` call, reduced to what discovery is actually asserted on. */
interface RecordedFetch {
  path: string;
  projectId: string | undefined;
}

describe("useOpenWork discovery", () => {
  let roster: FakeProject[];
  let activities: Record<string, { running: number; needsInput: number; errors: number; blocked: number; done: number }>;
  let calls: RecordedFetch[];
  let failingProjectIds: Set<string>;
  let hidden: boolean;

  const activity = (
    overrides: Partial<{ running: number; needsInput: number; errors: number; blocked: number; done: number }>,
  ) => ({ running: 0, needsInput: 0, errors: 0, blocked: 0, done: 0, ...overrides });

  function sessionRowsFor(projectId: string) {
    return [
      {
        id: `session-${projectId}`,
        name: `Chat in ${projectId}`,
        modified: Date.now(),
        messageCount: 2,
      },
    ];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    roster = [project("default"), project("busy-1"), project("quiet-1")];
    activities = {
      "busy-1": activity({ running: 1 }),
      "quiet-1": activity({ done: 4 }),
    };
    calls = [];
    failingProjectIds = new Set();
    hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    window.localStorage.clear();

    vi.spyOn(projectsApi, "listProjects").mockImplementation(async () =>
      roster.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: "",
        tags: [],
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
        archived: false,
        spendLimitUsd: null,
      })),
    );
    vi.spyOn(projectsApi, "listProjectActivities").mockImplementation(async () => activities);
    vi.spyOn(dagWorkflowsApi, "listDagWorkflowRuns").mockResolvedValue([]);
    vi.spyOn(projectsApi, "apiFetch").mockImplementation(
      async (path: string, _init?: RequestInit, projectId?: string) => {
        calls.push({ path, projectId });
        if (path === "/sessions") {
          const id = projectId ?? "default";
          if (failingProjectIds.has(id)) {
            return { ok: false, status: 500, json: async () => null } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => sessionRowsFor(id),
          } as unknown as Response;
        }
        throw new Error(`unexpected apiFetch ${path}`);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const sessionSweepIds = () =>
    calls.filter((call) => call.path === "/sessions").map((call) => call.projectId);

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function mount(overrides: Partial<Parameters<typeof useOpenWork>[0]> = {}) {
    return renderHook(() =>
      useOpenWork({ projectId: "default", enabled: true, allProjects: true, ...overrides }),
    );
  }

  it("does not touch the network at all while it is not active", async () => {
    // H1: the Console stays mounted-but-hidden after its first visit, so the
    // `enabled` predicate is the only thing standing between the reader being
    // in Chat and this hook sweeping every project every three seconds.
    const { result, unmount } = mount({ enabled: false });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_MS * 4);
    });

    expect(projectsApi.listProjects).not.toHaveBeenCalled();
    expect(projectsApi.listProjectActivities).not.toHaveBeenCalled();
    expect(dagWorkflowsApi.listDagWorkflowRuns).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(result.current.sources).toEqual([]);
    unmount();
  });

  it("sweeps only the projects /projects/activity reports as working now", async () => {
    roster = [
      project("default"),
      project("running"),
      project("needs-input"),
      project("errored"),
      project("over-budget"),
      project("finished"),
    ];
    activities = {
      running: activity({ running: 2 }),
      "needs-input": activity({ needsInput: 1 }),
      errored: activity({ errors: 4 }),
      "over-budget": activity({ blocked: 1 }),
      finished: activity({ done: 9 }),
    };

    const { result, unmount } = mount();
    await settle();

    expect(projectsApi.listProjectActivities).toHaveBeenCalled();
    // The active project is always swept; `errors`/`blocked`/`done` are not
    // "busy" and must not consume one of the twenty sweep slots.
    expect(new Set(sessionSweepIds())).toEqual(new Set(["default", "running", "needs-input"]));
    expect(result.current.sources.map((source) => source.projectId).sort()).toEqual([
      "default",
      "needs-input",
      "running",
    ]);
    // The busy project's counts ride along on the row.
    const busyRow = result.current.sources.find((source) => source.projectId === "running");
    expect(busyRow?.projectActivity).toEqual({ running: 2, needsInput: 0 });
    expect(busyRow?.origins).toContain("active-run");
    expect(result.current.notices).toEqual([]);
    unmount();
  });

  it("bounds the sweep and says how many busy projects it dropped", async () => {
    roster = [project("default")];
    activities = {};
    for (let index = 0; index < 30; index += 1) {
      roster.push(project(`p${index}`));
      activities[`p${index}`] = activity({ running: 1 });
    }

    const { result, unmount } = mount();
    await settle();

    const swept = new Set(sessionSweepIds());
    expect(swept.size).toBe(MAX_SWEPT_PROJECTS);
    expect(result.current.notices).toContain(
      `showing ${MAX_SWEPT_PROJECTS - 1} of 30 busy projects`,
    );
    unmount();
  });

  it("keeps the projects that answered when one project's /sessions fails", async () => {
    roster = [project("default"), project("busy-1"), project("broken")];
    activities = { "busy-1": activity({ running: 1 }), broken: activity({ running: 1 }) };
    failingProjectIds = new Set(["broken"]);

    const { result, unmount } = mount();
    await settle();

    // H3: one 500 used to reject the whole tick, throwing away the healthy
    // projects that had already answered in the same tick — and the rail then
    // asserted that nothing was running.
    expect(result.current.error).toBeNull();
    expect(result.current.sources.map((source) => source.projectId).sort()).toEqual([
      "busy-1",
      "default",
    ]);
    expect(result.current.notices).toContain("couldn't read 1 project");
    unmount();
  });

  it("keeps the active project's work when the cross-project sweep fails", async () => {
    vi.mocked(projectsApi.listProjectActivities).mockRejectedValue(new Error("activity 503"));

    const { result, unmount } = mount();
    await settle();

    expect(result.current.error).toBeNull();
    expect(sessionSweepIds()).toEqual(["default"]);
    expect(result.current.notices).toContain("cross-project sweep unavailable");
    unmount();
  });

  it("ticks every LIST_POLL_MS and reuses a project's list for the cache window", async () => {
    const { unmount } = mount();
    await settle();
    expect(sessionSweepIds().filter((id) => id === "busy-1")).toHaveLength(1);

    // One tick inside PROJECT_SWEEP_CACHE_MS: discovery re-runs, the list does
    // not (LIST_POLL_MS is 3s, the cache is 5s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_MS);
    });
    await settle();
    expect(LIST_POLL_MS).toBeLessThan(PROJECT_SWEEP_CACHE_MS);
    expect(sessionSweepIds().filter((id) => id === "busy-1")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_SWEEP_CACHE_MS);
    });
    await settle();
    expect(sessionSweepIds().filter((id) => id === "busy-1").length).toBeGreaterThan(1);
    unmount();
  });

  it("pauses while the browser tab is hidden and stops on unmount", async () => {
    const { unmount } = mount();
    await settle();
    const afterFirstTick = calls.length;

    hidden = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_MS * 3);
    });
    await settle();
    expect(calls.length).toBe(afterFirstTick);

    hidden = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_MS);
    });
    await settle();
    expect(calls.length).toBeGreaterThan(afterFirstTick);

    const afterResume = calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_MS * 5);
    });
    expect(calls.length).toBe(afterResume);
  });
});

describe("rail run-state probes", () => {
  const sessionSource = (id: string, overrides: Partial<LiveSource> = {}): LiveSource => ({
    key: liveSourceKey("session", "default", id),
    kind: "session",
    id,
    projectId: "default",
    projectName: "Default",
    title: id,
    // Discovery's own answer: it knows the chat exists, not whether it runs.
    status: "unknown",
    live: false,
    lastActivityAt: NOW,
    origins: ["recent"],
    projectActivity: null,
    ...overrides,
  });

  it("probes the ranked-in sessions and leaves the selected one to its own poller", () => {
    const sources = [sessionSource("a"), sessionSource("b"), sessionSource("c")];
    const ranks = new Map([
      [sources[0].key, 0],
      [sources[1].key, 1],
      [sources[2].key, 9],
    ]);
    expect(
      sessionsToProbe(sources, ranks, sources[0].key).map((source) => source.id),
    ).toEqual(["b"]);
    expect(sessionsToProbe(sources, ranks, null).map((source) => source.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("promotes a session the server reports running to running + live", () => {
    const idle = sessionSource("idle", { lastActivityAt: NOW });
    const busy = sessionSource("busy", { lastActivityAt: NOW - 60_000 });
    const promoted = applySessionRunStates(
      [idle, busy],
      new Map([[busy.key, { status: "running" as const, runId: "run-1" }]]),
    );
    // The running session sorts to the top even though it was touched later.
    expect(promoted[0].id).toBe("busy");
    expect(promoted[0].status).toBe("running");
    expect(promoted[0].live).toBe(true);
    expect(promoted[0].origins).toContain("active-run");
    // A session with no probe is left exactly as it was — still `unknown`,
    // because the rail never asked.
    expect(promoted[1]).toBe(idle);
    expect(promoted[1].status).toBe("unknown");
  });

  it("only says `idle` about a session the server actually answered for", () => {
    const asked = sessionSource("asked");
    const notAsked = sessionSource("not-asked");
    const applied = applySessionRunStates(
      [asked, notAsked],
      new Map([[asked.key, { status: "complete" as const, runId: null }]]),
    );
    const byId = new Map(applied.map((source) => [source.id, source]));
    // "complete" is a real observation: the server was asked and said no run.
    expect(byId.get("asked")?.status).toBe("idle");
    expect(byId.get("asked")?.live).toBe(false);
    // Never probed. `idle` here was a positive false statement about the 9th
    // open chat, which is exactly what a reader looks at this rail to learn.
    expect(byId.get("not-asked")?.status).toBe("unknown");
  });

  it("a `none` probe is also an observation and reads as idle", () => {
    const [applied] = applySessionRunStates(
      [sessionSource("quiet")],
      new Map([[liveSourceKey("session", "default", "quiet"), { status: "none" as const, runId: null }]]),
    );
    expect(applied.status).toBe("idle");
  });

  it("states the probe budget when more chats exist than it watches", () => {
    const sources = Array.from({ length: 12 }, (_, index) => sessionSource(`s${index}`));
    const ranks = assignPollRanks(sources, null);
    const coverage = sessionProbeCoverage(sources, ranks, null);
    expect(coverage).toEqual({ watched: MAX_CONCURRENT_SESSION_POLLERS, total: 12 });
    expect(sessionProbeNotice(coverage)).toBe("checking 8 of 12 chats for live status");
  });

  it("counts the selected chat as watched, and says nothing when every chat is watched", () => {
    const sources = Array.from({ length: 8 }, (_, index) => sessionSource(`s${index}`));
    const selectedKey = sources[7].key;
    const ranks = assignPollRanks(sources, selectedKey);
    // The selected chat is excluded from `sessionsToProbe` because
    // `useSessionGraph` polls it directly, so it is still watched.
    expect(sessionProbeCoverage(sources, ranks, selectedKey)).toEqual({
      watched: 8,
      total: 8,
    });
    expect(sessionProbeNotice({ watched: 8, total: 8 })).toBeNull();
  });

  it("polls run state for the probed sessions and reports the running one", async () => {
    vi.useFakeTimers();
    const runStateBodies: Record<string, unknown> = {
      "session-running": {
        status: "running",
        run: { runId: "run-1", frames: [{ seq: 1, type: "run_start" }], lastSeq: 1 },
      },
      "session-idle": { status: "none" },
    };
    const fetchSpy = vi
      .spyOn(projectsApi, "apiFetch")
      .mockImplementation(async (path: string) => {
        const match = /^\/sessions\/([^/]+)\/run\/state$/.exec(path);
        if (!match) throw new Error(`unexpected apiFetch ${path}`);
        return {
          ok: true,
          status: 200,
          json: async () => runStateBodies[match[1]],
        } as unknown as Response;
      });

    const running = sessionSource("session-running");
    const idle = sessionSource("session-idle");
    const ranks = new Map([
      [running.key, 0],
      [idle.key, 1],
    ]);
    const { result, unmount } = renderHook(() =>
      useSessionRunStates({ sessions: [running, idle], ranks, enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.get(running.key)).toEqual({ status: "running", runId: "run-1" });
    expect(result.current.get(idle.key)).toEqual({ status: "none", runId: null });
    unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads the typed workflow-run link a session delegated to", () => {
    expect(
      parseSessionWorkflowRunLink({
        state: {
          schemaVersion: 1,
          runId: "wrun_1",
          workflowId: "chat-e2e-workflow",
          workflowRevision: 2,
          status: "running",
          nodes: [],
          topology: { nodes: [], edges: [] },
        },
      }),
    ).toEqual({ runId: "wrun_1", workflowId: "chat-e2e-workflow", status: "running" });
    expect(parseSessionWorkflowRunLink({ state: null })).toBeNull();
    expect(parseSessionWorkflowRunLink({})).toBeNull();
    expect(parseSessionWorkflowRunLink({ state: { runId: "wrun_1" } })).toBeNull();
  });
});
