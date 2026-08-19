// Lane F6 — Gate B for rows 22 and 25, asserted on the EFFECT.
//
// Granted by W/requests/c-f6-2.response.md ("Grant F6 the new-file glob
// `server/test/wave-f/f6-*.test.ts`"), and written to the two assertions that
// response names:
//
//   row 22 — phase ordering on the event log;
//   row 25 — a fusion node dispatched at the enabled stage, and NOT dispatched
//            when the toggle is off.
//
// WHY THIS FILE EXISTS AT ALL. Master brief §3 Gate B: "a server test that
// asserts on the effect (which harness was dispatched, which parameters reached
// the provider call, which node executed), not on the schema accepting the
// field. 'The schema validates it' is not evidence of binding." So nothing here
// asserts that a document validates. Every assertion below is about which nodes
// the durable runner actually EXECUTED, read off the run's own event log.
//
// It drives `runWorkflowDag` with an injected `WorkflowNodeExecutor`, the same
// harness `server/test/workflow-runner.test.ts` uses. That is deliberate: it
// needs no provider credentials, so it asserts the scheduler's real behaviour
// rather than a network result. (The lane ALSO proved both rows against a live
// server on its preview; that transcript is in W/reports/f6-evidence.md. Those
// runs failed on WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE because the preview
// has no credentials, which is exactly why this file exists as the durable
// regression: here the nodes actually SUCCEED, so "phase 1 completed before
// phase 2 began" is proven with real completions rather than real failures.)
//
// The lane's modules are imported by relative path because the server test
// project has no `@/` alias (server/vitest.config.ts). Both imported modules are
// alias-free at runtime for that reason.

import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PROJECTS_ROOT } from "../../src/config.ts";
import {
  WorkflowStore,
  runWorkflowDag,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
  type WorkflowNode,
  type WorkflowNodeExecutor,
  type WorkflowNodeExecutorResult,
} from "../../src/workflows/index.ts";

import { stitchWorkflows } from "../../../web/src/lib/stitch-workflows.ts";
import { applyFusionBoost, FUSION_BOOST_NODE_IDS } from "../../../web/src/lib/fusion-boost.ts";

const PROJECT_ID = "f6-stitch-fusion-test";

function exactModel(): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

function modelReceipt(): WorkflowModelResolutionReceipt {
  return {
    request: exactModel(),
    resolved: {
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "high",
      runtime: "local",
    },
    fallbackUsed: false,
  };
}

function agentNode(id: string, terminal: boolean): WorkflowNode {
  return {
    id,
    name: id,
    kind: "agent",
    terminal,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: `Execute ${id}.`,
    model: exactModel(),
  };
}

/** `<id>-head -> <id>-tail`, tail terminal. A minimally valid workflow. */
function twoNodeWorkflow(id: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: `${id} workflow`,
    entryNodeId: `${id}-head`,
    defaultModel: exactModel(),
    limits: {
      maxIterations: 20,
      maxModelCalls: 100,
      maxParallelism: 4,
      maxSubagents: 16,
      timeoutMs: 60_000,
      maxTokens: 1_000_000,
      maxCostUsd: 10,
      maxRetries: 3,
    },
    rescue: { enabled: false, maxAttempts: 0, triggers: [] },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [agentNode(`${id}-head`, false), agentNode(`${id}-tail`, true)],
    edges: [{ id: `${id}-e1`, from: `${id}-head`, to: `${id}-tail`, condition: "always" }],
  } as WorkflowGraphDocument;
}

/**
 * Save `document`, run it to completion, and return the ids of the nodes that
 * actually executed, in the order the runner started them.
 *
 * The order comes from the run's own persisted `node_started` events, not from
 * the executor callback, so it is the durable record rather than a side effect
 * of how the test observed it.
 */
async function runAndCollect(document: WorkflowGraphDocument, requestId: string) {
  const store = new WorkflowStore();
  store.saveDefinition(PROJECT_ID, document.id, document);
  const manifest = store.createRun(PROJECT_ID, {
    workflowId: document.id,
    requestId,
    requestedBy: "api",
    input: { goal: "Lane F6 Gate B." },
  });

  const executeNode: WorkflowNodeExecutor = (context): WorkflowNodeExecutorResult => {
    // The runner refuses a success that left a declared model-call slot
    // unresolved (run-state.ts:1837-1845), so every slot the graph says the node
    // has must be answered. The slot ids are the runtime's, not invented here:
    // `agent` for an agent node, and for a kady-panel fusion node one slot per
    // member per round plus `fusion-synthesizer` (run-state.ts:874-930).
    const { node } = context;
    if (node.kind === "fusion" && node.fusion.mode === "kady-panel") {
      for (let round = 1; round <= node.fusion.rounds; round += 1) {
        for (const member of node.fusion.members) {
          context.recordModelResolution(`fusion-round-${round}-member-${member.id}`, {
            request: member.model,
            resolved: {
              provider: "ollama",
              model: "qwen3:32b",
              auth: { kind: "local" },
              reasoning: "high",
              runtime: "local",
            },
            fallbackUsed: false,
          });
        }
      }
      context.recordModelResolution("fusion-synthesizer", {
        request: node.fusion.synthesizer,
        resolved: {
          provider: "ollama",
          model: "qwen3:32b",
          auth: { kind: "local" },
          reasoning: "high",
          runtime: "local",
        },
        fallbackUsed: false,
      });
    } else {
      context.recordModelResolution("agent", modelReceipt());
    }
    return { output: `${node.id} done` };
  };

  const result = await runWorkflowDag({
    projectId: PROJECT_ID,
    runId: manifest.id,
    store,
    executeNode,
  });

  const events = store.readRunEvents(PROJECT_ID, manifest.id, { limit: 500 }).events;
  return {
    status: result.state.status,
    startedOrder: events.filter((e) => e.type === "node_started").map((e) => e.nodeId),
    succeededOrder: events.filter((e) => e.type === "node_succeeded").map((e) => e.nodeId),
    events,
  };
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("F6 row 22 — a stitched pipeline executes phase by phase", () => {
  it("completes EVERY phase-1 node before ANY phase-2 node starts", async () => {
    const { document, phases } = stitchWorkflows(
      [
        { document: twoNodeWorkflow("alpha"), sourceId: "alpha", graphSha256: "a".repeat(64) },
        { document: twoNodeWorkflow("beta"), sourceId: "beta", graphSha256: "b".repeat(64) },
      ],
      { id: "f6-composed", name: "F6 composed pipeline" },
    );

    const run = await runAndCollect(document, "f6-row22-order");

    expect(run.status).toBe("succeeded");
    expect(run.startedOrder).toEqual([
      "p1-alpha-head",
      "p1-alpha-tail",
      "p2-beta-head",
      "p2-beta-tail",
    ]);

    // The actual Gate B claim, stated as the brief states it: phase 1's nodes
    // COMPLETED before phase 2's BEGAN. Asserted on positions in the event log,
    // so it holds however many nodes each phase has.
    const phaseOne = new Set(phases[0]!.nodeIds);
    const phaseTwo = new Set(phases[1]!.nodeIds);
    const lastPhaseOneSucceeded = Math.max(
      ...run.events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === "node_succeeded" && phaseOne.has(event.nodeId!))
        .map(({ index }) => index),
    );
    const firstPhaseTwoStarted = Math.min(
      ...run.events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === "node_started" && phaseTwo.has(event.nodeId!))
        .map(({ index }) => index),
    );
    expect(lastPhaseOneSucceeded).toBeLessThan(firstPhaseTwoStarted);
  });

  it("runs the phases in the order they were stitched, not the reverse", async () => {
    // Guards against a stitch that happened to produce a valid graph with the
    // handover edge pointing the wrong way — which would still execute, and
    // would still be "phase by phase", but would be the wrong phases.
    const { document } = stitchWorkflows(
      [
        { document: twoNodeWorkflow("second"), sourceId: "second" },
        { document: twoNodeWorkflow("first"), sourceId: "first" },
      ],
      { id: "f6-order", name: "F6 order" },
    );
    const run = await runAndCollect(document, "f6-row22-direction");

    expect(run.status).toBe("succeeded");
    expect(run.startedOrder[0]).toBe("p1-second-head");
    expect(run.startedOrder.at(-1)).toBe("p2-first-tail");
  });

  it("carries meta.compositeOf through the store into the executed run", async () => {
    const { document } = stitchWorkflows(
      [
        { document: twoNodeWorkflow("alpha"), sourceId: "alpha", graphSha256: "a".repeat(64) },
        { document: twoNodeWorkflow("beta"), sourceId: "beta", graphSha256: "b".repeat(64) },
      ],
      { id: "f6-provenance", name: "F6 provenance" },
    );

    const store = new WorkflowStore();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "f6-row22-provenance",
      requestedBy: "api",
      input: { goal: "Lane F6 Gate B." },
    });

    // The manifest is what the runner executes. Provenance surviving into it is
    // what makes the record useful after the fact.
    const sources = manifest.graph.nodes.map((node) => node.meta?.compositeOf?.sourceId);
    expect(sources).toEqual(["alpha", "alpha", "beta", "beta"]);
    const hashes = new Set(
      manifest.graph.nodes.map((node) => node.meta?.compositeOf?.sourceGraphSha256),
    );
    expect(hashes).toEqual(new Set(["a".repeat(64), "b".repeat(64)]));
  });
});

describe("F6 row 25 — fusion boost changes which nodes the executor dispatches", () => {
  it("dispatches a fusion node at planning and at the verification gate when ON", async () => {
    const { document, appliedStages } = applyFusionBoost(
      twoNodeWorkflow("subject"),
      { enabled: true, stages: { planning: true, "verification-gate": true } },
    );
    expect(appliedStages).toEqual(["planning", "verification-gate"]);

    const run = await runAndCollect(document, "f6-row25-on");

    expect(run.status).toBe("succeeded");
    // The EFFECT: the fusion panel really ran, first at planning and last at the
    // verification gate. Not "the schema accepted a fusion node".
    expect(run.startedOrder).toEqual([
      FUSION_BOOST_NODE_IDS.planning,
      "subject-head",
      "subject-tail",
      FUSION_BOOST_NODE_IDS["verification-gate"],
    ]);
    expect(run.succeededOrder).toContain(FUSION_BOOST_NODE_IDS.planning);
    expect(run.succeededOrder).toContain(FUSION_BOOST_NODE_IDS["verification-gate"]);

    const executedKinds = run.startedOrder.map(
      (nodeId) => document.nodes.find((node) => node.id === nodeId)?.kind,
    );
    expect(executedKinds).toEqual(["fusion", "agent", "agent", "fusion"]);
  });

  it("dispatches NO fusion node when the toggle is off", async () => {
    const boosted = applyFusionBoost(twoNodeWorkflow("subject"), {
      enabled: true,
      stages: { planning: true, "verification-gate": true },
    }).document;
    const { document, appliedStages } = applyFusionBoost(boosted, { enabled: false, stages: {} });
    expect(appliedStages).toEqual([]);

    const run = await runAndCollect(document, "f6-row25-off");

    expect(run.status).toBe("succeeded");
    expect(run.startedOrder).toEqual(["subject-head", "subject-tail"]);
    // The negative half of the claim, and the half that actually catches a
    // control that "remembers" a value the document dropped.
    expect(run.startedOrder).not.toContain(FUSION_BOOST_NODE_IDS.planning);
    expect(run.startedOrder).not.toContain(FUSION_BOOST_NODE_IDS["verification-gate"]);
    expect(document.nodes.some((node) => node.kind === "fusion")).toBe(false);
  });

  it("dispatches ONLY the stage that was checked", async () => {
    const { document } = applyFusionBoost(twoNodeWorkflow("subject"), {
      enabled: true,
      stages: { planning: true },
    });
    const run = await runAndCollect(document, "f6-row25-planning-only");

    expect(run.status).toBe("succeeded");
    expect(run.startedOrder).toEqual([
      FUSION_BOOST_NODE_IDS.planning,
      "subject-head",
      "subject-tail",
    ]);
    expect(run.startedOrder).not.toContain(FUSION_BOOST_NODE_IDS["verification-gate"]);
  });

  it("dispatches nothing extra for a stage whose node kind does not exist", async () => {
    // elevation-to-DAG and hypothesis have no node kind in this tree. A caller
    // that bypassed the disabled checkbox must not be able to produce a run
    // that claims those stages ran.
    const { document, appliedStages } = applyFusionBoost(twoNodeWorkflow("subject"), {
      enabled: true,
      stages: { "elevation-to-dag": true, hypothesis: true },
    });
    expect(appliedStages).toEqual([]);

    const run = await runAndCollect(document, "f6-row25-absent-stages");
    expect(run.status).toBe("succeeded");
    expect(run.startedOrder).toEqual(["subject-head", "subject-tail"]);
  });
});
