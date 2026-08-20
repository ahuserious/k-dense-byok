// danbot-byok — web/src/lib/stitch-workflows.test.ts
//
// Row 22. These assert on the SHAPE the stitch produces, which is what this
// module is responsible for. They are NOT Gate B evidence and must never be
// cited as such: Gate B for row 22 is "a run whose node execution order shows
// phase 1's nodes completing before phase 2's begin", and that is proven on a
// live server in W/reports/f6-evidence.md, not here.
//
// What these DO pin is every validator rule the composed document has to
// satisfy (validate.ts line numbers in stitch-workflows.ts's header), because
// getting one wrong produces a document the server refuses at save time — and
// a refused save is a broken feature no e2e run would catch, since the failure
// is server-side.

import { describe, expect, it } from "vitest";

import type {
  WorkflowGraphDocument,
  WorkflowGraphNode,
} from "@/lib/dag-workflows";
import {
  STITCH_COMPOSITE_KIND,
  StitchError,
  readStitchPhases,
  stitchWorkflows,
} from "./stitch-workflows";

// The REAL `WorkflowLimits` shape (dag-workflows.ts:48-57). An invented
// fixture would let these tests pass over a document the server rejects —
// which is exactly what happened on the first draft, and the live validator
// on the lane preview caught it. Kept structural, with no cast.
const LIMITS: WorkflowGraphDocument["limits"] = {
  maxIterations: 4,
  maxModelCalls: 16,
  maxParallelism: 2,
  maxSubagents: 2,
  timeoutMs: 600_000,
  maxTokens: 200_000,
  maxCostUsd: 10,
  maxRetries: 2,
};

const EVIDENCE_OFF: WorkflowGraphDocument["evidence"] = {
  enabled: false,
  minimumIndependentSources: 0,
  requireArtifactReferences: false,
  onUnsupportedOutput: "fail",
};

function agentNode(id: string, terminal: boolean): WorkflowGraphNode {
  return {
    id,
    name: id,
    kind: "agent",
    terminal,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: `Do ${id}.`,
  } as WorkflowGraphNode;
}

/** `a -> b`, `b` terminal. The smallest document that is actually valid. */
function twoNodeDocument(id: string, name: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name,
    entryNodeId: `${id}-head`,
    limits: LIMITS,
    evidence: EVIDENCE_OFF,
    nodes: [agentNode(`${id}-head`, false), agentNode(`${id}-tail`, true)],
    edges: [
      { id: `${id}-e1`, from: `${id}-head`, to: `${id}-tail`, condition: "always" },
    ],
  };
}

const PHASE_ONE = {
  document: twoNodeDocument("alpha", "Alpha phase"),
  sourceId: "alpha",
  graphSha256: "a".repeat(64),
  label: "Alpha phase",
};
const PHASE_TWO = {
  document: twoNodeDocument("beta", "Beta phase"),
  sourceId: "beta",
  graphSha256: "b".repeat(64),
  label: "Beta phase",
};

const OPTIONS = { id: "composed", name: "Composed pipeline" };

/**
 * A topological order of the composed graph, used to assert the ORDERING
 * property the stitch exists to create. Kahn's algorithm, same shape as
 * validate.ts:1758-1780, so "what this test calls an order" and "what the
 * server calls a DAG" are the same notion.
 */
function topologicalOrder(document: WorkflowGraphDocument): string[] {
  const incoming = new Map(document.nodes.map((node) => [node.id, 0]));
  for (const edge of document.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const ready = document.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const current = ready[cursor]!;
    order.push(current);
    for (const edge of document.edges.filter((candidate) => candidate.from === current)) {
      const remaining = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, remaining);
      if (remaining === 0) ready.push(edge.to);
    }
  }
  return order;
}

describe("stitchWorkflows", () => {
  it("orders the phases: every phase-1 node precedes every phase-2 node", () => {
    const { document, phases } = stitchWorkflows([PHASE_ONE, PHASE_TWO], OPTIONS);
    const order = topologicalOrder(document);

    expect(order).toHaveLength(document.nodes.length);

    const lastOfPhaseOne = Math.max(...phases[0]!.nodeIds.map((id) => order.indexOf(id)));
    const firstOfPhaseTwo = Math.min(...phases[1]!.nodeIds.map((id) => order.indexOf(id)));
    expect(lastOfPhaseOne).toBeLessThan(firstOfPhaseTwo);
  });

  it("writes meta.compositeOf naming the source workflow AND its exact revision hash", () => {
    const { document } = stitchWorkflows([PHASE_ONE, PHASE_TWO], OPTIONS);

    for (const node of document.nodes) {
      expect(node.meta?.compositeOf).toBeDefined();
      expect(node.meta?.compositeOf?.kind).toBe(STITCH_COMPOSITE_KIND);
    }
    const fromAlpha = document.nodes.filter((n) => n.meta?.compositeOf?.sourceId === "alpha");
    const fromBeta = document.nodes.filter((n) => n.meta?.compositeOf?.sourceId === "beta");
    expect(fromAlpha).toHaveLength(2);
    expect(fromBeta).toHaveLength(2);
    expect(fromAlpha[0]?.meta?.compositeOf?.sourceGraphSha256).toBe("a".repeat(64));
    expect(fromBeta[0]?.meta?.compositeOf?.sourceGraphSha256).toBe("b".repeat(64));
    expect(fromAlpha[0]?.meta?.compositeOf?.label).toBe("Alpha phase");
  });

  it("demotes phase 1's terminal so it may carry the handover edge (validate.ts:1812)", () => {
    const { document, phases } = stitchWorkflows([PHASE_ONE, PHASE_TWO], OPTIONS);

    const handoverId = phases[0]!.handoverNodeIds[0]!;
    const handover = document.nodes.find((node) => node.id === handoverId)!;
    expect(handover.terminal).toBe(false);
    expect(document.edges.some((edge) => edge.from === handoverId)).toBe(true);

    // ...and the LAST phase's terminal stays terminal, with no outgoing edge.
    const finalId = phases[1]!.handoverNodeIds[0]!;
    const final = document.nodes.find((node) => node.id === finalId)!;
    expect(final.terminal).toBe(true);
    expect(document.edges.some((edge) => edge.from === finalId)).toBe(false);
  });

  it("gives the demoted node an unconditional route, satisfying validate.ts:1650/:1657", () => {
    const { document, phases } = stitchWorkflows([PHASE_ONE, PHASE_TWO], OPTIONS);
    const handoverId = phases[0]!.handoverNodeIds[0]!;
    const outgoing = document.edges.filter((edge) => edge.from === handoverId);

    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]?.condition).toBe("always");
    expect(outgoing[0]?.to).toBe(phases[1]!.entryNodeId);
  });

  it("routes BOTH evidence outcomes onward when the handover node is evidence-routed", () => {
    const routed = twoNodeDocument("gamma", "Gamma phase");
    routed.nodes[1] = {
      id: "gamma-tail",
      name: "gamma-tail",
      kind: "evidence-gate",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["citations"],
      artifactIds: [],
      onUnsupportedOutput: "route",
    } as WorkflowGraphNode;

    const { document, phases } = stitchWorkflows(
      [{ document: routed, sourceId: "gamma" }, PHASE_TWO],
      OPTIONS,
    );
    const handoverId = phases[0]!.handoverNodeIds[0]!;
    const conditions = document.edges
      .filter((edge) => edge.from === handoverId)
      .map((edge) => edge.condition)
      .sort();

    // `always` on an evidence-routed node is rejected outright by
    // validate.ts:1688, and dropping the unsupported branch would strand the
    // run — so both, and never `always`.
    expect(conditions).toEqual(["evidence-supported", "evidence-unsupported"]);
    expect(conditions).not.toContain("always");
  });

  it("keeps ids unique, valid, and within the 64-character IdentifierSchema bound", () => {
    const longIdA = twoNodeDocument("a".repeat(58), "Long A");
    const longIdB = twoNodeDocument("b".repeat(58), "Long B");
    const { document } = stitchWorkflows(
      [
        { document: longIdA, sourceId: "long-a" },
        { document: longIdB, sourceId: "long-b" },
      ],
      OPTIONS,
    );

    const ids = [...document.nodes.map((n) => n.id), ...document.edges.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });

  it("keeps the entry node free of incoming edges (validate.ts:1609)", () => {
    const { document } = stitchWorkflows([PHASE_ONE, PHASE_TWO], OPTIONS);
    expect(document.edges.some((edge) => edge.to === document.entryNodeId)).toBe(false);
    expect(document.nodes.some((node) => node.id === document.entryNodeId)).toBe(true);
  });

  it("remaps artifact writer nodes rather than leaving a dangling reference (validate.ts:241)", () => {
    const withArtifact = twoNodeDocument("delta", "Delta phase");
    withArtifact.artifacts = [
      { id: "report", name: "Report", kind: "report", writerNodeId: "delta-tail" },
    ];
    const { document } = stitchWorkflows(
      [{ document: withArtifact, sourceId: "delta" }, PHASE_TWO],
      OPTIONS,
    );

    expect(document.artifacts).toHaveLength(1);
    const writerNodeId = document.artifacts![0]!.writerNodeId;
    expect(document.nodes.some((node) => node.id === writerNodeId)).toBe(true);
  });

  it("refuses a stitch of fewer than two workflows", () => {
    expect(() => stitchWorkflows([PHASE_ONE], OPTIONS)).toThrow(StitchError);
  });

  it("refuses a composed id the server's IdentifierSchema would reject", () => {
    expect(() => stitchWorkflows([PHASE_ONE, PHASE_TWO], { id: "Composed", name: "x" })).toThrow(
      StitchError,
    );
  });

  it("refuses a phase with no terminal node, naming the workflow", () => {
    const noTerminal = twoNodeDocument("eps", "Eps phase");
    noTerminal.nodes[1] = agentNode("eps-tail", false);
    expect(() =>
      stitchWorkflows([{ document: noTerminal, sourceId: "eps" }, PHASE_TWO], OPTIONS),
    ).toThrow(/eps/);
  });

  it("reads the phases back out of a saved composed document", () => {
    const { document } = stitchWorkflows([PHASE_ONE, PHASE_TWO], OPTIONS);
    // Round-trip through JSON: what comes back from the server is parsed JSON,
    // not the object this process built.
    const reloaded = JSON.parse(JSON.stringify(document)) as WorkflowGraphDocument;
    const phases = readStitchPhases(reloaded);

    expect(phases.map((phase) => phase.sourceId)).toEqual(["alpha", "beta"]);
    expect(phases[0]?.label).toBe("Alpha phase");
    expect(phases[0]?.nodeIds).toHaveLength(2);
  });
});
