import { expect, test as base } from "@stablyai/playwright-test";
import type { FrameLocator, Locator, Page, Route } from "@playwright/test";

import { SCIENTIFIC_TEMPLATES } from "./inventory";

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
  runListRequests: number;
  requests: Array<{ method: string; path: string; postData: string | null }>;
  showRefreshedRegistryData: boolean;
  showRefreshedRun: boolean;
  failTypedDefinitionRead: boolean;
  unexpectedRequests: string[];
}

const BACKEND_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):18000\//;
const PIPELINE_ENGINE_API_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\//;
const E2E_CODEBASE_CWD = "/tmp/kady-e2e-codebase";
const now = Date.now();
export const WORKFLOW_RUN_ID = `wrun_${"1".repeat(32)}`;
export const REFRESHED_WORKFLOW_RUN_ID = `wrun_${"2".repeat(32)}`;
type HelperSessionProfile = "raindrop" | "workflow-rescue";
type HelperSessionSource = { kind: "run" | "session"; id: string };

function helperSessionId(profile: HelperSessionProfile, source: HelperSessionSource) {
  return `helper-${profile}-${source.kind}-${source.id.replace(/^wrun_/, "")}`;
}

const RAINDROP_RUN_SOURCE = { kind: "run", id: WORKFLOW_RUN_ID } as const;
const RAINDROP_SESSION_SOURCE = { kind: "session", id: "session-e2e" } as const;
const WORKFLOW_RESCUE_SOURCE = { kind: "run", id: WORKFLOW_RUN_ID } as const;
const RAINDROP_RUN_HELPER_SESSION_ID = helperSessionId("raindrop", RAINDROP_RUN_SOURCE);
const FIXTURE_SESSION_IDS = new Set([
  "session-e2e",
  RAINDROP_RUN_HELPER_SESSION_ID,
  helperSessionId("raindrop", RAINDROP_SESSION_SOURCE),
  helperSessionId("workflow-rescue", WORKFLOW_RESCUE_SOURCE),
]);
const TYPED_WORKFLOW_IDS = new Set([
  "e2e-workflow",
  ...SCIENTIFIC_TEMPLATES.map((template) => template.id),
]);
export const RAINDROP_ANALYST_QUESTION = "Which persisted event identifies the failed node?";
export const RAINDROP_ANALYST_RESPONSE =
  `Run ${WORKFLOW_RUN_ID} reached run_started before node analyze entered node_started.`;

function matchingTypedWorkflowId(path: string, suffix = "") {
  for (const workflowId of TYPED_WORKFLOW_IDS) {
    if (path === `/dag-workflows/${encodeURIComponent(workflowId)}${suffix}`) return workflowId;
  }
  return null;
}

function matchingFixtureSessionId(path: string, suffix: string) {
  for (const sessionId of FIXTURE_SESSION_IDS) {
    if (path === `/sessions/${encodeURIComponent(sessionId)}${suffix}`) return sessionId;
  }
  return null;
}

function isExpectedHelperSource(
  profile: HelperSessionProfile,
  source: { kind?: string; id?: string },
): source is HelperSessionSource {
  return (
    profile === "raindrop" &&
    ((source.kind === RAINDROP_SESSION_SOURCE.kind && source.id === RAINDROP_SESSION_SOURCE.id) ||
      (source.kind === RAINDROP_RUN_SOURCE.kind && source.id === RAINDROP_RUN_SOURCE.id))
  ) || (
    profile === "workflow-rescue" &&
    source.kind === WORKFLOW_RESCUE_SOURCE.kind &&
    source.id === WORKFLOW_RESCUE_SOURCE.id
  );
}

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

function runSummary(status: RunStatus, id = WORKFLOW_RUN_ID, workflowId = "e2e-workflow") {
  return {
    id,
    workflowId,
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

function runRecord(status: RunStatus, id = WORKFLOW_RUN_ID, workflowId = "e2e-workflow") {
  const graph = graphDocument(workflowId);
  return {
    manifest: {
      storageVersion: 1,
      id,
      projectId: "default",
      workflowId,
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
      runId: id,
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

function vendoredWorkflowDefinition() {
  return {
    name: "E2E Workflow",
    description: "Deterministic E2E workflow",
    nodes: [
      {
        id: "analyze",
        prompt: "Inspect the evidence. Compare every source. Report the bounded result.",
      },
    ],
  };
}

function validationResult(definition: unknown): { valid: boolean; errors?: string[] } {
  if (definition === null || typeof definition !== "object") {
    return { valid: false, errors: ["Workflow definition is required."] };
  }
  const record = definition as {
    nodes?: Array<{
      settings?: {
        autonomy?: unknown;
        billingMode?: unknown;
        conditions?: unknown;
        databases?: unknown;
        deliberation?: unknown;
        harness?: unknown;
        hyperparameters?: unknown;
        skills?: unknown;
        subagents?: unknown;
      };
    }>;
  };
  const settings = record.nodes?.[0]?.settings;
  if (settings?.deliberation !== undefined) {
    return { valid: false, errors: ["Pending unit S5: deliberation binding is not implemented."] };
  }
  if (
    settings?.hyperparameters !== undefined ||
    settings?.conditions !== undefined ||
    settings?.harness !== undefined ||
    settings?.databases !== undefined ||
    settings?.skills !== undefined ||
    settings?.subagents !== undefined ||
    settings?.autonomy !== undefined ||
    (settings?.billingMode !== undefined && settings.billingMode !== "inherit")
  ) {
    return { valid: false, errors: ["Pending unit S4: runtime binding is not implemented."] };
  }
  return { valid: true };
}

function routeJson(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, json: body, headers });
}

async function installStreamingFetch(page: Page) {
  await page.addInitScript((fixtureSessions) => {
    const nativeFetch = window.fetch.bind(window);
    let heldRunController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const e2eWindow = window as typeof window & {
      __kadyE2eAbortRequests: string[];
      __kadyE2eCompleteHeldRun: () => void;
      __kadyE2eRunRequests: Array<{ message: string; sessionId: string }>;
    };
    e2eWindow.__kadyE2eAbortRequests = [];
    e2eWindow.__kadyE2eRunRequests = [];
    const encode = (frame: Record<string, unknown>) =>
      new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
    e2eWindow.__kadyE2eCompleteHeldRun = () => {
      if (!heldRunController) throw new Error("No held E2E stream is available to complete.");
      heldRunController.enqueue(encode({ seq: 4, type: "turn_end" }));
      heldRunController.enqueue(encode({ seq: 5, type: "done" }));
      heldRunController.close();
      heldRunController = null;
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const runPaths = new Set(
        fixtureSessions.sessionIds.map((sessionId) => `/sessions/${encodeURIComponent(sessionId)}/run`),
      );
      if (method === "POST" && runPaths.has(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as { message?: unknown };
        const message = typeof requestBody.message === "string" ? requestBody.message : "";
        e2eWindow.__kadyE2eRunRequests.push({ message, sessionId });
        if (
          sessionId === fixtureSessions.raindropRunSessionId &&
          message !== "Which persisted event identifies the failed node?"
        ) {
          return new Response(JSON.stringify({ detail: "Unexpected Raindrop source or analyst question." }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          });
        }
        const mode = window.localStorage.getItem("kady:e2e-run-mode") ?? "complete";
        const responseText = sessionId === fixtureSessions.raindropRunSessionId
          ? `Run wrun_${"1".repeat(32)} reached run_started before node analyze entered node_started.`
          : `Assistant confirmed: ${message}`;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode({ seq: 1, type: "run_start", runId: "run-e2e" }));
            controller.enqueue(encode({ seq: 2, type: "turn_start" }));
            controller.enqueue(encode({ seq: 3, type: "text_delta", delta: responseText }));
            if (mode === "streaming") {
              heldRunController = controller;
              return;
            }
            if (mode === "error") {
              controller.enqueue(
                encode({ seq: 4, type: "error", message: "simulated provider failure" }),
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
      const abortPaths = new Set(
        fixtureSessions.sessionIds.map((sessionId) => `/sessions/${encodeURIComponent(sessionId)}/abort`),
      );
      if (method === "POST" && abortPaths.has(url.pathname)) {
        e2eWindow.__kadyE2eAbortRequests.push(decodeURIComponent(url.pathname.split("/")[2] ?? ""));
        heldRunController?.close();
        heldRunController = null;
        return new Response(JSON.stringify({ restored: ["restored steering"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return nativeFetch(input, init);
    };
  }, {
    sessionIds: [...FIXTURE_SESSION_IDS],
    raindropRunSessionId: RAINDROP_RUN_HELPER_SESSION_ID,
  });
}

async function installPipelineEngineApiMocks(page: Page, state: MockApiState) {
  await page.route(PIPELINE_ENGINE_API_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.port === "18000") return route.fallback();

    const path = url.pathname;
    const method = request.method();
    state.requests.push({ method, path, postData: request.postData() });

    if (path === "/api/codebases" && method === "GET") {
      return routeJson(route, [{
        id: "e2e-codebase",
        name: "E2E Codebase",
        repository_url: null,
        default_cwd: E2E_CODEBASE_CWD,
        default_branch: null,
        ai_assistant_type: "pi",
        commands: {},
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      }]);
    }
    if (path === "/api/providers" && method === "GET") {
      return routeJson(route, { providers: [] });
    }
    if (
      path === "/api/commands" &&
      method === "GET" &&
      [null, E2E_CODEBASE_CWD].includes(url.searchParams.get("cwd"))
    ) {
      return routeJson(route, { commands: [] });
    }
    if (
      path === "/api/workflows" &&
      method === "GET" &&
      [null, E2E_CODEBASE_CWD].includes(url.searchParams.get("cwd"))
    ) {
      return routeJson(route, { workflows: [], recommended: [] });
    }
    const isExactBoundWorkflow =
      path === "/api/workflows/e2e-vendored" &&
      url.searchParams.get("cwd") === E2E_CODEBASE_CWD &&
      url.searchParams.get("codebaseId") === "e2e-codebase";
    if (isExactBoundWorkflow && method === "GET") {
      return routeJson(route, {
        workflow: vendoredWorkflowDefinition(),
        filename: "e2e-workflow.yaml",
        workflowId: "e2e-vendored",
        source: "project",
      });
    }
    if (path === "/api/workflows/validate" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { definition?: unknown };
      return routeJson(route, validationResult(body.definition));
    }
    if (isExactBoundWorkflow && method === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}") as { definition?: unknown };
      return routeJson(route, {
        workflow: body.definition,
        filename: "e2e-workflow.yaml",
        workflowId: "e2e-vendored",
        source: "project",
      });
    }
    if (
      path === "/api/workflows/e2e-vendored" ||
      path === "/api/workflows/validate" ||
      path === "/api/workflows" ||
      path === "/api/codebases" ||
      path === "/api/commands"
    ) {
      state.unexpectedRequests.push(`${method} ${path}`);
      return routeJson(route, { detail: `Unexpected E2E engine request: ${method} ${path}` }, 501);
    }
    return route.fallback();
  });
}

async function installApiMocks(page: Page, state: MockApiState) {
  await installStreamingFetch(page);
  await installPipelineEngineApiMocks(page, state);
  await page.route(BACKEND_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    state.requests.push({ method, path, postData: request.postData() });

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
    if (path === "/projects/activity" && method === "GET") return routeJson(route, { activities: {} });
    if (path === "/projects/default/costs" && method === "GET") {
      return routeJson(route, {
        projectId: "default",
        totalUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        limitUsd: null,
        budget: emptyBudget(),
      });
    }
    if (path === "/sandbox/tree" && method === "GET") {
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
    if (path === "/skills" && method === "GET") {
      return routeJson(route, [{
        id: "scientific-dag-studio",
        name: "scientific-dag-studio",
        description: "Design and inspect bounded scientific DAG workflows.",
      }]);
    }
    if (path === "/skills/all" && method === "GET") {
      return routeJson(route, {
        scope: url.searchParams.get("scope") === "global" ? "global" : "project",
        enabled: [{
          id: "scientific-dag-studio",
          name: "scientific-dag-studio",
          description: "Design and inspect bounded scientific DAG workflows.",
          origin: "catalogue",
        }],
        disabled: [],
        problems: [],
        shadowed: [],
      });
    }
    if (path === "/model-providers" && method === "GET") return routeJson(route, { providers: [] });
    if (path === "/model-providers/models" && method === "GET") return routeJson(route, { models: [] });
    if (path === "/credentials" && method === "GET") return routeJson(route, { openrouter: { set: true } });
    if (path === "/ollama/models" && method === "GET") return routeJson(route, { available: false, models: [] });
    if (path === "/openai-compatible/models" && method === "GET") {
      return routeJson(route, { available: false, configured: false, models: [] });
    }
    if (path === "/nvidia/models" && method === "GET") {
      return routeJson(route, { configured: false, models: [] });
    }
    if (path === "/system/resources" && method === "GET") return route.fulfill({ status: 204 });
    if (path === "/modal/instances" && method === "GET") {
      return routeJson(route, {
        modalConfigured: false,
        instances: [
          {
            id: "cpu",
            label: "CPU · 1 core",
            kind: "cpu",
            gpu: null,
            gpuCount: 1,
            cpu: 1,
            memoryMiB: 2048,
            pricePerHour: 0.05,
            defaultImage: "python:3.13-slim",
            maxGpuCount: 1,
            estimatedBilling: true,
            pricing: {
              estimated: true,
              unit: "USD/hour",
              totalPerHour: 0.05,
              multiplier: "per preset",
            },
            legacy: true,
          },
        ],
        defaults: {
          instanceId: "cpu",
          gpuCount: 1,
          fallback: null,
          cache: "project",
        },
        estimatedBilling: true,
        pricing: {
          updatedAt: "2026-07-20",
          source: "K-Dense curated Modal resource estimates",
          estimated: true,
          unit: "USD/hour",
        },
      });
    }
    if (path === "/modal/jobs" && method === "GET") return routeJson(route, { jobs: [], total: 0 });
    if (path === "/raindrop/health" && method === "GET") {
      return routeJson(route, { healthy: false });
    }
    if (path === "/version/latest" && method === "GET") {
      return routeJson(route, { latestVersion: null });
    }
    if (path === "/sessions" && method === "POST") return routeJson(route, { id: "session-e2e" });
    if (path === "/sessions" && method === "GET") {
      return routeJson(route, [
        { id: "session-e2e", name: "E2E chat", created: now, modified: now, messageCount: 2 },
      ]);
    }
    const runStateSessionId = matchingFixtureSessionId(path, "/run/state");
    if (runStateSessionId && method === "GET") {
      return routeJson(route, { status: "none", run: null });
    }
    const historySessionId = matchingFixtureSessionId(path, "/history");
    if (historySessionId && method === "GET") {
      return routeJson(route, { messages: [], contextUsage: null });
    }
    const costsSessionId = matchingFixtureSessionId(path, "/costs");
    if (costsSessionId && method === "GET") {
      return routeJson(route, {
        sessionId: costsSessionId,
        totalUsd: 0,
        totalTokens: 0,
        agentUsd: 0,
        subagentUsd: 0,
        computeUsd: 0,
        entries: [],
      });
    }
    if (path === "/sessions/session-e2e/workflow-run-state" && method === "GET") {
      const failed = state.graphError;
      return routeJson(route, {
        state: {
          schemaVersion: 1,
          runId: WORKFLOW_RUN_ID,
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
    if (
      matchingFixtureSessionId(path, "/notebook") ||
      matchingFixtureSessionId(path, "/interview")
    ) {
      return routeJson(route, path.endsWith("interview") ? { pending: null } : { entries: [] });
    }
    if (matchingFixtureSessionId(path, "/steer")) {
      return routeJson(route, { pending: ["steering"] });
    }

    if (path === "/pipelines/health" && method === "GET") return routeJson(route, { healthy: true });
    if (path === "/pipelines" && method === "GET") {
      return routeJson(route, {
        workflows: [
          {
            source: "project",
            filename: "e2e-workflow.yaml",
            workflowId: "e2e-vendored",
            codebaseId: "e2e-codebase",
            workflow: {
              name: "E2E Workflow",
              description: state.showRefreshedRegistryData
                ? "Refreshed deterministic E2E workflow"
                : "Deterministic E2E workflow",
              nodes: [{ id: "analyze" }],
            },
          },
        ],
      });
    }
    if (path === "/pipelines/e2e-vendored/run" && method === "POST") {
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
            description: state.showRefreshedRegistryData
              ? "Refreshed deterministic E2E workflow"
              : "Deterministic E2E workflow",
            nodeCount: 1,
            edgeCount: 0,
          },
        ],
      });
    }
    const definitionId = matchingTypedWorkflowId(path);
    if (definitionId && method === "PUT") {
      const graph = JSON.parse(request.postData() ?? "{}") as ReturnType<typeof graphDocument>;
      return routeJson(
        route,
        storedDefinition(definitionId, graph.name, graph),
        200,
        { ETag: '"1"' },
      );
    }
    if (definitionId && method === "GET") {
      if (definitionId === "e2e-workflow" && state.failTypedDefinitionRead) {
        // A malformed success exercises the panel's caught topology-read failure without
        // intentionally adding an HTTP 503 browser-console error to this runtime-clean test.
        return routeJson(route, null);
      }
      return routeJson(route, storedDefinition(definitionId), 200, { ETag: '"1"' });
    }
    const typedRunWorkflowId = matchingTypedWorkflowId(path, "/runs");
    if (typedRunWorkflowId && method === "POST") {
      return routeJson(route, runRecord("queued", WORKFLOW_RUN_ID, typedRunWorkflowId), 201);
    }
    if (path === "/dag-workflow-runs" && method === "GET") {
      state.runListRequests += 1;
      return routeJson(route, {
        runs: [
          runSummary(state.runStatus),
          ...(state.showRefreshedRun
            ? [runSummary("queued", REFRESHED_WORKFLOW_RUN_ID)]
            : []),
        ],
      });
    }
    if (path === `/dag-workflow-runs/${WORKFLOW_RUN_ID}` && method === "GET") {
      return routeJson(route, runRecord(state.runStatus));
    }
    if (path === `/dag-workflow-runs/${WORKFLOW_RUN_ID}/budget` && method === "GET") {
      return routeJson(route, {
        runId: WORKFLOW_RUN_ID,
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
    if (path === `/dag-workflow-runs/${WORKFLOW_RUN_ID}/events` && method === "GET") {
      return routeJson(route, {
        events: [
          { schemaVersion: 1, eventId: "event-1", runId: WORKFLOW_RUN_ID, seq: 1, ts: now, type: "run_started" },
          { schemaVersion: 1, eventId: "event-2", runId: WORKFLOW_RUN_ID, seq: 2, ts: now + 1, type: "node_started", nodeId: "analyze" },
        ],
        lastSeq: 2,
        hasMore: false,
        diagnostics: [],
      });
    }
    const controlMatch = path.match(
      new RegExp(`^/dag-workflow-runs/${WORKFLOW_RUN_ID}/(cancel|resume|rescue)$`),
    );
    if (controlMatch && method === "POST") {
      const status = controlMatch[1] === "cancel" ? "cancelled" : "running";
      return routeJson(route, runRecord(status));
    }
    if (path === "/helper-sessions/raindrop/context" && method === "POST") {
      const source = JSON.parse(request.postData() ?? "{}") as { kind?: string; id?: string };
      const expectedSource =
        (source.kind === "session" && source.id === "session-e2e") ||
        (source.kind === "run" && source.id === WORKFLOW_RUN_ID);
      if (!expectedSource) {
        return routeJson(route, { detail: "Unexpected Raindrop context source." }, 422);
      }
      return routeJson(route, {
        source,
        context: source.kind === "run"
          ? `Run ${WORKFLOW_RUN_ID}: run_started, then node_started for analyze.`
          : "Session session-e2e: user request followed by an assistant answer.",
        truncated: false,
        observedEntries: 2,
        totalEntries: 2,
      });
    }
    const helperSession = path.match(/^\/helper-sessions\/(raindrop|workflow-rescue)$/);
    if (helperSession && method === "POST") {
      const profile = helperSession[1] as HelperSessionProfile;
      const source = JSON.parse(request.postData() ?? "{}") as { kind?: string; id?: string };
      if (!isExpectedHelperSource(profile, source)) {
        return routeJson(route, { detail: "Unexpected helper-session source binding." }, 422);
      }
      return routeJson(route, {
        id: helperSessionId(profile, source),
        source,
      });
    }
    if (path === "/console/runs" && method === "GET") {
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
    if (path === "/console/loops" && method === "GET") return routeJson(route, []);

    state.unexpectedRequests.push(`${method} ${path}`);
    return routeJson(
      route,
      { detail: `Unexpected E2E request: ${method} ${path}` },
      501,
    );
  });
}

export const test = base.extend<{
  apiState: MockApiState;
  runtimeErrors: void;
  workspacePage: Page;
}>({
  apiState: async ({}, use) => {
    await use({
      runStatus: "running",
      graphStatus: "running",
      graphError: false,
      uploadedFiles: [],
      runListRequests: 0,
      requests: [],
      showRefreshedRegistryData: false,
      showRefreshedRun: false,
      failTypedDefinitionRead: false,
      unexpectedRequests: [],
    });
  },
  runtimeErrors: [async ({ page, apiState }, use) => {
    const failures: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    await use();
    expect(
      apiState.unexpectedRequests,
      `Unexpected E2E backend requests:\n${apiState.unexpectedRequests.map((request) => `- ${request}`).join("\n")}`,
    ).toEqual([]);
    expect(failures, "Browser runtime errors must fail the owning Playwright test.").toEqual([]);
  }, { auto: true }],
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

export function requestCount(state: MockApiState, method: string, path: string) {
  return state.requests.filter(
    (request) => request.method === method && request.path === path,
  ).length;
}

export function lastRequestPostData(state: MockApiState, method: string, path: string) {
  return state.requests.filter(
    (request) => request.method === method && request.path === path,
  ).at(-1)?.postData;
}

export async function selectWorkspaceTab(page: Page, name: string) {
  const navigation = page.getByRole("navigation", { name: "Project workspace" });
  await navigation.getByRole("button", { name, exact: true }).click();
  await expect(navigation.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
}

export async function createTypedWorkflowFromTemplate(
  page: Page,
  templateId: string,
): Promise<{ details: Locator; rawDefinition: Locator; workflowName: string }> {
  await selectWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
  await page.getByRole("button", { name: "New typed workflow" }).click();
  await page.getByLabel("Workflow template").selectOption(templateId);
  await expect(page.getByLabel("New workflow id")).toHaveValue(templateId);
  const workflowNameInput = page.getByLabel("New workflow name");
  const workflowName = await workflowNameInput.inputValue();
  expect(workflowName).not.toBe("");
  await page.getByRole("button", { name: "Create and open" }).click();
  const details = page.getByRole("region", { name: workflowName, exact: true });
  await expect(details).toBeVisible();
  const rawDefinition = details.getByTestId("raw-typed-definition");
  await expect(rawDefinition).toBeVisible();
  return { details, rawDefinition, workflowName };
}

export async function openBuilderFrame(page: Page) {
  await selectWorkspaceTab(page, "Builder");
  const iframe = page.getByTitle("DAG Builder");
  await expect(iframe).toBeVisible();
  const frame = page.frameLocator('iframe[title="DAG Builder"]');
  await expect(frame.getByPlaceholder("workflow-name")).toBeVisible();
  return frame;
}

export async function openBuilderDraft(page: Page, workflowName = "e2e-builder-workflow") {
  const frame = await openBuilderFrame(page);
  const workflowNameInput = frame.getByPlaceholder("workflow-name");
  await workflowNameInput.fill(workflowName);
  await expect(workflowNameInput).toHaveValue(workflowName);
  await expect(frame.getByRole("application")).toBeVisible();
  return frame;
}

export async function openBoundBuilder(page: Page) {
  await selectWorkspaceTab(page, "Scientific Pipelines");
  await expect(page.getByRole("heading", { name: "Workflow registry" })).toBeVisible();
  await page.getByRole("button", { name: "Edit E2E Workflow with vendored engine" }).click();
  const navigation = page.getByRole("navigation", { name: "Project workspace" });
  await expect(navigation.getByRole("button", { name: "Builder" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const iframe = page.getByTitle("DAG Builder");
  await expect(iframe).toHaveAttribute(
    "src",
    /edit=e2e-vendored&codebaseId=e2e-codebase/,
  );
  const frame = page.frameLocator('iframe[title="DAG Builder"]');
  await expect(frame.getByPlaceholder("workflow-name")).toHaveValue("E2E Workflow");
  const promptNode = frame.locator(".react-flow__node").filter({ hasText: "Prompt" });
  await expect(promptNode).toHaveCount(1);
  await promptNode.click();
  await expect(frame.getByRole("button", { name: "Expand full node details" })).toBeVisible();
  return frame;
}

export async function addPromptNode(
  page: Page,
  options: { prompt?: string; workflowName?: string } = {},
) {
  const frame = await openBuilderDraft(page, options.workflowName);
  const canvas = frame.locator(".react-flow");
  await expect(canvas).toBeVisible();
  await canvas.dblclick({ position: { x: 640, y: 360 } });
  const promptChoice = frame.getByRole("button", { name: /^Prompt\s+Inline AI prompt$/ });
  await expect(promptChoice).toBeVisible();
  await promptChoice.click();
  await expect(frame.getByRole("button", { name: "Expand full node details" })).toBeVisible();
  const prompt = options.prompt ?? "Inspect the evidence.\nCompare every source.\nReport the bounded result.";
  const promptInput = frame.getByPlaceholder("Enter inline prompt...");
  await promptInput.fill(prompt);
  await expect(promptInput).toHaveValue(prompt);
  return frame;
}

export function inspectorControl(frame: FrameLocator, label: string) {
  return frame
    .getByText(label, { exact: true })
    .locator("..")
    .locator("input, select, textarea")
    .first();
}
