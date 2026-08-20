/**
 * Stateless Autoresearch² adapter over the authoritative WorkflowStore.
 *
 * It reads a live reduced RunState and its durable events. It intentionally
 * does not invent a second monitor store or append a made-up event type to the
 * frozen RunState v1 contract. The returned persistence flag is part of the
 * wire contract so callers cannot mistake an adjacent critique for a durable
 * run event.
 */
import {
  WorkflowStore,
  workflowStore,
  type WorkflowRunRecord,
} from "../workflows/store.ts";
import type { WorkflowRunEventV1 } from "../workflows/run-state.ts";
import { SkillCuratorError } from "./skill-curator.ts";

export type AutoresearchMonitorMode = "interactive" | "autonomous";
export type AutoresearchCritiqueSeverity = "info" | "warning" | "error";

export const MAX_AUTORESEARCH_EVALUATIONS = 20;
export const MAX_AUTORESEARCH_EVENT_WINDOW = 200;

export interface AutoresearchCritique {
  id: string;
  severity: AutoresearchCritiqueSeverity;
  title: string;
  detail: string;
  source:
    | { kind: "run-state"; lastSeq: number }
    | { kind: "run-event"; seq: number; eventId: string; eventType: string };
}

export interface AutoresearchEvaluationInput {
  mode: AutoresearchMonitorMode;
  cycle: number;
  maxEvaluations: number;
  afterSeq?: number;
  userInput?: string;
}

export interface AutoresearchEvaluation {
  runId: string;
  mode: AutoresearchMonitorMode;
  cycle: number;
  maxEvaluations: number;
  remainingEvaluations: number;
  state: {
    status: WorkflowRunRecord["state"]["status"];
    lastSeq: number;
    recoverable: boolean;
    terminal: boolean;
    canStopRun: boolean;
  };
  critiques: AutoresearchCritique[];
  nextAfterSeq: number;
  needsUserInput: boolean;
  question: string | null;
  persistedToRunState: false;
  runStatePersistenceReason: string;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function eventCritique(event: WorkflowRunEventV1): AutoresearchCritique | null {
  const source = {
    kind: "run-event" as const,
    seq: event.seq,
    eventId: event.eventId,
    eventType: event.type,
  };
  if (event.type === "node_failed") {
    const error = event.data?.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof error?.code === "string" ? error.code : "NODE_FAILED";
    const message =
      typeof error?.message === "string" ? error.message : "The node failed without a bounded message.";
    return {
      id: `event-${event.seq}-node-failed`,
      severity: "error",
      title: `Node ${event.nodeId ?? "(unknown)"} failed (${code})`,
      detail: message,
      source,
    };
  }
  if (
    (event.type === "gate_evaluated" || event.type === "evidence_checked") &&
    event.data?.supported === false
  ) {
    return {
      id: `event-${event.seq}-unsupported`,
      severity: "warning",
      title: "The run recorded unsupported output",
      detail:
        "A trusted gate or evidence check rejected the output. Inspect the cited sources and artifacts before continuing.",
      source,
    };
  }
  if (event.type === "compaction_checked" && event.data?.supported === false) {
    return {
      id: `event-${event.seq}-compaction`,
      severity: "warning",
      title: "A compaction check failed",
      detail: "The run's compacted context did not pass its persisted integrity check.",
      source,
    };
  }
  return null;
}

function stateCritiques(run: WorkflowRunRecord): AutoresearchCritique[] {
  const critiques: AutoresearchCritique[] = [];
  const source = { kind: "run-state" as const, lastSeq: run.state.lastSeq };
  for (const diagnostic of run.state.diagnostics) {
    critiques.push({
      id: `diagnostic-${diagnostic.code}-${diagnostic.line ?? "none"}`,
      severity: diagnostic.fatal ? "error" : "warning",
      title: diagnostic.fatal
        ? `Run-state integrity failure: ${diagnostic.code}`
        : `Run-state diagnostic: ${diagnostic.code}`,
      detail: diagnostic.message,
      source,
    });
  }
  if (run.state.lastError) {
    critiques.push({
      id: `last-error-${run.state.lastError.code}`,
      severity: "error",
      title: `Latest run error: ${run.state.lastError.code}`,
      detail: run.state.lastError.message,
      source,
    });
  }
  if (["waiting", "blocked", "paused"].includes(run.state.status)) {
    critiques.push({
      id: `run-status-${run.state.status}`,
      severity: "warning",
      title: `Run is ${run.state.status}`,
      detail:
        "Confirm the expected user decision or recovery action before spending another autonomous evaluation.",
      source,
    });
  }
  return critiques;
}

function assertEvaluationInput(input: AutoresearchEvaluationInput): void {
  if (input.mode !== "interactive" && input.mode !== "autonomous") {
    throw new SkillCuratorError(
      400,
      "INVALID_MONITOR_MODE",
      "mode must be interactive or autonomous.",
    );
  }
  if (
    !Number.isSafeInteger(input.maxEvaluations) ||
    input.maxEvaluations < 1 ||
    input.maxEvaluations > MAX_AUTORESEARCH_EVALUATIONS
  ) {
    throw new SkillCuratorError(
      400,
      "INVALID_EVALUATION_BOUND",
      `maxEvaluations must be an integer from 1 to ${MAX_AUTORESEARCH_EVALUATIONS}.`,
    );
  }
  if (
    !Number.isSafeInteger(input.cycle) ||
    input.cycle < 1 ||
    input.cycle > input.maxEvaluations
  ) {
    throw new SkillCuratorError(
      400,
      "EVALUATION_BOUND_REACHED",
      "cycle must be within the explicit maxEvaluations bound.",
    );
  }
  if (
    input.afterSeq !== undefined &&
    (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0)
  ) {
    throw new SkillCuratorError(400, "INVALID_EVENT_CURSOR", "afterSeq must be a non-negative integer.");
  }
  if (
    input.userInput !== undefined &&
    (typeof input.userInput !== "string" || input.userInput.length > 4_096)
  ) {
    throw new SkillCuratorError(
      400,
      "INVALID_USER_INPUT",
      "userInput must be at most 4096 characters.",
    );
  }
}

export function evaluateAutoresearchRun(
  projectId: string,
  runId: string,
  input: AutoresearchEvaluationInput,
  store: WorkflowStore = workflowStore,
): AutoresearchEvaluation {
  assertEvaluationInput(input);
  const run = store.readRun(projectId, runId);
  if (!run) {
    throw new SkillCuratorError(404, "RUN_NOT_FOUND", `No workflow run named "${runId}" exists.`);
  }
  const page = store.readRunEvents(projectId, runId, {
    after: input.afterSeq ?? 0,
    limit: MAX_AUTORESEARCH_EVENT_WINDOW,
  });
  const critiques = [
    ...stateCritiques(run),
    ...page.events.flatMap((event) => {
      const critique = eventCritique(event);
      return critique ? [critique] : [];
    }),
  ].slice(0, 32);

  const terminal = TERMINAL_STATUSES.has(run.state.status);
  if (critiques.length === 0) {
    critiques.push({
      id: `state-${run.state.lastSeq}-no-persisted-failure`,
      severity: "info",
      title: terminal ? "No persisted failure found in this event window" : "No persisted failure yet",
      detail:
        "This is not a correctness verdict. It only means the bounded RunState/event projection contains no recognized failure signal.",
      source: { kind: "run-state", lastSeq: run.state.lastSeq },
    });
  }

  const needsUserInput =
    input.mode === "interactive" && !(input.userInput?.trim());
  return {
    runId,
    mode: input.mode,
    cycle: input.cycle,
    maxEvaluations: input.maxEvaluations,
    remainingEvaluations: input.maxEvaluations - input.cycle,
    state: {
      status: run.state.status,
      lastSeq: run.state.lastSeq,
      recoverable: run.state.recoverable,
      terminal,
      canStopRun: !terminal,
    },
    critiques,
    nextAfterSeq: page.lastSeq,
    needsUserInput,
    question: needsUserInput
      ? "What outcome, assumption, or failure should this interactive evaluation challenge?"
      : null,
    persistedToRunState: false,
    runStatePersistenceReason:
      "RunState v1 has no critique/evaluation event channel on this build. This observer reads the authoritative state without changing its frozen contract.",
  };
}
