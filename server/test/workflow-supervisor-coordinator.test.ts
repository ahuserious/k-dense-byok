import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DagFusionDelegationHostSnapshot,
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  DelegateDagFusionNodeOptions,
  OwnedDelegationV2Request,
} from "../pi-packages/dag-fusion-drive/index.ts";
import type { WorkflowDelegationSession } from "../src/agent/workflow-delegation-session.ts";
import { resolvePaths } from "../src/projects.ts";
import {
  WorkflowSupervisorCoordinator,
  WorkflowSupervisorCoordinatorError,
  type WorkflowSupervisorCoordinatorDependencies,
} from "../src/workflows/supervisor/coordinator.ts";
import { WorkflowSupervisorJournal } from "../src/workflows/supervisor/journal.ts";
import { workflowBudgetReservationId } from "../src/workflows/budget.ts";
import { createSupervisedWorkflowBudgetDescriptor } from "../src/workflows/supervised-budget.ts";
import type { SerializedHostedOpenRouterFusionRequest } from "../src/workflows/supervisor/protocol.ts";

let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-supervisor-coordinator-"));
});

afterEach(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function request(projectId = "default"): OwnedDelegationV2Request {
  return {
    version: 2,
    requestId: "dagcall_run-1_node-1_agent",
    ownerRunId: "wrun_0123456789abcdef",
    nodeId: "node-1:agent",
    agent: "dag-workflow-readonly-executor",
    task: "Analyze the supplied evidence.",
    context: "fresh",
    cwd: resolvePaths(projectId).sandbox,
    model: "openai-codex/gpt-5.4",
    thinking: "high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 12, graceTurns: 2 },
    toolBudget: { soft: 20, hard: 30, block: "*" },
    skill: false,
    artifacts: false,
    result: { kind: "text" },
  };
}

function budgetFor(ownedRequest: OwnedDelegationV2Request, projectId = "default") {
  const separator = ownedRequest.nodeId.lastIndexOf(":");
  const executionId = ownedRequest.nodeId.slice(0, separator);
  const slotId = ownedRequest.nodeId.slice(separator + 1);
  const attempt = 1;
  const provider = ownedRequest.model.split("/", 1)[0];
  return createSupervisedWorkflowBudgetDescriptor({
    reservationId: workflowBudgetReservationId(
      projectId,
      ownedRequest.ownerRunId,
      executionId,
      attempt,
      slotId,
    ),
    runId: ownedRequest.ownerRunId,
    executionId,
    attempt,
    slotId,
    provider,
    authKind: provider === "openrouter"
      ? "api-key"
      : ["ollama", "openai-compatible"].includes(provider)
        ? "local"
        : "oauth",
  });
}

function activeBudgetReservation(
  budget: ReturnType<typeof budgetFor>,
  projectId = "default",
  overrides: Partial<{
    maxCostUsd: number;
    maxTokens: number;
    modelCallCount: number;
  }> = {},
) {
  return {
    id: budget.reservationId,
    projectId,
    runId: budget.runId,
    status: "active" as const,
    expiresAt: 60_000,
    maxCostUsd: 2,
    maxTokens: 1_000,
    modelCallCount: 1,
    ...overrides,
  };
}

function hostedRequest(
  memberCount: number,
  overrides: Partial<Pick<
    SerializedHostedOpenRouterFusionRequest,
    "maxCostUsd" | "maxTokens"
  >> = {},
): SerializedHostedOpenRouterFusionRequest {
  return {
    projectId: "default",
    identity: {
      requestId: "dagfusion_run-1_fusion-node",
      ownerRunId: "wrun_0123456789abcdef",
      nodeId: "fusion-node:fusion-hosted-compound",
    },
    resolved: {
      members: Array.from({ length: memberCount }, (_, index) => ({
        memberId: `member-${index + 1}`,
      })),
    },
    maxTokens: 4_000,
    maxCostUsd: 4,
    ...overrides,
  } as unknown as SerializedHostedOpenRouterFusionRequest;
}

function hostedBudget(requested: SerializedHostedOpenRouterFusionRequest) {
  return createSupervisedWorkflowBudgetDescriptor({
    reservationId: workflowBudgetReservationId(
      requested.projectId,
      requested.identity.ownerRunId,
      "fusion-node",
      1,
      "fusion-hosted-compound",
    ),
    runId: requested.identity.ownerRunId,
    executionId: "fusion-node",
    attempt: 1,
    slotId: "fusion-hosted-compound",
    provider: "openrouter",
    authKind: "api-key",
  });
}

function usage() {
  return {
    input: 100,
    output: 40,
    cacheRead: 10,
    cacheWrite: 0,
    cost: 0.25,
    turns: 2,
    toolCalls: 0,
    durationMs: 1_200,
  };
}

function settlement(
  ownedRequest: OwnedDelegationV2Request,
  reason: DagFusionDelegationUsageSettlement["reason"] = "terminal-response",
): DagFusionDelegationUsageSettlement {
  return {
    identity: {
      requestId: ownedRequest.requestId,
      ownerRunId: ownedRequest.ownerRunId,
      nodeId: ownedRequest.nodeId,
    },
    reason,
    responseStatus: reason === "terminal-response" ? "completed" : "cancelled",
    ...(reason === "terminal-response" ? { usage: usage() } : {}),
    progress: {
      started: true,
      model: ownedRequest.model,
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function receipt(ownedRequest: OwnedDelegationV2Request): DagFusionDelegationReceipt {
  return {
    identity: {
      requestId: ownedRequest.requestId,
      ownerRunId: ownedRequest.ownerRunId,
      nodeId: ownedRequest.nodeId,
    },
    requested: {
      agent: ownedRequest.agent,
      model: ownedRequest.model,
      thinking: ownedRequest.thinking,
    },
    resolved: {
      agent: ownedRequest.agent,
      model: ownedRequest.model,
      thinking: ownedRequest.thinking,
      launchContractDigest: "a".repeat(64),
    },
    response: {
      version: 2,
      requestId: ownedRequest.requestId,
      ownerRunId: ownedRequest.ownerRunId,
      nodeId: ownedRequest.nodeId,
      status: "completed",
      agent: ownedRequest.agent,
      model: ownedRequest.model,
      thinking: ownedRequest.thinking,
      result: { kind: "text", text: "Supported." },
      usage: usage(),
    },
    usage: { ...usage(), totalTokens: 150 },
    progress: {
      started: true,
      model: ownedRequest.model,
      tokens: 150,
      toolCalls: 0,
      durationMs: 1_200,
    },
  };
}

function hostSnapshot(
  overrides: Partial<DagFusionDelegationHostSnapshot> = {},
): DagFusionDelegationHostSnapshot {
  return {
    disposed: false,
    saturated: false,
    pending: [],
    quarantined: [],
    identityFacts: 0,
    rejectedEvents: 0,
    ...overrides,
  };
}

function fakeSession(input: {
  delegate(
    request: OwnedDelegationV2Request,
    options: DelegateDagFusionNodeOptions,
  ): Promise<DagFusionDelegationReceipt>;
  snapshot?: () => DagFusionDelegationHostSnapshot;
  dispose?: () => Promise<void>;
}): WorkflowDelegationSession {
  const projectId = "default";
  return {
    projectId,
    session: {} as WorkflowDelegationSession["session"],
    host: {
      delegate: input.delegate,
      snapshot: input.snapshot ?? (() => hostSnapshot()),
    } as WorkflowDelegationSession["host"],
    disposed: false,
    snapshot() {
      return { projectId, disposed: false, host: this.host.snapshot() };
    },
    dispose: input.dispose ?? (async () => undefined),
  };
}

/**
 * A settlement that carries real observed usage but is NOT `completed`. The
 * journal permits a non-completed terminal receipt without a settlement, so
 * this is the shape that could silently drop usage.
 */
function abortedSettlementWithUsage(
  ownedRequest: OwnedDelegationV2Request,
): DagFusionDelegationUsageSettlement {
  return {
    ...settlement(ownedRequest, "caller-aborted"),
    usage: usage(),
  };
}

function coordinator(
  session: WorkflowDelegationSession,
  overrides: Partial<WorkflowSupervisorCoordinatorDependencies> = {},
  journalDirectory = path.join(temporaryRoot, "journal"),
) {
  const journal = new WorkflowSupervisorJournal({
    stateDirectory: journalDirectory,
    now: () => 1_000,
  });
  const dependencies: Partial<WorkflowSupervisorCoordinatorDependencies> = {
    pathsForProject: resolvePaths,
    getDelegationSession: async () => session,
    disposeDelegationSession: async (_projectId, options) => {
      await session.dispose(options);
    },
    delegationSessionSnapshot: async () => session.snapshot(),
    disposeAllDelegationSessions: async () => session.dispose(),
    runHostedFusion: vi.fn(),
    hostedQuarantines: () => [],
    waitHostedQuarantines: async () => undefined,
    assertNoHostedQuarantine: () => undefined,
    settleBudget: async () => undefined,
    budgetReservation: (projectId, reservationId) => {
      const ownedRequest = request(projectId);
      const budget = budgetFor(ownedRequest, projectId);
      return budget.reservationId === reservationId
        ? activeBudgetReservation(budget, projectId)
        : undefined;
    },
    reloadCredentials: async () => undefined,
    now: () => 1_000,
    ...overrides,
  };
  return {
    journal,
    coordinator: new WorkflowSupervisorCoordinator({ journal, dependencies }),
  };
}

function expectCoordinatorCode(code: string) {
  return (error: unknown): boolean => {
    expect(error).toBeInstanceOf(WorkflowSupervisorCoordinatorError);
    expect((error as WorkflowSupervisorCoordinatorError).code).toBe(code);
    return true;
  };
}

describe("workflow supervisor coordinator", () => {
  // These deliberately use `caller-aborted` — a NON-completed settlement that
  // still carries observed usage. The journal refuses a `completed` terminal
  // receipt without a completed settlement all by itself, so a completed
  // settlement would quarantine even before this fix and prove nothing. A
  // non-completed outcome is exactly what the journal used to let terminalize
  // with the usage dropped.
  it.each([
    {
      label: "the durable budget store rejects the settlement",
      failJournal: false,
    },
    {
      label: "the ownership journal rejects the settlement receipt",
      failJournal: true,
    },
  ])("quarantines rather than terminalizing when $label", async ({ failJournal }) => {
    const ownedRequest = request();
    const observed = abortedSettlementWithUsage(ownedRequest);
    const delegate = vi.fn(async (
      current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ) => {
      await options.reconcileUsage(observed);
      return receipt(current);
    });
    const harness = coordinator(fakeSession({ delegate }), failJournal ? {} : {
      settleBudget: async () => {
        throw new Error("budget store is unavailable");
      },
    });
    if (failJournal) {
      vi.spyOn(harness.journal, "recordSettlement").mockImplementation(() => {
        throw new Error("journal settlement receipt could not be published");
      });
    }
    await harness.coordinator.attach(1);

    await expect(harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-unpersisted-settlement",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    })).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));

    const record = harness.journal.list()[0];
    expect(record).toMatchObject({
      state: "quarantined",
      quarantine: { reasonCode: "DELEGATION_SETTLEMENT_UNPERSISTED" },
    });
    expect(record.terminal).toBeUndefined();
    // The obligation survives as an exact, replayable payload.
    expect(record.pendingSettlement).toMatchObject({
      status: "aborted",
      usageComplete: true,
      budget: { usage: { input: 100, output: 40, total: 140 } },
    });
    expect(record.settlement).toBeUndefined();
  });

  it("replays a prepared settlement on the next startup without redispatching work", async () => {
    const ownedRequest = request();
    const observed = abortedSettlementWithUsage(ownedRequest);
    const delegate = vi.fn(async (
      current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ) => {
      await options.reconcileUsage(observed);
      return receipt(current);
    });
    const journalDirectory = path.join(temporaryRoot, "replay-journal");
    const failing = coordinator(fakeSession({ delegate }), {
      settleBudget: async () => {
        throw new Error("budget store is unavailable");
      },
    }, journalDirectory);
    await failing.coordinator.attach(1);
    await expect(failing.coordinator.delegate({
      epoch: 1,
      messageId: "msg-replay-prepare",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    })).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));

    // A fresh supervisor over the same durable journal, as after a crash.
    const settled: Array<[string, string, unknown]> = [];
    const restarted = coordinator(fakeSession({ delegate: vi.fn() }), {
      settleBudget: async (projectId, reservationId, input) => {
        settled.push([projectId, reservationId, input]);
      },
    }, journalDirectory);

    expect(await restarted.coordinator.recoverPendingSettlements())
      .toEqual([failing.journal.list()[0].operationId]);
    expect(settled).toHaveLength(1);
    expect(settled[0][0]).toBe("default");
    expect(settled[0][1]).toBe(budgetFor(ownedRequest).reservationId);
    expect(settled[0][2]).toMatchObject({
      status: "aborted",
      usage: { input: 100, output: 40, total: 140 },
    });
    expect(restarted.journal.list()[0].settlement).toMatchObject({
      status: "aborted",
      usageComplete: true,
    });
    // Replay is accounting only: no provider work was redispatched, and the
    // ownership quarantine from the crash still stands.
    expect(restarted.journal.list()[0].state).toBe("quarantined");
    expect(await restarted.coordinator.recoverPendingSettlements()).toEqual([]);
    expect(settled).toHaveLength(1);
  });

  it("quarantines when a delegation receipt arrives after a swallowed settlement failure", async () => {
    const ownedRequest = request();
    const observed = abortedSettlementWithUsage(ownedRequest);
    // A transport that swallows the reconciliation rejection and still returns
    // a receipt must not be read as proof that usage was settled.
    const delegate = vi.fn(async (
      current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ) => {
      try {
        await options.reconcileUsage(observed);
      } catch {
        // Deliberately swallowed by the transport under test.
      }
      return receipt(current);
    });
    const harness = coordinator(fakeSession({ delegate }), {
      settleBudget: async () => {
        throw new Error("budget store is unavailable");
      },
    });
    await harness.coordinator.attach(1);

    await expect(harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-swallowed-settlement",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    })).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));

    expect(harness.journal.list()[0]).toMatchObject({
      state: "quarantined",
      quarantine: { reasonCode: "DELEGATION_SETTLEMENT_UNPERSISTED" },
    });
    expect(harness.journal.list()[0].terminal).toBeUndefined();
  });

  it.each([
    {
      label: "the durable budget store rejects it",
      failJournal: false,
    },
    {
      label: "the ownership journal rejects its receipt",
      failJournal: true,
    },
  ])("quarantines hosted Fusion whose settlement is unpersisted when $label", async ({
    failJournal,
  }) => {
    const hosted = hostedRequest(2);
    const budget = hostedBudget(hosted);
    const harness = coordinator(fakeSession({ delegate: vi.fn() }), {
      runHostedFusion: vi.fn(async (options: {
        reconcileUsage: (observed: DagFusionDelegationUsageSettlement) => Promise<void>;
      }) => {
        await options.reconcileUsage({
          identity: hosted.identity,
          reason: "caller-aborted",
          responseStatus: "cancelled",
          usage: usage(),
          progress: { started: true, tokens: 150, toolCalls: 1, durationMs: 25 },
        });
        return { text: "unreachable" };
      }),
      ...(failJournal ? {} : {
        settleBudget: async () => {
          throw new Error("budget store is unavailable");
        },
      }),
      budgetReservation: () => activeBudgetReservation(budget, "default", {
        maxTokens: 4_000,
        maxCostUsd: 4,
        modelCallCount: 4,
      }),
    });
    if (failJournal) {
      vi.spyOn(harness.journal, "recordSettlement").mockImplementation(() => {
        throw new Error("journal settlement receipt could not be published");
      });
    }
    await harness.coordinator.attach(1);

    await expect(harness.coordinator.hostedFusion({
      epoch: 1,
      messageId: "msg-hosted-unpersisted",
      projectId: "default",
      request: hosted,
      budget,
    })).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));

    const record = harness.journal.list()[0];
    expect(record).toMatchObject({
      state: "quarantined",
      quarantine: { reasonCode: "HOSTED_FUSION_SETTLEMENT_UNPERSISTED" },
    });
    expect(record.terminal).toBeUndefined();
    expect(record.pendingSettlement).toMatchObject({ status: "aborted", usageComplete: true });
    expect(record.settlement).toBeUndefined();
  });

  it("journals settlement before returning and permanently consumes an ownership identity", async () => {
    const ownedRequest = request();
    const delegate = vi.fn(async (
      current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ) => {
      await options.reconcileUsage(settlement(current));
      return receipt(current);
    });
    const harness = coordinator(fakeSession({ delegate }));
    await harness.coordinator.attach(1);

    const result = await harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-first",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    });

    expect(result.settlement.responseStatus).toBe("completed");
    expect(harness.journal.list()[0]).toMatchObject({
      state: "terminal",
      settlement: { status: "completed", usageComplete: true },
      terminal: { outcome: "completed", code: "TERMINAL_RESPONSE" },
    });
    await expect(harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-replay",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    })).rejects.toSatisfy(expectCoordinatorCode("OPERATION_FAILED"));
    expect(delegate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "tokens",
      model: "openai-codex/gpt-5.4",
      limits: { maxTokens: 1_001, maxCostUsd: 2 },
      reservation: { maxTokens: 1_000, maxCostUsd: 2 },
    },
    {
      label: "cost",
      model: "openrouter/openai/gpt-5.4",
      limits: { maxTokens: 1_000, maxCostUsd: 2.01 },
      reservation: { maxTokens: 1_000, maxCostUsd: 2 },
    },
  ])("rejects delegation $label inflation before provider dispatch", async ({
    model,
    limits,
    reservation,
  }) => {
    const ownedRequest = { ...request(), model };
    const budget = budgetFor(ownedRequest);
    const delegate = vi.fn();
    const harness = coordinator(fakeSession({ delegate }), {
      budgetReservation: () => activeBudgetReservation(budget, "default", reservation),
    });
    await harness.coordinator.attach(1);

    await expect(harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-inflated-delegation",
      projectId: "default",
      request: ownedRequest,
      limits,
      budget,
    })).rejects.toThrow("exceeded its durable budget reservation");
    expect(delegate).not.toHaveBeenCalled();
    expect(harness.journal.list()).toEqual([]);
  });

  it.each([
    {
      label: "tokens",
      memberCount: 2,
      request: { maxTokens: 4_001, maxCostUsd: 4 },
      reservation: { maxTokens: 4_000, maxCostUsd: 4, modelCallCount: 4 },
    },
    {
      label: "cost",
      memberCount: 2,
      request: { maxTokens: 4_000, maxCostUsd: 4.01 },
      reservation: { maxTokens: 4_000, maxCostUsd: 4, modelCallCount: 4 },
    },
    {
      label: "model-call",
      memberCount: 3,
      request: { maxTokens: 4_000, maxCostUsd: 4 },
      reservation: { maxTokens: 4_000, maxCostUsd: 4, modelCallCount: 4 },
    },
  ])("rejects hosted Fusion $label inflation before provider dispatch", async ({
    memberCount,
    request: requestEnvelope,
    reservation,
  }) => {
    const hosted = hostedRequest(memberCount, requestEnvelope);
    const budget = hostedBudget(hosted);
    const runHostedFusion = vi.fn();
    const harness = coordinator(fakeSession({ delegate: vi.fn() }), {
      runHostedFusion,
      budgetReservation: () => activeBudgetReservation(budget, "default", reservation),
    });
    await harness.coordinator.attach(1);

    await expect(harness.coordinator.hostedFusion({
      epoch: 1,
      messageId: "msg-inflated-hosted-fusion",
      projectId: "default",
      request: hosted,
      budget,
    })).rejects.toThrow("exceeded its durable budget reservation");
    expect(runHostedFusion).not.toHaveBeenCalled();
    expect(harness.journal.list()).toEqual([]);
  });

  it("cancels the exact old epoch and waits for its terminal settlement before reattaching", async () => {
    const started = Promise.withResolvers<void>();
    const ownedRequest = request();
    const delegate = vi.fn(async (
      current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ): Promise<DagFusionDelegationReceipt> => {
      started.resolve();
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await options.reconcileUsage(settlement(current, "caller-aborted"));
      throw Object.assign(new Error("cancelled"), { code: "DAG_FUSION_ABORTED" });
    });
    const harness = coordinator(fakeSession({ delegate }));
    await harness.coordinator.attach(1);
    const operation = harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-owned",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    });
    await started.promise;

    harness.coordinator.detach(1);
    await expect(Promise.all([
      operation.catch((error) => {
        expectCoordinatorCode("OPERATION_FAILED")(error);
      }),
      harness.coordinator.attach(2),
    ])).resolves.toBeDefined();
    expect(harness.coordinator.snapshot().attachedEpoch).toBe(2);
    expect(harness.journal.list()[0]).toMatchObject({
      state: "terminal",
      settlement: { status: "aborted" },
      terminal: { outcome: "aborted", code: "DAG_FUSION_ABORTED" },
    });
  });

  it("aborts one operation socket without cancelling another message", async () => {
    const started = Promise.withResolvers<void>();
    const ownedRequest = request();
    const delegate = vi.fn(async (
      current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ): Promise<DagFusionDelegationReceipt> => {
      started.resolve();
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await options.reconcileUsage(settlement(current, "caller-cancelled"));
      throw Object.assign(new Error("caller disconnected"), { code: "DAG_FUSION_CANCELLED" });
    });
    const harness = coordinator(fakeSession({ delegate }));
    await harness.coordinator.attach(7);
    const operation = harness.coordinator.delegate({
      epoch: 7,
      messageId: "msg-owned",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    });
    await started.promise;

    expect(harness.coordinator.cancelMessage(7, "msg-other")).toBe(false);
    expect(harness.coordinator.cancelMessage(7, "msg-owned")).toBe(true);
    await expect(operation).rejects.toSatisfy(expectCoordinatorCode("OPERATION_FAILED"));
  });

  it("quarantines an unconfirmed cancellation and rejects replacement attachment promptly", async () => {
    const started = Promise.withResolvers<void>();
    const ownedRequest = request();
    const identity = {
      requestId: ownedRequest.requestId,
      ownerRunId: ownedRequest.ownerRunId,
      nodeId: ownedRequest.nodeId,
    };
    const delegate = vi.fn(async (
      _current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ): Promise<DagFusionDelegationReceipt> => {
      started.resolve();
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("terminal acknowledgement unavailable");
    });
    const session = fakeSession({
      delegate,
      snapshot: () => hostSnapshot({ pending: [identity], quarantined: [identity] }),
      dispose: async () => {
        throw new Error("cannot prove child exit");
      },
    });
    const harness = coordinator(session);
    await harness.coordinator.attach(1);
    const operation = harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-quarantine",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    });
    await started.promise;
    harness.coordinator.detach(1);

    await expect(operation).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));
    await expect(harness.coordinator.attach(2))
      .rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));
    expect(harness.journal.list()[0]).toMatchObject({
      state: "quarantined",
      quarantine: { reasonCode: "DELEGATION_TERMINAL_UNCONFIRMED" },
    });
  });

  it("refuses shutdown after an in-flight attempt becomes quarantined without hanging its drain", async () => {
    const started = Promise.withResolvers<void>();
    const cancellationObserved = Promise.withResolvers<void>();
    const enterQuarantine = Promise.withResolvers<void>();
    const ownedRequest = request();
    const identity = {
      requestId: ownedRequest.requestId,
      ownerRunId: ownedRequest.ownerRunId,
      nodeId: ownedRequest.nodeId,
    };
    const delegate = vi.fn(async (
      _current: OwnedDelegationV2Request,
      options: DelegateDagFusionNodeOptions,
    ): Promise<DagFusionDelegationReceipt> => {
      started.resolve();
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      cancellationObserved.resolve();
      await enterQuarantine.promise;
      throw new Error("terminal acknowledgement unavailable");
    });
    const session = fakeSession({
      delegate,
      snapshot: () => hostSnapshot({ pending: [identity], quarantined: [identity] }),
      dispose: async () => {
        throw new Error("cannot prove child exit");
      },
    });
    const harness = coordinator(session);
    await harness.coordinator.attach(1);
    const operation = harness.coordinator.delegate({
      epoch: 1,
      messageId: "msg-shutdown-quarantine",
      projectId: "default",
      request: ownedRequest,
      limits: { maxTokens: 1_000, maxCostUsd: 2 },
      budget: budgetFor(ownedRequest),
    });
    await started.promise;

    const shutdown = harness.coordinator.shutdown(1);
    await cancellationObserved.promise;
    enterQuarantine.resolve();

    await expect(operation).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));
    await expect(shutdown).rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));
    expect(harness.coordinator.snapshot()).toMatchObject({
      state: "shutting-down",
      attempts: [{ state: "quarantined" }],
    });
  });

  it("releases its temporary project admission gate after deletion quiesce fails", async () => {
    const session = fakeSession({
      async delegate(current, options) {
        await options.reconcileUsage(settlement(current));
        return receipt(current);
      },
      dispose: async () => {
        throw new Error("project disposal failed");
      },
    });
    const harness = coordinator(session);
    await harness.coordinator.attach(1);

    await expect(harness.coordinator.quiesceProject(1, "default"))
      .rejects.toThrow("project disposal failed");
    expect(harness.coordinator.snapshot().quiescingProjectIds).toEqual([]);
    expect(harness.coordinator.snapshot().state).toBe("ready");
  });

  it("quiesces a clean project despite another project's quarantine while global shutdown stays blocked", async () => {
    const harness = coordinator(fakeSession({ delegate: vi.fn() }));
    await harness.coordinator.attach(1);
    harness.journal.prepare({
      operationId: "operation-project-b",
      requestDigest: "a".repeat(64),
      kind: "pi-subagent",
      projectId: "project-b",
      backendEpoch: "1",
      ownerRunId: "wrun-project-b",
      nodeId: "node-b:agent",
    });
    harness.journal.markRunning("operation-project-b", {
      ownerId: "supervisor-test",
      pid: process.pid,
      processInstanceId: "supervisor-test",
    });
    harness.journal.quarantine("operation-project-b", {
      reasonCode: "TERMINAL_UNCONFIRMED",
    });

    await expect(harness.coordinator.quiesceProject(1, "project-a"))
      .resolves.toBe(0);
    expect(harness.coordinator.snapshot().quiescingProjectIds).toEqual([]);
    await expect(harness.coordinator.shutdown(1))
      .rejects.toSatisfy(expectCoordinatorCode("SUPERVISOR_BUSY"));
  });
});
