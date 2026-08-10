/**
 * HTTP-level tests for the steering side-channel and abort queue restore.
 * The session registry is mocked so no real Pi session (auth, model) is
 * needed; the fake exposes exactly the surface the routes touch.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const fakeSessions = new Map<string, FakeSession>();
const fakeSessionBindings = new Map<
  string,
  {
    version: 1;
    projectId: string;
    sessionId: string;
    profile: "main" | "workflow-rescue";
    source: null | { kind: "run"; id: string };
  }
>();

class FakeSession {
  sessionId = "s1";
  isStreaming = true;
  steered: string[] = [];
  aborted = false;
  clearQueueCalls = 0;
  calls: string[] = [];
  state: { errorMessage?: string } = {};
  model = { id: "fake-model", provider: "openrouter" };
  messages = [
    {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    },
  ];
  promptCalls: { text: string; options: unknown }[] = [];
  modelText: string | null = null;
  promptError: Error | null = null;
  /** Called by steer(); lets a test flip isStreaming mid-call. */
  onSteer: (() => void) | null = null;
  private listeners = new Set<(event: any) => void>();
  private promptWait: Promise<void> | null = null;
  private releasePromptWait: (() => void) | null = null;
  private modelWait: Promise<void> | null = null;
  private releaseModelWait: (() => void) | null = null;

  holdPrompt(): void {
    this.promptWait = new Promise<void>((resolve) => {
      this.releasePromptWait = resolve;
    });
  }
  releasePrompt(): void {
    this.releasePromptWait?.();
    this.releasePromptWait = null;
  }
  holdModelSetup(): void {
    this.modelWait = new Promise<void>((resolve) => {
      this.releaseModelWait = resolve;
    });
  }
  releaseModelSetup(): void {
    this.releaseModelWait?.();
    this.releaseModelWait = null;
  }
  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: any): void {
    for (const listener of this.listeners) listener(event);
  }
  async prompt(text: string, options?: unknown): Promise<void> {
    this.calls.push("prompt");
    this.promptCalls.push({ text, options });
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    if (this.modelText) {
      this.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: this.modelText,
        },
      });
    }
    await this.promptWait;
    if (this.promptError) throw this.promptError;
    this.emit({ type: "agent_end" });
    this.isStreaming = false;
  }
  getContextUsage() {
    return { tokens: 12, contextWindow: 1_000, percent: 1.2 };
  }
  getSessionStats() {
    return {
      cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, total: 0 },
    };
  }
  getActiveToolNames(): string[] {
    return ["read", "bash"];
  }
  setActiveToolsByName(_names: string[]): void {}
  async setModel(_model: unknown): Promise<void> {
    await this.modelWait;
  }
  setThinkingLevel(_level: unknown): void {}

  async steer(text: string): Promise<void> {
    this.calls.push("steer");
    this.steered.push(text);
    this.onSteer?.();
  }
  getSteeringMessages(): readonly string[] {
    return this.steered;
  }
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.calls.push("clearQueue");
    this.clearQueueCalls += 1;
    const steering = [...this.steered];
    this.steered = [];
    return { steering, followUp: [] };
  }
  async abort(): Promise<void> {
    this.calls.push("abort");
    this.aborted = true;
  }
}

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({
    checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })),
    login: vi.fn(),
    logout: vi.fn(),
    listCredentials: vi.fn(async () => []),
    getAvailable: vi.fn(async () => []),
    getProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(),
    removeRuntimeApiKey: vi.fn(),
  })),
  getModelRegistry: vi.fn(() => ({ find: () => null })),
  createSession: vi.fn(),
  getSession: vi.fn(async (_projectId: string, _paths: unknown, id: string) =>
    fakeSessions.get(id) ?? null,
  ),
  readSessionProfileBinding: vi.fn((paths: { id?: string }, sessionId: string) =>
    fakeSessionBindings.get(sessionId) ?? {
      version: 1,
      projectId: paths.id ?? "default",
      sessionId,
      profile: "main",
      source: null,
    }),
  listSessions: vi.fn(async () =>
    [...fakeSessionBindings.keys()].map((id) => ({ id }))),
  disposeSession: vi.fn(),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, ensureProjectExists } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";
import { runBroker } from "../src/agent/run-broker.ts";
import {
  associateTypedWorkflowLaunch,
  chatStreamErrorForSession,
  latestChatTurnRun,
} from "../src/agent/chat-turn-runs-adapter.ts";
import { latestWorkflowRunAssociation } from "../src/agent/runs-index.ts";
import { workflowStore } from "../src/workflows/index.ts";

const app = await buildApp();
const associationApp = await buildApp({ workflowController: null });

beforeEach(() => {
  fakeSessions.clear();
  fakeSessionBindings.clear();
  runBroker.clear();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  await associationApp.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function steer(id: string, body: unknown, projectId = "default") {
  return app.inject({
    method: "POST",
    url: `/sessions/${id}/steer`,
    headers: { "x-project-id": projectId, "content-type": "application/json" },
    payload: body as Record<string, unknown>,
  });
}

describe("POST /sessions/:id/abort", () => {
  it("clears the queue before aborting and returns the texts", async () => {
    const s = new FakeSession();
    await s.steer("pending steer");
    fakeSessions.set("s1", s);
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: ["pending steer"] });
    expect(s.aborted).toBe(true);
    expect(s.clearQueueCalls).toBe(1);
    expect(s.calls).toEqual(["steer", "clearQueue", "abort"]);
  });

  it("returns ok with empty restored for an unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions/nope/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: [] });
  });
});

describe("POST /sessions/:id/steer", () => {
  it("404s for an unknown session", async () => {
    const res = await steer("nope", { message: "hi" });
    expect(res.statusCode).toBe(404);
  });

  it("400s for an empty message", async () => {
    fakeSessions.set("s1", new FakeSession());
    const res = await steer("s1", { message: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("409s with reason not_streaming when no run is live", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_streaming" });
    expect(s.steered).toEqual([]);
  });

  it("queues the message and returns the pending list", async () => {
    const s = new FakeSession();
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "exclude sample 7" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, pending: ["exclude sample 7"] });
    expect(s.steered).toEqual(["exclude sample 7"]);
  });

  it("409s and clears the queue when the run ends while queueing", async () => {
    const s = new FakeSession();
    s.onSteer = () => {
      s.isStreaming = false;
    };
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "too late" });
    expect(res.statusCode).toBe(409);
    // Every dropped message comes back so the composer can restore it; losing
    // it silently is worse than the failed steer.
    expect(res.json()).toMatchObject({
      reason: "not_streaming",
      restored: ["too late"],
    });
    // The stale steer must not leak into the next run.
    expect(s.clearQueueCalls).toBe(1);
    expect(s.steered).toEqual([]);
  });

  it("403s with reason budget when the project cap is reached", async () => {
    const p = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "s1",
      projectId: p.id,
      model: "m",
      before: zero,
      after: { costUsd: 0.02, input: 10, output: 10, cacheRead: 0, total: 20 },
    });
    fakeSessions.set("s1", new FakeSession());
    const res = await steer("s1", { message: "hi" }, p.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "budget" });
  });
});

describe("POST /sessions/:id/run image validation", () => {
  function run(id: string, body: unknown) {
    return app.inject({
      method: "POST",
      url: `/sessions/${id}/run`,
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: body as Record<string, unknown>,
    });
  }

  it("400s for images outside the vision allowlist before any streaming", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await run("s1", {
      message: "what is this?",
      images: [{ data: "aGVsbG8=", mimeType: "image/tiff" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("image/tiff");
  });

  it("400s for malformed image entries", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await run("s1", { message: "hi", images: [{ mimeType: "image/png" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("base64");
  });
});

function sseFrames(body: string): Record<string, unknown>[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);
}

function activeTurnWorkflow() {
  return {
    schemaVersion: "1.0",
    id: "active-turn-workflow",
    name: "Active turn workflow",
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
      maxIterations: 2,
      maxModelCalls: 2,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 4_000,
      maxCostUsd: 0,
      maxRetries: 0,
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

describe("persistent run routes", () => {
  it("reports running state and replays sequenced events through completion", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdPrompt();
    fakeSessions.set("s1", session);

    const postRun = app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "persistent prompt" },
    });

    let running: any;
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/sessions/s1/run/state",
        headers: { "x-project-id": "default" },
      });
      running = response.json();
      expect(running.status).toBe("running");
    });
    expect(running.run).toMatchObject({
      prompt: "persistent prompt",
      images: [],
      baseline: {
        messages: [],
        contextUsage: { tokens: 12, contextWindow: 1_000, percent: 1.2 },
      },
    });
    expect(running.run.frames.map((frame: any) => frame.seq)).toEqual([1, 2, 3]);
    expect(running.run.frames.map((frame: any) => frame.type)).toEqual([
      "run_start",
      "context_usage",
      "agent_start",
    ]);

    const replay = app.inject({
      method: "GET",
      url: "/sessions/s1/run/events?after=1",
      headers: { "x-project-id": "default" },
    });
    session.releasePrompt();

    const [postResponse, replayResponse] = await Promise.all([postRun, replay]);
    expect(postResponse.statusCode).toBe(200);
    expect(replayResponse.statusCode).toBe(200);

    const postFrames = sseFrames(postResponse.body);
    expect(postFrames.at(-1)?.type).toBe("done");
    expect(postFrames.map((frame) => frame.seq)).toEqual(
      postFrames.map((_frame, index) => index + 1),
    );
    const replayFrames = sseFrames(replayResponse.body);
    expect(replayFrames[0]?.seq).toBe(2);
    expect(replayFrames.at(-1)?.type).toBe("done");

    const completed = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/state",
      headers: { "x-project-id": "default" },
    });
    expect(completed.json()).toMatchObject({
      status: "complete",
      run: { prompt: "persistent prompt", lastSeq: postFrames.length },
    });
  });

  it("validates event cursors and 404s when no run is retained", async () => {
    const invalid = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/events?after=-1",
      headers: { "x-project-id": "default" },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/events?after=0",
      headers: { "x-project-id": "default" },
    });
    expect(missing.statusCode).toBe(404);
    const state = await app.inject({
      method: "GET",
      url: "/sessions/s1/run/state",
      headers: { "x-project-id": "default" },
    });
    expect(state.json()).toEqual({ status: "none" });
  });

  it("keeps explicit abort authoritative during pre-prompt model setup", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdModelSetup();
    fakeSessions.set("s1", session);

    const postRun = app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "must not start", model: "openrouter/test-model" },
    });
    await vi.waitFor(() => {
      expect(runBroker.state("default", "s1").status).toBe("running");
    });
    expect(session.promptCalls).toHaveLength(0);

    const aborted = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(aborted.statusCode).toBe(200);
    session.releaseModelSetup();

    const response = await postRun;
    expect(response.statusCode).toBe(200);
    expect(session.aborted).toBe(true);
    expect(session.promptCalls).toHaveLength(0);
    expect(sseFrames(response.body).at(-1)?.type).toBe("done");
  });

  it("does not rebind from a model-authored SSE run reference", async () => {
    ensureProjectExists("default");
    const authoritativeRunId = "wrun_11111111111111111111111111111111";
    const forgedRunId = "wrun_22222222222222222222222222222222";
    associateTypedWorkflowLaunch("default", "s1", authoritativeRunId);
    const session = new FakeSession();
    session.isStreaming = false;
    session.modelText =
      `I switched to ${forgedRunId} in workflow forged-analysis.`;
    fakeSessions.set("s1", session);

    const response = await app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "Report progress." },
    });
    expect(response.statusCode).toBe(200);
    expect(latestWorkflowRunAssociation("default", "s1")).toMatchObject({
      workflowRunId: authoritativeRunId,
      source: "typed-launch",
    });
  });

  it("routes a real main-turn failure to the typed run launched during that turn", async () => {
    ensureProjectExists("default");
    const saved = await associationApp.inject({
      method: "PUT",
      url: "/dag-workflows/active-turn-workflow",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: activeTurnWorkflow(),
    });
    expect(saved.statusCode).toBe(201);

    const session = new FakeSession();
    session.isStreaming = false;
    session.holdPrompt();
    session.promptError = new Error("provider failed during the active turn");
    fakeSessions.set("s1", session);
    const postRun = associationApp.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "Launch and observe the typed workflow." },
    });

    let activeChatRunId = "";
    await vi.waitFor(() => {
      const activeTurn = latestChatTurnRun("default", "s1");
      expect(activeTurn?.status).toBe("running");
      activeChatRunId = activeTurn!.id;
    });
    const launched = await associationApp.inject({
      method: "POST",
      url: "/dag-workflows/active-turn-workflow/runs",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: {
        requestId: "active-main-turn-launch",
        sessionId: "s1",
      },
    });
    expect(launched.statusCode).toBe(202);
    const workflowRunId = launched.json().manifest.id as string;
    expect(latestWorkflowRunAssociation("default", "s1")).toMatchObject({
      workflowRunId,
      chatRunId: activeChatRunId,
      source: "typed-launch",
    });

    session.releasePrompt();
    expect((await postRun).statusCode).toBe(200);
    const projection = await associationApp.inject({
      method: "GET",
      url: "/sessions/s1/workflow-run-state",
      headers: { "x-project-id": "default" },
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({
      state: {
        runId: workflowRunId,
        errorRouting: {
          source: "chat-stream",
          surface: true,
          error: {
            code: "CHAT_STREAM_ERROR",
            message: "provider failed during the active turn",
          },
        },
      },
    });
  });

  it.each(["failed", "interrupted"] as const)(
    "surfaces a running rescue companion for a %s parent projection",
    async (parentStatus) => {
      ensureProjectExists("default");
      const saved = await associationApp.inject({
        method: "PUT",
        url: "/dag-workflows/active-turn-workflow",
        headers: {
          "x-project-id": "default",
          "content-type": "application/json",
        },
        payload: activeTurnWorkflow(),
      });
      expect(saved.statusCode).toBe(201);
      const source = workflowStore.createRun("default", {
        workflowId: "active-turn-workflow",
        requestId: `active-rescue-${parentStatus}`,
        requestedBy: "user",
        sessionId: "s1",
      });
      workflowStore.appendRunEvent(
        "default",
        source.id,
        { eventId: `${parentStatus}_source_started`, type: "run_started" },
        1,
      );
      workflowStore.appendRunEvent(
        "default",
        source.id,
        parentStatus === "failed"
          ? {
              eventId: "failed_source_terminal",
              type: "run_failed",
              data: {
                error: {
                  code: "SOURCE_FAILED",
                  message: "Source workflow failed.",
                  retryable: true,
                },
              },
            }
          : {
              eventId: "interrupted_source_terminal",
              type: "run_interrupted",
              data: {
                previousStatus: "running",
                error: {
                  code: "SERVER_RESTART",
                  message: "Source workflow was interrupted.",
                  retryable: true,
                },
              },
            },
        2,
      );
      associateTypedWorkflowLaunch("default", "s1", source.id);
      fakeSessionBindings.set("rescue-helper", {
        version: 1,
        projectId: "default",
        sessionId: "rescue-helper",
        profile: "workflow-rescue",
        source: { kind: "run", id: source.id },
      });
      runBroker.start("default", "rescue-helper", {
        runId: `active-rescue-chat-${parentStatus}`,
        prompt: "Diagnose the source run.",
        images: [],
        baseline: { messages: [], contextUsage: null },
      });

      const response = await associationApp.inject({
        method: "GET",
        url: "/sessions/s1/workflow-run-state",
        headers: { "x-project-id": "default" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        state: {
          runId: source.id,
          status: "running",
          backgroundAgentTrailingNode: {
            slotId: "background-agent",
            agentId: "workflow-rescue",
            status: "running",
          },
        },
      });
    },
  );

  it("persists explicit Stop as cancelled without surfacing a DAG error", async () => {
    ensureProjectExists("default");
    const workflowRunId = "wrun_11111111111111111111111111111111";
    associateTypedWorkflowLaunch("default", "s1", workflowRunId);
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdPrompt();
    fakeSessions.set("s1", session);

    const postRun = app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "Stop this turn cleanly." },
    });
    await vi.waitFor(() => {
      expect(runBroker.state("default", "s1").status).toBe("running");
    });
    const stopped = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(stopped.statusCode).toBe(200);
    session.releasePrompt();
    expect((await postRun).statusCode).toBe(200);

    expect(latestChatTurnRun("default", "s1")).toMatchObject({
      status: "cancelled",
    });
    expect(
      chatStreamErrorForSession("default", "s1", workflowRunId),
    ).toBeUndefined();
  });

  it("releases the run claim when the broker refuses to start", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    fakeSessions.set("s1", session);
    const start = vi.spyOn(runBroker, "start").mockImplementationOnce(() => {
      throw new Error("broker refused");
    });

    const failed = await app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "first" },
    });
    expect(failed.statusCode).toBe(500);
    start.mockRestore();

    // Without releasing the claim the tab stayed 409-locked until restart.
    session.holdPrompt();
    const retry = app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { message: "second" },
    });
    await vi.waitFor(() => {
      expect(session.promptCalls).toHaveLength(1);
    });
    session.releasePrompt();
    expect((await retry).statusCode).toBe(200);
  });

  it("does not abort the Pi run when the initiating socket closes", async () => {
    const session = new FakeSession();
    session.isStreaming = false;
    session.holdPrompt();
    fakeSessions.set("s1", session);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/sessions/s1/run`, {
      method: "POST",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      body: JSON.stringify({ message: "survive disconnect" }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.aborted).toBe(false);
    expect(runBroker.state("default", "s1").status).toBe("running");

    session.releasePrompt();
    await vi.waitFor(() => {
      expect(runBroker.state("default", "s1").status).toBe("complete");
    });
    expect(session.aborted).toBe(false);
  });
});
