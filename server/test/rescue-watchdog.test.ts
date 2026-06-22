// danbot-byok — rescue-watchdog.test.ts
// Proves the background-rescue watchdog (src/agent/rescue-watchdog.ts) WITHOUT any
// live call: getRun, rescue, restart, now and sleep are all injected.
//
// The watchdog POLLS getRun (Archon's per-run truth: { run, events }) rather than
// trusting the notification-only SSE, runs the PURE detector detectDivergence, and
// on a non-null signal calls rescue() (synthesize a re-grounding prompt) then
// restart() (new run / gate reject). We assert:
//   - detectDivergence flags 'stall' once the injected clock advances past stallMs
//   - detectDivergence flags 'loop-stuck' on repeated starts with no completion
//   - a healthy completing run triggers NOTHING (no rescue, no restart)
//   - watchRun wires detect -> rescue -> restart, forwarding the synthesized prompt
//
// runRescue logs a row to the file-backed runs-index, so we use a throwaway
// project id and wipe its .kady tree per test (same approach as runs-index.test.ts).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { resolvePaths } from "../src/projects.ts";
import { listRuns } from "../src/agent/runs-index.ts";
import {
  detectDivergence,
  watchRun,
  type RunEvent,
  type RescueContext,
  type RestartContext,
  type RescueEvent,
} from "../src/agent/rescue-watchdog.ts";

const PROJECT = "rescue-watchdog-test";

beforeEach(() => {
  const kadyDir = path.dirname(resolvePaths(PROJECT).runsDir); // .../.kady
  fs.rmSync(kadyDir, { recursive: true, force: true });
});

// Realistic epoch-ms base (2024-01-01). The watchdog scales any timestamp below
// 1e12 from seconds to ms, so fixtures MUST use real epoch-ms values (> 1e12) to
// be read as milliseconds — this is exactly the seconds-vs-ms guard under test.
const BASE = 1_704_067_200_000;

// A node_started event for `nodeId` at offset `tMs` from BASE.
function started(nodeId: string, tMs: number): RunEvent {
  return { type: "node_started", node_id: nodeId, ts: BASE + tMs };
}
// A node_completed event carrying an output text.
function completed(nodeId: string, tMs: number, output: string): RunEvent {
  return {
    type: "node_completed",
    node_id: nodeId,
    ts: BASE + tMs,
    data: { node_output: output, cost_usd: 0.01, num_turns: 3 },
  };
}
// A tool/command event — proof of real work inside a node.
function toolCall(nodeId: string, tMs: number): RunEvent {
  return { type: "tool_call", node_id: nodeId, ts: BASE + tMs };
}

// A snapshot in the { run, events } shape getRun returns.
function snapshot(status: string, events: RunEvent[]) {
  return { run: { status }, events };
}

describe("detectDivergence (pure)", () => {
  it("flags 'stall' once the clock advances past stallMs with no new event", () => {
    // Node started + did one tool call at t=1000ms, then went silent.
    const events = [started("plan", 1_000), toolCall("plan", 2_000)];

    // At BASE + 2s + 60s the node has only been idle 60s (< default 180s): healthy.
    const early = detectDivergence(events, { stallMs: 180_000, now: () => BASE + 2_000 + 60_000 });
    expect(early.kind).toBeNull();

    // Advance the injected clock past the 180s stall window: now it's a stall.
    const stalled = detectDivergence(events, { stallMs: 180_000, now: () => BASE + 2_000 + 200_000 });
    expect(stalled.kind).toBe("stall");
    expect(stalled.nodeId).toBe("plan");
  });

  it("flags 'loop-stuck' on repeated starts for one node with no completion", () => {
    // Same node started 5 times (> default maxRepeats=4), never completed.
    const events: RunEvent[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      events.push(started("build", 1_000 + attempt * 1_000));
    }
    // Use a fixed now() recent enough that the stall window is NOT also tripped,
    // so we isolate the loop-stuck signal (loop-stuck has priority anyway).
    const result = detectDivergence(events, { maxRepeats: 4, now: () => BASE + 5_001 });
    expect(result.kind).toBe("loop-stuck");
    expect(result.nodeId).toBe("build");
  });

  it("triggers NOTHING for a healthy node that did real work and completed", () => {
    const events = [
      started("plan", 1_000),
      toolCall("plan", 2_000),
      completed("plan", 3_000, "Wrote plan.md with 4 steps."),
    ];
    // Clock far in the future: a COMPLETED node is not "open", so no stall fires.
    const result = detectDivergence(events, { stallMs: 180_000, now: () => BASE + 10_000_000 });
    expect(result.kind).toBeNull();
  });
});

describe("watchRun (injected getRun/rescue/restart/now/sleep — no live calls)", () => {
  // A getRun that returns a fixed sequence of snapshots, one per poll, advancing
  // the injected clock between polls so the stall window can elapse deterministically.
  function sequencedGetRun(snapshots: ReturnType<typeof snapshot>[]) {
    let call = 0;
    return async () => snapshots[Math.min(call++, snapshots.length - 1)];
  }

  it("detects a STALL across polls, then calls rescue() + restart() with the synthesized prompt", async () => {
    // The same stalled events on every poll; the clock advances between polls so by
    // the 2nd poll the node has been idle past stallMs.
    const stalledEvents = [started("plan", 1_000), toolCall("plan", 2_000)];
    const snapshots = [snapshot("running", stalledEvents), snapshot("running", stalledEvents)];

    // now() is shared by the detector AND advances each poll. First poll: ~1s idle
    // (< 180s). Second poll: ~201s idle (>= 180s) -> stall. detectDivergence calls
    // now() exactly once per poll, so this single incrementing clock stays in sync.
    let clock = BASE + 2_000 + 1_000; // first detect sees ~1s idle
    const now = () => {
      const t = clock;
      clock += 200_000; // each call jumps the clock forward 200s
      return t;
    };

    const tags: RescueEvent["tag"][] = [];
    let rescueArgs: RescueContext | null = null;
    let restartArgs: RestartContext | null = null;

    const result = await watchRun({
      runId: "run-123",
      projectId: PROJECT,
      workflowName: "ship-it",
      getRun: sequencedGetRun(snapshots),
      now,
      pollMs: 15_000,
      sleep: async () => {}, // never wait real time
      onEvent: (e) => tags.push(e.tag),
      rescue: async (ctx) => {
        rescueArgs = ctx;
        return "RE-GROUNDING: restate the goal, drop unverified work, do step 1.";
      },
      restart: async (ctx) => {
        restartArgs = ctx;
        return { newRunId: "run-456" };
      },
    });

    // Rescue + restart both fired, with the synthesized prompt threaded through.
    expect(result.rescued).toBe(true);
    expect(result.stoppedReason).toBe("rescued");
    expect(result.divergence?.kind).toBe("stall");
    expect(rescueArgs).not.toBeNull();
    expect(rescueArgs!.divergence.kind).toBe("stall");
    expect(restartArgs).not.toBeNull();
    expect(restartArgs!.synthesizedPrompt).toBe(
      "RE-GROUNDING: restate the goal, drop unverified work, do step 1.",
    );
    expect(restartArgs!.workflowName).toBe("ship-it");
    expect(result.restartResult).toEqual({ newRunId: "run-456" });

    // Lifecycle tags emitted in order for SSE.
    expect(tags).toEqual(["rescue_detected", "synthesizing", "restart", "done"]);

    // The rescue was logged to the runs-index as a 'worker' row.
    const rows = listRuns(PROJECT);
    const rescueRow = rows.find((r) => r.role === "worker" && r.task.includes("background-rescue"));
    expect(rescueRow).toBeDefined();
    expect(rescueRow!.status).toBe("completed");
    expect(rescueRow!.output).toContain("RE-GROUNDING");
  });

  it("detects a LOOP-STUCK run and rescues+restarts it", async () => {
    const loopEvents: RunEvent[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      loopEvents.push(started("build", 1_000 + attempt * 1_000));
    }
    let restartCalled = false;

    const result = await watchRun({
      runId: "run-loop",
      projectId: PROJECT,
      workflowName: "ship-it",
      getRun: async () => snapshot("running", loopEvents),
      now: () => BASE + 7_001, // recent: isolate loop-stuck (not stall)
      sleep: async () => {},
      rescue: async () => "RE-GROUNDING: you are looping on build; verify the error first.",
      restart: async (ctx: RestartContext) => {
        restartCalled = true;
        expect(ctx.synthesizedPrompt).toContain("looping on build");
        return { newRunId: "run-loop-2" };
      },
    });

    expect(result.divergence?.kind).toBe("loop-stuck");
    expect(result.rescued).toBe(true);
    expect(restartCalled).toBe(true);
  });

  it("triggers NOTHING for a healthy run that completes (no rescue, no restart)", async () => {
    const healthyEvents = [
      started("plan", 1_000),
      toolCall("plan", 2_000),
      completed("plan", 3_000, "Done — plan written."),
    ];
    // First poll: running+healthy -> sleep. Second poll: terminal 'completed' -> stop.
    const snapshots = [snapshot("running", healthyEvents), snapshot("completed", healthyEvents)];

    let rescueCalled = false;
    let restartCalled = false;

    const result = await watchRun({
      runId: "run-ok",
      projectId: PROJECT,
      getRun: sequencedGetRun(snapshots),
      now: () => BASE + 3_000, // node already completed; not open -> no stall
      sleep: async () => {},
      rescue: async () => {
        rescueCalled = true;
        return "should not be called";
      },
      restart: async () => {
        restartCalled = true;
        return null;
      },
    });

    expect(result.rescued).toBe(false);
    expect(result.stoppedReason).toBe("terminal");
    expect(rescueCalled).toBe(false);
    expect(restartCalled).toBe(false);

    // No rescue row was logged.
    const rescueRows = listRuns(PROJECT).filter((r) => r.task.includes("background-rescue"));
    expect(rescueRows.length).toBe(0);
  });
});
