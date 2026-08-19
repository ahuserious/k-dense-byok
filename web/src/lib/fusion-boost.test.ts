// danbot-byok — web/src/lib/fusion-boost.test.ts
//
// Row 25. As with the stitch tests, these pin the ARTEFACT. Gate B for row 25 —
// "with the toggle on and stage X checked, a fusion call demonstrably runs at
// stage X; with it off, it does not" — is proven against the live server in
// W/reports/f6-evidence.md, not here.

import { describe, expect, it } from "vitest";

import type { WorkflowGraphDocument, WorkflowGraphNode } from "@/lib/dag-workflows";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";
import {
  FUSION_BOOST_NODE_IDS,
  FUSION_BOOST_STAGES,
  applyFusionBoost,
  isFusionBoostStageAvailable,
  readFusionBoost,
} from "./fusion-boost";

/** `head -> tail`, tail terminal — built from the repo's own default graph. */
function twoNodeDocument(): WorkflowGraphDocument {
  const base = createDefaultWorkflowGraph("subject", "Subject workflow");
  const head = { ...base.nodes[0]!, id: "head", name: "Head", terminal: false } as WorkflowGraphNode;
  const tail = { ...base.nodes[0]!, id: "tail", name: "Tail", terminal: true } as WorkflowGraphNode;
  return {
    ...base,
    entryNodeId: "head",
    nodes: [head, tail],
    edges: [{ id: "e1", from: "head", to: "tail", condition: "always" }],
  };
}

describe("fusion boost — stage availability", () => {
  it("marks exactly the two stages this tree can bind as available", () => {
    const available = FUSION_BOOST_STAGES.filter((stage) => stage.available).map((s) => s.id);
    expect(available).toEqual(["planning", "verification-gate"]);
  });

  it("gives every unavailable stage a reason naming the lane it is waiting on", () => {
    for (const stage of FUSION_BOOST_STAGES) {
      if (stage.available) continue;
      expect(stage.unavailableReason).toBeTruthy();
      expect(stage.unavailableReason).toMatch(/lane F5/);
    }
    // The two absent kinds are named, not vaguely gestured at.
    expect(isFusionBoostStageAvailable("elevation-to-dag")).toBe(false);
    expect(isFusionBoostStageAvailable("hypothesis")).toBe(false);
  });
});

describe("applyFusionBoost", () => {
  it("inserts NOTHING while the master toggle is off, even with stages checked", () => {
    const { document, appliedStages } = applyFusionBoost(twoNodeDocument(), {
      enabled: false,
      stages: { planning: true, "verification-gate": true },
    });
    expect(appliedStages).toEqual([]);
    expect(document.nodes.some((node) => node.kind === "fusion")).toBe(false);
  });

  it("puts a real fusion node AHEAD of the entry node for the planning stage", () => {
    const { document, appliedStages } = applyFusionBoost(twoNodeDocument(), {
      enabled: true,
      stages: { planning: true },
    });

    expect(appliedStages).toEqual(["planning"]);
    expect(document.entryNodeId).toBe(FUSION_BOOST_NODE_IDS.planning);

    const inserted = document.nodes.find((node) => node.id === FUSION_BOOST_NODE_IDS.planning)!;
    expect(inserted.kind).toBe("fusion");
    // The entry node must have no incoming edge (validate.ts:1609).
    expect(document.edges.some((edge) => edge.to === document.entryNodeId)).toBe(false);
    // ...and it must reach the workflow it is planning for.
    expect(document.edges.some((edge) => edge.from === inserted.id && edge.to === "head")).toBe(true);
  });

  it("puts a real fusion node AFTER the terminals for the verification-gate stage", () => {
    const { document, appliedStages } = applyFusionBoost(twoNodeDocument(), {
      enabled: true,
      stages: { "verification-gate": true },
    });

    expect(appliedStages).toEqual(["verification-gate"]);
    const verify = document.nodes.find(
      (node) => node.id === FUSION_BOOST_NODE_IDS["verification-gate"],
    )!;
    expect(verify.kind).toBe("fusion");
    expect(verify.terminal).toBe(true);

    // The former terminal was demoted and now routes into the panel — a
    // terminal node may not have outgoing edges (validate.ts:1812).
    const formerTerminal = document.nodes.find((node) => node.id === "tail")!;
    expect(formerTerminal.terminal).toBe(false);
    expect(
      document.edges.some((edge) => edge.from === "tail" && edge.to === verify.id),
    ).toBe(true);
    // Exactly one terminal remains.
    expect(document.nodes.filter((node) => node.terminal)).toHaveLength(1);
  });

  it("uses the existing `fusion` kind and adds no new node kind", () => {
    const { document } = applyFusionBoost(twoNodeDocument(), {
      enabled: true,
      stages: { planning: true, "verification-gate": true },
    });
    const kinds = new Set(document.nodes.map((node) => node.kind));
    // "agent" from the fixture, "fusion" from the boost — nothing invented.
    expect([...kinds].sort()).toEqual(["agent", "fusion"]);
  });

  it("refuses a stage whose node kind does not exist, even when asked directly", () => {
    const { document, appliedStages } = applyFusionBoost(twoNodeDocument(), {
      enabled: true,
      stages: { "elevation-to-dag": true, hypothesis: true },
    });
    // A caller bypassing the disabled checkbox still cannot produce a document
    // that claims a stage this tree cannot run.
    expect(appliedStages).toEqual([]);
    expect(document.nodes.some((node) => node.kind === "fusion")).toBe(false);
  });

  it("is idempotent — applying twice does not stack a second panel", () => {
    const config = { enabled: true, stages: { planning: true, "verification-gate": true } };
    const once = applyFusionBoost(twoNodeDocument(), config).document;
    const twice = applyFusionBoost(once, config).document;
    expect(twice.nodes.filter((node) => node.kind === "fusion")).toHaveLength(2);
    expect(twice.nodes).toHaveLength(once.nodes.length);
    expect(twice.edges).toHaveLength(once.edges.length);
  });

  it("turning the toggle back off REMOVES the panels and restores a valid shape", () => {
    const boosted = applyFusionBoost(twoNodeDocument(), {
      enabled: true,
      stages: { planning: true, "verification-gate": true },
    }).document;

    const { document } = applyFusionBoost(boosted, { enabled: false, stages: {} });

    expect(document.nodes.some((node) => node.kind === "fusion")).toBe(false);
    expect(document.entryNodeId).toBe("head");
    // The demoted terminal is terminal again, so it is not an unmarked sink
    // (validate.ts:1821).
    expect(document.nodes.find((node) => node.id === "tail")?.terminal).toBe(true);
    expect(document.edges.every((edge) => !edge.id.startsWith("fusion-boost"))).toBe(true);
  });

  it("reads its own state back off the document rather than remembering it", () => {
    const boosted = applyFusionBoost(twoNodeDocument(), {
      enabled: true,
      stages: { planning: true },
    }).document;
    const reloaded = JSON.parse(JSON.stringify(boosted)) as WorkflowGraphDocument;

    expect(readFusionBoost(reloaded)).toEqual({ enabled: true, stages: { planning: true } });
    expect(readFusionBoost(twoNodeDocument())).toEqual({ enabled: false, stages: {} });
  });
});
