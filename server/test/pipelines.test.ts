import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pipelineEngine from "../src/agent/pipeline-engine/client.ts";
import {
  pipelineNodeBudgetHooks,
  registerPipelineRoutes,
  unresolvedPipelineNodeBudgetHooks,
} from "../src/api/pipelines.ts";
import { createProject, getProject } from "../src/projects.ts";
import {
  recoverPipelineAdmission,
} from "../src/workflows/budget.ts";

const FIXED_MODEL = {
  requested: {
    source: "fixed",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    auth: { kind: "api-key" },
    reasoning: "off",
  },
  resolution: { mode: "exact" },
} as const;

const resolveRealEngineHooks: typeof pipelineNodeBudgetHooks = (definition, context) =>
  pipelineNodeBudgetHooks(definition, context, async () => ({
    receipt: {
      resolved: {
        provider: "openrouter",
        auth: { kind: "api-key" },
      },
    },
  } as never));

function realEngineWorkflow(settings: Record<string, unknown>) {
  return {
    workflow: {
      name: "research",
      limits: { maxTokens: 10_000, maxCostUsd: 10 },
      nodes: [{ id: "search", prompt: "Search", settings }],
    },
    filename: "research.yaml",
    source: "project",
  };
}

describe("Tier A S4 pipeline NodeSpec extraction", () => {
  it("round-trips the settings-bearing engine getWorkflow shape", () => {
    const definition = JSON.parse(JSON.stringify(realEngineWorkflow({
      model: FIXED_MODEL,
      billingMode: "api",
      budget: { maxTokens: 2_000, maxCostUsd: 1.5 },
    })));
    expect(unresolvedPipelineNodeBudgetHooks(definition)).toEqual([{
      nodeId: "search",
      maxTokens: 2_000,
      maxCostUsd: 1.5,
      declaredBillingMode: "api",
      modelRequest: FIXED_MODEL,
    }]);
  });

  it.each([
    { settings: { model: FIXED_MODEL }, message: /settings\.budget/ },
    {
      settings: { model: FIXED_MODEL, budget: { maxTokens: 100 } },
      message: /budget\.maxCostUsd/,
    },
    {
      settings: { model: FIXED_MODEL, budget: { maxTokens: 0, maxCostUsd: 1 } },
      message: /budget\.maxTokens/,
    },
    {
      settings: { budget: { maxTokens: 100, maxCostUsd: 1 } },
      message: /settings\.model/,
    },
  ])("fails closed when an executable node has no extractable hook", ({ settings, message }) => {
    expect(() => unresolvedPipelineNodeBudgetHooks(realEngineWorkflow(settings))).toThrow(message);
  });

  it("rejects a declared billing mode that contradicts resolved provider auth", async () => {
    const definition = realEngineWorkflow({
      model: FIXED_MODEL,
      billingMode: "subscription",
      budget: { maxTokens: 100, maxCostUsd: 1 },
    });
    await expect(pipelineNodeBudgetHooks(
      definition,
      { projectId: "default", sessionId: "session" },
      async () => ({
        receipt: {
          resolved: {
            provider: "openrouter",
            auth: { kind: "api-key" },
          },
        },
      } as never),
    )).rejects.toThrow(/resolved openrouter\/api_key is payg/);
  });
});

describe("Tier A S4 pipeline route admission and reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    if (!getProject("default")) {
      createProject({ name: "Default", projectId: "default", spendLimitUsd: 20 });
    }
  });

  it("persists async-start ownership, recovers after restart, and records actual overruns idempotently", async () => {
    const workflow = realEngineWorkflow({
      model: FIXED_MODEL,
      billingMode: "api",
      budget: { maxTokens: 2_000, maxCostUsd: 1.5 },
    });
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(workflow);
    let submittedBody: Record<string, unknown> | undefined;
    vi.spyOn(pipelineEngine, "runWorkflow").mockImplementation(async (_name, body) => {
      submittedBody = body as Record<string, unknown>;
      return { accepted: true, status: "started" };
    });

    const app = Fastify();
    await registerPipelineRoutes(app, {
      resolveBudgetHooks: resolveRealEngineHooks,
    });
    const start = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "conversation-1", message: "Run research" },
    });
    expect(start.statusCode).toBe(200);
    const startBody = start.json<{ accepted: boolean; kadyAdmissionId: string }>();
    expect(startBody.accepted).toBe(true);
    expect(startBody.kadyAdmissionId).toMatch(/^kadypipe_[a-f0-9]{32}$/);
    expect(submittedBody?.message).toContain(`KADY_PIPELINE_ADMISSION:${startBody.kadyAdmissionId}`);

    // Recovery reads only fsynced project state; no process-local map participates.
    const recovered = recoverPipelineAdmission("default", startBody.kadyAdmissionId);
    expect(recovered.record).toMatchObject({
      workflowName: "research",
      status: "dispatched",
      nodeIds: ["search"],
      capCountedNodeIds: ["search"],
    });

    const engineRunId = `run-${startBody.kadyAdmissionId.slice(-8)}`;
    const getRun = vi.spyOn(pipelineEngine, "getRun").mockResolvedValue({
      run: {
        id: engineRunId,
        workflow_name: "research",
        status: "running",
        user_message: submittedBody?.message,
      },
      events: [],
    });
    const early = await app.inject({
      method: "POST",
      url: `/pipelines/runs/${engineRunId}/reconcile-cost`,
    });
    expect(early.statusCode).toBe(409);
    expect(recoverPipelineAdmission("default", startBody.kadyAdmissionId).admission.handle.record.status).toBe("active");

    getRun.mockResolvedValue({
      run: {
        id: engineRunId,
        workflow_name: "research",
        status: "completed",
        user_message: submittedBody?.message,
      },
      events: [{
        event_type: "node_completed",
        step_name: "search",
        data: { cost_usd: 2.25, model_usage: { input_tokens: 1_200, output_tokens: 900 } },
      }],
    });
    const first = await app.inject({
      method: "POST",
      url: `/pipelines/runs/${engineRunId}/reconcile-cost`,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ entry: { settlement: { chargedCostUsd: number; limitExceeded: boolean; settlementId: string } } }>();
    expect(firstBody.entry.settlement).toMatchObject({ chargedCostUsd: 2.25, limitExceeded: true });

    const second = await app.inject({
      method: "POST",
      url: `/pipelines/runs/${engineRunId}/reconcile-cost`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().entry.settlement.settlementId).toBe(firstBody.entry.settlement.settlementId);
    await app.close();
  });

  it("rejects a nonterminal snapshot before attempting ownership recovery", async () => {
    const admissionId = "kadypipe_11111111111111111111111111111111";
    vi.spyOn(pipelineEngine, "getRun").mockResolvedValue({
      run: {
        id: "run-early",
        workflow_name: "research",
        status: "running",
        user_message: `work KADY_PIPELINE_ADMISSION:${admissionId}`,
      },
      events: [],
    });
    const app = Fastify();
    await registerPipelineRoutes(app, { resolveBudgetHooks: resolveRealEngineHooks });
    const response = await app.inject({ method: "POST", url: "/pipelines/runs/run-early/reconcile-cost" });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("settles immediately when an async start response does not accept ownership", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(realEngineWorkflow({
      model: FIXED_MODEL,
      billingMode: "api",
      budget: { maxTokens: 2_000, maxCostUsd: 1.5 },
    }));
    let admissionId = "";
    vi.spyOn(pipelineEngine, "runWorkflow").mockImplementation(async (_name, body) => {
      const message = String((body as Record<string, unknown>).message ?? "");
      admissionId = /KADY_PIPELINE_ADMISSION:(kadypipe_[a-f0-9]{32})/.exec(message)?.[1] ?? "";
      return { accepted: false, status: "rejected" };
    });
    const app = Fastify();
    await registerPipelineRoutes(app, { resolveBudgetHooks: resolveRealEngineHooks });
    const response = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "conversation-rejected", message: "Run" },
    });
    expect(response.statusCode).toBe(409);
    expect(admissionId).toMatch(/^kadypipe_/);
    expect(recoverPipelineAdmission("default", admissionId).admission.handle.record.status).toBe("failed");
    await app.close();
  });

  it("rejects a real engine workflow with missing settings budget before start", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(realEngineWorkflow({ model: FIXED_MODEL }));
    const start = vi.spyOn(pipelineEngine, "runWorkflow");
    const app = Fastify();
    await registerPipelineRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "conversation-missing", message: "Run" },
    });
    expect(response.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });
});
