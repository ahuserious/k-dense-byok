import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  associateTypedWorkflowLaunch,
  chatStreamErrorForSession,
  backgroundAgentTrailingNodeForSession,
  completeChatTurnRun,
  latestChatTurnRun,
  projectWorkflowRunStateV1,
  registerChatTurnRun,
  workflowRunForChatSession,
} from "../src/agent/chat-turn-runs-adapter.ts";
import { RunBroker } from "../src/agent/run-broker.ts";
import {
  WorkflowRunController,
  workflowStore,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
  type WorkflowRunRecord,
} from "../src/workflows/index.ts";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(DEFAULT_PROJECT_ID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function storedGraph(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "indexed-workflow",
    name: "Indexed workflow",
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

function workflowReceipt(): WorkflowModelResolutionReceipt {
  return {
    request: storedGraph().defaultModel!,
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

function syntheticRun(
  status: "running" | "succeeded" = "running",
): WorkflowRunRecord {
  return {
    manifest: {
      storageVersion: 1,
      id: "wrun_11111111111111111111111111111111",
      projectId: DEFAULT_PROJECT_ID,
      workflowId: "live-graph",
      workflowRevision: 2,
      graphSha256: "a".repeat(64),
      requestId: "request-1",
      requestSha256: "b".repeat(64),
      sessionId: "chat-session",
      createdAt: 1_000,
      requestedBy: "user",
      input: {},
      effectiveLimits: {},
      graph: {
        schemaVersion: 1,
        id: "live-graph",
        name: "Live graph",
        entryNodeId: "prepare",
        limits: {},
        evidence: {},
        nodes: [{ id: "prepare" }, { id: "analyze" }],
        edges: [{ id: "prepare-analyze", from: "prepare", to: "analyze" }],
      },
    },
    state: {
      runId: "wrun_11111111111111111111111111111111",
      status,
      lastSeq: 2,
      executions: {
        "execution-1": {
          executionId: "execution-1",
          nodeId: "prepare",
          status: status === "succeeded" ? "succeeded" : "running",
          attempt: 1,
          modelCallSlots: {},
          artifacts: [],
          startedAt: 1_100,
          ...(status === "succeeded" ? { finishedAt: 1_200 } : {}),
        },
      },
      startedAt: 1_050,
      ...(status === "succeeded" ? { finishedAt: 1_200 } : {}),
      recoverable: false,
      diagnostics: [],
    },
  } as unknown as WorkflowRunRecord;
}

describe("chat-turn runs-index adapter", () => {
  it("round-trips accepted and terminal chat turns through the runs index", () => {
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: "Watch the workflow",
      model: "openrouter/test/model",
    });
    expect(latestChatTurnRun(DEFAULT_PROJECT_ID, "chat-session")).toMatchObject(
      {
        id: indexRunId,
        role: "agent",
        status: "running",
        task: "Watch the workflow",
      },
    );

    expect(
      completeChatTurnRun({
        projectId: DEFAULT_PROJECT_ID,
        sessionId: "chat-session",
        indexRunId,
        status: "completed",
        costUsd: 0.25,
        tokensIn: 10,
        tokensOut: 20,
      }),
    ).toBe(true);
    expect(latestChatTurnRun(DEFAULT_PROJECT_ID, "chat-session")).toMatchObject(
      {
        id: indexRunId,
        status: "completed",
        costUsd: 0.25,
        tokensIn: 10,
        tokensOut: 20,
      },
    );
  });

  it("retains failed chat-stream errors for RunState error routing", () => {
    const workflowRunId = "wrun_11111111111111111111111111111111";
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: "Inspect the selected workflow run.",
      workflowRunId,
    });
    completeChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      indexRunId,
      status: "failed",
      error: "provider disconnected",
    });
    expect(
      chatStreamErrorForSession(
        DEFAULT_PROJECT_ID,
        "chat-session",
        workflowRunId,
      ),
    ).toEqual({
      code: "CHAT_STREAM_ERROR",
      message: "provider disconnected",
      retryable: true,
    });
  });

  it("does not route an unrelated later failed turn to the associated workflow", () => {
    const workflowRunId = "wrun_11111111111111111111111111111111";
    const associatedChatRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: `Inspect ${workflowRunId}`,
      workflowRunId,
    });
    completeChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      indexRunId: associatedChatRunId,
      status: "completed",
    });
    const unrelatedChatRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: "Answer an unrelated question.",
    });
    completeChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      indexRunId: unrelatedChatRunId,
      status: "failed",
      error: "unrelated provider failure",
    });

    expect(
      chatStreamErrorForSession(
        DEFAULT_PROJECT_ID,
        "chat-session",
        workflowRunId,
      ),
    ).toBeUndefined();
  });

  it("persists explicit Stop as cancelled without chat error routing", () => {
    const workflowRunId = "wrun_11111111111111111111111111111111";
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: "Inspect the selected workflow run.",
      workflowRunId,
    });
    expect(
      completeChatTurnRun({
        projectId: DEFAULT_PROJECT_ID,
        sessionId: "chat-session",
        indexRunId,
        status: "cancelled",
      }),
    ).toBe(true);
    expect(latestChatTurnRun(DEFAULT_PROJECT_ID, "chat-session")).toMatchObject(
      { id: indexRunId, status: "cancelled" },
    );
    expect(
      chatStreamErrorForSession(
        DEFAULT_PROJECT_ID,
        "chat-session",
        workflowRunId,
      ),
    ).toBeUndefined();
  });

  it("reconciles a crashed main turn to interrupted for Console and error routing", async () => {
    const workflowRunId = "wrun_11111111111111111111111111111111";
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "crashed-main-session",
      prompt: "Observe the workflow until the process restarts.",
      workflowRunId,
      ownerEpoch: "previous-server-process",
    });
    const app = await buildApp({ workflowController: null });
    try {
      const consoleRuns = await app.inject({
        method: "GET",
        url: "/console/runs",
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
      });
      expect(consoleRuns.statusCode).toBe(200);
      expect(consoleRuns.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: indexRunId,
            session_id: "crashed-main-session",
            status: "interrupted",
            output: "Chat stream was interrupted by process restart.",
            completed_at: expect.any(String),
          }),
        ]),
      );
      expect(
        latestChatTurnRun(DEFAULT_PROJECT_ID, "crashed-main-session"),
      ).toMatchObject({
        id: indexRunId,
        status: "interrupted",
        output: "Chat stream was interrupted by process restart.",
      });
      expect(
        chatStreamErrorForSession(
          DEFAULT_PROJECT_ID,
          "crashed-main-session",
          workflowRunId,
        ),
      ).toEqual({
        code: "CHAT_STREAM_ERROR",
        message: "Chat stream was interrupted by process restart.",
        retryable: true,
      });
    } finally {
      await app.close();
    }
  });

  it("resolves an exact session association with 200+ newer unrelated runs", () => {
    workflowStore.saveDefinition(
      DEFAULT_PROJECT_ID,
      "indexed-workflow",
      storedGraph(),
    );
    const target = workflowStore.createRun(DEFAULT_PROJECT_ID, {
      workflowId: "indexed-workflow",
      requestId: "target-request",
      requestedBy: "user",
      sessionId: "chat-session",
    });
    associateTypedWorkflowLaunch(
      DEFAULT_PROJECT_ID,
      "chat-session",
      target.id,
    );
    const newerUnrelatedRuns = Array.from({ length: 201 }, (_, index) => {
      const run = syntheticRun();
      return {
        ...run,
        manifest: {
          ...run.manifest,
          id: `wrun_${index.toString(16).padStart(32, "0")}`,
          sessionId: `other-session-${index}`,
          createdAt: target.createdAt + index + 1,
        },
      } as WorkflowRunRecord;
    });
    const listRuns = vi
      .spyOn(workflowStore, "listRuns")
      .mockReturnValue(newerUnrelatedRuns);
    const readdir = vi.spyOn(fs, "readdirSync");

    expect(
      workflowRunForChatSession(DEFAULT_PROJECT_ID, "chat-session")?.manifest
        .id,
    ).toBe(target.id);
    expect(listRuns).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it("recovers a torn association tail across restart and accepts a later write", () => {
    workflowStore.saveDefinition(
      DEFAULT_PROJECT_ID,
      "indexed-workflow",
      storedGraph(),
    );
    const first = workflowStore.createRun(DEFAULT_PROJECT_ID, {
      workflowId: "indexed-workflow",
      requestId: "torn-association-first",
      requestedBy: "user",
      sessionId: "chat-session",
    });
    associateTypedWorkflowLaunch(
      DEFAULT_PROJECT_ID,
      "chat-session",
      first.id,
    );
    const associationFile = path.join(
      resolvePaths(DEFAULT_PROJECT_ID).runsDir,
      "chat-session",
      "workflow-associations.jsonl",
    );
    fs.appendFileSync(associationFile, '{"schemaVersion":1');

    expect(
      workflowRunForChatSession(DEFAULT_PROJECT_ID, "chat-session")?.manifest
        .id,
    ).toBe(first.id);

    const second = workflowStore.createRun(DEFAULT_PROJECT_ID, {
      workflowId: "indexed-workflow",
      requestId: "torn-association-second",
      requestedBy: "user",
      sessionId: "chat-session",
    });
    associateTypedWorkflowLaunch(
      DEFAULT_PROJECT_ID,
      "chat-session",
      second.id,
    );
    expect(
      workflowRunForChatSession(DEFAULT_PROJECT_ID, "chat-session")?.manifest
        .id,
    ).toBe(second.id);
    expect(() => {
      for (const line of fs
        .readFileSync(associationFile, "utf-8")
        .trim()
        .split("\n")) {
        JSON.parse(line);
      }
    }).not.toThrow();
  });

  it("recovers a torn runs-index tail across restart and completes the run", () => {
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: "Survive a torn terminal append.",
    });
    const runsFile = path.join(
      resolvePaths(DEFAULT_PROJECT_ID).runsDir,
      "chat-session",
      "runs.jsonl",
    );
    fs.appendFileSync(runsFile, '{"id":"torn"');

    expect(latestChatTurnRun(DEFAULT_PROJECT_ID, "chat-session")?.id).toBe(
      indexRunId,
    );
    expect(
      completeChatTurnRun({
        projectId: DEFAULT_PROJECT_ID,
        sessionId: "chat-session",
        indexRunId,
        status: "completed",
      }),
    ).toBe(true);
    expect(latestChatTurnRun(DEFAULT_PROJECT_ID, "chat-session")).toMatchObject(
      { id: indexRunId, status: "completed" },
    );
    expect(fs.readFileSync(runsFile, "utf-8")).not.toContain('{"id":"torn"');
  });

  it("associates a validated typed launch with its active main chat", async () => {
    const app = await buildApp({ workflowController: null });
    try {
      const createdSession = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
      });
      expect(createdSession.statusCode).toBe(200);
      const sessionId = createdSession.json<{ id: string }>().id;
      const saved = await app.inject({
        method: "PUT",
        url: "/dag-workflows/indexed-workflow",
        headers: { "x-project-id": DEFAULT_PROJECT_ID, "if-none-match": "*" },
        payload: storedGraph(),
      });
      expect(saved.statusCode).toBe(201);
      const launched = await app.inject({
        method: "POST",
        url: "/dag-workflows/indexed-workflow/runs",
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
        payload: {
          requestId: "typed-launch-chat-projection",
          expectedWorkflowRevision: 1,
          sessionId,
        },
      });
      expect(launched.statusCode).toBe(202);
      const launchedRunId = launched.json<{
        manifest: { id: string };
      }>().manifest.id;

      const projection = await app.inject({
        method: "GET",
        url: `/sessions/${encodeURIComponent(sessionId)}/workflow-run-state`,
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
      });
      expect(projection.statusCode).toBe(200);
      expect(projection.json()).toMatchObject({
        state: {
          schemaVersion: 1,
          runId: launchedRunId,
          workflowId: "indexed-workflow",
          status: "queued",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rebinds a failed source session to its successful manual rescue run", async () => {
    const controller = new WorkflowRunController({
      createExecutor: () => async (context) => {
        context.recordModelResolution("agent", workflowReceipt());
        return { output: { rescued: true } };
      },
    });
    const app = await buildApp({ workflowController: controller });
    try {
      const createdSession = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
      });
      expect(createdSession.statusCode).toBe(200);
      const sessionId = createdSession.json<{ id: string }>().id;
      const saved = await app.inject({
        method: "PUT",
        url: "/dag-workflows/indexed-workflow",
        headers: { "x-project-id": DEFAULT_PROJECT_ID, "if-none-match": "*" },
        payload: storedGraph(),
      });
      expect(saved.statusCode).toBe(201);
      const source = workflowStore.createRun(DEFAULT_PROJECT_ID, {
        workflowId: "indexed-workflow",
        requestId: "manual-rescue-source",
        requestedBy: "user",
        sessionId,
      });
      workflowStore.appendRunEvent(
        DEFAULT_PROJECT_ID,
        source.id,
        { eventId: "manual_rescue_source_started", type: "run_started" },
        1,
      );
      workflowStore.appendRunEvent(
        DEFAULT_PROJECT_ID,
        source.id,
        {
          eventId: "manual_rescue_source_failed",
          type: "run_failed",
          data: {
            error: {
              code: "SOURCE_FAILED",
              message: "The source run failed.",
              retryable: true,
            },
          },
        },
        2,
      );

      const rescued = await app.inject({
        method: "POST",
        url: `/dag-workflow-runs/${source.id}/rescue`,
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
        payload: { requestId: "manual-rescue-replacement" },
      });
      expect(rescued.statusCode).toBe(202);
      const rescueRunId = rescued.json<{
        manifest: { id: string };
      }>().manifest.id;
      const projection = await app.inject({
        method: "GET",
        url: `/sessions/${encodeURIComponent(sessionId)}/workflow-run-state`,
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
      });
      expect(projection.statusCode).toBe(200);
      expect(projection.json()).toMatchObject({
        state: { schemaVersion: 1, runId: rescueRunId },
      });
    } finally {
      await app.close();
    }
  });

  it("starts a typed run with an unknown session without associating it", async () => {
    const controller = new WorkflowRunController({
      createExecutor: () => async (context) => {
        context.recordModelResolution("agent", workflowReceipt());
        return { output: { ok: true } };
      },
    });
    const app = await buildApp({ workflowController: controller });
    try {
      const saved = await app.inject({
        method: "PUT",
        url: "/dag-workflows/indexed-workflow",
        headers: { "x-project-id": DEFAULT_PROJECT_ID, "if-none-match": "*" },
        payload: storedGraph(),
      });
      expect(saved.statusCode).toBe(201);
      const sessionId = "unknown-main-session";
      const launched = await app.inject({
        method: "POST",
        url: "/dag-workflows/indexed-workflow/runs",
        headers: { "x-project-id": DEFAULT_PROJECT_ID },
        payload: { requestId: "unknown-session-launch", sessionId },
      });
      expect(launched.statusCode).toBe(202);
      const runId = launched.json<{ manifest: { id: string } }>().manifest.id;
      await vi.waitFor(() => {
        expect(
          workflowStore.readRun(DEFAULT_PROJECT_ID, runId)?.state.status,
        ).toBe("succeeded");
      });
      expect(
        workflowRunForChatSession(DEFAULT_PROJECT_ID, sessionId),
      ).toBeNull();
      expect(
        fs.existsSync(
          path.join(
            resolvePaths(DEFAULT_PROJECT_ID).runsDir,
            sessionId,
            "workflow-associations.jsonl",
          ),
        ),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("durable background-agent trailing state", () => {
  function persistHelperTerminal(status: "completed" | "failed") {
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "rescue-session",
      prompt: "Inspect the selected run.",
      workflowRunId: "wrun_11111111111111111111111111111111",
      agentId: "workflow-rescue",
    });
    completeChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "rescue-session",
      indexRunId,
      status,
      ...(status === "failed" ? { error: "rescue failed" } : {}),
    });
  }

  it("survives broker retention expiry", () => {
    vi.useFakeTimers();
    persistHelperTerminal("completed");
    const broker = new RunBroker({ completedRetentionMs: 10 });
    const handle = broker.start("default", "rescue-session", {
      runId: "chat-run",
      prompt: "Inspect the selected run.",
      images: [],
      baseline: { messages: [], contextUsage: null },
    });
    handle.publish({ type: "done" });
    handle.complete();
    vi.advanceTimersByTime(11);
    expect(broker.get("default", "rescue-session")).toBeUndefined();

    expect(
      backgroundAgentTrailingNodeForSession({
        projectId: DEFAULT_PROJECT_ID,
        helperSessionId: "rescue-session",
        workflowRunId: "wrun_11111111111111111111111111111111",
        workflowRunStatus: "failed",
      }),
    ).toMatchObject({ agentId: "workflow-rescue", status: "succeeded" });
    broker.clear();
  });

  it("reconstructs a failed trailing node after process restart", () => {
    persistHelperTerminal("failed");
    const restartedBroker = new RunBroker();
    expect(restartedBroker.get("default", "rescue-session")).toBeUndefined();

    expect(
      backgroundAgentTrailingNodeForSession({
        projectId: DEFAULT_PROJECT_ID,
        helperSessionId: "rescue-session",
        workflowRunId: "wrun_11111111111111111111111111111111",
        workflowRunStatus: "failed",
      }),
    ).toMatchObject({ agentId: "workflow-rescue", status: "failed" });
    restartedBroker.clear();
  });

  it("reconciles an orphaned in-flight rescue to failed after restart", () => {
    const workflowRunId = "wrun_11111111111111111111111111111111";
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "rescue-session",
      prompt: "Inspect the selected run.",
      workflowRunId,
      agentId: "workflow-rescue",
    });
    const restartedBroker = new RunBroker();
    expect(restartedBroker.get("default", "rescue-session")).toBeUndefined();

    expect(
      backgroundAgentTrailingNodeForSession({
        projectId: DEFAULT_PROJECT_ID,
        helperSessionId: "rescue-session",
        workflowRunId,
        workflowRunStatus: "failed",
        brokerHandlePresent: false,
      }),
    ).toMatchObject({ agentId: "workflow-rescue", status: "failed" });
    expect(latestChatTurnRun(DEFAULT_PROJECT_ID, "rescue-session")).toMatchObject(
      {
        id: indexRunId,
        status: "failed",
        output: "Background rescue agent was interrupted by process restart.",
      },
    );
    restartedBroker.clear();
  });
});

describe("RunState v1 chat projection", () => {
  it("projects a valid synthetic graph including the trailing background agent", () => {
    const projection = projectWorkflowRunStateV1(syntheticRun(), {
      backgroundAgentTrailingNode: {
        slotId: "background-agent",
        agentId: "rescue-agent",
        nodeId: "prepare",
        status: "running",
      },
    });
    expect(projection).toMatchObject({
      schemaVersion: 1,
      status: "running",
      nodes: [
        {
          id: "prepare",
          status: "running",
          progress: { completed: 0, total: 1 },
        },
        {
          id: "analyze",
          status: "pending",
          progress: { completed: 0, total: 1 },
        },
      ],
      backgroundAgentTrailingNode: {
        nodeId: "prepare",
        status: "running",
      },
    });
  });

  it("rejects an incoherent projection instead of returning it", () => {
    const run = syntheticRun("succeeded");
    run.state.executions["execution-1"].status = "running";
    expect(() => projectWorkflowRunStateV1(run)).toThrow(/status coherence/);
  });
});
