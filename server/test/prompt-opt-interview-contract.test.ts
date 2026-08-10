import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isWorkflowRunEventType } from "../src/workflows/run-state.ts";
import { resolvePaths } from "../src/projects.ts";
import { WorkflowStore } from "../src/workflows/store.ts";
import { workflowNodeExecutionId } from "../src/workflows/runner.ts";
import type { WorkflowGraphDocument } from "../src/workflows/schema.ts";
import {
  createPromptOptimizationInterviewContract,
} from "../src/workflows/prompt-opt-interview-contract.ts";
import { handlePromptOptimizationInterviewAnswer } from "../src/workflows/prompt-opt-interview-api.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function sandbox(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-opt-contract-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("durable prompt optimization interview contract", () => {
  it("round-trips launch to endpoint answer across a simulated restart", async () => {
    const sandboxPath = await sandbox();
    const firstProcess = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => 1_000,
    });
    const launched = await firstProcess.launch({
      runId: "run-durable",
      nodeId: "optimize-prompt",
      executionId: "execution-durable",
      attempt: 1,
      deadlineAt: 61_000,
      questions: {
        title: "Optimization constraints",
        questions: [{ id: "audience", type: "text", question: "Audience?" }],
      },
    });
    expect(isWorkflowRunEventType(launched.event.type)).toBe(true);
    expect(launched.event).toMatchObject({
      type: "run_waiting",
      data: { reason: expect.stringContaining("waiting for durable structured answers") },
    });

    const restartedProcess = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => 2_000,
    });
    expect(await restartedProcess.read("run-durable", "optimize-prompt"))
      .toMatchObject({ status: "pending", executionId: "execution-durable" });
    const answered = await handlePromptOptimizationInterviewAnswer({
      contract: restartedProcess,
      runId: "run-durable",
      nodeId: "optimize-prompt",
      answer: { responses: [{ id: "audience", value: "domain experts" }] },
    });
    expect(isWorkflowRunEventType(answered.event.type)).toBe(true);
    expect(answered).toMatchObject({
      state: {
        status: "answered",
        answer: { responses: [{ id: "audience", value: "domain experts" }] },
      },
      event: { type: "run_resumed", data: { resumeNumber: 1 } },
    });

    const secondRestart = createPromptOptimizationInterviewContract({ sandboxPath });
    expect(await secondRestart.read("run-durable", "optimize-prompt"))
      .toMatchObject({ status: "answered" });
  });

  it("persists a RunState-valid timeout transition", async () => {
    const sandboxPath = await sandbox();
    let clock = 1_000;
    const contract = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => clock,
      pollIntervalMs: 5,
    });
    await contract.launch({
      runId: "run-timeout",
      nodeId: "optimize-prompt",
      executionId: "execution-timeout",
      attempt: 1,
      deadlineAt: 2_000,
      questions: {
        title: "Constraints",
        questions: [{ id: "scope", type: "text", question: "Scope?" }],
      },
    });
    clock = 2_000;
    const transition = await contract.waitForAnswer(
      "run-timeout",
      "optimize-prompt",
      new AbortController().signal,
    );
    expect(isWorkflowRunEventType(transition.event.type)).toBe(true);
    expect(transition).toMatchObject({
      state: { status: "timed-out" },
      event: { type: "run_resumed", data: { resumeNumber: 1 } },
    });
    expect(await contract.read("run-timeout", "optimize-prompt"))
      .toMatchObject({ status: "timed-out" });
  });

  it("persists occurrence-aware interruption -> recovery -> answer -> completion in RunState", async () => {
    const projectId = `poevents${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const store = new WorkflowStore();
    const workflow: WorkflowGraphDocument = {
      schemaVersion: "1.0",
      id: "prompt-event-fixture",
      name: "Prompt event fixture",
      entryNodeId: "worker",
      defaultModel: {
        requested: {
          source: "fixed",
          provider: "ollama",
          model: "fixture",
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
        maxTokens: 1_000,
        maxCostUsd: 0,
        maxRetries: 1,
      },
      evidence: {
        enabled: false,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "fail",
      },
      nodes: [{
        id: "worker",
        name: "Worker",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Fixture.",
      }],
      edges: [],
    };
    try {
      store.saveDefinition(projectId, workflow.id, workflow);
      const manifest = store.createRun(projectId, {
        workflowId: workflow.id,
        requestId: `request-${randomUUID()}`,
        requestedBy: "api",
      });
      let record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-started",
        type: "run_started",
      }, record.state.lastSeq);
      expect(store.readRun(projectId, manifest.id)?.state.status).toBe("running");

      const contract = createPromptOptimizationInterviewContract({
        sandboxPath: resolvePaths(projectId).sandbox,
        now: () => 1_000,
      });
      const launched = await contract.launch({
        runId: manifest.id,
        nodeId: "optimize-prompt",
        executionId: "execution-store",
        attempt: 1,
        deadlineAt: 61_000,
        questions: {
          title: "Constraints",
          questions: [{ id: "scope", type: "text", question: "Scope?" }],
        },
      });
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, launched.event, record.state.lastSeq);
      expect(store.readRun(projectId, manifest.id)?.state.status).toBe("waiting");

      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-interrupted",
        type: "run_interrupted",
        data: {
          previousStatus: "waiting",
          error: {
            code: "RUN_INTERRUPTED",
            message: "Runner process stopped while the interview was pending.",
            retryable: true,
          },
        },
      }, record.state.lastSeq);
      expect(store.readRun(projectId, manifest.id)?.state.status).toBe("interrupted");

      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-runner-recovered",
        type: "run_resumed",
        data: { resumeNumber: 1 },
      }, record.state.lastSeq);
      expect(store.readRun(projectId, manifest.id)?.state.status).toBe("running");

      const restartedContract = createPromptOptimizationInterviewContract({
        sandboxPath: resolvePaths(projectId).sandbox,
        now: () => 2_000,
      });
      const recovered = await restartedContract.launch({
        runId: manifest.id,
        nodeId: "optimize-prompt",
        executionId: "execution-store",
        attempt: 1,
        deadlineAt: 61_000,
        questions: structuredClone(launched.state.questions),
      });
      expect(recovered.state.waitOccurrence).toBe(2);
      expect(recovered.event.eventId).not.toBe(launched.event.eventId);
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, recovered.event, record.state.lastSeq);
      expect(store.readRun(projectId, manifest.id)?.state.status).toBe("waiting");

      const answered = await handlePromptOptimizationInterviewAnswer({
        contract: restartedContract,
        runId: manifest.id,
        nodeId: "optimize-prompt",
        answer: { responses: [{ id: "scope", value: "Methods" }] },
      });
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, answered.event, record.state.lastSeq);
      const resumed = store.readRun(projectId, manifest.id)!;
      expect(resumed.state.status).toBe("running");
      expect(resumed.state.diagnostics).toEqual([]);
      expect(answered.event).toMatchObject({
        type: "run_resumed",
        data: { resumeNumber: 2 },
      });

      const executionId = workflowNodeExecutionId(manifest.id, "worker", 1);
      const request = workflow.defaultModel!;
      const receipt = {
        request,
        resolved: {
          provider: "ollama",
          model: "fixture",
          auth: { kind: "local" as const },
          reasoning: "high" as const,
          runtime: "local" as const,
        },
        fallbackUsed: false,
      };
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-worker-started",
        type: "node_started",
        executionId,
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
      }, record.state.lastSeq);
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-worker-slot",
        type: "model_call_declared",
        executionId,
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
        data: { modelCallSlot: { id: "agent", request } },
      }, record.state.lastSeq);
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-worker-resolved",
        type: "model_resolved",
        executionId,
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
        data: { modelCallSlotId: "agent", receipt },
      }, record.state.lastSeq);
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-worker-succeeded",
        type: "node_succeeded",
        executionId,
        nodeId: "worker",
        attempt: 1,
        branchId: "entry",
        data: { routeCondition: "success", output: { complete: true } },
      }, record.state.lastSeq);
      record = store.readRun(projectId, manifest.id)!;
      store.appendRunEvent(projectId, manifest.id, {
        eventId: "prompt-opt-run-succeeded",
        type: "run_succeeded",
      }, record.state.lastSeq);
      const completed = store.readRun(projectId, manifest.id)!;
      expect(completed.state.status).toBe("succeeded");
      expect(completed.state.diagnostics).toEqual([]);
      expect(store.readRunEvents(projectId, manifest.id, { limit: 100 }).events.map((event) => event.type))
        .toEqual([
          "run_queued",
          "run_started",
          "run_waiting",
          "run_interrupted",
          "run_resumed",
          "run_waiting",
          "run_resumed",
          "node_started",
          "model_call_declared",
          "model_resolved",
          "node_succeeded",
          "run_succeeded",
        ]);
    } finally {
      await fs.rm(resolvePaths(projectId).root, { recursive: true, force: true });
    }
  });

  it("carries answered state into a new attempt only when the question hash matches", async () => {
    const sandboxPath = await sandbox();
    const contract = createPromptOptimizationInterviewContract({
      sandboxPath,
      now: () => 1_000,
    });
    const originalQuestions = {
      title: "Constraints",
      questions: [{ id: "scope", type: "text" as const, question: "Scope?" }],
    };
    await contract.launch({
      runId: "run-retry",
      nodeId: "optimize-prompt",
      executionId: "execution-attempt-1",
      attempt: 1,
      deadlineAt: 61_000,
      questions: originalQuestions,
    });
    await contract.answer("run-retry", "optimize-prompt", {
      responses: [{ id: "scope", value: "Keep methods detail." }],
    });

    const reused = await contract.launch({
      runId: "run-retry",
      nodeId: "optimize-prompt",
      executionId: "execution-attempt-2",
      attempt: 2,
      deadlineAt: 62_000,
      questions: structuredClone(originalQuestions),
    });
    expect(reused.state).toMatchObject({
      executionId: "execution-attempt-2",
      attempt: 2,
      status: "answered",
      carriedFromExecutionId: "execution-attempt-1",
      answer: { responses: [{ id: "scope", value: "Keep methods detail." }] },
    });

    const changed = await contract.launch({
      runId: "run-retry",
      nodeId: "optimize-prompt",
      executionId: "execution-attempt-3",
      attempt: 3,
      deadlineAt: 63_000,
      questions: {
        title: "Constraints",
        questions: [{ id: "scope", type: "text", question: "Scope and audience?" }],
      },
    });
    expect(changed.state).toMatchObject({
      executionId: "execution-attempt-3",
      attempt: 3,
      status: "pending",
    });
    expect(changed.state.answer).toBeUndefined();
    expect(changed.state.questionSetSha256).not.toBe(reused.state.questionSetSha256);

    const superseded = await contract.launch({
      runId: "run-retry",
      nodeId: "optimize-prompt",
      executionId: "execution-attempt-4",
      attempt: 4,
      deadlineAt: 64_000,
      questions: structuredClone(changed.state.questions),
    });
    expect(superseded.state).toMatchObject({
      executionId: "execution-attempt-4",
      attempt: 4,
      status: "pending",
    });
  });
});
