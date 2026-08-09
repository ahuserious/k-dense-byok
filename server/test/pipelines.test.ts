import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pipelineEngine from "../src/agent/pipeline-engine/client.ts";
import {
  PipelineReconciliationWorker,
  type AdmissionQueryResult,
  pipelineNodeBudgetHooks,
  registerPipelineRoutes,
  unresolvedPipelineNodeBudgetHooks,
} from "../src/api/pipelines.ts";
import { projectCostSummary } from "../src/cost/ledger.ts";
import { createProject, getProject } from "../src/projects.ts";
import {
  listPipelineAdmissions,
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
    receipt: { resolved: { provider: "openrouter", auth: { kind: "api-key" } } },
  } as never));

function settingsWorkflow(settings: Record<string, unknown>) {
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

function legacyWorkflow() {
  return {
    workflow: {
      name: "research",
      description: "Research",
      provider: "pi",
      model: "openrouter/openai/gpt-4o-mini",
      nodes: [{ id: "search", prompt: "Search", maxBudgetUsd: 1.5 }],
    },
    filename: "research.yaml",
    source: "project",
  };
}

function completionSnapshot(admissionId: string, runId: string, costUsd = 2.25) {
  return {
    run: {
      id: runId,
      workflow_name: "research",
      status: "completed",
      metadata: {
        kadyAdmissionId: admissionId,
        kady_completion_watermark: {
          version: 1,
          admissionId,
          nodeIds: ["search"],
          usageByNode: {
            search: { costUsd, tokensIn: 1_200, tokensOut: 900 },
          },
        },
      },
    },
    events: [],
  };
}

async function registerTestRoutes(overrides: Parameters<typeof registerPipelineRoutes>[1] = {}) {
  const app = Fastify();
  await registerPipelineRoutes(app, {
    resolveBudgetHooks: resolveRealEngineHooks,
    reconciliationWorker: false,
    ...overrides,
  });
  return app;
}

describe("Tier A S4 dual-shape pipeline admission", () => {
  it("extracts the real current loader/get-workflow legacy shape", () => {
    expect(unresolvedPipelineNodeBudgetHooks(legacyWorkflow())).toEqual([expect.objectContaining({
      nodeId: "search",
      maxTokens: 100_000_000,
      maxCostUsd: 1.5,
      resolvedLegacyBilling: {
        provider: "openrouter",
        authType: "api_key",
        billingMode: "payg",
      },
    })]);
  });

  it("uses settings.budget authoritatively when it is present", () => {
    expect(unresolvedPipelineNodeBudgetHooks(settingsWorkflow({
      model: FIXED_MODEL,
      billingMode: "api",
      budget: { maxTokens: 2_000, maxCostUsd: 1.5 },
    }))).toEqual([{
      nodeId: "search",
      maxTokens: 2_000,
      maxCostUsd: 1.5,
      declaredBillingMode: "api",
      modelRequest: FIXED_MODEL,
    }]);
  });

  it("fails closed when neither settings nor legacy fields provide a budget basis", () => {
    expect(() => unresolvedPipelineNodeBudgetHooks(settingsWorkflow({ model: FIXED_MODEL })))
      .toThrow(/neither settings\.budget nor legacy maxBudgetUsd/);
  });

  it("rejects a declared billing mode that contradicts resolved provider auth", async () => {
    await expect(pipelineNodeBudgetHooks(
      settingsWorkflow({
        model: FIXED_MODEL,
        billingMode: "subscription",
        budget: { maxTokens: 100, maxCostUsd: 1 },
      }),
      { projectId: "default", sessionId: "session" },
      async () => ({
        receipt: { resolved: { provider: "openrouter", auth: { kind: "api-key" } } },
      } as never),
    )).rejects.toThrow(/resolved openrouter\/api_key is payg/);
  });
});

describe.skip("POST-INTEGRATION(S4) settings-bearing vendored loader", () => {
  it("round-trips S3 settings and admits every executable node", async () => {
    const { parseWorkflow } = await import("../vendor/pipeline-engine/packages/workflows/src/loader.ts");
    (globalThis as unknown as { Bun: { YAML: { parse: typeof JSON.parse } } }).Bun = {
      YAML: { parse: JSON.parse },
    };
    const parsed = parseWorkflow(JSON.stringify(settingsWorkflow({
      model: FIXED_MODEL,
      billingMode: "api",
      budget: { maxTokens: 2_000, maxCostUsd: 1.5 },
    }).workflow), "settings.json");
    expect(parsed.error).toBeNull();
    expect(unresolvedPipelineNodeBudgetHooks({ workflow: parsed.workflow })).toHaveLength(1);
  });
});

describe("Tier A S4 idempotent dispatch and durable reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    if (!getProject("default")) {
      createProject({ name: "Default", projectId: "default", spendLimitUsd: 20 });
    }
  });

  it("retains a lost-response reservation and resolves it to an accepted engine run", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(legacyWorkflow());
    let admissionId = "";
    let submittedIdempotencyKey = "";
    let queryResult: AdmissionQueryResult = { status: "unknown" };
    const app = await registerTestRoutes({
      runWorkflow: async (_name, body) => {
        admissionId = String((body as Record<string, unknown>).kadyAdmissionId);
        submittedIdempotencyKey = String((body as Record<string, unknown>).idempotencyKey);
        throw new Error("response lost");
      },
      queryAdmission: async () => queryResult,
    });
    const lost = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "lost-found", message: "Run" } });
    expect(lost.statusCode).toBe(503);
    expect(submittedIdempotencyKey).toBe(admissionId);
    expect(recoverPipelineAdmission("default", admissionId)).toMatchObject({
      record: {
        status: "indeterminate",
        workflowNodeCount: 1,
        requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      admission: { handle: { record: { status: "active" } } },
    });
    queryResult = { status: "found", runId: "run-found", run: { id: "run-found", status: "running" } };
    const response = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "lost-found", message: "Run", kadyAdmissionId: admissionId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, recovered: true, kadyAdmissionId: admissionId });
    expect(recoverPipelineAdmission("default", admissionId).record).toMatchObject({ status: "dispatched", engineRunId: "run-found" });
    await app.close();
  });

  it("releases a lost-response reservation only after authoritative not-found", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(legacyWorkflow());
    let admissionId = "";
    let queryResult: AdmissionQueryResult = { status: "unknown" };
    const app = await registerTestRoutes({
      runWorkflow: async (_name, body) => {
        admissionId = String((body as Record<string, unknown>).kadyAdmissionId);
        throw new Error("response lost");
      },
      queryAdmission: async () => queryResult,
    });
    const lost = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "lost-missing", message: "Run" } });
    expect(lost.statusCode).toBe(503);
    queryResult = { status: "not-found" };
    const response = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "lost-missing", message: "Run", kadyAdmissionId: admissionId },
    });
    expect(response.statusCode).toBe(409);
    expect(recoverPipelineAdmission("default", admissionId)).toMatchObject({
      record: { status: "settled" },
      admission: { handle: { record: { status: "failed" } } },
    });
    await app.close();
  });

  it("does not double-reserve or redispatch an indeterminate client retry", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(legacyWorkflow());
    const dispatch = vi.fn(async () => { throw new Error("response lost"); });
    const app = await registerTestRoutes({
      runWorkflow: dispatch,
      queryAdmission: async () => ({ status: "unknown" }),
    });
    const first = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "duplicate", message: "Run" } });
    expect(first.statusCode).toBe(503);
    const admissionId = first.json().kadyAdmissionId as string;
    const reserved = projectCostSummary("default").workflowReservedUsd;
    const second = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "duplicate", message: "Run", kadyAdmissionId: admissionId },
    });
    expect(second.statusCode).toBe(503);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(projectCostSummary("default").workflowReservedUsd).toBe(reserved);
    expect(listPipelineAdmissions("default").filter((record) => record.admissionId === admissionId)).toHaveLength(1);
    await app.close();
  });

  it("rejects a route-level workflow with no settings or legacy budget before dispatch", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(settingsWorkflow({ model: FIXED_MODEL }));
    const dispatch = vi.fn(async () => ({ accepted: true, status: "started" }));
    const app = await registerTestRoutes({ runWorkflow: dispatch });
    const response = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "missing-budget", message: "Run" } });
    expect(response.statusCode).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects nonterminal reconciliation before settlement", async () => {
    const app = await registerTestRoutes({
      getRun: async () => ({ run: { id: "run-early", status: "running" }, events: [] }),
    });
    const response = await app.inject({ method: "POST", url: "/pipelines/runs/run-early/reconcile-cost" });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/requires a terminal run/);
    await app.close();
  });

  it("retains unknown terminal accounting, then the worker full-charges without events", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(legacyWorkflow());
    const app = await registerTestRoutes({ runWorkflow: async () => ({ accepted: true, status: "started" }) });
    const start = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "no-events", message: "Run" } });
    const admissionId = start.json().kadyAdmissionId as string;
    const runId = "run-no-events";
    const snapshot = {
      run: { id: runId, workflow_name: "research", status: "completed", metadata: { kadyAdmissionId: admissionId } },
      events: [],
    };
    const reconcileApp = await registerTestRoutes({ getRun: async () => snapshot });
    const early = await reconcileApp.inject({ method: "POST", url: `/pipelines/runs/${runId}/reconcile-cost` });
    expect(early.statusCode).toBe(409);
    expect(recoverPipelineAdmission("default", admissionId).admission.handle.record.status).toBe("active");
    const worker = new PipelineReconciliationWorker({
      projects: () => [{ id: "default" }],
      queryAdmission: async () => ({ status: "found", runId, run: snapshot.run }),
      getRun: async () => snapshot,
    });
    await worker.runOnce();
    expect(recoverPipelineAdmission("default", admissionId).admission.handle.record.settlement)
      .toMatchObject({ chargedCostUsd: 1.5, usageComplete: false });
    await reconcileApp.close();
    await app.close();
  });

  it("settles observed overrun only from a complete durable watermark", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(legacyWorkflow());
    const app = await registerTestRoutes({ runWorkflow: async () => ({ accepted: true, status: "started" }) });
    const start = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "watermark", message: "Run" } });
    const admissionId = start.json().kadyAdmissionId as string;
    const runId = "run-watermark";
    const reconcileApp = await registerTestRoutes({ getRun: async () => completionSnapshot(admissionId, runId) });
    const response = await reconcileApp.inject({ method: "POST", url: `/pipelines/runs/${runId}/reconcile-cost` });
    expect(response.statusCode).toBe(200);
    expect(response.json().entry.settlement).toMatchObject({ chargedCostUsd: 2.25, limitExceeded: true, usageComplete: true });
    await reconcileApp.close();
    await app.close();
  });

  it("settles a terminal run without a client and a restarted worker resumes persisted ownership", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(legacyWorkflow());
    const app = await registerTestRoutes({ runWorkflow: async () => ({ accepted: true, status: "started" }) });
    const start = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "restart-worker", message: "Run" } });
    const admissionId = start.json().kadyAdmissionId as string;
    const runId = "run-worker-restart";
    const firstWorker = new PipelineReconciliationWorker({
      projects: () => [{ id: "default" }],
      queryAdmission: async () => ({ status: "found", runId, run: { id: runId, status: "running" } }),
      getRun: async () => ({
        run: { id: runId, workflow_name: "research", status: "running", metadata: { kadyAdmissionId: admissionId } },
        events: [],
      }),
    });
    await firstWorker.runOnce();
    expect(recoverPipelineAdmission("default", admissionId).record.engineRunId).toBe(runId);
    const restartedWorker = new PipelineReconciliationWorker({
      projects: () => [{ id: "default" }],
      getRun: async () => completionSnapshot(admissionId, runId, 1),
    });
    await restartedWorker.runOnce();
    expect(recoverPipelineAdmission("default", admissionId).admission.handle.record)
      .toMatchObject({ status: "completed", settlement: { chargedCostUsd: 1, usageComplete: true } });
    await app.close();
  });
});
