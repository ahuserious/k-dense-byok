import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildApp,
  type BuildAppOptions,
} from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import type { WorkflowSupervisorSnapshot } from "../src/workflows/supervisor/protocol.ts";

const snapshots: WorkflowSupervisorSnapshot[] = [];

function snapshot(state: WorkflowSupervisorSnapshot["state"] = "ready") {
  return {
    pid: 42,
    state,
    attachedEpoch: 7,
    quiescingProjectIds: [],
    attempts: [],
  } satisfies WorkflowSupervisorSnapshot;
}

function supervisor(
  overrides: Partial<NonNullable<BuildAppOptions["workflowSupervisor"]>> = {},
): NonNullable<BuildAppOptions["workflowSupervisor"]> {
  return {
    nodeExecutorDependencies: () => ({
      getDelegationSession: async () => {
        throw new Error("not used");
      },
      runHostedFusion: async () => {
        throw new Error("not used");
      },
    }),
    quiesceProject: async (projectId) => ({
      projectId,
      quiescent: true,
      cancelledAttempts: 0,
    }),
    reloadCredentials: async (keys) => [...keys],
    snapshot: async () => snapshot(),
    shutdown: async () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  snapshots.length = 0;
});

afterEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("workflow supervisor app lifecycle wiring", () => {
  it("captures remote ownership before asking the detached owner to stop", async () => {
    const events: string[] = [];
    const workflowSupervisor = supervisor({
      snapshot: async () => {
        events.push("snapshot");
        return snapshot();
      },
      shutdown: async (reason) => {
        events.push(`shutdown:${reason}`);
      },
    });
    const app = await buildApp({
      workflowController: null,
      workflowSupervisor,
      onWorkflowSupervisorSnapshot: (current) => snapshots.push(current),
    });

    await app.close();

    expect(events).toEqual(["snapshot", "shutdown:backend-shutdown"]);
    expect(snapshots).toEqual([snapshot()]);
  });

  it("retains the failed supervisor lease and refreshes remote diagnostics", async () => {
    const snapshotCall = vi.fn()
      .mockResolvedValueOnce(snapshot("quiescing"))
      .mockResolvedValueOnce({
        ...snapshot("quiescing"),
        attempts: [{
          messageId: "msg-owned",
          projectId: "default",
          kind: "delegate" as const,
          identity: {
            requestId: "dagcall-owned",
            ownerRunId: "wrun-owned",
            nodeId: "node:agent",
          },
          state: "quarantined" as const,
          startedAt: 1,
        }],
      });
    const shutdown = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("hidden provider detail"), {
        code: "SUPERVISOR_BUSY",
      }))
      .mockResolvedValueOnce(undefined);
    const workflowSupervisor = supervisor({
      snapshot: snapshotCall,
      shutdown,
    });
    const app = await buildApp({
      workflowController: null,
      workflowSupervisor,
      onWorkflowSupervisorSnapshot: (current) => snapshots.push(current),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    await expect(app.close()).rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });

    expect(app.server.listening).toBe(true);
    const health = await fetch(`${address}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(snapshotCall).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.attempts).toHaveLength(1);
    expect(snapshots.at(-1)?.attempts[0].state).toBe("quarantined");

    await app.close();
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("does not stop an already-terminated supervisor again when Fastify cleanup is retried", async () => {
    const workflowSupervisor = supervisor({
      snapshot: vi.fn(async () => snapshot()),
      shutdown: vi.fn(async () => undefined),
    });
    const app = await buildApp({
      workflowController: null,
      workflowSupervisor,
      onWorkflowSupervisorSnapshot: () => undefined,
    });
    const cleanupFailure = new Error("one cleanup hook failed");
    app.addHook("onClose", async () => {
      throw cleanupFailure;
    });

    await expect(app.close()).rejects.toBe(cleanupFailure);
    await expect(app.close()).resolves.toBeUndefined();

    expect(workflowSupervisor.shutdown).toHaveBeenCalledTimes(1);
    expect(workflowSupervisor.snapshot).toHaveBeenCalledTimes(1);
  });
});
