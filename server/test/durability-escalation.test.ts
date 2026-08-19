import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  WorkflowStore,
  workflowNodeExecutionId,
  type WorkflowGraphDocument,
  type WorkflowNode,
} from "../src/workflows/index.ts";
import { WorkflowRunController } from "../src/workflows/controller.ts";
import { ContextEngineeringProduction } from
  "../src/workflows/context-watcher-production.ts";
import { MemoryDurabilityJournal } from "../src/workflows/durability-journal.ts";
import {
  MemoryDurabilitySettingsStore,
  defaultDurabilitySettings,
} from "../src/workflows/durability-settings.ts";

/**
 * Row 24, the load-bearing test.
 *
 * A REAL run, with a REAL failing node, observed by the REAL durability
 * watcher, escalated through the REAL lateral-pass and escalate-fix-redeploy
 * behaviors, against the REAL workflow store and the REAL run controller. The
 * only stub is `completeJson` — the provider boundary. Everything above it,
 * including the compare-and-swap definition save, the replacement run creation,
 * the restart-proof check, and the controller's execution of the replacement,
 * is the production path.
 */

const PROJECT_ID = "durability-escalation-test";
const RESCUE_REF = "openrouter/openai/gpt-5.6-luna-pro";

const productions: ContextEngineeringProduction[] = [];
const controllers: WorkflowRunController[] = [];

afterEach(async () => {
  for (const production of productions.splice(0)) production.close();
  for (const controller of controllers.splice(0)) await controller.close({ graceMs: 200 });
  fs.rmSync(path.join(PROJECTS_ROOT, PROJECT_ID), { recursive: true, force: true });
});

function modelRequest() {
  return {
    requested: {
      source: "fixed" as const,
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" as const },
      reasoning: "high" as const,
    },
    resolution: { mode: "exact" as const },
  };
}

function modelReceipt() {
  return {
    request: modelRequest(),
    resolved: {
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "high" as const,
      runtime: "local" as const,
    },
    fallbackUsed: false,
  };
}

function leanNode(): WorkflowNode {
  return {
    id: "lean-proof",
    name: "Lean proof",
    kind: "lean4",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    goal: "Verify the theorem.",
    theorem: "theorem reflexive (n : Nat) : n = n := rfl",
    mode: "verify",
    mathlib: false,
    skill: "byom-dag-fusion",
  } as unknown as WorkflowNode;
}

function agentNode(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: "agent",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: `Execute ${id}.`,
  } as unknown as WorkflowNode;
}

function document(nodes: WorkflowNode[], name: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "workflow-durability",
    name,
    entryNodeId: nodes[0].id,
    defaultModel: modelRequest(),
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
    nodes,
    edges: [],
  } as unknown as WorkflowGraphDocument;
}

/** Drive a real run to "a script node failed and the run was interrupted". */
function induceScriptFailure(store: WorkflowStore): string {
  const original = document([leanNode()], "Durability workflow");
  store.saveDefinition(PROJECT_ID, original.id, original);
  const manifest = store.createRun(PROJECT_ID, {
    workflowId: original.id,
    requestId: "durability-escalation-source",
    requestedBy: "api",
    input: { goal: "Verify the theorem." },
  });
  const executionId = workflowNodeExecutionId(manifest.id, "lean-proof", 1);
  const identity = {
    executionId,
    nodeId: "lean-proof",
    attempt: 1,
    branchId: "entry",
  };
  const seq = () => store.readRun(PROJECT_ID, manifest.id)!.state.lastSeq;
  store.appendRunEvent(PROJECT_ID, manifest.id, {
    eventId: "durability-started",
    type: "run_started",
  }, seq());
  store.appendRunEvent(PROJECT_ID, manifest.id, {
    eventId: "durability-node-started",
    type: "node_started",
    ...identity,
  }, seq());
  store.appendRunEvent(PROJECT_ID, manifest.id, {
    eventId: "durability-node-failed",
    type: "node_failed",
    ...identity,
    data: {
      error: { code: "LEAN_EXIT_1", message: "The proof script exited 1.", retryable: true },
      routeCondition: "failure",
    },
  }, seq());
  store.appendRunEvent(PROJECT_ID, manifest.id, {
    eventId: "durability-interrupted",
    type: "run_interrupted",
    data: {
      previousStatus: "running",
      error: { code: "RUN_INTERRUPTED", message: "The run stopped after the script failed.", retryable: true },
    },
  }, seq());
  return manifest.id;
}

describe("row 24 — an induced failure escalates to the rescue model and the run continues", () => {
  it("repairs the DAG at the operator's rescue model and starts the replacement run", async () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const sourceRunId = induceScriptFailure(store);
    expect(store.readRun(PROJECT_ID, sourceRunId)!.state.status).toBe("interrupted");

    const executed: string[] = [];
    const controller = new WorkflowRunController({
      store,
      createExecutor: () => (context) => {
        executed.push(context.node.id);
        context.recordModelResolution("agent", modelReceipt());
        return {};
      },
    });
    controllers.push(controller);

    // The provider boundary, and the ONLY stub in this test. It records what
    // the server actually asked for.
    const completeJson = vi.fn().mockImplementation(
      async (call: { model: string; instruction: string }) => {
        if (call.instruction.startsWith("Repair the supplied WorkflowGraphDocument")) {
          // The repair call: the larger model returns a repaired graph.
          return document([agentNode("repaired-writer")], "Durability workflow (repaired)");
        }
        return {
          summary: "The Lean proof node exited 1.",
          goal: "Verify the theorem.",
          openTodos: ["Repair the proof node"],
          decisions: ["Escalate to the rescue model"],
          constraints: ["Preserve the original goal"],
        };
      },
    );

    const settings = new MemoryDurabilitySettingsStore();
    settings.write(PROJECT_ID, {
      ...defaultDurabilitySettings(),
      enabled: true,
      rescueModel: { kind: "direct", ref: RESCUE_REF, effort: "xhigh" },
      signals: {
        ...defaultDurabilitySettings().signals,
        "failed-script-run": { enabled: true, action: "escalate", threshold: 1 },
      },
    });
    const journal = new MemoryDurabilityJournal();
    const production = new ContextEngineeringProduction(controller, {
      store,
      completeJson,
      durabilitySettings: settings,
      durabilityJournal: journal,
    });
    productions.push(production);

    const observations = await production
      .forProject(PROJECT_ID)
      .durability.observeProject();

    const fires = observations.flatMap((observation) => observation.fires);
    expect(fires.map((fire) => fire.signal)).toContain("failed-script-run");
    expect(fires.every((fire) => fire.dispatched)).toBe(true);

    // 1. The rescue model, with its effort, reached the provider call.
    const models = completeJson.mock.calls.map((call) => call[0].model);
    expect(models).toContain(`${RESCUE_REF}-xhigh`);
    expect(models.filter((model) => model === `${RESCUE_REF}-xhigh`)).toHaveLength(2);

    // 2. The DAG was really repaired: a new definition revision exists, and it
    //    is the repaired graph, not the failing one.
    const repaired = store.readDefinition(PROJECT_ID, "workflow-durability")!;
    expect(repaired.revision).toBe(2);
    expect(repaired.graph.nodes.map((node) => node.id)).toEqual(["repaired-writer"]);

    // 3. The run continued: a replacement run exists, it points back at the
    //    failing run, and the controller executed it to completion.
    const replacement = store.listRuns(PROJECT_ID, 20)
      .find((run) => run.manifest.id !== sourceRunId);
    expect(replacement).toBeDefined();
    expect(replacement!.manifest.input.variables?._kadyContextRepair)
      .toMatchObject({ sourceRunId, workflowRevision: 2 });

    await controller.waitForIdle();
    expect(executed).toEqual(["repaired-writer"]);
    expect(store.readRun(PROJECT_ID, replacement!.manifest.id)!.state.status).toBe("succeeded");

    // 4. The timeline says the escalation happened, and names the model.
    const timeline = journal.read(PROJECT_ID, sourceRunId, { limit: 200 }).events;
    expect(timeline.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "durability.signal.fired",
        "durability.escalation.started",
        "durability.escalation.completed",
      ]),
    );
    expect(
      timeline.find((entry) => entry.name === "durability.escalation.started")!.model,
    ).toBe(RESCUE_REF);
  });

  it("leaves the run exactly as it was when the rescue model does not resolve", async () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const sourceRunId = induceScriptFailure(store);
    const before = store.readRun(PROJECT_ID, sourceRunId)!;

    const controller = new WorkflowRunController({
      store,
      createExecutor: () => () => ({}),
    });
    controllers.push(controller);
    const completeJson = vi.fn();
    const settings = new MemoryDurabilitySettingsStore();
    settings.write(PROJECT_ID, {
      ...defaultDurabilitySettings(),
      enabled: true,
      // The shipped default: the owner's "GPT-5.6 Pro" resolves to three ids.
      signals: {
        ...defaultDurabilitySettings().signals,
        "failed-script-run": { enabled: true, action: "escalate", threshold: 1 },
      },
    });
    const journal = new MemoryDurabilityJournal();
    const production = new ContextEngineeringProduction(controller, {
      store,
      completeJson,
      durabilitySettings: settings,
      durabilityJournal: journal,
    });
    productions.push(production);

    const observations = await production.forProject(PROJECT_ID).durability.observeProject();
    const fire = observations.flatMap((observation) => observation.fires)[0];

    expect(fire.dispatched).toBe(false);
    expect(fire.detail).toContain("GPT-5.6 Pro");
    expect(completeJson).not.toHaveBeenCalled();
    // No new definition revision, no replacement run, no state change.
    expect(store.readDefinition(PROJECT_ID, "workflow-durability")!.revision).toBe(1);
    expect(store.listRuns(PROJECT_ID, 20)).toHaveLength(1);
    const after = store.readRun(PROJECT_ID, sourceRunId)!;
    expect(after.state.status).toBe(before.state.status);
    expect(after.state.lastSeq).toBe(before.state.lastSeq);
    expect(journal.read(PROJECT_ID, sourceRunId, { limit: 50 }).events.map((e) => e.name))
      .toContain("durability.model.unresolved");
  });
});
