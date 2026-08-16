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
  reconcilePipelineTerminalSnapshot,
  registerPipelineRoutes,
  unresolvedPipelineNodeBudgetHooks,
} from "../src/api/pipelines.ts";
import { projectCostSummary } from "../src/cost/ledger.ts";
import { createProject, getProject, resolvePaths } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import {
  listPipelineAdmissions,
  recoverPipelineAdmission,
  reservePipelineNodeBudgets,
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
      modelCallCount: 1,
      maxTokens: 2_000,
      maxCostUsd: 1.5,
      declaredBillingMode: "api",
      modelRequest: FIXED_MODEL,
    }]);
  });

  it("derives every vendored topology's worst-case provider calls from the shared node schema", () => {
    const expectedCalls = new Map([
      ["opinion", 1],
      ["parallel", 3],
      ["coordinate", 4],
      ["ultraplan", 4],
      ["plan-debate", 7],
      ["auto-validate", 6],
      ["draco-fusion", 7],
      ["council", 12],
      ["fusion", 10],
      ["best-of-n", 4],
    ]);
    for (const [kind, modelCallCount] of expectedCalls) {
      const hooks = unresolvedPipelineNodeBudgetHooks({
        workflow: {
          name: `topology-${kind}`,
          provider: "pi",
          model: "openrouter/openai/gpt-4o-mini",
          nodes: [{
            id: "deliberate",
            kind,
            task: "Review the evidence.",
            topology_agents: [
              { id: "alpha", role: "Lead" },
              { id: "beta", role: "Reviewer" },
              { id: "gamma", role: "Skeptic" },
            ],
            max_rounds: 3,
            maxBudgetUsd: 2,
          }],
        },
      });
      expect(hooks).toEqual([expect.objectContaining({ nodeId: "deliberate", modelCallCount })]);
    }
  });

  it("settles every admitted topology at its exact durable usage instead of its reservation", async () => {
    const topologyKinds = [
      "opinion",
      "parallel",
      "coordinate",
      "ultraplan",
      "plan-debate",
      "auto-validate",
      "draco-fusion",
      "council",
      "fusion",
      "best-of-n",
    ] as const;
    for (const kind of topologyKinds) {
      const projectId = `settle-${kind}`;
      const workflowName = `topology-${kind}`;
      createProject({ name: workflowName, projectId, spendLimitUsd: 10 });
      const definition = {
        workflow: {
          name: workflowName,
          provider: "pi",
          model: "openrouter/openai/gpt-4o-mini",
          nodes: [{
            id: "deliberate",
            kind,
            task: "Evaluate the evidence.",
            topology_agents: [
              { id: "alpha", role: "Lead" },
              { id: "beta", role: "Reviewer" },
              { id: "gamma", role: "Skeptic" },
            ],
            max_rounds: 3,
            maxBudgetUsd: 2,
          }],
        },
      };
      const runId = `run-settlement-${kind}`;
      const app = await registerTestRoutes({
        getWorkflow: async () => definition,
        runWorkflow: async () => ({
          accepted: true,
          status: "pending",
          runId,
          dispatchState: "queued",
        }),
      });
      const response = await app.inject({
        method: "POST",
        url: `/pipelines/${workflowName}/run`,
        headers: { "x-project-id": projectId },
        payload: {
          conversationId: `conversation-${kind}`,
          message: `Run ${kind}`,
        },
      });
      expect(response.statusCode).toBe(200);
      const admissionId = response.json().kadyAdmissionId as string;
      const recovered = recoverPipelineAdmission(projectId, admissionId);
      const reservedCostUsd = recovered.admission.handle.record.reservedCostUsd;
      expect(recovered.record).toMatchObject({
        status: "dispatched",
        engineRunId: runId,
        nodeIds: ["deliberate"],
      });
      expect(reservedCostUsd).toBeGreaterThan(0.25);
      const reconciliation = await reconcilePipelineTerminalSnapshot(projectId, runId, {
        run: {
          id: runId,
          workflow_name: workflowName,
          status: "completed",
          metadata: {
            kadyProjectId: projectId,
            kadyEngineAdmissionKey: recovered.record.engineAdmissionKey,
            kady_completion_watermark: {
              version: 1,
              projectId,
              engineAdmissionKey: recovered.record.engineAdmissionKey,
              nodeIds: ["deliberate"],
              usageByNode: {
                deliberate: { costUsd: 0.25, tokensIn: 120, tokensOut: 30 },
              },
            },
          },
        },
        events: [],
      }, "full-charge");
      expect(reconciliation).toMatchObject({
        evidence: "durable-completion-watermark",
        entry: {
          settlement: { chargedCostUsd: 0.25, usageComplete: true },
        },
      });
      expect(projectCostSummary(projectId)).toMatchObject({
        workflowReservedUsd: 0,
        workflowSpentUsd: 0.25,
      });
      await app.close();
    }
  }, 30_000);

  it("releases a topology reservation when dispatch fails before execution", async () => {
    const projectId = "topology-dispatch-failure";
    const admissionId = "kadypipe_44444444444444444444444444444444";
    createProject({ name: "Topology dispatch failure", projectId, spendLimitUsd: 10 });
    const app = await registerTestRoutes({
      getWorkflow: async () => ({
        workflow: {
          name: "topology-failure",
          provider: "pi",
          model: "openrouter/openai/gpt-4o-mini",
          nodes: [{
            id: "deliberate",
            kind: "council",
            task: "Evaluate the evidence.",
            topology_agents: [
              { id: "alpha", role: "Lead" },
              { id: "beta", role: "Reviewer" },
              { id: "gamma", role: "Skeptic" },
            ],
            maxBudgetUsd: 2,
          }],
        },
      }),
      runWorkflow: async () => ({ accepted: false, status: "rejected" }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/pipelines/topology-failure/run",
      headers: { "x-project-id": projectId },
      payload: { conversationId: "topology-failure", message: "Run", kadyAdmissionId: admissionId },
    });
    expect(response.statusCode).toBe(409);
    expect(recoverPipelineAdmission(projectId, admissionId)).toMatchObject({
      record: { status: "settled", nodeIds: ["deliberate"] },
      admission: {
        handle: {
          record: {
            status: "failed",
            settlement: { chargedCostUsd: 0, usageComplete: true },
          },
        },
      },
    });
    await app.close();
  });

  it("fails closed on a provider-shaped kind outside the vendored engine schema", () => {
    expect(() => unresolvedPipelineNodeBudgetHooks({
      workflow: {
        name: "unsupported-provider-node",
        provider: "pi",
        model: "openrouter/openai/gpt-4o-mini",
        nodes: [{
          id: "future-provider-node",
          kind: "future-topology",
          maxBudgetUsd: 1,
        }],
      },
    })).toThrow(/not supported by the engine node schema/);
  });

  it("reserves and settles the mixed prompt plus topology aggregate including every model call", async () => {
    createProject({ name: "Topology budget", projectId: "topology-budget", spendLimitUsd: 3 });
    const definition = {
      workflow: {
        name: "mixed-topology",
        provider: "pi",
        model: "openrouter/openai/gpt-4o-mini",
        limits: { maxTokens: 10_000, maxCostUsd: 10 },
        nodes: [
          { id: "ordinary", prompt: "Summarize", maxBudgetUsd: 0.5 },
          {
            id: "deliberate",
            kind: "plan-debate",
            task: "Challenge the summary.",
            topology_agents: [
              { id: "alpha", role: "Lead" },
              { id: "beta", role: "Reviewer" },
              { id: "gamma", role: "Skeptic" },
            ],
            maxBudgetUsd: 1.5,
          },
        ],
      },
    };
    const hooks = await pipelineNodeBudgetHooks(
      definition,
      { projectId: "topology-budget", sessionId: "topology-session" },
    );
    const admission = await reservePipelineNodeBudgets({
      projectId: "topology-budget",
      admissionId: "mixed-topology-admission",
      workflowNodeCount: 2,
      hooks,
    });
    expect(hooks.map((hook) => [hook.nodeId, hook.modelCallCount])).toEqual([
      ["ordinary", 1],
      ["deliberate", 7],
    ]);
    expect(admission.handle.record).toMatchObject({
      maxCostUsd: 2,
      modelCallCount: 8,
      runMaxModelCalls: 8,
      reservedCostUsd: 2,
    });
    await admission.handle.settle({
      status: "completed",
      usage: { input: 400, output: 200, total: 600, cost: 1.25, cacheRead: 0, cacheWrite: 0 },
    });
    expect(projectCostSummary("topology-budget")).toMatchObject({
      workflowReservedUsd: 0,
      workflowSpentUsd: 1.25,
    });
  });

  it("rejects a mixed topology envelope over the cap without leaving a reservation", async () => {
    createProject({ name: "Topology cap", projectId: "topology-cap", spendLimitUsd: 1.9 });
    const hooks = await pipelineNodeBudgetHooks({
      workflow: {
        name: "mixed-topology-over-cap",
        provider: "pi",
        model: "openrouter/openai/gpt-4o-mini",
        limits: { maxTokens: 10_000, maxCostUsd: 10 },
        nodes: [
          { id: "ordinary", prompt: "Summarize", maxBudgetUsd: 0.5 },
          {
            id: "deliberate",
            kind: "plan-debate",
            task: "Challenge the summary.",
            topology_agents: [
              { id: "alpha", role: "Lead" },
              { id: "beta", role: "Reviewer" },
              { id: "gamma", role: "Skeptic" },
            ],
            maxBudgetUsd: 1.5,
          },
        ],
      },
    }, { projectId: "topology-cap", sessionId: "topology-cap-session" });
    await expect(reservePipelineNodeBudgets({
      projectId: "topology-cap",
      admissionId: "mixed-topology-over-cap",
      workflowNodeCount: 2,
      hooks,
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(projectCostSummary("topology-cap")).toMatchObject({
      workflowReservedUsd: 0,
      workflowSpentUsd: 0,
    });
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
    const dispatch = vi.fn(async () => ({ accepted: true, status: "started", dispatchState: "queued" }));
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
        return { accepted: true, status: "started", dispatchState: "queued" };
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

  it("recovers a pre-dispatch crash while disabled without engine traffic", async () => {
    const projectId = "crash-intent-disabled";
    createProject({ name: projectId, projectId, spendLimitUsd: 20 });
    const admissionId = "kadypipe_41111111111111111111111111111111";
    await persistCrashWindowInChild(projectId, admissionId, "intent");
    const fetchMock = vi.fn();
    const queryAdmission = vi.fn(async (): Promise<AdmissionQueryResult> => ({ status: "unknown" }));
    const getRun = vi.fn(async () => ({}));
    vi.stubGlobal("fetch", fetchMock);
    const worker = new PipelineReconciliationWorker({
      engineDisabled: true,
      projects: () => [{ id: projectId }],
      queryAdmission,
      getRun,
    });
    await worker.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queryAdmission).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(recoverPipelineAdmission(projectId, admissionId)).toMatchObject({
      record: { status: "settled" },
      admission: {
        handle: { record: { status: "failed", settlement: { chargedCostUsd: 0, usageComplete: true } } },
      },
    });
    vi.unstubAllGlobals();
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

  it("completes a settlement crash while disabled without engine traffic", async () => {
    const projectId = "crash-settling-disabled";
    createProject({ name: projectId, projectId, spendLimitUsd: 20 });
    const admissionId = "kadypipe_43333333333333333333333333333333";
    await persistCrashWindowInChild(projectId, admissionId, "settling");
    const fetchMock = vi.fn();
    const queryAdmission = vi.fn(async (): Promise<AdmissionQueryResult> => ({ status: "unknown" }));
    const getRun = vi.fn(async () => ({}));
    vi.stubGlobal("fetch", fetchMock);
    const worker = new PipelineReconciliationWorker({
      engineDisabled: true,
      projects: () => [{ id: projectId }],
      queryAdmission,
      getRun,
    });
    await worker.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queryAdmission).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(recoverPipelineAdmission(projectId, admissionId)).toMatchObject({
      record: { status: "settled", engineRunId: "run-child-settling" },
      admission: {
        handle: { record: { status: "completed", settlement: { chargedCostUsd: 0.4 } } },
      },
    });
    vi.unstubAllGlobals();
  });

  it("rejects a route-level workflow with no settings or legacy budget before dispatch", async () => {
    vi.spyOn(pipelineEngine, "getWorkflow").mockResolvedValue(settingsWorkflow({ model: FIXED_MODEL }));
    const dispatch = vi.fn(async () => ({ accepted: true, status: "started", dispatchState: "queued" }));
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
    const app = await registerTestRoutes({
      runWorkflow: async () => ({ accepted: true, status: "started", dispatchState: "queued" }),
    });
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
    const app = await registerTestRoutes({
      runWorkflow: async () => ({ accepted: true, status: "started", dispatchState: "queued" }),
    });
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
    const app = await registerTestRoutes({
      runWorkflow: async () => ({ accepted: true, status: "started", dispatchState: "queued" }),
    });
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
