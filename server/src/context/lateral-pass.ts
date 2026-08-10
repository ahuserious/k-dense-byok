import type {
  WorkflowBehaviorRegistry,
  WorkflowBehaviorResult,
} from "../workflows/behavior-registry.ts";
import { DEFAULT_COMPACTION_WATCHER_MODEL } from "../workflows/compaction-watcher.ts";

export const LATERAL_PASS_BEHAVIOR = "lateral-pass";
export const DEFAULT_LATERAL_PASS_MODEL = DEFAULT_COMPACTION_WATCHER_MODEL;

const MODEL_REF_PATTERN = /^[a-z0-9][a-z0-9._-]*\/.+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MAX_MESSAGES = 50_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 256;
const MAX_ITEM_BYTES = 16 * 1024;

export type LateralPassErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_DISPATCH"
  | "INVALID_MODEL_SUMMARY"
  | "CLEAN_WINDOW_REJECTED";

export class LateralPassError extends Error {
  constructor(readonly code: LateralPassErrorCode, message: string) {
    super(message);
    this.name = "LateralPassError";
  }
}

export interface LateralPassMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

export interface LateralPassModelRequest {
  model: string;
  runId: string;
  sourceSessionId: string;
  userPrompt: string;
  goal: string;
  openTodos: readonly string[];
  transcript: readonly LateralPassMessage[];
  instruction: string;
}

export interface LateralPassSummary {
  summary: string;
  goal: string;
  openTodos: readonly string[];
  decisions: readonly string[];
  constraints: readonly string[];
}

export interface OpenCleanWindowRequest extends LateralPassSummary {
  sourceSessionId: string;
  /** This must remain false; lateral pass is a new-window operation. */
  compacted: false;
}

export interface LateralPassBehaviorResult extends WorkflowBehaviorResult {
  sourceSessionId: string;
  targetSessionId: string;
  compacted: false;
  model: string;
}

export interface LateralPassDependencies {
  registry: WorkflowBehaviorRegistry;
  summarize(request: LateralPassModelRequest): Promise<unknown>;
  openCleanWindow(request: OpenCleanWindowRequest): Promise<{ sessionId: string }>;
  env?: NodeJS.ProcessEnv;
  model?: string;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= MAX_TEXT_BYTES;
}

function boundedItems(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(
    (item) => typeof item === "string" && item.length > 0 && utf8Bytes(item) <= MAX_ITEM_BYTES,
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseMessages(value: unknown): LateralPassMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new LateralPassError(
      "INVALID_DISPATCH",
      "Lateral pass requires a non-empty bounded transcript.",
    );
  }
  let totalBytes = 0;
  const messages: LateralPassMessage[] = [];
  for (const message of value) {
    if (
      !plainRecord(message) ||
      Object.keys(message).some((key) => key !== "role" && key !== "content") ||
      !["user", "assistant", "tool", "system"].includes(message.role as string) ||
      !boundedText(message.content)
    ) {
      throw new LateralPassError("INVALID_DISPATCH", "Lateral pass transcript is malformed.");
    }
    totalBytes += utf8Bytes(message.content);
    if (totalBytes > MAX_TEXT_BYTES) {
      throw new LateralPassError("INVALID_DISPATCH", "Lateral pass transcript is too large.");
    }
    messages.push({
      role: message.role as LateralPassMessage["role"],
      content: message.content,
    });
  }
  return messages;
}

export function parseLateralPassSummary(value: unknown): LateralPassSummary {
  if (
    !plainRecord(value) ||
    Object.keys(value).some((key) => ![
      "summary",
      "goal",
      "openTodos",
      "decisions",
      "constraints",
    ].includes(key)) ||
    !boundedText(value.summary) ||
    !boundedText(value.goal) ||
    !boundedItems(value.openTodos) ||
    !boundedItems(value.decisions) ||
    !boundedItems(value.constraints)
  ) {
    throw new LateralPassError(
      "INVALID_MODEL_SUMMARY",
      "The lateral-pass model returned an invalid clean-window summary.",
    );
  }
  return {
    summary: value.summary,
    goal: value.goal,
    openTodos: [...value.openTodos],
    decisions: [...value.decisions],
    constraints: [...value.constraints],
  };
}

const LATERAL_PASS_INSTRUCTION = [
  "Summarize this session for a new clean context window without compacting or",
  "rewriting the source session. Preserve the user goal, unresolved todos,",
  "decisions, constraints, provenance-sensitive facts, and uncertainty.",
  "Do not invent completion or discard a still-open obligation.",
].join(" ");

/** Register server-side clean-window handoff through the frozen behavior registry. */
export function registerLateralPassBehavior(
  dependencies: LateralPassDependencies,
): { model: string } {
  const model = dependencies.model?.trim() ||
    (dependencies.env ?? process.env).KADY_LATERAL_PASS_MODEL?.trim() ||
    DEFAULT_LATERAL_PASS_MODEL;
  if (!MODEL_REF_PATTERN.test(model)) {
    throw new LateralPassError(
      "INVALID_CONFIGURATION",
      "KADY_LATERAL_PASS_MODEL must be a provider-qualified model reference.",
    );
  }

  dependencies.registry.register(
    LATERAL_PASS_BEHAVIOR,
    ["lateral-pass"],
    async (dispatch): Promise<LateralPassBehaviorResult> => {
      if (!plainRecord(dispatch.payload)) {
        throw new LateralPassError("INVALID_DISPATCH", "Lateral pass requires a payload.");
      }
      const payload = dispatch.payload;
      const sourceSessionId = payload.sourceSessionId;
      if (typeof sourceSessionId !== "string" || !SESSION_ID_PATTERN.test(sourceSessionId)) {
        throw new LateralPassError("INVALID_DISPATCH", "Lateral pass session id is invalid.");
      }
      if (!boundedText(payload.userPrompt) || !boundedText(payload.goal)) {
        throw new LateralPassError("INVALID_DISPATCH", "Lateral pass prompt or goal is invalid.");
      }
      if (!boundedItems(payload.openTodos)) {
        throw new LateralPassError("INVALID_DISPATCH", "Lateral pass todos are invalid.");
      }
      const transcript = parseMessages(payload.transcript);
      const summary = parseLateralPassSummary(await dependencies.summarize({
        model,
        runId: dispatch.runId,
        sourceSessionId,
        userPrompt: payload.userPrompt,
        goal: payload.goal,
        openTodos: [...payload.openTodos],
        transcript,
        instruction: LATERAL_PASS_INSTRUCTION,
      }));
      const openTodos = [...new Set([...payload.openTodos, ...summary.openTodos])];
      if (openTodos.length > MAX_ITEMS) {
        throw new LateralPassError(
          "INVALID_MODEL_SUMMARY",
          "The lateral-pass summary exceeds the open-todo bound.",
        );
      }
      const cleanWindow = await dependencies.openCleanWindow({
        sourceSessionId,
        compacted: false,
        ...summary,
        // The originating request remains authoritative over model paraphrase.
        goal: payload.goal,
        openTodos,
      });
      if (!SESSION_ID_PATTERN.test(cleanWindow.sessionId) || cleanWindow.sessionId === sourceSessionId) {
        throw new LateralPassError(
          "CLEAN_WINDOW_REJECTED",
          "Lateral pass did not create a distinct clean session.",
        );
      }
      return {
        handled: true,
        sourceSessionId,
        targetSessionId: cleanWindow.sessionId,
        compacted: false,
        model,
        detail: `Created clean session ${cleanWindow.sessionId} from ${sourceSessionId}.`,
      };
    },
  );

  return { model };
}
