import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  reserveWorkflowBudget,
  workflowBudgetReservationId,
  workflowBudgetStore,
} from "../src/workflows/budget.ts";
import {
  WorkflowRunController,
  workflowStore,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
} from "../src/workflows/index.ts";

const app = await buildApp({ workflowController: null });
const productionApp = await buildApp();
let controlledExecutorGate: Promise<void> | null = null;

function receipt(): WorkflowModelResolutionReceipt {
  return {
    request: graph().defaultModel!,
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

const controlledController = new WorkflowRunController({
  createExecutor: () => async (context) => {
    context.recordModelResolution("agent", receipt());
    if (controlledExecutorGate) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(context.signal.reason ?? new Error("aborted"));
        if (context.signal.aborted) {
          onAbort();
          return;
        }
        context.signal.addEventListener("abort", onAbort, { once: true });
        controlledExecutorGate!.then(resolve, reject).finally(() => {
          context.signal.removeEventListener("abort", onAbort);
        });
      });
    }
    return { output: { ok: true } };
  },
});
const controlledApp = await buildApp({ workflowController: controlledController });

function graph(name = "API workflow"): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "api-workflow",
    name,
    entryNodeId: "start",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "ollama",
        model: "qwen3:32b",
        auth: { kind: "local" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 4,
      maxModelCalls: 4,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 0,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "start",
        name: "Start",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Return one bounded result.",
      },
    ],
    edges: [],
  };
}

function headers(projectId = "default", extra: Record<string, string> = {}) {
  return { "x-project-id": projectId, ...extra };
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
});

afterAll(async () => {
  await app.close();
  await controlledApp.close();
  await productionApp.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("DAG workflow API", () => {
  it("previews a legacy YAML translation without scanning or saving project files", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/dag-workflow-imports/legacy-pipeline/preview",
      headers: headers(),
      payload: {
        workflowId: "legacy-preview",
        reasoning: "low",
        source: [
          "name: Legacy preview",
          "provider: pi",
          "interactive: false",
          "nodes:",
          "  - id: start",
          "    prompt: Inspect the explicit run context.",
          "    model: ollama/local-test",
        ].join("\n"),
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.json()).toMatchObject({
      sourceFormat: "pipeline-workflow-yaml/v1",
      graph: {
        id: "legacy-preview",
        nodes: [{ model: { requested: { reasoning: "low" } } }],
      },
      blockers: [],
      legacyRuns: { mode: "archive-only", resumable: false },
    });

    const list = await app.inject({
      method: "GET",
      url: "/dag-workflows",
      headers: headers(),
    });
    expect(list.json()).toEqual({ workflows: [] });
  });

  it("saves, lists, and reads a revisioned graph", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: graph(),
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.headers.etag).toBe('"1"');
    expect(saved.json()).toMatchObject({ id: "api-workflow", revision: 1 });

    const list = await app.inject({
      method: "GET",
      url: "/dag-workflows",
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      workflows: [
        expect.objectContaining({
          id: "api-workflow",
          revision: 1,
          name: "API workflow",
          nodeCount: 1,
          edgeCount: 0,
        }),
      ],
    });
    expect(list.json().workflows[0]).not.toHaveProperty("graph");

    const read = await app.inject({
      method: "GET",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    expect(read.json().graph.name).toBe("API workflow");
  });

  it("requires compare-and-swap for changed updates", async () => {
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: graph(),
    });
    const stale = await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: graph("Changed"),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("CONFLICT");

    const saved = await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers("default", { "if-match": '"1"' }),
      payload: graph("Changed"),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers.etag).toBe('"2"');

    const malformed = await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers("default", { "if-match": "revision-one" }),
      payload: graph("Changed again"),
    });
    expect(malformed.statusCode).toBe(409);
  });

  it("creates an idempotent immutable queued run and exposes bounded events", async () => {
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: graph(),
    });
    const create = () => app.inject({
      method: "POST" as const,
      url: "/dag-workflows/api-workflow/runs",
      headers: headers(),
      payload: {
        requestId: "ui-request-1",
        expectedWorkflowRevision: 1,
        input: { goal: "Check the sample" },
      },
    });
    const first = await create();
    const retry = await create();
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().manifest.id).toBe(first.json().manifest.id);
    expect(first.json()).toMatchObject({
      manifest: { workflowId: "api-workflow", workflowRevision: 1 },
      state: { status: "queued", lastSeq: 1 },
    });

    const runId = first.json().manifest.id as string;
    const runs = await app.inject({
      method: "GET",
      url: "/dag-workflow-runs?limit=1",
      headers: headers(),
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs[0]).toMatchObject({ id: runId, status: "queued" });
    expect(runs.json().runs[0]).not.toHaveProperty("graph");

    const events = await app.inject({
      method: "GET",
      url: `/dag-workflow-runs/${runId}/events?after=0&limit=1`,
      headers: headers(),
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({
      lastSeq: 1,
      hasMore: false,
      events: [{ type: "run_queued", seq: 1 }],
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/dag-workflows/api-workflow/runs",
      headers: headers(),
      payload: { requestId: "ui-request-1", input: { goal: "Different" } },
    });
    expect(conflict.statusCode).toBe(409);

    const noPublicAppender = await app.inject({
      method: "POST",
      url: `/dag-workflow-runs/${runId}/events`,
      headers: headers(),
      payload: { type: "run_succeeded" },
    });
    expect(noPublicAppender.statusCode).toBe(404);
  });

  it("exposes one existing run's read-only budget projection without reconciliation", async () => {
    const budgetGraph = graph("Budget projection");
    budgetGraph.limits.maxCostUsd = 10;
    budgetGraph.limits.maxTokens = 1_000;
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: budgetGraph,
    });
    const created = await app.inject({
      method: "POST",
      url: "/dag-workflows/api-workflow/runs",
      headers: headers(),
      payload: { requestId: "budget-projection-run" },
    });
    const runId = created.json().manifest.id as string;
    const common = {
      projectId: "default",
      runId,
      runMaxCostUsd: 10,
      runMaxTokens: 1_000,
      runMaxModelCalls: 4,
    };
    const observed = await reserveWorkflowBudget({
      ...common,
      reservationId: workflowBudgetReservationId("api-budget", "observed"),
      modelCallCount: 1,
      maxCostUsd: 3,
      maxTokens: 200,
    });
    await observed.settle({
      status: "completed",
      usage: {
        input: 80,
        output: 40,
        total: 120,
        cost: 1.25,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
    const missing = await reserveWorkflowBudget({
      ...common,
      reservationId: workflowBudgetReservationId("api-budget", "missing"),
      modelCallCount: 2,
      maxCostUsd: 4,
      maxTokens: 300,
    });
    await missing.settle({ status: "failed", reason: "credential detail must stay private" });
    await reserveWorkflowBudget({
      ...common,
      reservationId: workflowBudgetReservationId("api-budget", "active"),
      modelCallCount: 1,
      maxCostUsd: 2,
      maxTokens: 100,
    });

    const list = vi.spyOn(workflowBudgetStore, "list");
    const reconcile = vi.spyOn(workflowBudgetStore, "reconcileStale");
    const response = await app.inject({
      method: "GET",
      url: `/dag-workflow-runs/${runId}/budget`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      runId,
      reservationCount: 3,
      ceilings: { maxCostUsd: 10, maxTokens: 1_000, maxModelCalls: 4 },
      modelCallCount: 4,
      activeReservationCount: 1,
      activeReservedMaximumUsd: 2,
      activeReservedMaximumTokens: 100,
      settledReservationCount: 2,
      settledChargedUsd: 5.25,
      observedUsageTokens: 120,
      missingUsageMaximumTokens: 300,
      staleReservationCount: 0,
      fullChargeReservationCount: 1,
    });
    expect(response.body).not.toContain("credential");
    expect(list).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();

    ensureProjectExists("private-lab");
    const foreign = await app.inject({
      method: "GET",
      url: `/dag-workflow-runs/${runId}/budget`,
      headers: headers("private-lab"),
    });
    expect(foreign.statusCode).toBe(404);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRestore();
    reconcile.mockRestore();
  });

  it("keeps workflow definitions isolated by active project", async () => {
    ensureProjectExists("private-lab");
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers("default"),
      payload: graph("Default graph"),
    });
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers("private-lab"),
      payload: graph("Private graph"),
    });
    const privateRead = await app.inject({
      method: "GET",
      url: "/dag-workflows/api-workflow",
      headers: headers("private-lab"),
    });
    const defaultRead = await app.inject({
      method: "GET",
      url: "/dag-workflows/api-workflow",
      headers: headers("default"),
    });
    expect(privateRead.json().graph.name).toBe("Private graph");
    expect(defaultRead.json().graph.name).toBe("Default graph");
  });

  it("surfaces graph validation failures without writing a definition", async () => {
    const invalid = graph();
    invalid.nodes[0].workspace.writePaths = ["../escape"];
    const response = await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: invalid,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_DEFINITION" });
    const list = await app.inject({
      method: "GET",
      url: "/dag-workflows",
      headers: headers(),
    });
    expect(list.json()).toEqual({ workflows: [] });
  });

  it("starts accepted runs and exposes cancel, resume, and rescue controls", async () => {
    await controlledApp.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: graph(),
    });

    const immediate = await controlledApp.inject({
      method: "POST",
      url: "/dag-workflows/api-workflow/runs",
      headers: headers(),
      payload: { requestId: "controlled-immediate", sessionId: "main-session" },
    });
    expect(immediate.statusCode).toBe(202);
    const immediateRunId = immediate.json().manifest.id as string;
    await vi.waitFor(() => {
      expect(workflowStore.readRun("default", immediateRunId)!.state.status).toBe("succeeded");
    });

    let releaseGate!: () => void;
    controlledExecutorGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const active = await controlledApp.inject({
      method: "POST",
      url: "/dag-workflows/api-workflow/runs",
      headers: headers(),
      payload: { requestId: "controlled-cancel" },
    });
    const activeRunId = active.json().manifest.id as string;
    await vi.waitFor(() => {
      expect(workflowStore.readRun("default", activeRunId)!.state.status).toBe("running");
    });
    const cancelled = await controlledApp.inject({
      method: "POST",
      url: `/dag-workflow-runs/${activeRunId}/cancel`,
      headers: headers(),
    });
    expect(cancelled.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(workflowStore.readRun("default", activeRunId)!.state.status).toBe("cancelled");
    });
    releaseGate();
    controlledExecutorGate = null;

    const interruptedManifest = workflowStore.createRun("default", {
      workflowId: "api-workflow",
      requestId: "controlled-interrupted",
      requestedBy: "api",
    });
    workflowStore.appendRunEvent(
      "default",
      interruptedManifest.id,
      { eventId: "api_manual_start", type: "run_started" },
      1,
    );
    workflowStore.appendRunEvent(
      "default",
      interruptedManifest.id,
      {
        eventId: "api_manual_interrupt",
        type: "run_interrupted",
        data: {
          previousStatus: "running",
          error: {
            code: "SERVER_RESTART",
            message: "Interrupted for API control coverage.",
            retryable: true,
          },
        },
      },
      2,
    );
    const resumed = await controlledApp.inject({
      method: "POST",
      url: `/dag-workflow-runs/${interruptedManifest.id}/resume`,
      headers: headers(),
    });
    expect(resumed.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(workflowStore.readRun("default", interruptedManifest.id)!.state.status).toBe("succeeded");
    });

    const failedManifest = workflowStore.createRun("default", {
      workflowId: "api-workflow",
      requestId: "controlled-failed",
      requestedBy: "api",
      input: { goal: "Repair the failed analysis." },
    });
    workflowStore.appendRunEvent(
      "default",
      failedManifest.id,
      { eventId: "api_failed_start", type: "run_started" },
      1,
    );
    workflowStore.appendRunEvent(
      "default",
      failedManifest.id,
      {
        eventId: "api_failed_terminal",
        type: "run_failed",
        data: {
          error: {
            code: "OBSERVED_FAILURE",
            message: "The observed output failed its gate.",
            retryable: true,
          },
        },
      },
      2,
    );
    const rescued = await controlledApp.inject({
      method: "POST",
      url: `/dag-workflow-runs/${failedManifest.id}/rescue`,
      headers: headers(),
      payload: { requestId: "controlled-rescue" },
    });
    expect(rescued.statusCode).toBe(202);
    const rescueRunId = rescued.json().manifest.id as string;
    expect(rescued.json().manifest.input.variables._kadyRescue).toMatchObject({
      sourceRunId: failedManifest.id,
      error: { code: "OBSERVED_FAILURE" },
    });
    await vi.waitFor(() => {
      expect(workflowStore.readRun("default", rescueRunId)!.state.status).toBe("succeeded");
    });
  });

  it("uses the production workflow controller when buildApp receives no override", async () => {
    const unsupported = graph("Production controller proof");
    if (unsupported.defaultModel?.requested.source !== "fixed") {
      throw new Error("Expected a fixed test model.");
    }
    unsupported.defaultModel.requested.provider = "unsupported-provider";

    await productionApp.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
      payload: unsupported,
    });
    const created = await productionApp.inject({
      method: "POST",
      url: "/dag-workflows/api-workflow/runs",
      headers: headers(),
      payload: { requestId: "production-controller-proof" },
    });
    expect(created.statusCode).toBe(202);
    const runId = created.json().manifest.id as string;

    await vi.waitFor(() => {
      expect(workflowStore.readRun("default", runId)!.state.status).toBe("failed");
    });
  });
});
