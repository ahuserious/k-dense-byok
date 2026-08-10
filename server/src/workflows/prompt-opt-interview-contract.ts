import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
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
  /** Monotonic compare-and-swap revision for cross-process mutations. */
  revision: number;
  runId: string;
  nodeId: string;
  executionId: string;
  attempt: number;
  /** Monotonic identity for each persisted waiting transition, including recovery. */
  waitOccurrence: number;
  status: PromptOptimizationInterviewStatus;
  questions: InterviewParamsT;
  questionSetSha256: string;
  carriedFromExecutionId?: string;
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
const INTERVIEW_LOCK_WAIT_MS = 5;
const INTERVIEW_LOCK_TIMEOUT_MS = 5_000;
const INTERVIEW_STALE_LOCK_MS = 30_000;

function safeKey(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label} is not a safe workflow identifier.`);
  return value.replaceAll(":", "_");
}

function transitionEventId(
  prefix: string,
  runId: string,
  nodeId: string,
  attempt: number,
  waitOccurrence: number,
): string {
  const digest = createHash("sha256")
    .update(`${runId}\0${nodeId}\0${attempt}\0${waitOccurrence}`)
    .digest("hex")
    .slice(0, 24);
  return `prompt_opt_interview_${prefix}_${digest}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function promptOptimizationQuestionSetSha256(questions: InterviewParamsT): string {
  return createHash("sha256").update(canonicalJson(questions)).digest("hex");
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
  const expectedQuestionSetSha256 = promptOptimizationQuestionSetSha256(record.questions);
  if (
    record.questionSetSha256 !== undefined &&
    record.questionSetSha256 !== expectedQuestionSetSha256
  ) {
    throw new Error("Prompt optimization interview question-set hash does not match its persisted questions.");
  }
  // Migrate states written by the first S6 seam without invalidating a paused run.
  record.questionSetSha256 ??= expectedQuestionSetSha256;
  record.attempt ??= 1;
  record.waitOccurrence ??= 1;
  record.revision ??= 1;
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 1) {
    throw new Error("Prompt optimization interview state has an invalid attempt number.");
  }
  if (!Number.isSafeInteger(record.waitOccurrence) || record.waitOccurrence < 1) {
    throw new Error("Prompt optimization interview state has an invalid wait occurrence.");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new Error("Prompt optimization interview state has an invalid revision.");
  }
}

function waitingEvent(state: PromptOptimizationInterviewStateV1): WorkflowRunEventInput {
  return {
    eventId: transitionEventId(
      "waiting",
      state.runId,
      state.nodeId,
      state.attempt,
      state.waitOccurrence,
    ),
    type: "run_waiting",
    data: {
      reason: `Prompt optimization ${state.nodeId} is waiting for durable structured answers.`,
    },
  };
}

function resumedEvent(state: PromptOptimizationInterviewStateV1): WorkflowRunEventInput {
  return {
    eventId: transitionEventId(
      `resumed_${state.status}`,
      state.runId,
      state.nodeId,
      state.attempt,
      state.waitOccurrence,
    ),
    type: "run_resumed",
    data: {
      resumeNumber: state.waitOccurrence,
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

  private async withMutationLock<T>(
    runId: string,
    nodeId: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    const target = this.statePath(runId, nodeId);
    const lockPath = `${target}.lock`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const lockDeadline = Date.now() + INTERVIEW_LOCK_TIMEOUT_MS;
    let lock: FileHandle | undefined;
    while (!lock) {
      try {
        lock = await fs.open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockStat = await fs.stat(lockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs >= INTERVIEW_STALE_LOCK_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= lockDeadline) {
          throw new Error("Timed out acquiring the durable prompt optimization interview lock.");
        }
        await new Promise((resolve) => setTimeout(resolve, INTERVIEW_LOCK_WAIT_MS));
      }
    }
    try {
      return await mutate();
    } finally {
      try {
        await lock.close();
      } finally {
        await fs.unlink(lockPath).catch(() => undefined);
      }
    }
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

  private async compareAndSwap(
    runId: string,
    nodeId: string,
    expectedRevision: number | null,
    next: PromptOptimizationInterviewStateV1,
  ): Promise<{ swapped: boolean; state: PromptOptimizationInterviewStateV1 | null }> {
    return this.withMutationLock(runId, nodeId, async () => {
      const current = await this.read(runId, nodeId);
      if ((current?.revision ?? null) !== expectedRevision) {
        return { swapped: false, state: current };
      }
      const stored: PromptOptimizationInterviewStateV1 = {
        ...next,
        revision: (expectedRevision ?? 0) + 1,
      };
      await this.persist(stored);
      return { swapped: true, state: stored };
    });
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
    attempt: number;
    questions: InterviewParamsT;
    deadlineAt: number;
  }): Promise<PromptOptimizationInterviewTransition> {
    const now = Math.max(0, Math.floor(this.now()));
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new Error("Prompt optimization interview requires a positive attempt number.");
    }
    if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= now) {
      throw new Error("Prompt optimization interview has no time remaining in the node envelope.");
    }
    const questionSetSha256 = promptOptimizationQuestionSetSha256(input.questions);
    for (;;) {
      const existing = await this.read(input.runId, input.nodeId);
      if (
        existing &&
        existing.executionId === input.executionId &&
        existing.questionSetSha256 === questionSetSha256 &&
        existing.status !== "pending"
      ) {
        // A terminal answer always wins over a stale recovery snapshot.
        return { state: existing, event: resumedEvent(existing) };
      }

      let next: PromptOptimizationInterviewStateV1;
      if (
        existing &&
        existing.executionId === input.executionId &&
        existing.questionSetSha256 === questionSetSha256
      ) {
        next = {
          ...existing,
          attempt: input.attempt,
          waitOccurrence: existing.waitOccurrence + 1,
          updatedAt: now,
          // Recovery may never mint a fresh interview timeout envelope.
          deadlineAt: Math.min(existing.deadlineAt, Math.floor(input.deadlineAt)),
        };
      } else if (
        existing &&
        (existing.status === "answered" || existing.status === "cancelled") &&
        existing.questionSetSha256 === questionSetSha256
      ) {
        next = {
          ...existing,
          executionId: input.executionId,
          attempt: input.attempt,
          updatedAt: now,
          deadlineAt: Math.floor(input.deadlineAt),
          carriedFromExecutionId: existing.executionId,
        };
      } else {
        next = {
          stateVersion: PROMPT_OPTIMIZATION_INTERVIEW_STATE_VERSION,
          revision: existing?.revision ?? 1,
          runId: input.runId,
          nodeId: input.nodeId,
          executionId: input.executionId,
          attempt: input.attempt,
          waitOccurrence: (existing?.waitOccurrence ?? 0) + 1,
          status: "pending",
          questions: structuredClone(input.questions),
          questionSetSha256,
          createdAt: now,
          updatedAt: now,
          deadlineAt: Math.floor(input.deadlineAt),
        };
      }
      const committed = await this.compareAndSwap(
        input.runId,
        input.nodeId,
        existing?.revision ?? null,
        next,
      );
      if (!committed.swapped || !committed.state) continue;
      return {
        state: committed.state,
        event: committed.state.status === "pending"
          ? waitingEvent(committed.state)
          : resumedEvent(committed.state),
      };
    }
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
    for (;;) {
      const state = await this.read(runId, nodeId);
      if (!state) throw new Error("No durable prompt optimization interview exists for this run and node.");
      if (state.status !== "pending") {
        // Successful terminal answer writes are idempotent. A timeout remains
        // a rejected late submission rather than being reported as an answer.
        if (state.status === "answered" || state.status === "cancelled") {
          return { state, event: resumedEvent(state) };
        }
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
      const committed = await this.compareAndSwap(runId, nodeId, state.revision, next);
      if (!committed.swapped || !committed.state) continue;
      return { state: committed.state, event: resumedEvent(committed.state) };
    }
  }

  async timeout(runId: string, nodeId: string): Promise<PromptOptimizationInterviewTransition> {
    for (;;) {
      const state = await this.read(runId, nodeId);
      if (!state) throw new Error("No durable prompt optimization interview exists for this run and node.");
      if (state.status !== "pending") return { state, event: resumedEvent(state) };
      const next: PromptOptimizationInterviewStateV1 = {
        ...state,
        status: "timed-out",
        updatedAt: Math.max(0, Math.floor(this.now())),
      };
      const committed = await this.compareAndSwap(runId, nodeId, state.revision, next);
      if (!committed.swapped || !committed.state) continue;
      return { state: committed.state, event: resumedEvent(committed.state) };
    }
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
