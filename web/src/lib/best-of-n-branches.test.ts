// danbot-byok — web/src/lib/best-of-n-branches.test.ts
//
// Row 33. The acceptance test the master brief states for this row is that the
// visualisation "reflects real candidate state, not a static fan-out drawing".
// These tests are written to FAIL a static fan-out: every branch's state is
// asserted against the run's own `modelCallSlots`, and a projection that
// ignored slot data would report every branch identically and be caught here.

import { describe, expect, it } from "vitest";

import type { WorkflowRunEvent, WorkflowRunRecord } from "@/lib/dag-workflows";
import {
  SEQUENTIAL_CANDIDATES_NOTICE,
  candidateCountForNode,
  projectBestOfNRuns,
} from "./best-of-n-branches";

/**
 * A run record shaped like the wire body of `GET /dag-workflow-runs/:id`.
 * `slots` names which candidate slots have been declared, and which of those
 * carry a receipt — the exact signal `run-state.ts:1648`/`:1685` produce.
 */
function runRecord(
  candidateCount: number,
  slots: { declared: string[]; resolved: string[] },
): WorkflowRunRecord {
  const modelCallSlots: Record<string, unknown> = {};
  for (const slotId of slots.declared) {
    modelCallSlots[slotId] = slots.resolved.includes(slotId)
      ? { id: slotId, request: {}, receipt: { request: {}, response: {} } }
      : { id: slotId, request: {} };
  }
  return {
    manifest: {
      graph: {
        nodes: [
          { id: "pick", name: "Pick the best", kind: "best-of-n", candidateCount, goal: "g" },
        ],
      },
    },
    state: {
      executions: { "exec-1": { executionId: "exec-1", nodeId: "pick", modelCallSlots } },
    },
  } as unknown as WorkflowRunRecord;
}

function succeededEvent(output: unknown): WorkflowRunEvent {
  return {
    schemaVersion: 1,
    eventId: "e1",
    runId: "r1",
    seq: 9,
    ts: 1,
    type: "node_succeeded",
    nodeId: "pick",
    data: { output },
  } as WorkflowRunEvent;
}

describe("candidateCountForNode", () => {
  it("mirrors the executor's own fallback chain", () => {
    // kady-node-executor.ts:2863 — candidateCount ?? candidateModels?.length ?? 2
    expect(candidateCountForNode({ candidateCount: 5 })).toBe(5);
    expect(candidateCountForNode({ candidateModels: [{}, {}, {}] })).toBe(3);
    expect(candidateCountForNode({})).toBe(2);
  });
});

describe("projectBestOfNRuns", () => {
  it("draws one branch per candidate for a candidateCount:4 run", () => {
    const [projection] = projectBestOfNRuns(runRecord(4, { declared: [], resolved: [] }));
    expect(projection?.candidateCount).toBe(4);
    expect(projection?.branches.map((branch) => branch.slotId)).toEqual([
      "candidate-1",
      "candidate-2",
      "candidate-3",
      "candidate-4",
    ]);
  });

  it("gives each branch ITS OWN slot's state — a static fan-out fails this", () => {
    const [projection] = projectBestOfNRuns(
      runRecord(4, {
        declared: ["candidate-1", "candidate-2", "candidate-3"],
        resolved: ["candidate-1", "candidate-2"],
      }),
    );
    // Two resolved, one in flight, one the sequential executor has not reached.
    expect(projection?.branches.map((branch) => branch.state)).toEqual([
      "resolved",
      "resolved",
      "in-flight",
      "not-started",
    ]);
    expect(new Set(projection?.branches.map((b) => b.state)).size).toBeGreaterThan(1);
  });

  it("reports an unreached candidate as not-started, never as queued-in-parallel", () => {
    const [projection] = projectBestOfNRuns(
      runRecord(3, { declared: ["candidate-1"], resolved: [] }),
    );
    expect(projection?.branches[1]?.state).toBe("not-started");
    expect(projection?.branches[2]?.state).toBe("not-started");
    expect(SEQUENTIAL_CANDIDATES_NOTICE).toMatch(/one at a time/);
  });

  it("tracks the evaluator slot separately from the candidates", () => {
    const [projection] = projectBestOfNRuns(
      runRecord(2, {
        declared: ["candidate-1", "candidate-2", "candidate-evaluator"],
        resolved: ["candidate-1", "candidate-2"],
      }),
    );
    expect(projection?.evaluator.slotId).toBe("candidate-evaluator");
    expect(projection?.evaluator.state).toBe("in-flight");
  });

  it("marks the winner from the run's OWN evaluation, with its score", () => {
    const record = runRecord(3, {
      declared: ["candidate-1", "candidate-2", "candidate-3", "candidate-evaluator"],
      resolved: ["candidate-1", "candidate-2", "candidate-3", "candidate-evaluator"],
    });
    const [projection] = projectBestOfNRuns(record, [
      succeededEvent({
        kind: "best-of-n",
        candidateCount: 3,
        winner: 2,
        scores: [
          { candidate: 1, score: 40 },
          { candidate: 2, score: 91 },
          { candidate: 3, score: 55 },
        ],
        rationale: "Candidate 2 cited the most independent sources.",
      }),
    ]);

    expect(projection?.winnerIndex).toBe(2);
    expect(projection?.branches.map((branch) => branch.winner)).toEqual([false, true, false]);
    expect(projection?.branches[1]?.score).toBe(91);
    expect(projection?.rationale).toMatch(/independent sources/);
  });

  it("marks NO winner before the evaluator has chosen", () => {
    const [projection] = projectBestOfNRuns(
      runRecord(3, { declared: ["candidate-1"], resolved: [] }),
      [],
    );
    expect(projection?.winnerIndex).toBeUndefined();
    expect(projection?.branches.every((branch) => !branch.winner)).toBe(true);
  });

  it("ignores a node_succeeded whose output is not a best-of-n result", () => {
    const [projection] = projectBestOfNRuns(runRecord(2, { declared: [], resolved: [] }), [
      succeededEvent({ kind: "agent", answer: "unrelated" }),
    ]);
    expect(projection?.winnerIndex).toBeUndefined();
  });

  it("returns an empty projection for a malformed body instead of throwing (#62)", () => {
    const malformed = { manifest: { graph: { nodes: "not-an-array" } }, state: {} };
    expect(() =>
      projectBestOfNRuns(malformed as unknown as WorkflowRunRecord),
    ).not.toThrow();
    expect(projectBestOfNRuns(malformed as unknown as WorkflowRunRecord)).toEqual([]);

    const nullish = { manifest: null, state: null };
    expect(projectBestOfNRuns(nullish as unknown as WorkflowRunRecord)).toEqual([]);
  });

  it("survives an execution whose modelCallSlots is not an object", () => {
    const record = {
      manifest: { graph: { nodes: [{ id: "pick", kind: "best-of-n", candidateCount: 2 }] } },
      state: { executions: { e: { nodeId: "pick", modelCallSlots: 7 } } },
    } as unknown as WorkflowRunRecord;
    const [projection] = projectBestOfNRuns(record);
    expect(projection?.branches.map((branch) => branch.state)).toEqual([
      "not-started",
      "not-started",
    ]);
  });

  it("returns nothing for a run with no best-of-n node", () => {
    const record = {
      manifest: { graph: { nodes: [{ id: "a", kind: "agent" }] } },
      state: { executions: {} },
    } as unknown as WorkflowRunRecord;
    expect(projectBestOfNRuns(record)).toEqual([]);
  });
});
