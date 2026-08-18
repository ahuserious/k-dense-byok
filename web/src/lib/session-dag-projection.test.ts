import { describe, expect, it } from "vitest";

import {
  childrenOf,
  emptySessionGraph,
  MODELLED_FRAME_TYPES,
  MAX_RENDERED_NODES,
  MAX_RETAINED_FRAMES,
  MAX_TOOLS_PER_TURN,
  projectSession,
  projectSessionGraph,
  projectionNotices,
  sessionRootId,
  type SessionFrame,
  type SessionGraphProjection,
} from "./session-dag-projection";

const SESSION = "session-a";

/** Number an ordered frame list the way the run broker does: seq starts at 1. */
function frames(
  ...items: Array<{ type: string } & Record<string, unknown>>
): SessionFrame[] {
  return items.map((item, index) => ({ ...item, seq: index + 1 }));
}

/** The frame stream a single tool-using turn with one subagent produces. */
const TURN_WITH_TOOL_AND_SUBAGENT = frames(
  { type: "run_start", runId: "run-1" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", role: "user", content: "Cluster the RNA-seq counts and summarise." },
  { type: "thinking_delta", delta: "Plan the analysis." },
  { type: "text_delta", delta: "Inspecting the counts matrix." },
  { type: "tool_start", toolCallId: "call_a1", toolName: "bash", args: { command: "head -3 counts.tsv" } },
  { type: "tool_end", toolCallId: "call_a1", toolName: "bash", isError: false, result: "gene\ts1" },
  {
    type: "tool_start",
    toolCallId: "call_a2",
    toolName: "subagent",
    args: { agent: "statistical-reviewer", task: "Check the clustering choice." },
  },
  { type: "tool_end", toolCallId: "call_a2", toolName: "subagent", isError: false, result: "k=4 is defensible." },
  { type: "turn_end", usage: { input: 10, output: 20 } },
  { type: "context_usage", tokens: 30, contextWindow: 1_000_000, percent: 0 },
  { type: "cost", cost: 0.01, tokens: 30 },
  { type: "done" },
);

function nodeIds(projection: SessionGraphProjection): string[] {
  return projection.nodes.map((node) => node.id);
}

function nodeById(projection: SessionGraphProjection, id: string) {
  const node = projection.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}: have ${nodeIds(projection).join(", ")}`);
  return node;
}

describe("session graph shape", () => {
  it("projects the taxonomy's node kinds off a real turn", () => {
    const projection = projectSession(SESSION, TURN_WITH_TOOL_AND_SUBAGENT);

    expect(nodeIds(projection)).toEqual([
      sessionRootId(SESSION),
      "turn:1",
      "tool:call_a1",
      "tool:call_a2",
      "agent:call_a2:statistical-reviewer",
    ]);
    // The subagent shares its parent's creation sequence, so parents-first
    // ordering (depth, then id) is what keeps the render stable.
    expect(nodeById(projection, "agent:call_a2:statistical-reviewer").depth).toBe(3);
    expect(nodeById(projection, sessionRootId(SESSION)).detail).toBe("run-1");
    expect(nodeById(projection, "turn:1").detail).toBe(
      "Cluster the RNA-seq counts and summarise.",
    );
    expect(nodeById(projection, "tool:call_a1").detail).toBe("head -3 counts.tsv");
    expect(nodeById(projection, "agent:call_a2:statistical-reviewer").kind).toBe("subagent");
    expect(projection.cursor).toBe(TURN_WITH_TOOL_AND_SUBAGENT.length);
  });

  it("chains turns off the root and hangs tools off their turn", () => {
    const projection = projectSession(
      SESSION,
      frames(
        { type: "turn_start" },
        { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} },
        { type: "turn_end" },
        { type: "turn_start" },
        { type: "tool_start", toolCallId: "t2", toolName: "read", args: { path: "a.py" } },
      ),
    );

    expect(childrenOf(projection, sessionRootId(SESSION)).map((node) => node.id)).toEqual([
      "turn:1",
    ]);
    expect(childrenOf(projection, "turn:1").map((node) => node.id)).toEqual([
      "tool:t1",
      "turn:2",
    ]);
    expect(childrenOf(projection, "turn:2").map((node) => node.id)).toEqual(["tool:t2"]);
  });

  it("advances status from running to ok and error", () => {
    const running = projectSession(
      SESSION,
      frames(
        { type: "turn_start" },
        { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} },
      ),
      { runStatus: "running" },
    );
    expect(nodeById(running, sessionRootId(SESSION)).status).toBe("running");
    expect(nodeById(running, "turn:1").status).toBe("running");
    expect(nodeById(running, "tool:t1").status).toBe("running");

    const finished = projectSessionGraph(
      running,
      frames(
        { type: "turn_start" },
        { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} },
        { type: "tool_end", toolCallId: "t1", toolName: "bash", isError: true, result: "boom" },
        { type: "turn_end" },
        { type: "done" },
      ),
      { runStatus: "complete" },
    );
    expect(nodeById(finished, "tool:t1").status).toBe("error");
    expect(nodeById(finished, "turn:1").status).toBe("ok");
    expect(nodeById(finished, sessionRootId(SESSION)).status).toBe("ok");
  });

  it("marks a budget refusal cancelled and a model error error", () => {
    const cancelled = projectSession(
      SESSION,
      frames(
        { type: "turn_start" },
        { type: "error", kind: "budget", message: "Project spend limit reached" },
      ),
    );
    expect(nodeById(cancelled, sessionRootId(SESSION)).status).toBe("cancelled");
    expect(nodeById(cancelled, "turn:1").status).toBe("cancelled");

    const failed = projectSession(
      SESSION,
      frames({ type: "turn_start" }, { type: "error", message: "Model error (overloaded)" }),
    );
    expect(nodeById(failed, sessionRootId(SESSION)).status).toBe("error");
    expect(nodeById(failed, "turn:1").detail).toBe("Model error (overloaded)");
  });

  it("falls back to event:<seq> for an unmodelled frame type", () => {
    const projection = projectSession(
      SESSION,
      frames(
        { type: "turn_start" },
        { type: "quantum_teleport", message: "a frame the console has never seen" },
      ),
    );
    const fallback = nodeById(projection, "event:2");
    expect(fallback.kind).toBe("event");
    expect(fallback.label).toBe("quantum_teleport");
    expect(fallback.detail).toBe("a frame the console has never seen");
  });

  it("keeps the modelled frame set and the fold in agreement", () => {
    // Every type the taxonomy calls modelled must be handled; if one silently
    // fell through it would show up as an event:<seq> node instead.
    for (const type of MODELLED_FRAME_TYPES) {
      const projection = projectSession(SESSION, [{ seq: 1, type }]);
      expect(nodeIds(projection), `${type} fell through to the fallback`).not.toContain(
        "event:1",
      );
    }
    expect(nodeIds(projectSession(SESSION, [{ seq: 1, type: "not_modelled" }]))).toContain(
      "event:1",
    );
  });

  it("adds a dag node from the typed workflow-run link", () => {
    const projection = projectSession(SESSION, frames({ type: "turn_start" }), {
      workflowRun: { runId: "wrun_1", workflowId: "rna-seq", status: "running" },
    });
    const dag = nodeById(projection, "dag:wrun_1");
    expect(dag.kind).toBe("dag");
    expect(dag.status).toBe("running");
    expect(childrenOf(projection, "turn:1").map((node) => node.id)).toContain("dag:wrun_1");
  });
});

describe("invariant 1 — idempotent", () => {
  it("project(project(s,E),E) === project(s,E)", () => {
    const once = projectSession(SESSION, TURN_WITH_TOOL_AND_SUBAGENT);
    const twice = projectSessionGraph(once, TURN_WITH_TOOL_AND_SUBAGENT);
    expect(twice).toEqual(once);
  });

  it("re-folding a partially overlapping buffer changes nothing", () => {
    const full = projectSession(SESSION, TURN_WITH_TOOL_AND_SUBAGENT);
    const replayed = projectSessionGraph(full, TURN_WITH_TOOL_AND_SUBAGENT.slice(4));
    expect(replayed).toEqual(full);
  });
});

describe("invariant 2 — incremental equals full", () => {
  it("chunked folding matches one-shot folding", () => {
    const oneShot = projectSession(SESSION, TURN_WITH_TOOL_AND_SUBAGENT);
    let incremental = emptySessionGraph(SESSION);
    for (let index = 0; index < TURN_WITH_TOOL_AND_SUBAGENT.length; index += 3) {
      incremental = projectSessionGraph(
        incremental,
        TURN_WITH_TOOL_AND_SUBAGENT.slice(index, index + 3),
      );
    }
    expect(incremental).toEqual(oneShot);
  });

  it("holds when every frame arrives on its own", () => {
    const oneShot = projectSession(SESSION, TURN_WITH_TOOL_AND_SUBAGENT);
    const incremental = TURN_WITH_TOOL_AND_SUBAGENT.reduce(
      (state, frame) => projectSessionGraph(state, [frame]),
      emptySessionGraph(SESSION),
    );
    expect(incremental).toEqual(oneShot);
  });
});

describe("invariant 3 — order tolerant", () => {
  it("creates a placeholder for a tool whose start has not arrived", () => {
    const outOfOrder = projectSession(
      SESSION,
      [
        { seq: 3, type: "tool_end", toolCallId: "t1", toolName: "bash", isError: false, result: "ok" },
      ],
    );
    const placeholder = nodeById(outOfOrder, "tool:t1");
    expect(placeholder.placeholder).toBe(true);
    // The turn it needed did not exist either, so one was synthesized.
    expect(nodeIds(outOfOrder)).toContain("turn:1");

    const filled = projectSessionGraph(outOfOrder, [
      { seq: 2, type: "tool_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
    ]);
    const node = nodeById(filled, "tool:t1");
    expect(node.placeholder).toBeUndefined();
    expect(node.detail).toBe("ls");
    // tool_end already landed, so the filled node keeps its terminal status.
    expect(node.status).toBe("ok");
  });

  it("never drops a frame that references an unseen parent", () => {
    const shuffled = [...TURN_WITH_TOOL_AND_SUBAGENT].sort((left, right) => right.seq - left.seq);
    const projection = projectSession(SESSION, shuffled);
    expect(projection.cursor).toBe(TURN_WITH_TOOL_AND_SUBAGENT.length);
    expect(nodeIds(projection)).toContain("tool:call_a1");
    expect(nodeIds(projection)).toContain("tool:call_a2");
  });
});

describe("invariant 4 — bounded", () => {
  it("groups tool calls past the per-turn width", () => {
    const wide: SessionFrame[] = [{ seq: 1, type: "turn_start" }];
    for (let index = 0; index < MAX_TOOLS_PER_TURN + 5; index += 1) {
      wide.push({
        seq: index + 2,
        type: "tool_start",
        toolCallId: `call_${index}`,
        toolName: "bash",
        args: { command: `echo ${index}` },
      });
    }
    const projection = projectSession(SESSION, wide);
    const tools = projection.nodes.filter((node) => node.kind === "tool");
    expect(tools).toHaveLength(MAX_TOOLS_PER_TURN);
    const group = nodeById(projection, "group:turn:1");
    expect(group.collapsedCount).toBe(5);
    expect(group.detail).toBe("5 more tool calls");
  });

  it("stops at the rendered-node cap and says so", () => {
    const many: SessionFrame[] = [];
    let seq = 1;
    // Each turn takes one node; the cap is reached long before this many turns.
    for (let index = 0; index < MAX_RENDERED_NODES + 40; index += 1) {
      many.push({ seq: seq++, type: "turn_start" });
    }
    const projection = projectSession(SESSION, many);
    expect(projection.nodes).toHaveLength(MAX_RENDERED_NODES);
    expect(projection.truncated).toBe(true);
    expect(projectionNotices(projection)).toContain(
      `Graph truncated at ${MAX_RENDERED_NODES} nodes`,
    );
  });

  it("keeps at most MAX_RETAINED_FRAMES sequences in the ring", () => {
    const long: SessionFrame[] = [];
    for (let index = 0; index < MAX_RETAINED_FRAMES + 25; index += 1) {
      long.push({ seq: index + 1, type: "text_delta", delta: "x" });
    }
    const projection = projectSession(SESSION, long);
    expect(projection.retainedSeqs).toHaveLength(MAX_RETAINED_FRAMES);
    expect(projection.droppedFrames).toBe(25);
    expect(projection.cursor).toBe(MAX_RETAINED_FRAMES + 25);
    // Replaying an evicted sequence must not double-count it.
    expect(projectSessionGraph(projection, long)).toEqual(projection);
  });

  it("refuses a child past the recursion cap and badges its parent", () => {
    // A crafted previous projection standing in for R3's nested delegation:
    // the open turn already sits at MAX_DEPTH, so its next tool child would be
    // depth 4 and must be collapsed rather than drawn.
    const deep = emptySessionGraph(SESSION);
    const nested: SessionGraphProjection = {
      ...deep,
      nodes: [
        ...deep.nodes,
        {
          id: "turn:1",
          kind: "turn",
          label: "Turn 1",
          status: "running",
          depth: 3,
          createdAtSeq: 1,
        },
      ],
      edges: [
        { id: `${sessionRootId(SESSION)}->turn:1`, from: sessionRootId(SESSION), to: "turn:1", kind: "turn" },
      ],
      cursor: 1,
      retainedSeqs: [1],
    };

    const projection = projectSessionGraph(nested, [
      { seq: 2, type: "tool_start", toolCallId: "too_deep", toolName: "bash", args: {} },
    ]);
    expect(nodeIds(projection)).not.toContain("tool:too_deep");
    expect(projection.depthCollapsed).toBe(true);
    expect(nodeById(projection, "turn:1").deeperCollapsed).toBe(true);
    expect(projectionNotices(projection)).toContain("Deeper graph collapsed");
  });

  it("draws a delegation cycle as a back-edge instead of expanding it", () => {
    // Ancestry that makes the next natural edge (turn -> tool) close a loop:
    // turn:1's parent already IS the tool the next frame belongs to.
    const base = emptySessionGraph(SESSION);
    const looped: SessionGraphProjection = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: "tool:call_a", kind: "tool", label: "subagent", status: "running", depth: 1, createdAtSeq: 1 },
        { id: "turn:1", kind: "turn", label: "Turn 1", status: "running", depth: 2, createdAtSeq: 2 },
      ],
      edges: [
        { id: "tool:call_a->turn:1", from: "tool:call_a", to: "turn:1", kind: "turn" },
      ],
      cursor: 2,
      retainedSeqs: [1, 2],
    };

    const projection = projectSessionGraph(looped, [
      { seq: 3, type: "tool_update", toolCallId: "call_a", toolName: "subagent" },
    ]);
    const backEdge = projection.edges.find((edge) => edge.id === "turn:1->tool:call_a");
    expect(backEdge?.kind).toBe("back");
    expect(projection.backEdgeCount).toBe(1);
    expect(nodeById(projection, "tool:call_a").cyclic).toBe(true);
    expect(projectionNotices(projection)).toContain("1 back-edge");
    // The cycle is drawn, never walked: tool:call_a keeps its original parent.
    expect(childrenOf(projection, "tool:call_a").map((node) => node.id)).toEqual(["turn:1"]);
  });
});
