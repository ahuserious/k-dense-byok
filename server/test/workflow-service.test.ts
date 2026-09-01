import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import type { DagFusionDelegationUsageSettlement } from "../pi-packages/dag-fusion-drive/index.ts";
import {
  listWorkflowBudgetReservations,
  workflowBudgetReservationId,
  type ReserveWorkflowBudgetInput,
  type WorkflowBudgetReservationHandle,
} from "../src/workflows/budget.ts";
import type {
  KadyWorkflowUsageAdmission,
  TrustedLeanVerifier,
} from "../src/workflows/kady-node-executor.ts";
import {
  WORKFLOW_BUDGET_SETTLEMENT_GRACE_MS,
  createProductionWorkflowController,
  createProductionWorkflowUsageReserver,
  workflowControllerErrorLogFields,
} from "../src/workflows/service.ts";

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
}

beforeEach(resetProjects);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

function admission(options: {
  provider?: string;
  authKind?: "api-key" | "oauth" | "local" | "custom";
  runtime?: "pi" | "local" | "custom";
  slotId?: string;
  maxCostUsd?: number;
  timeoutMs?: number;
} = {}): KadyWorkflowUsageAdmission {
  const provider = options.provider ?? "openrouter";
  const authKind = options.authKind ?? "api-key";
  const runtime = options.runtime ?? "pi";
  const slotId = options.slotId ?? "agent";
  return {
    projectId: "default",
    runId: "dagrun_service_test",
    workflowId: "service-test",
    nodeId: "node-a",
    executionId: "dagx_service_test",
    attempt: 1,
    slotId,
    modelReceipt: {
      request: {
        requested: {
          source: "fixed",
          provider,
          model: "model-a",
          auth: { kind: authKind },
          reasoning: "high",
        },
        resolution: { mode: "exact" },
      },
      resolved: {
        provider,
        model: "model-a",
        auth: { kind: authKind },
        reasoning: "high",
        runtime,
      },
      fallbackUsed: false,
    },
    maxTokens: 4_000,
    maxCostUsd: options.maxCostUsd ?? 2,
    modelCallCount: 1,
    runMaxTokens: 40_000,
    runMaxCostUsd: 20,
    runMaxModelCalls: 10,
    timeoutMs: options.timeoutMs ?? 5_000,
  };
}

function settlement(
  item: KadyWorkflowUsageAdmission,
  options: Partial<DagFusionDelegationUsageSettlement> = {},
): DagFusionDelegationUsageSettlement {
  return {
    identity: {
      requestId: "dagcall_service_test",
      ownerRunId: item.runId,
      nodeId: `${item.executionId}:${item.slotId}`,
    },
    reason: "terminal-response",
    responseStatus: "completed",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.25,
      turns: 1,
      toolCalls: 0,
      durationMs: 100,
    },
    progress: {
      started: true,
      model: `${item.modelReceipt.resolved.provider}/${item.modelReceipt.resolved.model}`,
      tokens: 15,
      toolCalls: 0,
      durationMs: 100,
    },
    ...options,
  };
}

function fakeBudgetHandle(
  settle = vi.fn(async () => ({} as never)),
): WorkflowBudgetReservationHandle {
  return {
    record: {} as never,
    settle,
    renew: vi.fn(async () => ({} as never)),
  };
}

describe("production workflow usage reservations", () => {
  it("durably reserves the deterministic call identity before returning dispatch admission", async () => {
    const events: string[] = [];
    let captured: ReserveWorkflowBudgetInput | undefined;
    const reserveBudget = vi.fn(async (input: ReserveWorkflowBudgetInput) => {
      events.push("reserve");
      captured = input;
      return fakeBudgetHandle();
    });
    const item = admission();
    const reserveUsage = createProductionWorkflowUsageReserver({ reserveBudget });

    const reservation = await reserveUsage(item);
    events.push("dispatch");

    expect(events).toEqual(["reserve", "dispatch"]);
    expect(reservation.reconcile).toBeTypeOf("function");
    expect(captured).toEqual({
      projectId: item.projectId,
      reservationId: workflowBudgetReservationId(
        item.projectId,
        item.runId,
        item.executionId,
        item.attempt,
        item.slotId,
      ),
      runId: item.runId,
      runMaxCostUsd: item.runMaxCostUsd,
      runMaxTokens: item.runMaxTokens,
      runMaxModelCalls: item.runMaxModelCalls,
      maxCostUsd: item.maxCostUsd,
      maxTokens: item.maxTokens,
      modelCallCount: item.modelCallCount,
      leaseDurationMs: item.timeoutMs + WORKFLOW_BUDGET_SETTLEMENT_GRACE_MS,
    });
  });

  it("charges the reserved maximum when terminal usage is missing", async () => {
    const item = admission({ maxCostUsd: 1.75 });
    const reserveUsage = createProductionWorkflowUsageReserver();
    const reservation = await reserveUsage(item);

    await reservation.reconcile(settlement(item, {
      reason: "protocol-error",
      responseStatus: undefined,
      usage: undefined,
      progress: { started: true, tokens: 0, toolCalls: 0, durationMs: 50 },
    }));

    const [record] = listWorkflowBudgetReservations("default");
    expect(record.status).toBe("failed");
    expect(record.settlement).toMatchObject({
      usageComplete: false,
      chargedCostUsd: 1.75,
      reason: "dag-fusion:protocol-error:no-response:usage-missing",
    });
  });

  it.each([
    ["ollama", "local", "local"],
    ["openai-compatible", "custom", "custom"],
    ["openai-codex", "oauth", "pi"],
    ["github-copilot", "oauth", "pi"],
    ["xai", "oauth", "pi"],
  ] as const)(
    "reserves and settles %s non-cap-counted calls at zero dollars",
    async (provider, authKind, runtime) => {
      const settleBudget = vi.fn(async () => ({} as never));
      const reserveBudget = vi.fn(async () => fakeBudgetHandle(settleBudget));
      const item = admission({ provider, authKind, runtime, slotId: provider });
      const reservation = await createProductionWorkflowUsageReserver({
        reserveBudget,
      })(item);

      await reservation.reconcile(settlement(item));

      expect(reserveBudget).toHaveBeenCalledWith(expect.objectContaining({
        maxCostUsd: 0,
      }));
      expect(settleBudget).toHaveBeenCalledWith(expect.objectContaining({
        status: "completed",
        usage: expect.objectContaining({
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          total: 15,
          cost: 0,
        }),
      }));
    },
  );

  it("keeps Anthropic OAuth metered usage inside the project cap", async () => {
    const settleBudget = vi.fn(async () => ({} as never));
    const reserveBudget = vi.fn(async () => fakeBudgetHandle(settleBudget));
    const item = admission({ provider: "anthropic", authKind: "oauth" });
    const reservation = await createProductionWorkflowUsageReserver({
      reserveBudget,
    })(item);

    await reservation.reconcile(settlement(item));

    expect(reserveBudget).toHaveBeenCalledWith(expect.objectContaining({
      maxCostUsd: 2,
    }));
    expect(settleBudget).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ cost: 0.25 }),
    }));
  });

  it("reconciles the same terminal receipt idempotently", async () => {
    const item = admission({ maxCostUsd: 1 });
    const reservation = await createProductionWorkflowUsageReserver()(item);
    const terminal = settlement(item);

    await reservation.reconcile(terminal);
    await reservation.reconcile(terminal);

    const [record] = listWorkflowBudgetReservations("default");
    expect(record.status).toBe("completed");
    expect(record.settlement).toMatchObject({
      usageComplete: true,
      chargedCostUsd: 0.25,
      incrementalUsage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        total: 15,
        costUsd: 0.25,
      },
    });
  });
});

describe("production workflow controller composition", () => {
  it("injects the durable reserver and trusted Lean verifier into its node runtime", () => {
    const leanVerifier: TrustedLeanVerifier = vi.fn(async () => ({
      status: "verified",
      summary: "verified",
    }));
    const executeNode = vi.fn(async () => ({ output: { ok: true } }));
    const nodeExecutorFactory = vi.fn(() => executeNode);
    const controller = createProductionWorkflowController({
      leanVerifier,
      nodeExecutorFactory,
      reserveBudget: vi.fn(async () => fakeBudgetHandle()),
    });

    expect(controller.snapshot()).toEqual({ pending: [], active: [] });
    expect(nodeExecutorFactory).toHaveBeenCalledWith({
      reserveUsage: expect.any(Function),
      verifyLean: leanVerifier,
    });
  });

  it("returns credential-safe controller error log fields", () => {
    const error = Object.assign(
      new Error("OPENROUTER_API_KEY=secret-value"),
      { code: "WORKFLOW_MODEL_FAILURE", cause: "secret-cause" },
    );
    expect(workflowControllerErrorLogFields(error)).toEqual({
      errorName: "Error",
      errorCode: "WORKFLOW_MODEL_FAILURE",
    });
    expect(JSON.stringify(workflowControllerErrorLogFields(error))).not.toContain("secret");
  });
});
