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
  WorkflowDefinitionConflictError,
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

/** The strict create precondition every definition PUT that creates must send. */
function createHeaders(projectId = "default") {
  return headers(projectId, { "if-none-match": "*" });
}

/** The strict update precondition; `revision` may be any non-negative integer. */
function updateHeaders(revision: number, projectId = "default") {
  return headers(projectId, { "if-match": `"${revision}"` });
}

function putDefinition(
  requestHeaders: Record<string, string | string[]>,
  payload: WorkflowGraphDocument,
  target = app,
) {
  return target.inject({
    method: "PUT",
    url: "/dag-workflows/api-workflow",
    headers: requestHeaders,
    payload,
  });
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
    const payload = {
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
    };
    const preview = await app.inject({
      method: "POST",
      url: "/dag-workflow-imports/legacy-pipeline/preview",
      headers: headers(),
      payload,
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

    const deprecatedPreview = await app.inject({
      method: "POST",
      // deprecated-compat: existing migration scripts retain this URL temporarily.
      url: "/dag-workflow-imports/legacy-archon/preview",
      headers: headers(),
      payload,
    });
    expect(deprecatedPreview.statusCode).toBe(200);
    expect(deprecatedPreview.headers["cache-control"]).toBe("no-store");
    const deprecatedBody = deprecatedPreview.json();
    expect(deprecatedBody).toMatchObject({
      sourceFormat: "archon-workflow-yaml/v1",
      graph: {
        id: "legacy-preview",
        nodes: [{ model: { requested: { reasoning: "low" } } }],
      },
      blockers: [],
      legacyRuns: { mode: "archive-only", resumable: false },
    });
    expect(deprecatedBody).toEqual({
      ...preview.json(),
      sourceFormat: "archon-workflow-yaml/v1",
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
      headers: createHeaders(),
      payload: graph(),
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.headers.etag).toBe('"1"');
    expect(saved.json()).toMatchObject({
      outcome: "created",
      definition: { id: "api-workflow", revision: 1 },
    });

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

  it("returns 201 created only for a create against an absent definition", async () => {
    const created = await putDefinition(createHeaders(), graph());
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.headers.location).toBe("/dag-workflows/api-workflow");
    expect(created.json()).toMatchObject({
      outcome: "created",
      definition: { id: "api-workflow", revision: 1 },
    });
  });

  it("returns 200 unchanged for an identical update at the current revision", async () => {
    expect((await putDefinition(createHeaders(), graph())).statusCode).toBe(201);

    const unchanged = await putDefinition(updateHeaders(1), graph());
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.headers.etag).toBe('"1"');
    expect(unchanged.json()).toMatchObject({
      outcome: "unchanged",
      definition: { id: "api-workflow", revision: 1 },
    });
  });

  it("returns 200 updated and the next ETag for a changed update at the current revision", async () => {
    expect((await putDefinition(createHeaders(), graph())).statusCode).toBe(201);

    const updated = await putDefinition(updateHeaders(1), graph("Changed"));
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.json()).toMatchObject({
      outcome: "updated",
      definition: { id: "api-workflow", revision: 2 },
    });
  });

  it("conflicts on a stale update precondition for identical and changed bodies alike", async () => {
    expect((await putDefinition(createHeaders(), graph())).statusCode).toBe(201);

    // Revision 0 is a legal precondition that no persisted definition can
    // satisfy. An identical body must not bypass it.
    const staleIdentical = await putDefinition(updateHeaders(0), graph());
    expect(staleIdentical.statusCode).toBe(409);
    expect(staleIdentical.json().code).toBe("CONFLICT");
    expect(staleIdentical.headers.etag).toBe('"1"');

    const staleChanged = await putDefinition(updateHeaders(0), graph("Changed"));
    expect(staleChanged.statusCode).toBe(409);
    expect(staleChanged.json().code).toBe("CONFLICT");
    expect(staleChanged.headers.etag).toBe('"1"');

    // Neither attempt wrote.
    const read = await app.inject({
      method: "GET",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
    });
    expect(read.json().revision).toBe(1);
  });

  it("conflicts without an ETag when an update targets a missing definition", async () => {
    const missing = await putDefinition(updateHeaders(0), graph());
    expect(missing.statusCode).toBe(409);
    expect(missing.json().code).toBe("CONFLICT");
    expect(missing.headers.etag).toBeUndefined();
  });

  it("conflicts on a create against an existing definition for identical and changed bodies alike", async () => {
    expect((await putDefinition(createHeaders(), graph())).statusCode).toBe(201);

    // An identical body would pass a hash-equality shortcut placed before the
    // intent check; the create precondition must still fail.
    const identical = await putDefinition(createHeaders(), graph());
    expect(identical.statusCode).toBe(409);
    expect(identical.json().code).toBe("CONFLICT");
    expect(identical.headers.etag).toBe('"1"');

    const changed = await putDefinition(createHeaders(), graph("Changed"));
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("CONFLICT");
    expect(changed.headers.etag).toBe('"1"');

    const read = await app.inject({
      method: "GET",
      url: "/dag-workflows/api-workflow",
      headers: headers(),
    });
    expect(read.json().revision).toBe(1);
    expect(read.json().graph.name).toBe("API workflow");
  });

  it("requires exactly one conditional header on every definition write", async () => {
    const missingBoth = await putDefinition(headers(), graph());
    expect(missingBoth.statusCode).toBe(428);
    expect(missingBoth.json().code).toBe("CONDITIONAL_HEADER_REQUIRED");
    expect(missingBoth.headers.etag).toBeUndefined();

    const both = await putDefinition(
      headers("default", { "if-none-match": "*", "if-match": '"1"' }),
      graph(),
    );
    expect(both.statusCode).toBe(400);
    expect(both.json().code).toBe("INVALID_CONDITIONAL_HEADER");
    expect(both.headers.etag).toBeUndefined();

    // Nothing was written by either rejected request.
    const list = await app.inject({
      method: "GET",
      url: "/dag-workflows",
      headers: headers(),
    });
    expect(list.json().workflows).toEqual([]);
  });

  it.each([
    ["bare", { "if-match": "1" }],
    ["weak", { "if-match": 'W/"1"' }],
    ["list", { "if-match": '"1", "2"' }],
    ["array", { "if-match": ['"1"', '"2"'] }],
    ["wildcard", { "if-match": "*" }],
    ["negative", { "if-match": '"-1"' }],
    // RFC 7232 §2.3.2 strong comparison is octet-by-octet and the route never
    // mints a padded ETag, so a padded revision matches no issued entity-tag.
    ["leading zero", { "if-match": '"01"' }],
    ["zero padded", { "if-match": '"0000000001"' }],
    ["padded zero", { "if-match": '"00"' }],
  ] as const)(
    "rejects a %s If-Match with 400 and no ETag",
    async (_label, extra) => {
      const response = await putDefinition(
        { "x-project-id": "default", ...extra },
        graph(),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_CONDITIONAL_HEADER");
      expect(response.headers.etag).toBeUndefined();
    },
  );

  it("keeps the canonical zero and current-revision preconditions legal", async () => {
    expect((await putDefinition(createHeaders(), graph())).statusCode).toBe(201);

    // The padded-form rejection above must not have narrowed the legal set:
    // "0" is canonical and reaches the conflict carrying the current revision.
    const zero = await putDefinition(updateHeaders(0), graph());
    expect(zero.statusCode).toBe(409);
    expect(zero.json().code).toBe("CONFLICT");
    expect(zero.headers.etag).toBe('"1"');

    // "1" is the revision the create's ETag published: still a 200.
    const current = await putDefinition(updateHeaders(1), graph());
    expect(current.statusCode).toBe(200);
    expect(current.headers.etag).toBe('"1"');
    expect(current.json()).toMatchObject({
      outcome: "unchanged",
      definition: { id: "api-workflow", revision: 1 },
    });
  });

  it.each([
    ["non-wildcard", { "if-none-match": '"1"' }],
    ["list", { "if-none-match": '*, "1"' }],
    ["array", { "if-none-match": ["*", '"1"'] }],
  ] as const)(
    "rejects a %s If-None-Match with 400 and no ETag",
    async (_label, extra) => {
      const response = await putDefinition(
        { "x-project-id": "default", ...extra },
        graph(),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_CONDITIONAL_HEADER");
      expect(response.headers.etag).toBeUndefined();
    },
  );

  it("derives every 409 ETag from the store's locked revision without rereading", async () => {
    const readSpy = vi.spyOn(workflowStore, "readDefinition");
    const saveSpy = vi
      .spyOn(workflowStore, "saveDefinitionWithIntent")
      .mockImplementation(() => {
        throw new WorkflowDefinitionConflictError(
          "Workflow api-workflow is revision 7; expected 1.",
          7,
        );
      });
    try {
      const conflict = await putDefinition(updateHeaders(1), graph("Changed"));
      expect(conflict.statusCode).toBe(409);
      expect(conflict.headers.etag).toBe('"7"');
      // The revision 7 the route published came only from the structured error.
      // Any reread after the throw would race a later writer.
      expect(readSpy).not.toHaveBeenCalled();
      expect(saveSpy).toHaveBeenCalledTimes(1);

      saveSpy.mockImplementation(() => {
        throw new WorkflowDefinitionConflictError(
          "Workflow api-workflow does not exist at revision 1.",
          null,
        );
      });
      const nullConflict = await putDefinition(updateHeaders(1), graph("Changed"));
      expect(nullConflict.statusCode).toBe(409);
      expect(nullConflict.headers.etag).toBeUndefined();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("creates an idempotent immutable queued run and exposes bounded events", async () => {
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: createHeaders(),
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
      headers: createHeaders(),
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
      headers: createHeaders("default"),
      payload: graph("Default graph"),
    });
    await app.inject({
      method: "PUT",
      url: "/dag-workflows/api-workflow",
      headers: createHeaders("private-lab"),
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
      headers: createHeaders(),
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
      headers: createHeaders(),
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
      headers: createHeaders(),
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
