import { describe, expect, it } from "vitest";

import type { WorkflowGraphDocument } from "@/lib/dag-workflows";
import {
  applyDelta,
  canonicalDocumentJson,
  documentGraphSha256,
  rejectStaleDeltas,
  viewFromDoc,
  type CanvasDeltaOp,
} from "@/lib/typed-canvas-adapter";
import {
  GRAPH_HASH_PARITY_DOCUMENT,
  GRAPH_HASH_PARITY_SHA256,
} from "@/lib/typed-canvas-adapter.fixture";
import { typedToView } from "@/lib/typed-graph-view";

function document(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "adapter-workflow",
    name: "Adapter workflow",
    entryNodeId: "research",
    defaultModel: {
      requested: { source: "kady-current", auth: { kind: "kady-current" }, reasoning: "high" },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 12,
      maxModelCalls: 12,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 0,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "research",
        name: "Research",
        kind: "research-until-goal",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        position: { x: 0, y: 0 },
        goal: "Inventory the provided material.",
        completionCriteria: ["Gaps are explicit."],
        limits: { maxIterations: 6, maxModelCalls: 7 },
        settings: {
          harness: "pi",
          databases: ["postgres://analytics"],
          skills: { mode: "manual", list: ["internal-skill"] },
          autonomy: "loose",
        },
      },
      {
        id: "report",
        name: "Report",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        position: { x: 320, y: 0 },
        prompt: "Report the bounded plan.",
      },
    ],
    edges: [{ id: "research-to-report", from: "research", to: "report", condition: "always" }],
  };
}

describe("applyDelta", () => {
  it("moves a node without touching any other field", () => {
    const before = document();
    const result = applyDelta(before, [
      { op: "moveNode", nodeId: "research", position: { x: 140, y: -60 } },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.document.nodes[0].position).toEqual({ x: 140, y: -60 });
    // The input is never mutated: the host keeps the pre-edit document for undo.
    expect(before.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("preserves every typed field the canvas was never shown", () => {
    const before = document();
    const ops: CanvasDeltaOp[] = [
      { op: "moveNode", nodeId: "research", position: { x: 5, y: 5 } },
      { op: "renameNode", nodeId: "research", name: "Research, renamed" },
      { op: "addEdge", edgeId: "report-to-research", from: "report", to: "research" },
    ];

    const { document: after } = applyDelta(before, ops);

    const researchBefore = before.nodes[0];
    const researchAfter = after.nodes[0];
    expect(researchAfter.settings).toEqual(researchBefore.settings);
    expect(researchAfter.limits).toEqual(researchBefore.limits);
    expect(researchAfter.workspace).toEqual(researchBefore.workspace);
    expect("goal" in researchAfter && researchAfter.goal).toBe(
      "goal" in researchBefore && researchBefore.goal,
    );
    expect(after.defaultModel).toEqual(before.defaultModel);
    expect(after.evidence).toEqual(before.evidence);
    // Only the two fields the ops named actually differ.
    expect(researchAfter.position).toEqual({ x: 5, y: 5 });
    expect(researchAfter.name).toBe("Research, renamed");
  });

  it("keeps node and edge order stable so ids do not churn across an edit", () => {
    const { document: after } = applyDelta(document(), [
      { op: "addNode", nodeId: "extra", name: "Extra", position: { x: 640, y: 0 } },
      { op: "moveNode", nodeId: "research", position: { x: 1, y: 1 } },
    ]);

    expect(after.nodes.map((node) => node.id)).toEqual(["research", "report", "extra"]);
    expect(after.nodes[2]).toMatchObject({ kind: "agent", terminal: false, id: "extra" });
  });

  it("stamps a harness onto a canvas-created node and can clear one later", () => {
    const created = applyDelta(document(), [
      { op: "addNode", nodeId: "harnessed", name: "Harnessed", harness: "claude-code" },
    ]);
    expect(created.document.nodes[2].settings).toEqual({ harness: "claude-code" });

    const cleared = applyDelta(created.document, [
      { op: "setHarness", nodeId: "research", harness: null },
    ]);
    expect(cleared.document.nodes[0].settings?.harness).toBeUndefined();
    // Clearing the harness must not take the rest of the NodeSpec with it.
    expect(cleared.document.nodes[0].settings?.databases).toEqual(["postgres://analytics"]);
  });

  it("removes a node with its incident edges and reassigns a removed entry node", () => {
    const result = applyDelta(document(), [{ op: "removeNode", nodeId: "research" }]);

    expect(result.document.nodes.map((node) => node.id)).toEqual(["report"]);
    expect(result.document.edges).toEqual([]);
    expect(result.document.entryNodeId).toBe("report");
    expect(result.entryNodeReassigned).toBe(true);
  });

  it("rejects unknown nodes, duplicate ids, dangling edges, and bad values without applying them", () => {
    const before = document();
    const result = applyDelta(before, [
      { op: "moveNode", nodeId: "ghost", position: { x: 1, y: 1 } },
      { op: "addNode", nodeId: "research", name: "Duplicate" },
      { op: "addNode", nodeId: "Not A Valid Id", name: "Bad id" },
      { op: "addEdge", edgeId: "dangling", from: "research", to: "ghost" },
      { op: "removeEdge", edgeId: "no-such-edge" },
      { op: "moveNode", nodeId: "research", position: { x: Number.NaN, y: 0 } },
      { op: "setHarness", nodeId: "research", harness: "gpt-cli" as never },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.document).toBe(before);
    expect(result.rejected.map((rejection) => rejection.code)).toEqual([
      "delta/unknown-node",
      "delta/duplicate-node",
      "delta/invalid-id",
      "delta/edge-endpoint-missing",
      "delta/unknown-edge",
      "delta/invalid-value",
      "delta/invalid-value",
    ]);
  });

  it("rejects an unknown op rather than ignoring it", () => {
    const result = applyDelta(document(), [
      { op: "replaceDocument", document: {} } as unknown as CanvasDeltaOp,
    ]);

    expect(result.rejected).toEqual([
      {
        op: "replaceDocument",
        code: "delta/unknown-op",
        message: "Unsupported canvas delta: replaceDocument",
      },
    ]);
  });

});

describe("rejectStaleDeltas", () => {
  it("drops a delta computed against an older projection and keeps the fresh ones", () => {
    const base = document();
    const view = typedToView(base);
    const staleDigest = "deadbeefdeadbeef";

    const { fresh, stale } = rejectStaleDeltas(view, [
      { op: "moveNode", nodeId: "research", position: { x: 1, y: 1 }, specDigest: staleDigest },
      {
        op: "moveNode",
        nodeId: "report",
        position: { x: 2, y: 2 },
        specDigest: view.nodes[1].specDigest,
      },
      { op: "removeEdge", edgeId: "research-to-report" },
    ]);

    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ code: "delta/stale-digest", nodeId: "research" });
    expect(fresh.map((operation) => operation.op)).toEqual(["moveNode", "removeEdge"]);
  });
});

describe("canonicalDocumentJson", () => {
  it("sorts keys recursively and is insensitive to input key order", () => {
    const ordered = document();
    const reordered = JSON.parse(
      JSON.stringify(ordered, Object.keys(ordered).reverse()),
    ) as WorkflowGraphDocument;

    expect(canonicalDocumentJson({ ...reordered, ...ordered })).toBe(
      canonicalDocumentJson(ordered),
    );
    expect(canonicalDocumentJson(ordered).startsWith('{"defaultModel"')).toBe(true);
  });

  it("refuses non-finite numbers and undefined fields rather than hashing them away", () => {
    const broken = document() as unknown as Record<string, unknown>;
    expect(() =>
      canonicalDocumentJson({ ...broken, extra: Number.POSITIVE_INFINITY } as never),
    ).toThrow(/non-finite/);
    expect(() =>
      canonicalDocumentJson({ ...broken, extra: undefined } as never),
    ).toThrow(/undefined/);
  });

  it("agrees with the server on the shared parity fixture", async () => {
    const digest = await documentGraphSha256(
      GRAPH_HASH_PARITY_DOCUMENT as unknown as WorkflowGraphDocument,
    );

    expect(digest).toBe(GRAPH_HASH_PARITY_SHA256);
  });
});

describe("viewFromDoc", () => {
  it("is the projection typedToView produces", () => {
    const base = document();
    expect(viewFromDoc(base, { graphSha256: "abc" })).toEqual(
      typedToView(base, { graphSha256: "abc" }),
    );
  });
});
