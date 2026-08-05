import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  WorkflowRunController,
  WorkflowStore,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
  type WorkflowNodeExecutor,
} from "../src/workflows/index.ts";

const PROJECT_ID = "workflow-controller-test";

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

function graph(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "controller-workflow",
    name: "Controller workflow",
    entryNodeId: "start",
    defaultModel: exactModel(),
    limits: {
      maxIterations: 2,
      maxModelCalls: 2,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 10_000,
      maxCostUsd: 0,
      maxRetries: 0,
    },
    rescue: { enabled: false, maxAttempts: 0, triggers: [] },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [{
      id: "start",
      name: "Start",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Return a bounded result.",
    }],
    edges: [],
  };
}

function createRun(store: WorkflowStore, requestId: string) {
  store.saveDefinition(PROJECT_ID, graph().id, graph());
  return store.createRun(PROJECT_ID, {
    workflowId: graph().id,
    requestId,
    requestedBy: "api",
  });
}

function successfulExecutor(output: unknown = { ok: true }): WorkflowNodeExecutor {
  return (context) => {
    context.recordModelResolution("agent", modelReceipt());
    return { output };
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatedExecutor(gate: Promise<void>): WorkflowNodeExecutor {
  return async (context) => {
    context.recordModelResolution("agent", modelReceipt());
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(context.signal.reason ?? new Error("aborted"));
      if (context.signal.aborted) {
        onAbort();
        return;
      }
      context.signal.addEventListener("abort", onAbort, { once: true });
      gate.then(resolve, reject).finally(() => {
        context.signal.removeEventListener("abort", onAbort);
      });
    });
    return { output: { released: true } };
  };
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("workflow run controller", () => {
  it("starts a queued durable run and returns an idempotent existing record", async () => {
    const store = new WorkflowStore();
    const manifest = createRun(store, "controller-success");
    const controller = new WorkflowRunController({
      store,
      createExecutor: () => successfulExecutor(),
    });

    expect(controller.start(PROJECT_ID, manifest.id).state.status).toBe("queued");
    controller.start(PROJECT_ID, manifest.id);
    await controller.waitForIdle();
    const completed = store.readRun(PROJECT_ID, manifest.id)!;
    expect(completed.state.status).toBe("succeeded");
    expect(controller.start(PROJECT_ID, manifest.id).state.status).toBe("succeeded");
  });

  it("enforces global/project run concurrency while preserving the durable queue", async () => {
    const store = new WorkflowStore();
    const first = createRun(store, "controller-gate-first");
    const second = createRun(store, "controller-gate-second");
    const firstGate = deferred();
    const secondGate = deferred();
    const controller = new WorkflowRunController({
      store,
      maxActiveRuns: 1,
      maxActiveRunsPerProject: 1,
      createExecutor: (_projectId, runId) => gatedExecutor(
        runId === first.id ? firstGate.promise : secondGate.promise,
      ),
    });

    controller.start(PROJECT_ID, first.id);
    controller.start(PROJECT_ID, second.id);
    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({
        active: [{ runId: first.id }],
        pending: [{ runId: second.id }],
      });
    });
    expect(store.readRun(PROJECT_ID, second.id)!.state.status).toBe("queued");

    firstGate.resolve();
    await vi.waitFor(() => {
      expect(controller.snapshot().active[0]?.runId).toBe(second.id);
    });
    secondGate.resolve();
    await controller.waitForIdle();
    expect(store.readRun(PROJECT_ID, first.id)!.state.status).toBe("succeeded");
    expect(store.readRun(PROJECT_ID, second.id)!.state.status).toBe("succeeded");
  });

  it("cancels both an active run and a not-yet-started queued run", async () => {
    const store = new WorkflowStore();
    const active = createRun(store, "controller-cancel-active");
    const queued = createRun(store, "controller-cancel-queued");
    const gate = deferred();
    const controller = new WorkflowRunController({
      store,
      maxActiveRuns: 1,
      createExecutor: () => gatedExecutor(gate.promise),
    });

    controller.start(PROJECT_ID, active.id);
    controller.start(PROJECT_ID, queued.id);
    await vi.waitFor(() => {
      expect(store.readRun(PROJECT_ID, active.id)!.state.status).toBe("running");
    });
    expect(controller.cancel(PROJECT_ID, queued.id).state.status).toBe("cancelled");
    controller.cancel(PROJECT_ID, active.id);
    await controller.waitForIdle();
    expect(store.readRun(PROJECT_ID, active.id)!.state.status).toBe("cancelled");
    expect(
      store.readRunEvents(PROJECT_ID, queued.id, { limit: 10 }).events.at(-1),
    ).toMatchObject({
      type: "run_cancelled",
      data: { error: { code: "USER_CANCELLED" } },
    });
  });

  it("resumes one explicitly interrupted run without changing its identity", async () => {
    const store = new WorkflowStore();
    const manifest = createRun(store, "controller-resume");
    store.appendRunEvent(
      PROJECT_ID,
      manifest.id,
      { eventId: "manual_start", type: "run_started" },
      1,
    );
    store.appendRunEvent(
      PROJECT_ID,
      manifest.id,
      {
        eventId: "manual_interrupt",
        type: "run_interrupted",
        data: {
          previousStatus: "running",
          error: {
            code: "SERVER_RESTART",
            message: "Restarted before the first node.",
            retryable: true,
          },
        },
      },
      2,
    );
    const controller = new WorkflowRunController({
      store,
      createExecutor: () => successfulExecutor({ resumed: true }),
    });

    controller.resume(PROJECT_ID, manifest.id);
    await controller.waitForIdle();
    const resumed = store.readRun(PROJECT_ID, manifest.id)!;
    expect(resumed.manifest.id).toBe(manifest.id);
    expect(resumed.state.status).toBe("succeeded");
    expect(
      store.readRunEvents(PROJECT_ID, manifest.id, { limit: 100 }).events
        .map((event) => event.type),
    ).toContain("run_resumed");
  });

  it("persists executor-construction failures instead of leaving a false queue", async () => {
    const store = new WorkflowStore();
    const manifest = createRun(store, "controller-factory-failure");
    const errors: unknown[] = [];
    const controller = new WorkflowRunController({
      store,
      createExecutor: async () => {
        throw new Error("executor construction failed");
      },
      onError: ({ error }) => errors.push(error),
    });

    controller.start(PROJECT_ID, manifest.id);
    await controller.waitForIdle();
    const failed = store.readRun(PROJECT_ID, manifest.id)!;
    expect(failed.state.status).toBe("failed");
    expect(failed.state.lastError).toMatchObject({
      code: "WORKFLOW_CONTROLLER_FAILURE",
      retryable: true,
    });
    expect(errors).toHaveLength(1);
  });

  it("does not mutate a run owned by another live durable lease", async () => {
    const store = new WorkflowStore();
    const manifest = createRun(store, "controller-live-owner");
    const lease = store.acquireRunLease(PROJECT_ID, manifest.id);
    const errors: unknown[] = [];
    const controller = new WorkflowRunController({
      store,
      createExecutor: () => successfulExecutor(),
      onError: ({ error }) => errors.push(error),
    });

    controller.start(PROJECT_ID, manifest.id);
    await controller.waitForIdle();
    expect(store.readRun(PROJECT_ID, manifest.id)!.state.status).toBe("queued");
    expect(errors).toHaveLength(1);
    store.releaseRunLease(PROJECT_ID, lease);
  });

  it("delivers cancellation from a second controller to the durable lease owner", async () => {
    const ownerStore = new WorkflowStore();
    const cancellingStore = new WorkflowStore();
    const manifest = createRun(ownerStore, "controller-cross-process-cancel");
    const never = new Promise<void>(() => {});
    const owner = new WorkflowRunController({
      store: ownerStore,
      createExecutor: () => gatedExecutor(never),
    });
    const canceller = new WorkflowRunController({
      store: cancellingStore,
      createExecutor: () => successfulExecutor(),
    });

    owner.start(PROJECT_ID, manifest.id);
    await vi.waitFor(() => {
      expect(ownerStore.readRun(PROJECT_ID, manifest.id)!.state.status).toBe("running");
    });
    expect(canceller.cancel(PROJECT_ID, manifest.id).state.status).toBe("running");
    await owner.waitForIdle();
    expect(ownerStore.readRun(PROJECT_ID, manifest.id)!.state).toMatchObject({
      status: "cancelled",
      lastError: { code: "USER_CANCELLED", retryable: false },
    });
  });

  it("recovers expired ownership while re-enqueueing only unowned queued runs", async () => {
    let now = 10_000;
    const store = new WorkflowStore({
      now: () => now,
      randomOwnerToken: () => "d".repeat(64),
      defaultLeaseDurationMs: 1_000,
    });
    const queued = createRun(store, "controller-recovery-queued");
    const liveQueued = createRun(store, "controller-recovery-live-queued");
    const interrupted = createRun(store, "controller-recovery-interrupted");
    const expiredLease = store.acquireRunLease(PROJECT_ID, interrupted.id);
    store.appendRunEvent(PROJECT_ID, interrupted.id, {
      eventId: "recovery-running",
      type: "run_started",
    }, 1, expiredLease);
    now += 1_001;
    const liveQueuedLease = store.acquireRunLease(PROJECT_ID, liveQueued.id);
    const controller = new WorkflowRunController({
      store,
      createExecutor: () => successfulExecutor(),
    });

    const [result] = controller.recoverProjects([PROJECT_ID]);
    expect(result.interrupted).toContain(interrupted.id);
    expect(result.active).toContain(liveQueued.id);
    expect(result.enqueued).toContain(queued.id);
    await controller.waitForIdle();
    expect(store.readRun(PROJECT_ID, queued.id)!.state.status).toBe("succeeded");
    expect(store.readRun(PROJECT_ID, liveQueued.id)!.state.status).toBe("queued");
    expect(store.readRun(PROJECT_ID, interrupted.id)!.state.status).toBe("interrupted");

    store.releaseRunLease(PROJECT_ID, liveQueuedLease);
    expect(controller.recoverProjects([PROJECT_ID])[0].enqueued).toContain(liveQueued.id);
    await controller.waitForIdle();
    expect(store.readRun(PROJECT_ID, liveQueued.id)!.state.status).toBe("succeeded");
  });

  it("periodically discovers durable queued runs", async () => {
    const store = new WorkflowStore();
    const controller = new WorkflowRunController({
      store,
      createExecutor: () => successfulExecutor(),
    });
    controller.startRecoveryLoop(() => [PROJECT_ID], 10);
    const manifest = createRun(store, "controller-periodic-recovery");

    await vi.waitFor(() => {
      expect(store.readRun(PROJECT_ID, manifest.id)!.state.status).toBe("succeeded");
    });
    await controller.close();
  });

  it("interrupts active work, leaves pending work durable, and closes boundedly", async () => {
    const store = new WorkflowStore();
    const active = createRun(store, "controller-shutdown-active");
    const queued = createRun(store, "controller-shutdown-queued");
    const gate = deferred();
    const controller = new WorkflowRunController({
      store,
      maxActiveRuns: 1,
      closeGraceMs: 20,
      createExecutor: () => async (context) => {
        context.recordModelResolution("agent", modelReceipt());
        await gate.promise;
        return { output: { late: true } };
      },
    });
    controller.start(PROJECT_ID, active.id);
    controller.start(PROJECT_ID, queued.id);
    await vi.waitFor(() => {
      expect(store.readRun(PROJECT_ID, active.id)!.state.status).toBe("running");
    });

    const startedClosingAt = Date.now();
    await controller.close();
    expect(Date.now() - startedClosingAt).toBeLessThan(500);
    expect(store.readRun(PROJECT_ID, queued.id)!.state.status).toBe("queued");
    gate.resolve();
    await vi.waitFor(() => {
      expect(store.readRun(PROJECT_ID, active.id)!.state).toMatchObject({
        status: "interrupted",
        lastError: { code: "CONTROLLER_SHUTDOWN", retryable: true },
      });
    });
    expect(() => controller.start(PROJECT_ID, queued.id)).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_CLOSED" }),
    );
  });

  it("quiesces a project with durable cancellations and blocks later admission", async () => {
    const store = new WorkflowStore();
    const active = createRun(store, "controller-quiesce-active");
    const queued = createRun(store, "controller-quiesce-queued");
    const never = new Promise<void>(() => {});
    const controller = new WorkflowRunController({
      store,
      maxActiveRuns: 1,
      createExecutor: () => gatedExecutor(never),
    });
    controller.start(PROJECT_ID, active.id);
    controller.start(PROJECT_ID, queued.id);
    await vi.waitFor(() => {
      expect(store.readRun(PROJECT_ID, active.id)!.state.status).toBe("running");
    });

    const result = await controller.quiesceProject(PROJECT_ID, { graceMs: 2_000 });
    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      drained: true,
    });
    expect(new Set(result.cancellationRequested)).toEqual(new Set([active.id, queued.id]));
    expect(store.readRun(PROJECT_ID, active.id)!.state.status).toBe("cancelled");
    expect(store.readRun(PROJECT_ID, queued.id)!.state.status).toBe("cancelled");

    const late = createRun(store, "controller-quiesce-late");
    expect(() => controller.start(PROJECT_ID, late.id)).toThrowError(
      expect.objectContaining({ code: "PROJECT_QUIESCING" }),
    );
    expect(store.readRun(PROJECT_ID, late.id)!.state.status).toBe("cancelled");
    controller.releaseProjectQuiesce(PROJECT_ID);
    expect(controller.isProjectQuiescing(PROJECT_ID)).toBe(false);
  });
});
