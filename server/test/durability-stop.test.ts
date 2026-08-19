import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  WorkflowStore,
  workflowNodeExecutionId,
  type WorkflowGraphDocument,
  type WorkflowNode,
} from "../src/workflows/index.ts";
import {
  WorkflowRunController,
  WorkflowRunControllerError,
} from "../src/workflows/controller.ts";
import { DURABILITY_STOP_ERROR_CODE } from "../src/workflows/durability-settings.ts";

/**
 * Stop authority (#39 / N-A1) proven against the real store and the real
 * controller: who may stop, what happens to in-flight work, what terminal state
 * the run reaches, and how the stop is told apart from a failure.
 */

const PROJECT_ID = "durability-stop-test";
const controllers: WorkflowRunController[] = [];

afterEach(async () => {
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

function document(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "workflow-stop",
    name: "Stop workflow",
    entryNodeId: "writer",
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
    nodes: [agentNode("writer")],
    edges: [],
  } as unknown as WorkflowGraphDocument;
}

function createRun(store: WorkflowStore, requestId: string): string {
  const graph = document();
  store.saveDefinition(PROJECT_ID, graph.id, graph);
  return store.createRun(PROJECT_ID, {
    workflowId: graph.id,
    requestId,
    requestedBy: "api",
    input: { goal: "Exercise the durability stop." },
  }).id;
}

function idleController(store: WorkflowStore): WorkflowRunController {
  const controller = new WorkflowRunController({
    store,
    createExecutor: () => () => ({}),
  });
  controllers.push(controller);
  return controller;
}

describe("stop authority — the watcher can end a run, not only restart it", () => {
  it("stops a queued run, lands it on cancelled, and names the durability watcher", () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const runId = createRun(store, "stop-queued");
    const controller = idleController(store);

    const receipt = controller.stopRun(PROJECT_ID, runId, {
      reason: "Paused with no progress fired",
      stoppedBy: "durability-watcher",
    });

    expect(receipt).toMatchObject({
      stopped: true,
      terminalStatus: "cancelled",
      stoppedBy: "durability-watcher",
      distinguishedInRunEvents: true,
    });

    const run = store.readRun(PROJECT_ID, runId)!;
    // The stated terminal state, and NOT a failure.
    expect(run.state.status).toBe("cancelled");
    expect(run.state.lastError).toMatchObject({
      code: DURABILITY_STOP_ERROR_CODE,
      retryable: false,
    });

    const events = store.readRunEvents(PROJECT_ID, runId, { limit: 100 }).events;
    // A stop is a cancellation event, never a failure event.
    expect(events.some((event) => event.type === "run_failed")).toBe(false);
    const cancelled = events.find((event) => event.type === "run_cancelled")!;
    // …and it is told apart from a USER cancel by its error code.
    expect(cancelled.data?.error).toMatchObject({ code: DURABILITY_STOP_ERROR_CODE });
  });

  it("is distinguishable from a user cancel in the same event stream", () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const stoppedRunId = createRun(store, "stop-distinct-a");
    const cancelledRunId = createRun(store, "stop-distinct-b");
    const controller = idleController(store);

    controller.stopRun(PROJECT_ID, stoppedRunId, {
      reason: "Context rot fired",
      stoppedBy: "durability-watcher",
    });
    controller.cancel(PROJECT_ID, cancelledRunId);

    expect(store.readRun(PROJECT_ID, stoppedRunId)!.state.lastError?.code)
      .toBe(DURABILITY_STOP_ERROR_CODE);
    expect(store.readRun(PROJECT_ID, cancelledRunId)!.state.lastError?.code)
      .toBe("USER_CANCELLED");
    expect(store.readRun(PROJECT_ID, cancelledRunId)!.state.status).toBe("cancelled");
  });

  it("settles in-flight node executions rather than leaving them running", () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const runId = createRun(store, "stop-in-flight");
    const seq = () => store.readRun(PROJECT_ID, runId)!.state.lastSeq;
    store.appendRunEvent(PROJECT_ID, runId, {
      eventId: "stop-started",
      type: "run_started",
    }, seq());
    store.appendRunEvent(PROJECT_ID, runId, {
      eventId: "stop-node-started",
      type: "node_started",
      executionId: workflowNodeExecutionId(runId, "writer", 1),
      nodeId: "writer",
      attempt: 1,
      branchId: "entry",
    }, seq());
    expect(Object.values(store.readRun(PROJECT_ID, runId)!.state.executions)[0].status)
      .toBe("running");

    idleController(store).stopRun(PROJECT_ID, runId, {
      reason: "Hallucination fired",
      stoppedBy: "durability-watcher",
    });

    const run = store.readRun(PROJECT_ID, runId)!;
    expect(run.state.status).toBe("cancelled");
    expect(Object.values(run.state.executions)[0].status).toBe("interrupted");
    expect(Object.values(run.state.executions)[0].finishedAt).toBeDefined();
  });

  it("leaves nothing pending or active behind, so nothing can be orphaned", async () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const runId = createRun(store, "stop-no-orphan");
    const controller = idleController(store);

    controller.stopRun(PROJECT_ID, runId, {
      reason: "Compaction fired",
      stoppedBy: "durability-watcher",
    });

    expect(controller.snapshot()).toEqual({ pending: [], active: [] });
    await controller.waitForIdle();
    expect(controller.snapshot()).toEqual({ pending: [], active: [] });
  });

  it("refuses a stop from a terminal state, and is idempotent once stopped", () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const runId = createRun(store, "stop-terminal");
    const controller = idleController(store);

    const first = controller.stopRun(PROJECT_ID, runId, {
      reason: "Context rot fired",
      stoppedBy: "durability-watcher",
    });
    const second = controller.stopRun(PROJECT_ID, runId, {
      reason: "Context rot fired again",
      stoppedBy: "durability-watcher",
    });

    expect(first.stopped).toBe(true);
    expect(second).toMatchObject({ stopped: true, distinguishedInRunEvents: true });
    expect(store.readRunEvents(PROJECT_ID, runId, { limit: 100 }).events
      .filter((event) => event.type === "run_cancelled")).toHaveLength(1);

    expect(() =>
      controller.stopRun(PROJECT_ID, "wrun_ffffffffffffffffffffffffffffffff", {
        reason: "Missing run",
        stoppedBy: "operator",
      })
    ).toThrow(WorkflowRunControllerError);
  });

  it("requires a reason, so the timeline can always say why a run was stopped", () => {
    ensureProjectExists(PROJECT_ID);
    const store = new WorkflowStore();
    const runId = createRun(store, "stop-reason");

    expect(() =>
      idleController(store).stopRun(PROJECT_ID, runId, {
        reason: "   ",
        stoppedBy: "durability-watcher",
      })
    ).toThrow(/reason/);
  });
});
