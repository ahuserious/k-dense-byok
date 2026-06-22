// danbot-byok — goal-loop.test.ts
// Proves the ported agent-control-plane loop engine (src/agent/goal-loop.ts)
// driving Kady's in-process Pi, WITHOUT any live model call.
//
// KADY_FAKE_LOOP=1 swaps the real createSession/session.prompt drive for a
// deterministic stand-in (fakeIterationPi) that reads control tokens out of the
// goal ([steps=N]/[fanout=K]) and keeps an on-disk counter, exactly mirroring
// agent-control-plane's ACP_FAKE_PI contract. So we can assert the state machine:
//   - a ralph loop runs until its output says LOOP_STATUS: DONE → 'completed'
//   - an orchestrated loop fans out K workers per round and finishes 'completed'
//   - parseDecision handles fenced ```json AND bare-brace JSON, newest-wins
//
// We never import session-registry or call a model: fake mode returns before any
// session is created.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, it, expect } from "vitest";

// The fake hook MUST be set before goal-loop.ts (transitively) decides to skip
// the real Pi drive. It is read per-call (process.env.KADY_FAKE_LOOP), so
// setting it at import time is sufficient, but we set it explicitly to be safe.
process.env.KADY_FAKE_LOOP = "1";

import { resolvePaths } from "../src/projects.ts";
import {
  startLoop,
  parseDecision,
  isLoopRunning,
  MAX_FANOUT,
} from "../src/agent/goal-loop.ts";
import { getLoop, listRunsForLoop } from "../src/agent/runs-index.ts";

beforeAll(() => {
  process.env.KADY_FAKE_LOOP = "1";
});

// Wipe a project's .kady tree (runs + loops + the fake counters) so cases don't
// leak iteration counts into each other. Same approach as runs-index.test.ts.
function wipe(projectId: string): void {
  const kadyDir = path.dirname(resolvePaths(projectId).runsDir); // .../.kady
  fs.rmSync(kadyDir, { recursive: true, force: true });
}

// startLoop kicks runLoop off async (fire-and-forget). In fake mode every
// iteration is synchronous-ish (no real I/O latency), so the loop reaches a
// terminal state within a few microtasks. Poll the in-process running flag (and
// then the on-disk status) instead of sleeping on a magic number.
async function waitForLoopToSettle(loopId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // First let the running flag clear (the runner's finally deletes the control).
  while (isLoopRunning(loopId)) {
    if (Date.now() > deadline) throw new Error(`loop ${loopId} did not settle in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("goal-loop: ralph mode reaches DONE", () => {
  const PROJECT = "goal-loop-ralph-test";
  beforeEach(() => wipe(PROJECT));

  it("runs until the worker's output says LOOP_STATUS: DONE, then completes", async () => {
    // [steps=3] → the fake ralph agent emits CONTINUE for rounds 1-2 and DONE on
    // round 3 (the on-disk counter proves cross-iteration state).
    const loop = startLoop({
      projectId: PROJECT,
      goal: "Build the thing [steps=3]",
      mode: "ralph",
      maxIterations: 10,
    });
    expect(loop.status).toBe("pending");
    expect(loop.mode).toBe("ralph");

    await waitForLoopToSettle(loop.id);

    const settled = getLoop(PROJECT, loop.id);
    expect(settled).not.toBeNull();
    expect(settled!.status).toBe("completed");
    // Finished exactly on round 3 (not the 10-round cap).
    expect(settled!.iteration).toBe(3);

    // Lineage: three worker runs (ralph records each increment as a worker),
    // all completed.
    const runs = listRunsForLoop(PROJECT, loop.id);
    const workers = runs.filter((r) => r.role === "worker");
    expect(workers).toHaveLength(3);
    expect(workers.every((r) => r.status === "completed")).toBe(true);
    // No orchestrator rows in ralph mode.
    expect(runs.some((r) => r.role === "orchestrator")).toBe(false);
  });

  it("a ralph [fail] token marks the loop failed", async () => {
    const loop = startLoop({
      projectId: PROJECT,
      goal: "Break early [fail][steps=5]",
      mode: "ralph",
      maxIterations: 10,
    });
    await waitForLoopToSettle(loop.id);
    const settled = getLoop(PROJECT, loop.id);
    expect(settled!.status).toBe("failed");
    expect(settled!.iteration).toBe(1); // failed on the first round
    expect(settled!.lastError).toMatch(/simulated Pi failure/);
  });
});

describe("goal-loop: orchestrated mode fans out workers", () => {
  const PROJECT = "goal-loop-orch-test";
  beforeEach(() => wipe(PROJECT));

  it("orchestrator emits K parallel worker tasks per round, then calls done", async () => {
    // [steps=2] → orchestrator continues on round 1 (emitting [fanout=3] workers)
    // and calls "done" on round 2. So we expect 3 worker runs total + 2
    // orchestrator runs, and a 'completed' loop.
    const fanout = 3;
    const loop = startLoop({
      projectId: PROJECT,
      goal: `Ship the module [steps=2][fanout=${fanout}]`,
      mode: "orchestrated",
      maxIterations: 10,
    });
    expect(loop.mode).toBe("orchestrated");

    await waitForLoopToSettle(loop.id);

    const settled = getLoop(PROJECT, loop.id);
    expect(settled!.status).toBe("completed");
    expect(settled!.iteration).toBe(2); // continued round 1, done round 2

    const runs = listRunsForLoop(PROJECT, loop.id);
    const orchestrators = runs.filter((r) => r.role === "orchestrator");
    const workers = runs.filter((r) => r.role === "worker");

    // Two orchestrator decisions (round 1 continue, round 2 done).
    expect(orchestrators).toHaveLength(2);
    // Round 1 fanned out exactly `fanout` workers; round 2 (done) spawns none.
    expect(workers).toHaveLength(fanout);
    expect(workers.every((r) => r.status === "completed")).toBe(true);
    // Lineage: every worker points back at the round-1 orchestrator run.
    const round1Orch = orchestrators.find((r) => r.iteration === 1);
    expect(round1Orch).toBeDefined();
    expect(workers.every((r) => r.parentRunId === round1Orch!.id)).toBe(true);
    // The workers ran in the same round (1), proving the fan-out is one round.
    expect(workers.every((r) => r.iteration === 1)).toBe(true);
  });

  it("clamps fan-out to MAX_FANOUT", async () => {
    // Ask for more workers than allowed; the engine slices to MAX_FANOUT.
    const loop = startLoop({
      projectId: PROJECT,
      goal: `Too many [steps=2][fanout=${MAX_FANOUT + 5}]`,
      mode: "orchestrated",
      maxIterations: 10,
    });
    await waitForLoopToSettle(loop.id);
    const workers = listRunsForLoop(PROJECT, loop.id).filter((r) => r.role === "worker");
    expect(workers).toHaveLength(MAX_FANOUT);
  });
});

describe("goal-loop: parseDecision handles fenced + bare-brace JSON", () => {
  it("parses a fenced ```json block", () => {
    const text = [
      "Here is my decision for this round.",
      "```json",
      '{"status": "continue", "reasoning": "more to do", "tasks": ["a", "b"]}',
      "```",
    ].join("\n");
    const d = parseDecision(text);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("continue");
    expect(d!.reasoning).toBe("more to do");
    expect(d!.tasks).toEqual(["a", "b"]);
  });

  it("parses a bare (unfenced) brace object", () => {
    const text =
      'I think we are done now: {"status": "done", "reasoning": "goal met", "tasks": []}';
    const d = parseDecision(text);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("done");
    expect(d!.tasks).toEqual([]);
  });

  it("prefers the NEWEST valid object when several are present", () => {
    // An early throwaway object then the real decision later — newest wins.
    const text = [
      'scratchpad: {"status": "continue", "reasoning": "draft", "tasks": ["old"]}',
      "final answer:",
      "```json",
      '{"status": "continue", "reasoning": "final", "tasks": ["new"]}',
      "```",
    ].join("\n");
    const d = parseDecision(text);
    expect(d!.reasoning).toBe("final");
    expect(d!.tasks).toEqual(["new"]);
  });

  it("filters empty/non-string tasks and rejects junk", () => {
    const ok = parseDecision('{"status":"continue","reasoning":"r","tasks":["keep","",42,"  ",null]}');
    expect(ok!.tasks).toEqual(["keep"]); // empties, whitespace-only, and non-strings dropped

    expect(parseDecision("no json here at all")).toBeNull();
    expect(parseDecision('{"status":"maybe","tasks":[]}')).toBeNull(); // bad status
    expect(parseDecision("")).toBeNull();
  });
});
