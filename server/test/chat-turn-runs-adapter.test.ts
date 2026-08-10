import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  chatStreamErrorForSession,
  completeChatTurnRun,
  latestChatTurnRun,
  projectWorkflowRunStateV1,
  registerChatTurnRun,
} from "../src/agent/chat-turn-runs-adapter.ts";
import type { WorkflowRunRecord } from "../src/workflows/index.ts";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(DEFAULT_PROJECT_ID);
});

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
    const indexRunId = registerChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      prompt: "Inspect wrun_11111111111111111111111111111111",
    });
    completeChatTurnRun({
      projectId: DEFAULT_PROJECT_ID,
      sessionId: "chat-session",
      indexRunId,
      status: "failed",
      error: "provider disconnected",
    });
    expect(
      chatStreamErrorForSession(DEFAULT_PROJECT_ID, "chat-session"),
    ).toEqual({
      code: "CHAT_STREAM_ERROR",
      message: "provider disconnected",
      retryable: true,
    });
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
