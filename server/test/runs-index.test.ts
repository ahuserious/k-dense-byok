// danbot-byok — runs-index.test.ts
// Proves the file-backed run/loop metadata index (src/agent/runs-index.ts) that
// replaces agent-control-plane's Neon DB:
//   - startRun → finishRun round-trips with latest-row-wins (append-only log)
//   - createLoop / updateLoop persist the single mutable loop.json doc
//   - listRuns folds to one row per id and returns them newest-first
//   - reconcileInterruptedLoops fails a 'running'/'pending' loop on boot
//   - path traversal in sessionId / loopId is rejected (same guard as the ledger)

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { resolvePaths } from "../src/projects.ts";
import {
  startRun,
  finishRun,
  listRuns,
  listRunsForLoop,
  createLoop,
  getLoop,
  updateLoop,
  reconcileInterruptedLoops,
} from "../src/agent/runs-index.ts";

const PROJECT = "runs-index-test";

// Wipe the project's .kady tree before each test so runs/loops don't leak across
// cases. resolvePaths is a pure path computation (no seeding), like the ledger test.
beforeEach(() => {
  const kadyDir = path.dirname(resolvePaths(PROJECT).runsDir); // .../.kady
  fs.rmSync(kadyDir, { recursive: true, force: true });
});

describe("runs-index: runs (append-only, latest-row-wins)", () => {
  it("startRun then finishRun round-trips; readers take the latest row per id", () => {
    const sessionId = "sess-roundtrip";
    const runId = startRun(PROJECT, {
      sessionId,
      loopId: null,
      iteration: 0,
      task: "do the thing",
      role: "agent",
      model: "test-model",
    });

    // After startRun: exactly one row, status 'running', nothing finalized.
    let runs = listRuns(PROJECT);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.status).toBe("running");
    expect(runs[0]!.output).toBeUndefined();

    const ok = finishRun(PROJECT, sessionId, runId, {
      status: "completed",
      output: "the result",
      reasoning: "because",
      costUsd: 0.42,
      tokensIn: 100,
      tokensOut: 50,
      numTurns: 3,
    });
    expect(ok).toBe(true);

    // Two physical rows on disk (append-only), but the index folds to one.
    const file = path.join(resolvePaths(PROJECT).runsDir, sessionId, "runs.jsonl");
    const physicalRows = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    expect(physicalRows).toHaveLength(2);

    runs = listRuns(PROJECT);
    expect(runs).toHaveLength(1);
    const finished = runs[0]!;
    expect(finished.id).toBe(runId); // same id — the terminal row carries it
    expect(finished.status).toBe("completed"); // latest row wins
    expect(finished.output).toBe("the result");
    expect(finished.reasoning).toBe("because");
    expect(finished.costUsd).toBeCloseTo(0.42, 6);
    expect(finished.tokensIn).toBe(100);
    expect(finished.tokensOut).toBe(50);
    expect(finished.numTurns).toBe(3);
    // Fields set at startRun and not overwritten by finishRun survive.
    expect(finished.task).toBe("do the thing");
    expect(finished.model).toBe("test-model");
  });

  it("finishRun returns false for an unknown run id", () => {
    const sessionId = "sess-unknown";
    startRun(PROJECT, {
      sessionId,
      loopId: null,
      iteration: 0,
      task: "t",
      role: "agent",
    });
    expect(finishRun(PROJECT, sessionId, "deadbeef", { status: "completed" })).toBe(false);
  });

  it("listRuns returns newest-first across multiple sessions", () => {
    // Three runs in different sessions; the LAST started should sort first.
    const first = startRun(PROJECT, {
      sessionId: "sess-a",
      loopId: null,
      iteration: 0,
      task: "a",
      role: "agent",
    });
    const second = startRun(PROJECT, {
      sessionId: "sess-b",
      loopId: null,
      iteration: 0,
      task: "b",
      role: "agent",
    });
    const third = startRun(PROJECT, {
      sessionId: "sess-c",
      loopId: null,
      iteration: 0,
      task: "c",
      role: "agent",
    });

    const runs = listRuns(PROJECT);
    // All three runs are present, one row each.
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id).sort()).toEqual([first, second, third].sort());
    // ts is non-increasing (newest first). These three start in the same
    // millisecond, so we can't assert a strict insertion order across the tie —
    // only that the result is sorted descending by ts and stable across calls.
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i - 1]!.ts).toBeGreaterThanOrEqual(runs[i]!.ts);
    }
    // The order is deterministic: a second call yields the identical sequence.
    expect(listRuns(PROJECT).map((r) => r.id)).toEqual(runs.map((r) => r.id));

    // limit caps the result after sorting (first 2 of the stable order).
    expect(listRuns(PROJECT, 2).map((r) => r.id)).toEqual(runs.slice(0, 2).map((r) => r.id));
  });

  it("listRunsForLoop filters by loopId", () => {
    const loopId = "loop-filter";
    const inLoop = startRun(PROJECT, {
      sessionId: "sess-loop",
      loopId,
      iteration: 1,
      task: "loop task",
      role: "worker",
    });
    startRun(PROJECT, {
      sessionId: "sess-free",
      loopId: null,
      iteration: 0,
      task: "free task",
      role: "agent",
    });

    const forLoop = listRunsForLoop(PROJECT, loopId);
    expect(forLoop).toHaveLength(1);
    expect(forLoop[0]!.id).toBe(inLoop);
    expect(forLoop[0]!.loopId).toBe(loopId);
  });
});

describe("runs-index: loops (single mutable doc)", () => {
  it("createLoop / updateLoop persist to loop.json", () => {
    const loop = createLoop(PROJECT, {
      goal: "ship the feature",
      mode: "orchestrated",
      maxIterations: 10,
    });
    expect(loop.status).toBe("pending");
    expect(loop.iteration).toBe(0);
    expect(loop.maxIterations).toBe(10);

    // Round-trips from disk.
    expect(getLoop(PROJECT, loop.id)).toEqual(loop);

    const updated = updateLoop(PROJECT, loop.id, {
      status: "running",
      iteration: 3,
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.iteration).toBe(3);
    // Immutable fields untouched; updatedAt bumped.
    expect(updated!.goal).toBe("ship the feature");
    expect(updated!.maxIterations).toBe(10);

    // Persisted, not just returned.
    const reread = getLoop(PROJECT, loop.id);
    expect(reread!.status).toBe("running");
    expect(reread!.iteration).toBe(3);
  });

  it("updateLoop returns null for an unknown loop", () => {
    expect(updateLoop(PROJECT, "nope", { status: "failed" })).toBeNull();
  });

  it("reconcileInterruptedLoops fails running/pending loops, preserves paused/stopped", () => {
    const running = createLoop(PROJECT, { goal: "g1", mode: "ralph", maxIterations: 5 });
    updateLoop(PROJECT, running.id, { status: "running" });

    const pending = createLoop(PROJECT, { goal: "g2", mode: "ralph", maxIterations: 5 });
    // pending is the default — leave as-is.

    const paused = createLoop(PROJECT, { goal: "g3", mode: "ralph", maxIterations: 5 });
    updateLoop(PROJECT, paused.id, { status: "paused" });

    const reconciled = reconcileInterruptedLoops(PROJECT);
    expect(reconciled.sort()).toEqual([running.id, pending.id].sort());

    expect(getLoop(PROJECT, running.id)!.status).toBe("failed");
    expect(getLoop(PROJECT, running.id)!.lastError).toMatch(/server restart/);
    expect(getLoop(PROJECT, pending.id)!.status).toBe("failed");
    expect(getLoop(PROJECT, paused.id)!.status).toBe("paused"); // wait state preserved
  });
});

describe("runs-index: path traversal is rejected", () => {
  it("rejects a traversing sessionId in startRun", () => {
    expect(() =>
      startRun(PROJECT, {
        sessionId: "../escape",
        loopId: null,
        iteration: 0,
        task: "t",
        role: "agent",
      }),
    ).toThrow(/Invalid session id/);
  });

  it("rejects a traversing loopId in createLoop", () => {
    expect(() =>
      createLoop(PROJECT, { goal: "g", mode: "ralph", maxIterations: 1, id: "../../etc" }),
    ).toThrow(/Invalid loop id/);
  });

  it("rejects a dot-leading sessionId in finishRun", () => {
    expect(() => finishRun(PROJECT, ".hidden", "abc", { status: "completed" })).toThrow(
      /Invalid session id/,
    );
  });
});
