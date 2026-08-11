import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pipelineEngine from "../src/agent/pipeline-engine/client.ts";
import {
  PipelineReconciliationWorker,
  type AdmissionQueryResult,
  pipelineNodeBudgetHooks,
  queryEngineRunByAdmissionId,
  registerPipelineRoutes,
  unresolvedPipelineNodeBudgetHooks,
} from "../src/api/pipelines.ts";
import { projectCostSummary } from "../src/cost/ledger.ts";
import { createProject, getProject, resolvePaths } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
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

function recordOfForTest(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function settingsWorkflow(settings: Record<string, unknown>) {
  return {
    workflow: {
      name: "research",
      description: "Research",
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

function completionSnapshot(
  projectId: string,
  engineAdmissionKey: string,
  runId: string,
  costUsd = 2.25,
) {
  return {
    run: {
      id: runId,
      workflow_name: "research",
      codebase_id: `codebase-${projectId}`,
      status: "completed",
      metadata: {
        kadyProjectId: projectId,
        kadyEngineAdmissionKey: engineAdmissionKey,
        kady_completion_watermark: {
          version: 1,
          projectId,
          engineAdmissionKey,
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
  app.addHook("onRequest", (request, _reply, done) => {
    const header = request.headers["x-project-id"];
    withActiveProject(typeof header === "string" ? header : "default", () => done());
  });
  await registerPipelineRoutes(app, {
    resolveBudgetHooks: resolveRealEngineHooks,
    reconciliationWorker: false,
    resolveWorkflowScope: async (projectId) => ({
      cwd: resolvePaths(projectId).sandbox,
      codebaseId: `codebase-${projectId}`,
    }),
    ...overrides,
  });
  return app;
}

async function persistCrashWindowInChild(
  projectId: string,
  admissionId: string,
  window: "intent" | "dispatching" | "settling",
): Promise<void> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "workflows", "budget.ts")).href;
  const script = `
    import {
      beginPipelineAdmissionSettlement,
      persistPipelineAdmission,
      reservePipelineNodeBudgets,
      updatePipelineAdmission,
    } from ${JSON.stringify(moduleUrl)};
    const admission = await reservePipelineNodeBudgets({
      projectId: ${JSON.stringify(projectId)},
      admissionId: ${JSON.stringify(admissionId)},
      workflowNodeCount: 1,
      hooks: [{
        nodeId: "search",
        maxTokens: 1000,
        maxCostUsd: 1.5,
        declaredBillingMode: "api",
        billing: { provider: "openrouter", authType: "api_key", billingMode: "payg" },
      }],
      durableIntent: {
        workflowName: "research",
        requestSha256: ${JSON.stringify("a".repeat(64))},
        workflowRevisionSha256: ${JSON.stringify("b".repeat(64))},
      },
    });
    if (${JSON.stringify(window)} !== "intent") {
      persistPipelineAdmission(admission, "research", ${JSON.stringify("a".repeat(64))}, ${JSON.stringify("b".repeat(64))});
    }
    if (${JSON.stringify(window)} === "dispatching" || ${JSON.stringify(window)} === "settling") {
      updatePipelineAdmission(${JSON.stringify(projectId)}, admission.admissionId, { status: "dispatching" });
    }
    if (${JSON.stringify(window)} === "settling") {
      updatePipelineAdmission(${JSON.stringify(projectId)}, admission.admissionId, {
        status: "dispatched",
        engineRunId: "run-child-settling",
      });
      beginPipelineAdmissionSettlement(${JSON.stringify(projectId)}, admission.admissionId, {
        status: "completed",
        usage: { input: 10, output: 5, total: 15, cost: 0.4, cacheRead: 0, cacheWrite: 0 },
      }, "run-child-settling");
    }
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Crash-window child exited ${String(code)}: ${stderr}`));
    });
  });
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

  it("degrades safely against the current non-echoing engine run-list shape", async () => {
    const engineAdmissionKey = "kadypipe_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runs: [{
          id: "run-current-shape",
          user_message: `Run\nKADY_PIPELINE_PROJECT:default\nKADY_PIPELINE_ADMISSION:${engineAdmissionKey}`,
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(queryEngineRunByAdmissionId("default", engineAdmissionKey)).resolves.toMatchObject({
        status: "found",
        runId: "run-current-shape",
      });
      await expect(queryEngineRunByAdmissionId("default", engineAdmissionKey)).resolves.toEqual({
        status: "unknown",
      });
      expect(String(fetchMock.mock.calls[0][0])).toContain("projectId=default");
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("POST-INTEGRATION(S4) settings-bearing vendored loader", () => {
  it("round-trips S3 settings and admits every executable node", async () => {
    const { parseWorkflow } = await import("../vendor/pipeline-engine/packages/workflows/src/loader.ts");
    // Mirror engine boot: providers register before any workflow parses.
    const { registerBuiltinProviders, registerCommunityProviders } = await import("../vendor/pipeline-engine/packages/providers/src/index.ts");
    registerBuiltinProviders();
    registerCommunityProviders();
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
    let submittedWorkflowRevision = "";
    let queryResult: AdmissionQueryResult = { status: "unknown" };
    const app = await registerTestRoutes({
      runWorkflow: async (_name, body) => {
        admissionId = String((body as Record<string, unknown>).kadyAdmissionId);
        submittedIdempotencyKey = String((body as Record<string, unknown>).idempotencyKey);
        submittedWorkflowRevision = String((body as Record<string, unknown>).workflowRevisionSha256);
        throw new Error("response lost");
      },
      queryAdmission: async () => queryResult,
    });
    const lost = await app.inject({ method: "POST", url: "/pipelines/research/run", payload: { conversationId: "lost-found", message: "Run" } });
    expect(lost.statusCode).toBe(503);
    const pending = recoverPipelineAdmission("default", admissionId);
    expect(submittedIdempotencyKey).toBe(pending.record.engineAdmissionKey);
    expect(submittedIdempotencyKey).not.toBe(admissionId);
    expect(submittedWorkflowRevision).toBe(pending.record.workflowRevisionSha256);
    expect(pending).toMatchObject({
      record: {
        status: "dispatching",
        workflowNodeCount: 1,
        requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        workflowRevisionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
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

  it("rejects an edit between admission and engine start", async () => {
    const changed = structuredClone(legacyWorkflow());
    changed.workflow.nodes[0].prompt = "Changed after admission";
    const getWorkflow = vi.fn()
      .mockResolvedValueOnce(legacyWorkflow())
      .mockResolvedValueOnce(changed);
    const dispatch = vi.fn(async () => ({ accepted: true, status: "started" }));
    const admissionId = "kadypipe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const app = await registerTestRoutes({ getWorkflow, runWorkflow: dispatch });
    const response = await app.inject({
      method: "POST",
      url: "/pipelines/research/run",
      payload: { conversationId: "revision-change", message: "Run", kadyAdmissionId: admissionId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/revision changed between admission and dispatch/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(recoverPipelineAdmission("default", admissionId)).toMatchObject({
      record: { status: "settled" },
      admission: { handle: { record: { settlement: { chargedCostUsd: 0 } } } },
    });
    await app.close();
  });

  it("scopes identical workflow names and client admission ids by project", async () => {
    for (const projectId of ["scope-a", "scope-b"]) {
      if (!getProject(projectId)) {
        createProject({ name: projectId, projectId, spendLimitUsd: 20 });
      }
    }
    const submitted: Record<string, unknown>[] = [];
    const app = await registerTestRoutes({
      getWorkflow: async () => legacyWorkflow(),
      runWorkflow: async (_name, body) => {
        submitted.push(body as Record<string, unknown>);
        return { accepted: true, status: "started" };
      },
    });
    const admissionId = "kadypipe_cccccccccccccccccccccccccccccccc";
    for (const projectId of ["scope-a", "scope-b"]) {
      const response = await app.inject({
        method: "POST",
        url: "/pipelines/research/run",
        headers: { "x-project-id": projectId },
        payload: { conversationId: "same-conversation", message: "Run", kadyAdmissionId: admissionId },
      });
      expect(response.statusCode).toBe(200);
    }
    const scopeA = recoverPipelineAdmission("scope-a", admissionId).record;
    const scopeB = recoverPipelineAdmission("scope-b", admissionId).record;
    expect(scopeA.engineAdmissionKey).not.toBe(scopeB.engineAdmissionKey);
    expect(submitted.map((body) => body.idempotencyKey)).toEqual([
      scopeA.engineAdmissionKey,
      scopeB.engineAdmissionKey,
    ]);
    expect(submitted.map((body) => recordOfForTest(body.metadata)?.kadyProjectId)).toEqual([
      "scope-a",
      "scope-b",
    ]);

    const runId = "run-scope-a";
    const scopeASnapshot = completionSnapshot("scope-a", scopeA.engineAdmissionKey, runId, 0.5);
    const reconcileApp = await registerTestRoutes({ getRun: async () => scopeASnapshot });
    const crossProject = await reconcileApp.inject({
      method: "POST",
      url: `/pipelines/runs/${runId}/reconcile-cost`,
      headers: { "x-project-id": "scope-b" },
    });
    expect(crossProject.statusCode).toBe(404);
    expect(recoverPipelineAdmission("scope-b", admissionId).admission.handle.record.status).toBe("active");
    await reconcileApp.close();
    await app.close();
  });

  it("recovers a child crash between reservation intent and dispatch by releasing zero usage", async () => {
    const projectId = "crash-intent";
    createProject({ name: projectId, projectId, spendLimitUsd: 20 });
    const admissionId = "kadypipe_11111111111111111111111111111111";
    await persistCrashWindowInChild(projectId, admissionId, "intent");
    expect(listPipelineAdmissions(projectId)).toEqual([]);
    expect(projectCostSummary(projectId).workflowReservedUsd).toBe(1.5);
    const queryAdmission = vi.fn(async (): Promise<AdmissionQueryResult> => ({ status: "unknown" }));
    const worker = new PipelineReconciliationWorker({
      projects: () => [{ id: projectId }],
      queryAdmission,
    });
    await worker.runOnce();
    expect(queryAdmission).not.toHaveBeenCalled();
    expect(recoverPipelineAdmission(projectId, admissionId)).toMatchObject({
      record: { status: "settled" },
      admission: {
        handle: { record: { status: "failed", settlement: { chargedCostUsd: 0, usageComplete: true } } },
      },
    });
  });

  it("recovers a child crash after write-ahead dispatch by querying and settling", async () => {
    const projectId = "crash-dispatch";
    createProject({ name: projectId, projectId, spendLimitUsd: 20 });
    const admissionId = "kadypipe_22222222222222222222222222222222";
    await persistCrashWindowInChild(projectId, admissionId, "dispatching");
    const record = recoverPipelineAdmission(projectId, admissionId).record;
    const runId = "run-child-dispatch";
    const worker = new PipelineReconciliationWorker({
      projects: () => [{ id: projectId }],
      queryAdmission: async (queriedProjectId, queriedKey) => {
        expect([queriedProjectId, queriedKey]).toEqual([projectId, record.engineAdmissionKey]);
        return { status: "found", runId, run: { id: runId, status: "completed" } };
      },
      getRun: async () => completionSnapshot(projectId, record.engineAdmissionKey, runId, 0.8),
    });
    await worker.runOnce();
    expect(recoverPipelineAdmission(projectId, admissionId)).toMatchObject({
      record: { status: "settled", engineRunId: runId },
      admission: {
        handle: { record: { status: "completed", settlement: { chargedCostUsd: 0.8 } } },
      },
    });
  });

  it("completes a child crash after settlement intent without querying again", async () => {
    const projectId = "crash-settling";
    createProject({ name: projectId, projectId, spendLimitUsd: 20 });
    const admissionId = "kadypipe_33333333333333333333333333333333";
    await persistCrashWindowInChild(projectId, admissionId, "settling");
    const queryAdmission = vi.fn(async (): Promise<AdmissionQueryResult> => ({ status: "unknown" }));
    const getRun = vi.fn(async () => ({}));
    const worker = new PipelineReconciliationWorker({
      projects: () => [{ id: projectId }],
      queryAdmission,
      getRun,
    });
    await worker.runOnce();
    expect(queryAdmission).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(recoverPipelineAdmission(projectId, admissionId)).toMatchObject({
      record: { status: "settled", engineRunId: "run-child-settling" },
      admission: {
        handle: { record: { status: "completed", settlement: { chargedCostUsd: 0.4 } } },
      },
    });
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
      getRun: async () => ({
        run: { id: "run-early", codebase_id: "codebase-default", status: "running" },
        events: [],
      }),
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
    const admissionRecord = recoverPipelineAdmission("default", admissionId).record;
    const runId = "run-no-events";
    const snapshot = {
      run: {
        id: runId,
        workflow_name: "research",
        codebase_id: "codebase-default",
        status: "completed",
        metadata: {
          kadyProjectId: "default",
          kadyEngineAdmissionKey: admissionRecord.engineAdmissionKey,
        },
      },
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
    const admissionRecord = recoverPipelineAdmission("default", admissionId).record;
    const runId = "run-watermark";
    const reconcileApp = await registerTestRoutes({
      getRun: async () => completionSnapshot("default", admissionRecord.engineAdmissionKey, runId),
    });
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
    const admissionRecord = recoverPipelineAdmission("default", admissionId).record;
    const runId = "run-worker-restart";
    const firstWorker = new PipelineReconciliationWorker({
      projects: () => [{ id: "default" }],
      queryAdmission: async () => ({ status: "found", runId, run: { id: runId, status: "running" } }),
      getRun: async () => ({
        run: {
          id: runId,
          workflow_name: "research",
          status: "running",
          metadata: {
            kadyProjectId: "default",
            kadyEngineAdmissionKey: admissionRecord.engineAdmissionKey,
          },
        },
        events: [],
      }),
    });
    await firstWorker.runOnce();
    expect(recoverPipelineAdmission("default", admissionId).record.engineRunId).toBe(runId);
    const restartedWorker = new PipelineReconciliationWorker({
      projects: () => [{ id: "default" }],
      getRun: async () => completionSnapshot("default", admissionRecord.engineAdmissionKey, runId, 1),
    });
    await restartedWorker.runOnce();
    expect(recoverPipelineAdmission("default", admissionId).admission.handle.record)
      .toMatchObject({ status: "completed", settlement: { chargedCostUsd: 1, usageComplete: true } });
    await app.close();
  });
});
