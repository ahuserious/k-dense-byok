import { describe, expect, it } from "vitest";

import {
  ACTIVE_IDLE_POLL_MS,
  ACTIVE_RUNNING_POLL_MS,
  appendFrames,
  assignPollRanks,
  BACKGROUND_POLL_MS,
  dagRunSources,
  deepLinkSearch,
  describeEmptyState,
  filterLiveSources,
  formatElapsed,
  isRecentlyActive,
  liveSourceKey,
  matchDeepLink,
  MAX_BACKOFF_MS,
  MAX_CONCURRENT_SESSION_POLLERS,
  mergeLiveSources,
  nextPollDelayMs,
  openChatTabsFromStorage,
  openTabSources,
  parseDeepLink,
  parseSessionRunSnapshot,
  RECENT_ACTIVITY_WINDOW_MS,
  SELECTED_IDLE_POLL_MS,
  SELECTED_RUNNING_POLL_MS,
  sessionSources,
  SOURCE_FRAME_RING,
  toEpochMs,
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

  it("names both empty reasons instead of spinning", () => {
    const message = describeEmptyState(null);
    expect(message).toContain("no queued or running DAG workflow runs");
    expect(message).toContain("last 30 minutes");
    expect(describeEmptyState("default")).toContain("in default");
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
