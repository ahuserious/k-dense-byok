import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateAnswer,
  type InterviewAnswer,
  type InterviewParamsT,
} from "../agent/interview.ts";
import type { WorkflowRunEventInput } from "./run-state.ts";

export const PROMPT_OPTIMIZATION_INTERVIEW_STATE_VERSION = 1 as const;

export type PromptOptimizationInterviewStatus =
  | "pending"
  | "answered"
  | "cancelled"
  | "timed-out";

export interface PromptOptimizationInterviewStateV1 {
  stateVersion: typeof PROMPT_OPTIMIZATION_INTERVIEW_STATE_VERSION;
  runId: string;
  nodeId: string;
  executionId: string;
  status: PromptOptimizationInterviewStatus;
  questions: InterviewParamsT;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  answer?: InterviewAnswer;
}

export interface PromptOptimizationInterviewTransition {
  state: PromptOptimizationInterviewStateV1;
  event: WorkflowRunEventInput;
}

export interface PromptOptimizationInterviewContractOptions {
  sandboxPath: string;
  now?: () => number;
  pollIntervalMs?: number;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NODE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function safeKey(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label} is not a safe workflow identifier.`);
  return value.replaceAll(":", "_");
}

function transitionEventId(prefix: string, runId: string, nodeId: string): string {
  const digest = createHash("sha256").update(`${runId}\0${nodeId}`).digest("hex").slice(0, 24);
  return `prompt_opt_interview_${prefix}_${digest}`;
}

function assertStoredState(
  state: unknown,
  runId: string,
  nodeId: string,
): asserts state is PromptOptimizationInterviewStateV1 {
  if (!state || typeof state !== "object") {
    throw new Error("Prompt optimization interview state is malformed.");
  }
  const record = state as Partial<PromptOptimizationInterviewStateV1>;
  if (
    record.stateVersion !== PROMPT_OPTIMIZATION_INTERVIEW_STATE_VERSION ||
    record.runId !== runId ||
    record.nodeId !== nodeId ||
    typeof record.executionId !== "string" ||
    !["pending", "answered", "cancelled", "timed-out"].includes(String(record.status)) ||
    !record.questions ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number" ||
    typeof record.deadlineAt !== "number"
  ) {
    throw new Error("Prompt optimization interview state is malformed or belongs to another run.");
  }
}

function waitingEvent(state: PromptOptimizationInterviewStateV1): WorkflowRunEventInput {
  return {
    eventId: transitionEventId("waiting", state.runId, state.nodeId),
    type: "run_waiting",
    executionId: state.executionId,
    nodeId: state.nodeId,
    data: {
      reason: "prompt-optimization-interview-user",
      durable: true,
      deadlineAt: state.deadlineAt,
      questionCount: state.questions.questions.length,
      endpoint: `/dag-workflow-runs/${encodeURIComponent(state.runId)}/nodes/${encodeURIComponent(state.nodeId)}/prompt-opt-interview`,
    },
  };
}

function resumedEvent(state: PromptOptimizationInterviewStateV1): WorkflowRunEventInput {
  return {
    eventId: transitionEventId(`resumed_${state.status}`, state.runId, state.nodeId),
    type: "run_resumed",
    executionId: state.executionId,
    nodeId: state.nodeId,
    data: {
      reason: "prompt-optimization-interview-user",
      durable: true,
      status: state.status,
      timedOut: state.status === "timed-out",
      cancelled: state.status === "cancelled",
      responseCount: state.answer && !state.answer.cancelled
        ? state.answer.responses.length
        : 0,
    },
  };
}

export class PromptOptimizationInterviewContract {
  readonly sandboxPath: string;
  readonly now: () => number;
  readonly pollIntervalMs: number;

  constructor(options: PromptOptimizationInterviewContractOptions) {
    this.sandboxPath = options.sandboxPath;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = Math.max(5, Math.min(1_000, options.pollIntervalMs ?? 50));
  }

  private statePath(runId: string, nodeId: string): string {
    const run = safeKey(runId, SAFE_RUN_ID, "runId");
    const node = safeKey(nodeId, SAFE_NODE_ID, "nodeId");
    return path.join(
      this.sandboxPath,
      ".kady",
      "workflows",
      "prompt-interviews",
      run,
      `${node}.json`,
    );
  }

  private async persist(state: PromptOptimizationInterviewStateV1): Promise<void> {
    const target = this.statePath(state.runId, state.nodeId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async read(runId: string, nodeId: string): Promise<PromptOptimizationInterviewStateV1 | null> {
    const target = this.statePath(runId, nodeId);
    let serialized: string;
    try {
      serialized = await fs.readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const state: unknown = JSON.parse(serialized);
    assertStoredState(state, runId, nodeId);
    return state;
  }

  async launch(input: {
    runId: string;
    nodeId: string;
    executionId: string;
    questions: InterviewParamsT;
    deadlineAt: number;
  }): Promise<PromptOptimizationInterviewTransition> {
    const existing = await this.read(input.runId, input.nodeId);
    if (existing) {
      if (existing.executionId !== input.executionId) {
        throw new Error("A durable prompt optimization interview already exists for this run and node.");
      }
      return {
        state: existing,
        event: existing.status === "pending" ? waitingEvent(existing) : resumedEvent(existing),
      };
    }
    const now = Math.max(0, Math.floor(this.now()));
    if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= now) {
      throw new Error("Prompt optimization interview has no time remaining in the node envelope.");
    }
    const state: PromptOptimizationInterviewStateV1 = {
      stateVersion: PROMPT_OPTIMIZATION_INTERVIEW_STATE_VERSION,
      runId: input.runId,
      nodeId: input.nodeId,
      executionId: input.executionId,
      status: "pending",
      questions: structuredClone(input.questions),
      createdAt: now,
      updatedAt: now,
      deadlineAt: Math.floor(input.deadlineAt),
    };
    await this.persist(state);
    return { state, event: waitingEvent(state) };
  }

  async answer(
    runId: string,
    nodeId: string,
    answer: InterviewAnswer,
  ): Promise<PromptOptimizationInterviewTransition> {
    if (!answer || typeof answer !== "object") {
      throw new Error("Invalid prompt optimization interview answer: body must be an object");
    }
    const invalid = validateAnswer(answer);
    if (invalid) throw new Error(`Invalid prompt optimization interview answer: ${invalid}`);
    const state = await this.read(runId, nodeId);
    if (!state) throw new Error("No durable prompt optimization interview exists for this run and node.");
    if (state.status !== "pending") {
      throw new Error(`Prompt optimization interview is already ${state.status}.`);
    }
    const now = Math.max(0, Math.floor(this.now()));
    if (now >= state.deadlineAt) return this.timeout(runId, nodeId);
    if (!answer.cancelled) {
      const answerable = new Set(
        state.questions.questions.filter((question) => question.type !== "info").map((question) => question.id),
      );
      const seen = new Set<string>();
      for (const response of answer.responses) {
        if (!answerable.has(response.id) || seen.has(response.id)) {
          throw new Error(`Invalid or duplicate prompt optimization interview response id: ${response.id}`);
        }
        seen.add(response.id);
      }
    }
    const next: PromptOptimizationInterviewStateV1 = {
      ...state,
      status: answer.cancelled ? "cancelled" : "answered",
      answer: structuredClone(answer),
      updatedAt: now,
    };
    await this.persist(next);
    return { state: next, event: resumedEvent(next) };
  }

  async timeout(runId: string, nodeId: string): Promise<PromptOptimizationInterviewTransition> {
    const state = await this.read(runId, nodeId);
    if (!state) throw new Error("No durable prompt optimization interview exists for this run and node.");
    if (state.status !== "pending") return { state, event: resumedEvent(state) };
    const next: PromptOptimizationInterviewStateV1 = {
      ...state,
      status: "timed-out",
      updatedAt: Math.max(0, Math.floor(this.now())),
    };
    await this.persist(next);
    return { state: next, event: resumedEvent(next) };
  }

  async waitForAnswer(
    runId: string,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<PromptOptimizationInterviewTransition> {
    while (true) {
      if (signal.aborted) throw new Error("Prompt optimization interview was aborted.");
      const state = await this.read(runId, nodeId);
      if (!state) throw new Error("Durable prompt optimization interview disappeared while waiting.");
      if (state.status !== "pending") return { state, event: resumedEvent(state) };
      const remainingMs = state.deadlineAt - this.now();
      if (remainingMs <= 0) return this.timeout(runId, nodeId);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("Prompt optimization interview was aborted."));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, Math.min(this.pollIntervalMs, remainingMs));
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

export function createPromptOptimizationInterviewContract(
  options: PromptOptimizationInterviewContractOptions,
): PromptOptimizationInterviewContract {
  return new PromptOptimizationInterviewContract(options);
}
