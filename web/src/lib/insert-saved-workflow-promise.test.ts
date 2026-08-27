// BF-30 / BF-55 / BF-56 — the insert-saved-workflow confirmation dialog must not
// promise something the same confirmation then breaks.
//
// This is the gate that had to exist and did not. The two adversarial seats that
// missed BF-30 both asserted about ids and counts; neither read the dialog's
// words against the state the dialog produced. A test of the edge set alone
// would have passed on the day the defect was introduced, and so would a test of
// the copy alone. The property asserted here is that THE TWO AGREE:
//
//   the existing-graph nodes the dialog SAYS will gain a connection
//     ===
//   the existing-graph nodes the settled document ACTUALLY connects
//
// Both halves are computed, not restated, and both come from the REAL host path:
//   * the words come from `savedWorkflowInsertCopy` in the VENDORED engine — the
//     same function `WorkflowCanvas` renders — fed the settlement declaration
//     that `buildInsertSavedWorkflowPayload` actually posts (BF-56: cycle 1
//     inferred the claim from the canvas instead, and on the standalone engine
//     it therefore promised edges nothing created);
//   * the settled document comes from `applySavedWorkflowInsertToHostDocument`,
//     which is what `dag-builder-surface.tsx` calls on
//     `builder.savedWorkflowInserted` before pushing the view back to the canvas.
//
// The dialog also has to be READABLE, not merely true (BF-55), so the sentence
// is asserted to name each node the way its card is drawn.
//
// WHY THIS FILE DOES NOT CALL `planInsertSavedWorkflow`
// -----------------------------------------------------
// The engine's planner reaches its neighbours through the engine's own `@/`
// alias, which `web`'s TypeScript program cannot resolve: importing it here runs
// green under vitest (esbuild erases the type-only imports) while adding four
// TS2307 errors to a `tsc -p web/tsconfig.json` that is otherwise clean. The
// contract therefore crosses the package boundary through the engine's
// zero-import copy module. That the planner's own `plan.stitchPoints` produce
// the identical claim is pinned on the engine side, by
// server/vendor/pipeline-engine/packages/web/src/host/insert-saved-workflow-copy.test.ts,
// which drives the real `planInsertSavedWorkflow` and `confirmInsertSavedWorkflow`.

import { describe, expect, it } from "vitest";

import {
  SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE,
  savedWorkflowInsertCopy,
  type SavedWorkflowInsertCopy,
} from "../../../server/vendor/pipeline-engine/packages/web/src/host/insert-saved-workflow-copy";
import {
  applySavedWorkflowInsertToHostDocument,
  buildInsertSavedWorkflowPayload,
} from "@/lib/insert-saved-workflow-host";
import { typedToView } from "@/lib/typed-graph-view";
import type { WorkflowGraphDocument } from "@/lib/dag-workflows";

/**
 * The saved workflow id from the BF-30 observation. `p3Nonce`
 * (e2e/p3/fixtures.ts:480) mints suffixes shaped `mta203oo-0-7y6x4v`, so this is
 * the exact id the observed edge was built from — which makes the reproduction
 * below byte-comparable with the finding rather than merely similar.
 */
const OBSERVED_SAVED_ID = "p3-bld24-cancel-saved-mta203oo-0-7y6x4v";
const OBSERVED_EDGE_ID = "stitch-always-writeup-to-p3-bld24-cancel-saved-mta203oo-0-7y6x4v";

const HOST_SHA = "a".repeat(64);
const SAVED_SHA = "b".repeat(64);

/** Mirrors e2e/p3/fixtures.ts `minimalAgentDocument` — a shape the server accepts. */
function agentChain(id: string, name: string, nodeIds: readonly string[]): WorkflowGraphDocument {
  const model = {
    requested: {
      source: "fixed",
      provider: "openrouter",
      model: "stealth/ox-alpha",
      auth: { kind: "api-key" },
      reasoning: "low",
    },
    resolution: { mode: "exact" },
  };
  return {
    schemaVersion: "1.0",
    id,
    name,
    entryNodeId: nodeIds[0]!,
    defaultModel: structuredClone(model),
    limits: {
      maxIterations: 2,
      maxModelCalls: Math.max(2, nodeIds.length * 2),
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 120_000,
      maxTokens: 52_224 * nodeIds.length,
      maxCostUsd: 0.05,
      maxRetries: 0,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    },
    nodes: nodeIds.map((nodeId, index) => ({
      id: nodeId,
      name: nodeId.replace(/-/g, " "),
      kind: "agent",
      terminal: index === nodeIds.length - 1,
      position: { x: 80 + index * 260, y: 80 },
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: `Reply with exactly the single word OK. (step ${String(index + 1)})`,
      model: structuredClone(model),
    })),
    edges: nodeIds.slice(1).map((nodeId, index) => ({
      id: `${nodeIds[index]!}-${nodeId}`,
      from: nodeIds[index]!,
      to: nodeId,
      condition: "always",
    })),
  } as unknown as WorkflowGraphDocument;
}

/** The engine's canvas as the host's `builder.loadGraph` leaves it. */
function canvasNodesFor(document: WorkflowGraphDocument, graphSha256: string) {
  const view = typedToView(document, { graphSha256 });
  return view.nodes.map((node) => ({ id: node.id, label: node.label }));
}

interface InsertRun {
  /** The dialog branch. `planInsertSavedWorkflow` picks `replace` iff the canvas is empty. */
  mode: "replace" | "append";
  copy: SavedWorkflowInsertCopy;
  /** What the host DECLARED in the posted payload, before any settlement ran. */
  declared: string[];
  /** The document the host pushes back onto the canvas after settlement. */
  settled: WorkflowGraphDocument;
  /** Settled edges with exactly one endpoint in the pre-existing graph. */
  crossEdges: WorkflowGraphDocument["edges"];
}

/** Drive one insert: the dialog's words, then the settlement they describe. */
function runInsert(host: WorkflowGraphDocument, saved: WorkflowGraphDocument): InsertRun {
  const canvasNodes = canvasNodesFor(host, HOST_SHA);
  const mode = canvasNodes.length === 0 ? "replace" : "append";

  // The declaration is taken from the payload the host really posts, not from a
  // convenience helper — if `buildInsertSavedWorkflowPayload` ever stops
  // declaring, or declares the wrong set, this gate is the thing that fails.
  const payload = buildInsertSavedWorkflowPayload(
    { id: saved.id, revision: 1, graphSha256: SAVED_SHA, graph: saved },
    { x: 640, y: 180 },
    "swi-1-bf30",
    host,
  );

  const copy = savedWorkflowInsertCopy({
    mode,
    workflowId: saved.id,
    insertedNodeCount: saved.nodes.length,
    settlementConnectsFromNodeIds: payload.settlement.connectsFromNodeIds,
    existingNodes: canvasNodes,
  });

  const settled = applySavedWorkflowInsertToHostDocument(host, HOST_SHA, {
    id: saved.id,
    graphSha256: SAVED_SHA,
    graph: saved,
  });
  const hostNodeIds = new Set(host.nodes.map((node) => node.id));
  const crossEdges = settled.edges.filter(
    (edge) => hostNodeIds.has(edge.from) !== hostNodeIds.has(edge.to),
  );

  return { mode, copy, declared: payload.settlement.connectsFromNodeIds, settled, crossEdges };
}

describe("BF-30 · the insert dialog's promise and the settled canvas", () => {
  it("says exactly which existing nodes gain a connection, and connects exactly those", () => {
    const host = agentChain("p3-bld24-cancel-host", "BF-30 host", ["start", "analysis", "writeup"]);
    const saved = agentChain(OBSERVED_SAVED_ID, "BF-30 saved", ["saved-a", "saved-b", "saved-c"]);
    const run = runInsert(host, saved);

    expect(run.mode).toBe("append");

    // ---- THE PROPERTY. Copy and edge set, asserted together, in one test.
    const promised = [...run.copy.claim.connectedFromNodeIds].sort();
    const actuallyConnected = [...new Set(run.crossEdges.map((edge) => edge.from))].sort();
    expect(
      actuallyConnected,
      `BF-30: the dialog said ${JSON.stringify(promised)} would be connected to the inserted group; `
        + `the settled document connects ${JSON.stringify(actuallyConnected)}. `
        + `Dialog body was: ${run.copy.body}`,
    ).toEqual(promised);

    // The claim is not allowed to be satisfied vacuously in either direction.
    if (promised.length === 0) {
      expect(run.crossEdges, "the dialog promised no edge; the settlement made one").toEqual([]);
      expect(run.copy.body).toContain(SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE);
    } else {
      expect(
        run.copy.body,
        "the dialog created edges to the existing graph while still claiming it would not",
      ).not.toContain("No edges will be created");
      for (const displayName of run.copy.claim.connectedFromDisplayNames) {
        expect(
          run.copy.body,
          `the dialog's claim names ${displayName} but its words do not`,
        ).toContain(displayName);
      }
      // BF-55: every name in the sentence is a name the canvas actually shows.
      const canvasLabels = new Set(canvasNodesFor(host, HOST_SHA).map((node) => node.label));
      for (const displayName of run.copy.claim.connectedFromDisplayNames) {
        expect(
          canvasLabels.has(displayName),
          `the dialog named "${displayName}", which no card on the canvas is drawn as`,
        ).toBe(true);
      }
    }

    // BF-56: the promise came from the host's own declaration, and the
    // declaration is what the settlement then honoured.
    expect([...run.declared].sort()).toEqual(promised);

    // Every connection the dialog describes lands INSIDE the inserted group.
    const hostNodeIds = new Set(host.nodes.map((node) => node.id));
    for (const edge of run.crossEdges) {
      expect(hostNodeIds.has(edge.from)).toBe(true);
      expect(hostNodeIds.has(edge.to)).toBe(false);
    }
  });

  it("reproduces the observed fifth edge, byte for byte, on the append branch", () => {
    const host = agentChain("p3-bld24-cancel-host", "BF-30 host", ["start", "analysis", "writeup"]);
    const saved = agentChain(OBSERVED_SAVED_ID, "BF-30 saved", ["saved-a", "saved-b", "saved-c"]);
    const run = runInsert(host, saved);

    expect(host.edges).toHaveLength(2);
    expect(saved.edges).toHaveLength(2);
    // Four edges are the two graphs' own. The fifth is the stitch.
    expect(run.settled.edges).toHaveLength(5);
    expect(run.crossEdges.map((edge) => edge.id)).toEqual([OBSERVED_EDGE_ID]);
    expect(run.crossEdges[0]).toMatchObject({
      from: "writeup",
      to: `${OBSERVED_SAVED_ID}-saved-a`,
      condition: "always",
    });
    // And the dialog that produced it now says so.
    expect(run.copy.claim.connectedFromNodeIds).toEqual(["writeup"]);
    // This fixture's node is NAMED "writeup", so its card is drawn "writeup" and
    // its id and its label coincide. Cycle 1 used exactly this and mistook the
    // coincidence for readable copy — BF-55. The label case that does NOT
    // coincide is asserted in "names each node by the label its card shows".
    expect(run.copy.body).toContain("an edge is created from your end node \u201cwriteup\u201d");
  });

  it("names both end nodes when the existing graph forks", () => {
    const base = agentChain("bf30-fork-host", "BF-30 fork host", ["start", "analysis", "review"]);
    const host = {
      ...base,
      nodes: base.nodes.map((node) => (node.id === "analysis" ? { ...node, terminal: true } : node)),
      edges: [
        { id: "start-analysis", from: "start", to: "analysis", condition: "always" },
        { id: "start-review", from: "start", to: "review", condition: "always" },
      ],
    } as WorkflowGraphDocument;
    const saved = agentChain("bf30-fork-saved", "BF-30 fork saved", ["saved-a", "saved-b"]);
    const run = runInsert(host, saved);

    expect([...run.copy.claim.connectedFromNodeIds].sort()).toEqual(["analysis", "review"]);
    expect([...new Set(run.crossEdges.map((edge) => edge.from))].sort()).toEqual([
      "analysis",
      "review",
    ]);
    expect(run.copy.body).toContain(
      "edges are created from your end nodes \u201canalysis\u201d and \u201creview\u201d",
    );
  });
});

describe("BF-30 negative controls", () => {
  it("the settled edge set is unchanged by this fix — only the words moved", () => {
    const host = agentChain("p3-bld24-cancel-host", "BF-30 host", ["start", "analysis", "writeup"]);
    const saved = agentChain(OBSERVED_SAVED_ID, "BF-30 saved", ["saved-a", "saved-b", "saved-c"]);
    const run = runInsert(host, saved);

    expect(run.settled.edges.map((edge) => edge.id)).toEqual([
      "start-analysis",
      "analysis-writeup",
      `${OBSERVED_SAVED_ID}-saved-a-saved-b`.slice(0, 64),
      `${OBSERVED_SAVED_ID}-saved-b-saved-c`.slice(0, 64),
      OBSERVED_EDGE_ID,
    ]);
  });

  it("the replace branch is untouched: no promise, no claim, no connection", () => {
    const saved = agentChain(OBSERVED_SAVED_ID, "BF-30 saved", ["saved-a", "saved-b"]);
    const copy = savedWorkflowInsertCopy({
      mode: "replace",
      workflowId: saved.id,
      insertedNodeCount: saved.nodes.length,
      settlementConnectsFromNodeIds: [],
      existingNodes: [],
    });

    expect(copy.title).toBe("Replace empty canvas with saved workflow?");
    expect(copy.body).toBe(`This canvas is empty. Confirm to load 2 nodes from ${OBSERVED_SAVED_ID}.`);
    expect(copy.claim.connectedFromNodeIds).toEqual([]);
    expect(copy.body).not.toContain(SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE);
  });

  it("the ordinary no-stitch case: nothing on the existing side, old wording, no cross edge", () => {
    // A host that declares it will connect nothing gets the pre-BF-30 sentence,
    // which is then true, and nothing about it claims a connection.
    const copy = savedWorkflowInsertCopy({
      mode: "append",
      workflowId: OBSERVED_SAVED_ID,
      insertedNodeCount: 2,
      settlementConnectsFromNodeIds: [],
      existingNodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });

    expect(copy.claim.connectedFromNodeIds).toEqual([]);
    expect(copy.body).toContain(SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE);
  });
});

describe("BF-56 · the guarantee holds in both directions on a canvas mid-edit", () => {
  // Seat A's probes P5 and P6 both DISAGREED under cycle 1's rule, in opposite
  // directions, because the dialog inferred "end node" as "has no outgoing
  // edge" while `stitchWorkflows` hands over from `terminal === true`. The
  // declaration now comes from the same property the stitch uses, so both
  // directions agree — and these are the cases that prove it, not prose.

  it("P6 · a node marked terminal that still has an outgoing edge is NAMED, not silently bridged", () => {
    const base = agentChain("bf30-p6-host", "BF-30 P6 host", ["start", "writeup"]);
    const host = {
      ...base,
      // `start` keeps its outgoing edge AND is marked terminal: the shape a
      // canvas takes mid-edit, and one the validator would refuse
      // (terminal-has-outgoing-edge, validate.ts:2496) — but the dialog renders
      // long before Save.
      nodes: base.nodes.map((node) => (node.id === "start" ? { ...node, terminal: true } : node)),
    } as WorkflowGraphDocument;
    const saved = agentChain("bf30-p6-saved", "BF-30 P6 saved", ["saved-a", "saved-b"]);
    const run = runInsert(host, saved);

    const promised = [...run.copy.claim.connectedFromNodeIds].sort();
    const actuallyConnected = [...new Set(run.crossEdges.map((edge) => edge.from))].sort();
    expect(promised).toEqual(["start", "writeup"]);
    expect(
      actuallyConnected,
      `BF-56/P6: the settlement bridged from a node the dialog never mentioned. `
        + `Dialog body was: ${run.copy.body}`,
    ).toEqual(promised);
  });

  it("P5 · an unwired draft node that is not terminal is NOT promised and NOT connected", () => {
    const base = agentChain("bf30-p5-host", "BF-30 P5 host", ["start", "writeup"]);
    const host = {
      ...base,
      // A card the user just dropped and has not wired: no outgoing edge, so
      // cycle 1's rule named it, and no `terminal`, so nothing ever connects it.
      nodes: [
        ...base.nodes,
        { ...base.nodes[0]!, id: "draft", name: "draft", terminal: false },
      ],
    } as WorkflowGraphDocument;
    const saved = agentChain("bf30-p5-saved", "BF-30 P5 saved", ["saved-a", "saved-b"]);
    const run = runInsert(host, saved);

    const promised = [...run.copy.claim.connectedFromNodeIds].sort();
    const actuallyConnected = [...new Set(run.crossEdges.map((edge) => edge.from))].sort();
    expect(promised).toEqual(["writeup"]);
    expect(actuallyConnected).toEqual(promised);
    expect(run.copy.body, "the dialog promised an edge from an unwired draft node").not.toContain(
      "draft",
    );
  });
});

describe("BF-55 · the sentence is readable on the host route", () => {
  it("names each node by the label its card shows, not by its id", () => {
    // The BF-55 observation: a card drawn "saved b" described as
    // `p3-bld24-confirm-saved-saved-b-2`, and a canvas-authored card drawn
    // "Prompt" described as `node-a9e723f9-...`. Here the id and the label are
    // deliberately different so the coincidence that hid this cannot recur.
    const base = agentChain("bf30-label-host", "BF-30 label host", ["start", "writeup"]);
    const host = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === "writeup" ? { ...node, name: "Draft the write-up" } : node,
      ),
    } as WorkflowGraphDocument;
    const saved = agentChain("bf30-label-saved", "BF-30 label saved", ["saved-a", "saved-b"]);
    const run = runInsert(host, saved);

    expect(run.copy.claim.connectedFromNodeIds).toEqual(["writeup"]);
    expect(run.copy.claim.connectedFromDisplayNames).toEqual(["Draft the write-up"]);
    expect(run.copy.body).toContain(
      "an edge is created from your end node \u201cDraft the write-up\u201d",
    );
    expect(run.copy.body, "the raw id leaked into the sentence again").not.toContain("writeup\u201d ");
    // The canvas really does draw that card with that label.
    expect(canvasNodesFor(host, HOST_SHA)).toContainEqual({
      id: "writeup",
      label: "Draft the write-up",
    });
  });
});

describe("BF-56 · no settling party, no promise", () => {
  it("a payload with no settlement declaration produces the 'no edges' sentence", () => {
    // This is the standalone engine (:13091) and the engine's own palette drag:
    // nothing outside the engine touches the document, so confirming creates no
    // cross edge. Cycle 1 promised edges here and created none.
    const host = agentChain("bf30-nohost", "BF-30 no host", ["start", "writeup"]);
    const copy = savedWorkflowInsertCopy({
      mode: "append",
      workflowId: OBSERVED_SAVED_ID,
      insertedNodeCount: 2,
      settlementConnectsFromNodeIds: null,
      existingNodes: canvasNodesFor(host, HOST_SHA),
    });

    expect(copy.claim.connectedFromNodeIds).toEqual([]);
    expect(copy.body).toContain(SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE);
    expect(copy.body).not.toContain("an edge is created");
  });
});
