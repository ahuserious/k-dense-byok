import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isWorkflowRunEventType } from "../src/workflows/run-state.ts";
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
      deadlineAt: 61_000,
      questions: {
        title: "Optimization constraints",
        questions: [{ id: "audience", type: "text", question: "Audience?" }],
      },
    });
    expect(isWorkflowRunEventType(launched.event.type)).toBe(true);
    expect(launched.event).toMatchObject({
      type: "run_waiting",
      data: { durable: true, deadlineAt: 61_000 },
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
      event: { type: "run_resumed", data: { responseCount: 1 } },
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
      event: { type: "run_resumed", data: { timedOut: true } },
    });
    expect(await contract.read("run-timeout", "optimize-prompt"))
      .toMatchObject({ status: "timed-out" });
  });
});
