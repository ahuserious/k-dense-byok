import { describe, expect, it } from "vitest";

import {
  isPromotableWorkflowId,
  MAX_PROMOTED_NODES,
  planSessionPromotion,
  promotedWorkflowId,
  promotedWorkflowLimits,
  WORKFLOW_ID_PATTERN,
} from "./session-dag-projection-promote";
import {
  emptySessionGraph,
  projectSessionGraph,
  type SessionFrame,
} from "./session-dag-projection";

const OPTIONS = {
  workflowId: "chat-session-a",
  sessionId: "session-a",
  sessionTitle: "Cluster the counts",
  projectName: "Default",
};

function fold(frames: SessionFrame[]) {
  const projection = projectSessionGraph(emptySessionGraph("session-a"), frames);
  return { projection, frames };
}

const TWO_TURN_FRAMES: SessionFrame[] = [
  { seq: 1, type: "run_start", runId: "run-a" },
  { seq: 2, type: "turn_start" },
  {
    seq: 3,
    type: "message_start",
    role: "user",
    content: "Cluster the RNA-seq counts.\nUse k-means and report the silhouette.",
  },
  { seq: 4, type: "text_delta", delta: "Inspecting." },
  {
    seq: 5,
    type: "tool_start",
    toolCallId: "call_a",
    toolName: "bash",
    args: { command: "head -3 counts.tsv" },
  },
  { seq: 6, type: "tool_end", toolCallId: "call_a", toolName: "bash", isError: false },
  { seq: 7, type: "turn_end" },
  { seq: 8, type: "turn_start" },
  { seq: 9, type: "message_start", role: "user", content: "Now plot the clusters." },
  { seq: 10, type: "turn_end" },
  { seq: 11, type: "done" },
];

/**
 * The typed schema and semantic validator, transcribed from
 * `server/src/workflows/schema.ts` and `server/src/workflows/validate.ts`. The
 * runtime proof that the real route accepts these documents is the PUT the
 * dialog issues; this keeps the shape from drifting without a preview running.
 */
interface LooseNode {
  id: string;
  kind: string;
  name: string;
  prompt: string;
  terminal: boolean;
  description?: string;
  model?: unknown;
  limits?: { maxSubagents?: number };
  workspace: { isolation: string; writePaths: string[] };
}
interface LooseEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
}
interface LooseDocument {
  schemaVersion: string;
  id: string;
  name: string;
  description?: string;
  entryNodeId: string;
  defaultModel?: unknown;
  limits: Record<string, number>;
  evidence: { enabled: boolean; onUnsupportedOutput: string };
  nodes: LooseNode[];
  edges: LooseEdge[];
}

function typedDocumentIssues(document: unknown): string[] {
  const issues: string[] = [];
  const doc = document as LooseDocument;
  const identifier = /^[a-z][a-z0-9_-]{0,63}$/;
  const push = (condition: boolean, message: string) => {
    if (!condition) issues.push(message);
  };

  push(doc.schemaVersion === "1.0", "schemaVersion must be the literal 1.0");
  push(identifier.test(doc.id), "id must be an identifier");
  push(
    typeof doc.name === "string" && doc.name.length >= 1 && doc.name.length <= 256,
    "name must be 1..256 characters",
  );
  push(
    doc.description === undefined ||
      (doc.description.length >= 1 && doc.description.length <= 4_096),
    "description must be 1..4096 characters",
  );
  push(Array.isArray(doc.nodes) && doc.nodes.length >= 1, "nodes must be non-empty");
  push(doc.nodes.length <= 256, "at most 256 nodes");

  const limitBounds: Record<string, [number, number]> = {
    maxIterations: [1, 1_000],
    maxModelCalls: [1, 10_000],
    maxParallelism: [1, 16],
    maxSubagents: [0, 256],
    timeoutMs: [1_000, 86_400_000],
    maxTokens: [1, 100_000_000],
    maxCostUsd: [0, 1_000_000],
    maxRetries: [0, 3],
  };
  for (const [key, [minimum, maximum]] of Object.entries(limitBounds)) {
    const value = doc.limits?.[key];
    push(
      typeof value === "number" && value >= minimum && value <= maximum,
      `limits.${key} must be within [${minimum}, ${maximum}]`,
    );
  }
  push(
    Object.keys(doc.limits ?? {}).length === Object.keys(limitBounds).length,
    "limits must carry exactly the eight required keys",
  );

  push(typeof doc.evidence?.enabled === "boolean", "evidence.enabled is required");
  push(
    ["fail", "rescue", "route"].includes(doc.evidence?.onUnsupportedOutput),
    "evidence.onUnsupportedOutput must be fail|rescue|route",
  );
  // Evidence policies that route to rescue need rescue enabled; this document
  // does not use one, and the assertion pins that.
  push(doc.evidence?.enabled === false, "promoted drafts must not enable evidence gating");

  const nodeIds = new Set<string>();
  for (const node of doc.nodes ?? []) {
    push(node.kind === "agent", `node ${node.id} must be an agent node`);
    push(identifier.test(node.id), `node id ${node.id} must be an identifier`);
    push(!nodeIds.has(node.id), `duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    push(
      typeof node.name === "string" && node.name.length >= 1 && node.name.length <= 256,
      `node ${node.id} name must be 1..256 characters`,
    );
    push(
      typeof node.prompt === "string" &&
        node.prompt.length >= 1 &&
        node.prompt.length <= 32_768,
      `node ${node.id} prompt must be 1..32768 characters`,
    );
    push(typeof node.terminal === "boolean", `node ${node.id} needs terminal`);
    push(
      ["read-only", "isolated-worktree", "exclusive-project"].includes(
        node.workspace?.isolation,
      ),
      `node ${node.id} needs a workspace isolation`,
    );
    // read-only-write-path / missing-write-path
    push(
      node.workspace.isolation === "read-only"
        ? node.workspace.writePaths.length === 0
        : node.workspace.writePaths.length > 0,
      `node ${node.id} workspace/writePaths disagrees with its isolation`,
    );
    // missing-model-request: an agent node inherits the workflow default.
    push(
      node.model !== undefined || doc.defaultModel !== undefined,
      `node ${node.id} has no model request and no workflow default`,
    );
    // node-subagent-demand-exceeds-limit: a model-driven node demands one
    // Pi-subagent execution slot, so `maxSubagents: 0` is rejected.
    push(
      (node.limits?.maxSubagents ?? doc.limits.maxSubagents) >= 1,
      `node ${node.id} needs at least one subagent slot for its model call`,
    );
  }

  const edgeIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const node of doc.nodes ?? []) outgoing.set(node.id, []);
  for (const edge of doc.edges ?? []) {
    push(identifier.test(edge.id), `edge id ${edge.id} must be an identifier`);
    push(!edgeIds.has(edge.id), `duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
    push(nodeIds.has(edge.from), `unknown edge source ${edge.from}`);
    push(nodeIds.has(edge.to), `unknown edge target ${edge.to}`);
    push(edge.from !== edge.to, `self-edge on ${edge.from}`);
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  // unknown-entry-node / entry-has-incoming-edge
  push(nodeIds.has(doc.entryNodeId), "entryNodeId must name a node");
  push((incoming.get(doc.entryNodeId) ?? 0) === 0, "entry node must have no incoming edge");

  // terminal-has-outgoing-edge / unterminated-sink / missing-terminal
  let terminals = 0;
  for (const node of doc.nodes ?? []) {
    const out = outgoing.get(node.id)?.length ?? 0;
    if (node.terminal) {
      terminals += 1;
      push(out === 0, `terminal node ${node.id} must have no outgoing edge`);
    } else {
      push(out > 0, `sink node ${node.id} must be marked terminal`);
    }
  }
  push(terminals > 0, "a workflow needs at least one terminal node");

  // mixed-always-and-outcome-routes / missing-success-route / missing-failure-route
  for (const node of doc.nodes ?? []) {
    if (node.terminal) continue;
    const conditions = (doc.edges ?? [])
      .filter((edge) => edge.from === node.id)
      .map((edge) => edge.condition ?? "always");
    push(
      conditions.every((condition: string) => condition === "always"),
      `node ${node.id} must use unconditional fan-out or a full outcome pair`,
    );
  }

  // unreachable-node / no-terminal-path
  const reachable = new Set<string>();
  const pending = [doc.entryNodeId];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of outgoing.get(id) ?? []) pending.push(next);
  }
  for (const node of doc.nodes ?? []) {
    push(reachable.has(node.id), `node ${node.id} is unreachable from the entry node`);
  }

  // cycle
  push(
    (doc.edges ?? []).length === nodeIds.size - 1,
    "a promoted chain has exactly one edge fewer than it has nodes",
  );

  // workflow-model-call-demand-exceeds-limit: an agent node demands 1 call, 1 iteration.
  push(
    doc.nodes.length <= doc.limits.maxModelCalls,
    "the workflow model-call limit must cover one call per agent node",
  );
  push(
    doc.nodes.length <= doc.limits.maxIterations,
    "the workflow iteration limit must cover one iteration per agent node",
  );

  return issues;
}

describe("promoted workflow ids", () => {
  it("derives a server-legal id from a session id", () => {
    expect(promotedWorkflowId("session-e2e")).toBe("chat-session-e2e");
    expect(WORKFLOW_ID_PATTERN.test(promotedWorkflowId("session-e2e"))).toBe(true);
  });

  it("survives ids the identifier alphabet does not allow", () => {
    for (const sessionId of [
      "01H8XY_ABC",
      "Session/With Spaces",
      "ÜNICODE",
      "x".repeat(200),
      "",
    ]) {
      const id = promotedWorkflowId(sessionId);
      expect(WORKFLOW_ID_PATTERN.test(id), `${sessionId} -> ${id}`).toBe(true);
    }
  });

  it("rejects ids the server would reject", () => {
    expect(isPromotableWorkflowId("Chat-A")).toBe(false);
    expect(isPromotableWorkflowId("1chat")).toBe(false);
    expect(isPromotableWorkflowId("chat a")).toBe(false);
    expect(isPromotableWorkflowId("c".repeat(65))).toBe(false);
    expect(isPromotableWorkflowId("chat-a_1")).toBe(true);
  });
});

describe("planSessionPromotion", () => {
  it("produces a document the typed schema and semantic validator accept", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    expect(plan.document).not.toBeNull();
    expect(typedDocumentIssues(plan.document)).toEqual([]);
  });

  it("maps one turn to one agent node, chained in conversation order", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    expect(plan.nodes.map((node) => node.id)).toEqual(["turn-1", "turn-2"]);
    expect(plan.nodes.map((node) => node.terminal)).toEqual([false, true]);
    expect(plan.edges).toEqual([
      { id: "edge-1", from: "turn-1", to: "turn-2", condition: "always" },
    ]);
    expect(plan.document?.entryNodeId).toBe("turn-1");
  });

  it("carries the whole user message, not the truncated node label", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    // The live graph's node detail is a single truncated line; the promoted
    // prompt is the message the user actually sent.
    expect(plan.nodes[0].prompt).toBe(
      "Cluster the RNA-seq counts.\nUse k-means and report the silhouette.",
    );
    expect(plan.nodes[1].prompt).toBe("Now plot the clusters.");
  });

  it("names every part of the session it cannot represent", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    const tool = plan.unrepresented.find((part) => part.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool?.label).toBe("bash");
    expect(tool?.reason).toMatch(/not a typed node kind/);
    // ...but the tool is not lost: the node's description records it.
    expect(plan.document?.nodes[0].description).toContain("bash");
    expect(plan.nodes[0].observedWork).toEqual(["bash"]);
  });

  it("reports a delegated typed run rather than copying it", () => {
    const projection = projectSessionGraph(
      emptySessionGraph("session-a"),
      TWO_TURN_FRAMES,
      { workflowRun: { runId: "run-9", workflowId: "e2e-workflow", status: "running" } },
    );
    const plan = planSessionPromotion(projection, TWO_TURN_FRAMES, OPTIONS);
    const dag = plan.unrepresented.find((part) => part.kind === "dag");
    expect(dag?.label).toBe("e2e-workflow");
    expect(dag?.reason).toMatch(/must not copy or re-create it/);
    expect(plan.document?.nodes.every((node) => node.kind === "agent")).toBe(true);
  });

  it("refuses to invent a prompt for a turn whose user text it never retained", () => {
    // A tool call with no preceding user message opens a turn with no prompt.
    const { projection, frames } = fold([
      { seq: 1, type: "run_start", runId: "run-a" },
      { seq: 2, type: "tool_start", toolCallId: "c1", toolName: "bash", args: {} },
      { seq: 3, type: "tool_end", toolCallId: "c1", toolName: "bash", isError: false },
      { seq: 4, type: "done" },
    ]);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    expect(plan.document).toBeNull();
    expect(plan.nodes).toEqual([]);
    expect(plan.blockedReason).toMatch(/without inventing an instruction/);
    const turn = plan.unrepresented.find((part) => part.kind === "turn");
    expect(turn?.reason).toMatch(/No user prompt text/);
  });

  it("bounds the node count and says which turns it dropped", () => {
    const frames: SessionFrame[] = [];
    let seq = 1;
    for (let turn = 0; turn < MAX_PROMOTED_NODES + 3; turn += 1) {
      frames.push({ seq: seq++, type: "turn_start" });
      frames.push({
        seq: seq++,
        type: "message_start",
        role: "user",
        content: `Step ${turn + 1}.`,
      });
      frames.push({ seq: seq++, type: "turn_end" });
    }
    const { projection } = fold(frames);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    expect(plan.nodes).toHaveLength(MAX_PROMOTED_NODES);
    const dropped = plan.unrepresented.filter((part) =>
      part.reason.includes(`${MAX_PROMOTED_NODES}-node bound`),
    );
    expect(dropped).toHaveLength(3);
    expect(typedDocumentIssues(plan.document)).toEqual([]);
  });

  it("does not mutate the projection or the frames it reads", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const projectionBefore = JSON.stringify(projection);
    const framesBefore = JSON.stringify(frames);
    planSessionPromotion(projection, frames, OPTIONS);
    expect(JSON.stringify(projection)).toBe(projectionBefore);
    expect(JSON.stringify(frames)).toBe(framesBefore);
  });

  it("asks for Kady Current exactly rather than naming a model the chat never recorded", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    expect(plan.document?.defaultModel).toEqual({
      requested: { source: "kady-current", auth: { kind: "kady-current" }, reasoning: "high" },
      resolution: { mode: "exact" },
    });
    // A `kady-current` request may not appear in an explicit fallback list
    // (validate.ts `ambiguous-kady-current-fallback`), so the mode is `exact`.
    expect(plan.document?.defaultModel?.resolution.mode).toBe("exact");
  });

  it("gives every node a read-only workspace", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, OPTIONS);
    for (const node of plan.document?.nodes ?? []) {
      expect(node.workspace).toEqual({ isolation: "read-only", writePaths: [] });
    }
  });

  it("sizes the limits to the demand an agent node actually charges", () => {
    expect(promotedWorkflowLimits(5).maxModelCalls).toBe(5);
    expect(promotedWorkflowLimits(5).maxIterations).toBe(5);
    // Never zero: the schema's minimum for both is 1.
    expect(promotedWorkflowLimits(0).maxModelCalls).toBe(1);
    expect(promotedWorkflowLimits(0).maxIterations).toBe(1);
    // One Pi-subagent execution slot, which every model-driven node demands.
    expect(promotedWorkflowLimits(5).maxSubagents).toBe(1);
  });

  it("uses the id it was given, because the store requires document.id === the URL id", () => {
    const { projection, frames } = fold(TWO_TURN_FRAMES);
    const plan = planSessionPromotion(projection, frames, {
      ...OPTIONS,
      workflowId: "renamed-by-the-user",
    });
    expect(plan.workflowId).toBe("renamed-by-the-user");
    expect(plan.document?.id).toBe("renamed-by-the-user");
  });
});
