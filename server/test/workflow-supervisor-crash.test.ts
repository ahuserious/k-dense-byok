import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DagFusionDelegationUsageSettlement,
  DelegateDagFusionNodeOptions,
  OwnedDelegationRequest,
} from "../pi-packages/dag-fusion-drive/index.ts";
import type { WorkflowDelegationSession } from "../src/agent/workflow-delegation-session.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import {
  workflowBudgetReservationId,
  workflowBudgetStore,
} from "../src/workflows/budget.ts";
import {
  createSupervisedWorkflowBudgetDescriptor,
  settleWorkflowBudgetInputForDagFusion,
} from "../src/workflows/supervised-budget.ts";
import { WorkflowSupervisorCoordinator } from "../src/workflows/supervisor/coordinator.ts";
import { WorkflowSupervisorJournal } from "../src/workflows/supervisor/journal.ts";
import {
  encodeWorkflowSupervisorRequestLine,
  parseWorkflowSupervisorResponseLine,
} from "../src/workflows/supervisor/protocol.ts";
import {
  createWorkflowSupervisorSocketServer,
  type WorkflowSupervisorSocketServer,
} from "../src/workflows/supervisor/server.ts";

const PROJECT_ID = "supervisor-crash";
const TOKEN = "a".repeat(64);
const EPOCH = 71;

let temporaryRoot: string;
let socketPath: string;
let server: WorkflowSupervisorSocketServer | undefined;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-crash-"));
  socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\kady-supervisor-crash-${process.pid}-${Date.now()}`
    : path.join(temporaryRoot, "supervisor.sock");
  createProject({ name: "Supervisor crash", projectId: PROJECT_ID, spendLimitUsd: 10 });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function delegationRequest(): OwnedDelegationRequest {
  return {
    requestId: "dagcall_supervisor_crash",
    ownerRunId: "wrun_supervisor_crash",
    nodeId: "research:agent",
    agent: "dag-workflow-readonly-executor",
    task: "Analyze evidence until cancelled.",
    context: "fresh",
    cwd: resolvePaths(PROJECT_ID).sandbox,
    model: "openrouter/anthropic/claude-sonnet-4",
    thinking: "high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 4 },
    toolBudget: { hard: 8, block: "*" },
    result: { kind: "text" },
  };
}

function cancelledSettlement(
  request: OwnedDelegationRequest,
): DagFusionDelegationUsageSettlement {
  return {
    identity: {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
    },
    reason: "caller-aborted",
    responseStatus: "cancelled",
    usage: {
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 0,
      cost: 0.25,
      turns: 2,
      toolCalls: 0,
      durationMs: 1_200,
    },
    progress: {
      started: true,
      model: request.model,
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readOneResponse(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const newlineAt = bytes.indexOf(0x0a);
      if (newlineAt < 0) return;
      cleanup();
      try {
        const response = parseWorkflowSupervisorResponseLine(
          bytes.subarray(0, newlineAt + 1),
        );
        if (!response.ok) throw new Error(response.error.code);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for crash reconciliation.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("workflow supervisor backend-crash ownership", () => {
  it("cancels a disconnected backend and settles budget before terminal journaling", async () => {
    const request = delegationRequest();
    const reservationId = workflowBudgetReservationId(
      PROJECT_ID,
      request.ownerRunId,
      "research",
      1,
      "agent",
    );
    await workflowBudgetStore.reserve({
      projectId: PROJECT_ID,
      reservationId,
      runId: request.ownerRunId,
      runMaxCostUsd: 2,
      runMaxTokens: 1_000,
      runMaxModelCalls: 1,
      modelCallCount: 1,
      maxCostUsd: 2,
      maxTokens: 1_000,
    });
    const budget = createSupervisedWorkflowBudgetDescriptor({
      reservationId,
      runId: request.ownerRunId,
      executionId: "research",
      attempt: 1,
      slotId: "agent",
      provider: "openrouter",
      authKind: "api-key",
    });
    const started = Promise.withResolvers<void>();
    const ordering: string[] = [];
    const session: WorkflowDelegationSession = {
      projectId: PROJECT_ID,
      session: {} as WorkflowDelegationSession["session"],
      host: {
        delegate: async (
          current: OwnedDelegationRequest,
          options: DelegateDagFusionNodeOptions,
        ) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await options.reconcileUsage(cancelledSettlement(current));
          ordering.push("delegation-reconciled");
          throw Object.assign(new Error("backend disconnected"), {
            code: "DAG_FUSION_ABORTED",
          });
        },
        snapshot: () => ({
          disposed: false,
          saturated: false,
          pending: [],
          quarantined: [],
          identityFacts: 0,
          rejectedEvents: 0,
        }),
      } as WorkflowDelegationSession["host"],
      disposed: false,
      snapshot() {
        return { projectId: PROJECT_ID, disposed: false, host: this.host.snapshot() };
      },
      dispose: async () => undefined,
    };
    const journal = new WorkflowSupervisorJournal({
      stateDirectory: path.join(temporaryRoot, "journal"),
    });
    const originalRecordSettlement = journal.recordSettlement.bind(journal);
    vi.spyOn(journal, "recordSettlement").mockImplementation((id, input) => {
      ordering.push("journal-settlement");
      return originalRecordSettlement(id, input);
    });
    const coordinator = new WorkflowSupervisorCoordinator({
      journal,
      dependencies: {
        pathsForProject: resolvePaths,
        getDelegationSession: async () => session,
        disposeDelegationSession: async () => session.dispose(),
        delegationSessionSnapshot: async () => session.snapshot(),
        disposeAllDelegationSessions: async () => session.dispose(),
        runHostedFusion: vi.fn(),
        hostedQuarantines: () => [],
        waitHostedQuarantines: async () => undefined,
        assertNoHostedQuarantine: () => undefined,
        settleBudget: async (projectId, reservationId, input) => {
          // The intent is journalled before it is applied, so the replayable
          // record exists here while the settlement receipt does not yet.
          expect(journal.list()[0].pendingSettlement).toBeDefined();
          expect(journal.list()[0].settlement).toBeUndefined();
          await workflowBudgetStore.settle(projectId, reservationId, input);
          ordering.push("budget-durable");
        },
        reloadCredentials: async () => undefined,
      },
    });
    server = createWorkflowSupervisorSocketServer({
      socketPath,
      token: TOKEN,
      coordinator,
    });
    await server.listen();

    const control = await connect();
    const attached = readOneResponse(control);
    control.write(encodeWorkflowSupervisorRequestLine({
      version: 1,
      messageId: "msg-control-crash",
      token: TOKEN,
      op: "attach",
      epoch: EPOCH,
    }));
    await attached;

    const operation = await connect();
    operation.write(encodeWorkflowSupervisorRequestLine({
      version: 1,
      messageId: "msg-operation-crash",
      token: TOKEN,
      op: "delegate",
      epoch: EPOCH,
      projectId: PROJECT_ID,
      request,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget,
    }));
    await started.promise;

    // A hard backend exit drops both its long-lived control lease and the
    // in-flight one-shot operation socket without receiving any IPC response.
    control.destroy();
    operation.destroy();

    await waitUntil(() => journal.list()[0]?.state === "terminal");
    const reservation = workflowBudgetStore.list(PROJECT_ID)[0];
    expect(reservation).toMatchObject({
      id: reservationId,
      status: "aborted",
      settlement: {
        usageComplete: true,
        chargedCostUsd: 0.25,
        observedUsage: { input: 100, output: 40, total: 140 },
      },
    });
    expect(journal.list()[0]).toMatchObject({
      state: "terminal",
      settlement: { status: "aborted", usageComplete: true },
      terminal: { outcome: "aborted", code: "DAG_FUSION_ABORTED" },
    });
    expect(ordering).toEqual([
      "budget-durable",
      "journal-settlement",
      "delegation-reconciled",
    ]);
    expect(coordinator.snapshot().attachedEpoch).toBeNull();
    await expect(coordinator.attach(EPOCH + 1)).resolves.toBeUndefined();
  });
});
