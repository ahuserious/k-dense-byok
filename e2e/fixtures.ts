import { expect, test as base } from "@stablyai/playwright-test";
import type { FrameLocator, Page, Route } from "@playwright/test";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "paused"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface MockApiState {
  runStatus: RunStatus;
  graphStatus: RunStatus;
  graphError: boolean;
  uploadedFiles: string[];
}

const BACKEND_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):18000\//;
const now = Date.now();
const workflowRunId = `wrun_${"1".repeat(32)}`;

function emptyBudget() {
  return {
    totalUsd: 0,
    spentUsd: 0,
    reservedUsd: 0,
    inFlightUsd: 0,
    committedUsd: 0,
    limitUsd: null,
    ratio: null,
    state: "ok",
  };
}

function graphDocument(id = "e2e-workflow", name = "E2E Workflow") {
  return {
    schemaVersion: "1.0",
    id,
    name,
    description: "Deterministic E2E workflow",
    entryNodeId: "analyze",
    limits: {
      maxIterations: 6,
      maxModelCalls: 8,
      maxParallelism: 2,
      maxSubagents: 2,
      timeoutMs: 300000,
      maxTokens: 50000,
      maxCostUsd: 5,
      maxRetries: 2,
    },
    rescue: { enabled: true, maxAttempts: 1, triggers: ["failure"] },
    evidence: {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "analyze",
        name: "Analyze",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Analyze the supplied evidence.",
      },
    ],
    edges: [],
  };
}

function storedDefinition(id = "e2e-workflow", name = "E2E Workflow", graph = graphDocument(id, name)) {
  return {
    storageVersion: 1,
    id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    graphSha256: "e2e-graph-sha256",
    graph,
  };
}

function runSummary(status: RunStatus) {
  return {
    id: workflowRunId,
    workflowId: "e2e-workflow",
    workflowRevision: 1,
    graphSha256: "e2e-graph-sha256",
    sessionId: "session-e2e",
    createdAt: now,
    requestedBy: "user",
    status,
    lastSeq: 2,
    startedAt: status === "queued" ? null : now,
    finishedAt: ["succeeded", "failed", "cancelled"].includes(status) ? now + 1000 : null,
    interruptedAt: status === "interrupted" ? now + 500 : null,
    recoverable: status === "interrupted" || status === "failed",
    lastError:
      status === "failed"
        ? { code: "E2E_FAILURE", message: "simulated failure", retryable: true }
        : null,
    diagnostics: [],
  };
}

function runRecord(status: RunStatus) {
  const graph = graphDocument();
  return {
    manifest: {
      storageVersion: 1,
      id: workflowRunId,
      projectId: "default",
      workflowId: "e2e-workflow",
      workflowRevision: 1,
      graphSha256: "e2e-graph-sha256",
      requestId: "e2e-request",
      requestSha256: "e2e-request-sha256",
      sessionId: "session-e2e",
      createdAt: now,
      requestedBy: "user",
      input: { goal: "E2E goal" },
      effectiveLimits: graph.limits,
      graph,
    },
    state: {
      runId: workflowRunId,
      status,
      lastSeq: 2,
      executions: {},
      startedAt: now,
      ...(status === "interrupted" ? { interruptedAt: now + 500 } : {}),
      ...(["succeeded", "failed", "cancelled"].includes(status)
        ? { finishedAt: now + 1000 }
        : {}),
      ...(status === "failed"
        ? { lastError: { code: "E2E_FAILURE", message: "simulated failure", retryable: true } }
        : {}),
      recoverable: status === "interrupted" || status === "failed",
      diagnostics: [],
    },
  };
}

function routeJson(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, json: body, headers });
}

async function installStreamingFetch(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let heldRunController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encode = (frame: Record<string, unknown>) =>
      new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && /\/sessions\/[^/]+\/run$/.test(url.pathname)) {
        const mode = window.localStorage.getItem("kady:e2e-run-mode") ?? "complete";
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode({ seq: 1, type: "run_start", runId: "run-e2e" }));
            controller.enqueue(encode({ seq: 2, type: "turn_start" }));
            controller.enqueue(encode({ seq: 3, type: "text_delta", delta: "E2E response" }));
            if (mode === "streaming") {
              heldRunController = controller;
              return;
            }
            if (mode === "error") {
              controller.enqueue(
                encode({ seq: 4, type: "error", error: "simulated provider failure" }),
              );
            }
            controller.enqueue(encode({ seq: 5, type: "turn_end" }));
            controller.enqueue(encode({ seq: 6, type: "done" }));
            controller.close();
          },
          cancel() {
            heldRunController = null;
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (method === "POST" && /\/sessions\/[^/]+\/abort$/.test(url.pathname)) {
        heldRunController?.close();
        heldRunController = null;
        return new Response(JSON.stringify({ restored: ["restored steering"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return nativeFetch(input, init);
    };
  });
}

async function installApiMocks(page: Page, state: MockApiState) {
  await installStreamingFetch(page);
  await page.route(BACKEND_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/projects" && method === "GET") {
      return routeJson(route, [
        {
          id: "default",
          name: "E2E Project",
          description: "Hermetic Playwright project",
          tags: ["e2e"],
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          archived: false,
          spendLimitUsd: null,
        },
      ]);
    }
    if (path === "/projects/activity") return routeJson(route, { activities: {} });
    if (path === "/projects/default/costs") {
      return routeJson(route, {
        projectId: "default",
        totalUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        limitUsd: null,
        budget: emptyBudget(),
      });
    }
    if (path === "/sandbox/tree") {
      return routeJson(route, {
        name: "sandbox",
        path: "",
        type: "directory",
        children: state.uploadedFiles.length
          ? [
              {
                name: "user_data",
                path: "user_data",
                type: "directory",
                children: state.uploadedFiles.map((filePath) => ({
                  name: filePath.split("/").at(-1),
                  path: filePath,
                  type: "file",
                })),
              },
            ]
          : [],
      });
    }
    if (path === "/skills") return routeJson(route, []);
    if (path === "/model-providers") return routeJson(route, { providers: [] });
    if (path === "/model-providers/models") return routeJson(route, { models: [] });
    if (path === "/credentials") return routeJson(route, { openrouter: { set: true } });
    if (path === "/ollama/models") return routeJson(route, { available: false, models: [] });
    if (path === "/openai-compatible/models") {
      return routeJson(route, { available: false, configured: false, models: [] });
    }
    if (path === "/nvidia/models") return routeJson(route, { configured: false, models: [] });
    if (path === "/system/resources") return route.fulfill({ status: 204 });
    if (path === "/modal/jobs") return routeJson(route, { jobs: [], total: 0 });
    if (path === "/sessions" && method === "POST") return routeJson(route, { id: "session-e2e" });
    if (path === "/sessions" && method === "GET") {
      return routeJson(route, [
        { id: "session-e2e", title: "E2E chat", created: now, modified: now, messageCount: 2 },
      ]);
    }
    if (/^\/sessions\/[^/]+\/run\/state$/.test(path)) {
      return routeJson(route, { status: "none", run: null });
    }
    if (/^\/sessions\/[^/]+\/history$/.test(path)) {
      return routeJson(route, { messages: [], contextUsage: null });
    }
    if (/^\/sessions\/[^/]+\/costs$/.test(path)) {
      return routeJson(route, {
        sessionId: "session-e2e",
        totalUsd: 0,
        totalTokens: 0,
        agentUsd: 0,
        subagentUsd: 0,
        computeUsd: 0,
        entries: [],
      });
    }
    if (/^\/sessions\/[^/]+\/workflow-run-state$/.test(path)) {
      const failed = state.graphError;
      return routeJson(route, {
        state: {
          schemaVersion: 1,
          runId: workflowRunId,
          workflowId: "chat-e2e-workflow",
          workflowRevision: 2,
          status: failed ? "failed" : state.graphStatus,
          nodes: [
            {
              id: "prepare",
              status: "succeeded",
              progress: { completed: 1, total: 1, message: "prepared" },
            },
            {
              id: "analyze",
              status: failed ? "failed" : state.graphStatus,
              progress: { completed: failed ? 1 : 2, total: failed ? 1 : 5, message: "analyzing" },
            },
          ],
          topology: {
            nodes: [{ id: "prepare" }, { id: "analyze" }],
            edges: [{ id: "prepare-analyze", from: "prepare", to: "analyze" }],
          },
          backgroundAgentTrailingNode: failed
            ? undefined
            : { slotId: "background-agent", agentId: "rescue-agent", nodeId: "analyze", status: "running" },
          ...(failed
            ? {
                errorRouting: {
                  source: "chat-stream",
                  surface: true,
                  nodeId: "analyze",
                  error: { code: "CHAT_STREAM_ERROR", message: "persisted provider failure", retryable: true },
                },
              }
            : {}),
          updatedAt: now,
        },
      });
    }
    if (/^\/sessions\/[^/]+\/(notebook|interview)$/.test(path)) {
      return routeJson(route, path.endsWith("interview") ? { pending: null } : { entries: [] });
    }
    if (/^\/sessions\/[^/]+\/steer$/.test(path)) return routeJson(route, { pending: ["steering"] });

    if (path === "/pipelines/health") return routeJson(route, { healthy: true });
    if (path === "/pipelines") {
      return routeJson(route, {
        workflows: [
          {
            source: "project",
            filename: "e2e-workflow.yaml",
            workflowId: "e2e-vendored",
            codebaseId: "e2e-codebase",
            workflow: {
              name: "E2E Workflow",
              description: "Deterministic E2E workflow",
              nodes: [{ id: "analyze" }],
            },
          },
        ],
      });
    }
    if (/^\/pipelines\/[^/]+\/run$/.test(path)) {
      return routeJson(route, {
        accepted: true,
        status: "queued",
        runId: "engine-run-e2e",
      });
    }

    if (path === "/dag-workflows" && method === "GET") {
      return routeJson(route, {
        workflows: [
          {
            id: "e2e-workflow",
            revision: 1,
            createdAt: now,
            updatedAt: now,
            graphSha256: "e2e-graph-sha256",
            schemaVersion: "1.0",
            name: "E2E Workflow",
            description: "Deterministic E2E workflow",
            nodeCount: 1,
            edgeCount: 0,
          },
        ],
      });
    }
    const definitionMatch = path.match(/^\/dag-workflows\/([^/]+)$/);
    if (definitionMatch && method === "PUT") {
      const graph = JSON.parse(request.postData() ?? "{}") as ReturnType<typeof graphDocument>;
      return routeJson(
        route,
        storedDefinition(decodeURIComponent(definitionMatch[1]), graph.name, graph),
        200,
        { ETag: '"1"' },
      );
    }
    if (definitionMatch && method === "GET") {
      return routeJson(route, storedDefinition(decodeURIComponent(definitionMatch[1])), 200, { ETag: '"1"' });
    }
    if (/^\/dag-workflows\/[^/]+\/runs$/.test(path) && method === "POST") {
      return routeJson(route, runRecord("queued"), 201);
    }
    if (path === "/dag-workflow-runs") return routeJson(route, { runs: [runSummary(state.runStatus)] });
    if (path === `/dag-workflow-runs/${workflowRunId}`) return routeJson(route, runRecord(state.runStatus));
    if (path === `/dag-workflow-runs/${workflowRunId}/budget`) {
      return routeJson(route, {
        runId: workflowRunId,
        reservationCount: 0,
        ceilings: null,
        modelCallCount: 0,
        activeReservationCount: 0,
        activeReservedMaximumUsd: 0,
        activeReservedMaximumTokens: 0,
        settledReservationCount: 0,
        settledChargedUsd: 0,
        observedUsageTokens: 0,
        missingUsageMaximumTokens: 0,
        staleReservationCount: 0,
        fullChargeReservationCount: 0,
      });
    }
    if (path === `/dag-workflow-runs/${workflowRunId}/events`) {
      return routeJson(route, {
        events: [
          { schemaVersion: 1, eventId: "event-1", runId: workflowRunId, seq: 1, ts: now, type: "run_started" },
          { schemaVersion: 1, eventId: "event-2", runId: workflowRunId, seq: 2, ts: now + 1, type: "node_started", nodeId: "analyze" },
        ],
        lastSeq: 2,
        hasMore: false,
        diagnostics: [],
      });
    }
    const controlMatch = path.match(/^\/dag-workflow-runs\/[^/]+\/(cancel|resume|rescue)$/);
    if (controlMatch && method === "POST") {
      const status = controlMatch[1] === "cancel" ? "cancelled" : "running";
      return routeJson(route, runRecord(status));
    }
    if (path === "/helper-sessions/raindrop/context" && method === "POST") {
      const source = JSON.parse(request.postData() ?? "{}") as { kind?: string; id?: string };
      return routeJson(route, {
        source,
        context: `Observed E2E ${source.kind ?? "unknown"} context for ${source.id ?? "unknown"}.`,
        truncated: false,
        observedEntries: 2,
        totalEntries: 2,
      });
    }
    const helperSession = path.match(/^\/helper-sessions\/([^/]+)$/);
    if (helperSession && method === "POST") {
      const source = JSON.parse(request.postData() ?? "{}") as { kind?: string; id?: string };
      return routeJson(route, {
        id: `helper-${helperSession[1]}-e2e`,
        source,
      });
    }
    if (path === "/console/runs") {
      return routeJson(route, [
          {
            id: "agent-run-e2e",
            role: "agent",
            task: "E2E analysis",
            status: "completed",
            model: "openrouter/e2e",
            cost_usd: 0.01,
            started_at: new Date(now).toISOString(),
          },
        ]);
    }
    if (path === "/console/loops") return routeJson(route, []);

    return routeJson(route, {});
  });
}

export const test = base.extend<{
  apiState: MockApiState;
  workspacePage: Page;
}>({
  apiState: async ({}, use) => {
    await use({
      runStatus: "running",
      graphStatus: "running",
      graphError: false,
      uploadedFiles: [],
    });
  },
  workspacePage: async ({ page, apiState }, use) => {
    await installApiMocks(page, apiState);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Choose a project" })).toBeVisible();
    await page.getByRole("button", { name: "Open project E2E Project" }).click();
    await expect(page.getByRole("navigation", { name: "Project workspace" })).toBeVisible();
    await use(page);
  },
});

export { expect };

export async function selectWorkspaceTab(page: Page, name: string) {
  const navigation = page.getByRole("navigation", { name: "Project workspace" });
  await navigation.getByRole("button", { name, exact: true }).click();
  await expect(navigation.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
}

export async function openBuilderFrame(page: Page) {
  await selectWorkspaceTab(page, "Builder");
  const iframe = page.getByTitle("DAG Builder");
  await expect(iframe).toBeVisible();
  const frame = page.frameLocator('iframe[title="DAG Builder"]');
  await expect(frame.getByPlaceholder("workflow-name")).toBeVisible();
  return frame;
}

export async function openBuilderDraft(page: Page) {
  const frame = await openBuilderFrame(page);
  const workflowName = frame.getByPlaceholder("workflow-name");
  await workflowName.fill("e2e-builder-workflow");
  await expect(workflowName).toHaveValue("e2e-builder-workflow");
  await expect(frame.getByRole("application")).toBeVisible();
  return frame;
}

export async function addPromptNode(page: Page) {
  const frame = await openBuilderDraft(page);
  const canvas = frame.locator(".react-flow");
  await expect(canvas).toBeVisible();
  await canvas.dblclick({ position: { x: 640, y: 360 } });
  const promptChoice = frame.getByRole("button", { name: /^Prompt\s+Inline AI prompt$/ });
  await expect(promptChoice).toBeVisible();
  await promptChoice.click();
  await expect(frame.getByRole("button", { name: "Expand full node details" })).toBeVisible();
  return frame;
}

export function inspectorControl(frame: FrameLocator, label: string) {
  return frame
    .getByText(label, { exact: true })
    .locator("..")
    .locator("input, select, textarea")
    .first();
}
