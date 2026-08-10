import {
  associateWorkflowRun,
  finishRun,
  latestWorkflowRunAssociation,
  listRunsForSession,
  startRun,
  type FinishRunFields,
  type RunRecord,
} from "./runs-index.ts";
import { parseRunStateV1, type RunStateV1 } from "../api/workflow-run-state.ts";
import {
  workflowStore,
  type WorkflowNodeExecutionState,
  type WorkflowRunRecord,
} from "../workflows/index.ts";

const WORKFLOW_RUN_REFERENCE = /\bwrun_[a-f0-9]{32}\b/;
type RunStateV1NodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted"
  | "cancelled";
const COMPLETED_NODE_STATUSES = new Set<RunStateV1NodeStatus>([
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
]);

export interface RegisterChatTurnInput {
  projectId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  workflowRunId?: string;
  agentId?: string;
}

export interface CompleteChatTurnInput {
  projectId: string;
  sessionId: string;
  indexRunId: string;
  status: FinishRunFields["status"];
  error?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  numTurns?: number;
}

export interface BackgroundAgentTrailingNodeInput {
  slotId: string;
  agentId: string;
  status: RunStateV1NodeStatus;
  nodeId?: string;
}

export interface ProjectWorkflowRunOptions {
  backgroundAgentTrailingNode?: BackgroundAgentTrailingNodeInput;
  chatStreamError?: {
    code: string;
    message: string;
    retryable: boolean;
    nodeId?: string;
  };
}

/** Register one accepted chat turn in the shared append-only runs index. */
export function registerChatTurnRun(input: RegisterChatTurnInput): string {
  const workflowRunId =
    input.workflowRunId ?? input.prompt.match(WORKFLOW_RUN_REFERENCE)?.[0];
  const indexRunId = startRun(input.projectId, {
    sessionId: input.sessionId,
    loopId: null,
    iteration: 0,
    task: input.prompt,
    role: "agent",
    ...(input.model ? { model: input.model } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  if (workflowRunId) {
    associateWorkflowRun(
      input.projectId,
      input.sessionId,
      workflowRunId,
      input.workflowRunId ? "chat-event" : "chat-prompt",
      indexRunId,
    );
  }
  return indexRunId;
}

/** Append the terminal row for a previously registered chat turn. */
export function completeChatTurnRun(input: CompleteChatTurnInput): boolean {
  return finishRun(input.projectId, input.sessionId, input.indexRunId, {
    status: input.status,
    ...(input.error ? { output: input.error } : {}),
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    ...(input.tokensIn !== undefined ? { tokensIn: input.tokensIn } : {}),
    ...(input.tokensOut !== undefined ? { tokensOut: input.tokensOut } : {}),
    ...(input.numTurns !== undefined ? { numTurns: input.numTurns } : {}),
  });
}

/** Latest indexed ordinary chat turn for a session, if one has been accepted. */
export function latestChatTurnRun(
  projectId: string,
  sessionId: string,
): RunRecord | null {
  return (
    listRunsForSession(projectId, sessionId).find(
      (run) => run.role === "agent",
    ) ?? null
  );
}

function collectWorkflowRunReferences(
  value: unknown,
  output: Set<string>,
  depth = 0,
): void {
  if (output.size >= 8 || depth > 8) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(/\bwrun_[a-f0-9]{32}\b/g)) {
      output.add(match[0]);
      if (output.size >= 8) return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) {
      collectWorkflowRunReferences(item, output, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    if (key === "data" && typeof item === "string" && item.length > 8_192)
      continue;
    collectWorkflowRunReferences(item, output, depth + 1);
  }
}

/** Persist bounded workflow-run references observed in chat SSE frames. */
export function indexWorkflowRunReferences(
  projectId: string,
  sessionId: string,
  chatRunId: string,
  value: unknown,
): string[] {
  const references = new Set<string>();
  collectWorkflowRunReferences(value, references);
  for (const workflowRunId of references) {
    associateWorkflowRun(
      projectId,
      sessionId,
      workflowRunId,
      "chat-event",
      chatRunId,
    );
  }
  return [...references];
}

/** Persist a validated typed launch that is not owned by any chat turn. */
export function associateTypedWorkflowLaunch(
  projectId: string,
  sessionId: string,
  workflowRunId: string,
): void {
  associateWorkflowRun(
    projectId,
    sessionId,
    workflowRunId,
    "typed-launch",
    null,
  );
}

/** Resolve a chat session's indexed workflow run by its exact durable id. */
export function workflowRunForChatSession(
  projectId: string,
  sessionId: string,
): WorkflowRunRecord | null {
  const association = latestWorkflowRunAssociation(projectId, sessionId);
  return association
    ? workflowStore.readRun(projectId, association.workflowRunId)
    : null;
}

/** Error routing is driven only by a failed chat stream, never inferred from a DAG failure. */
export function chatStreamErrorForSession(
  projectId: string,
  sessionId: string,
  workflowRunId: string,
): ProjectWorkflowRunOptions["chatStreamError"] | undefined {
  const association = latestWorkflowRunAssociation(projectId, sessionId);
  if (
    !association ||
    association.workflowRunId !== workflowRunId ||
    association.chatRunId === null
  ) {
    return undefined;
  }
  const chatTurn = listRunsForSession(projectId, sessionId).find(
    (run) => run.id === association.chatRunId && run.role === "agent",
  );
  if (!chatTurn || chatTurn.status !== "failed") return undefined;
  return {
    code: "CHAT_STREAM_ERROR",
    message:
      chatTurn.output ||
      "The chat stream failed while observing this workflow run.",
    retryable: true,
  };
}

type ActiveBackgroundAgentState = "running" | "error" | "blocked";

function trailingStatusAllowed(
  workflowRunStatus: RunStateV1["status"],
  trailingStatus: RunStateV1NodeStatus,
): boolean {
  if (workflowRunStatus === "queued") return trailingStatus === "pending";
  if (
    workflowRunStatus === "running" ||
    workflowRunStatus === "waiting" ||
    workflowRunStatus === "blocked" ||
    workflowRunStatus === "paused"
  ) {
    return true;
  }
  if (workflowRunStatus === "succeeded") {
    return trailingStatus === "succeeded" || trailingStatus === "skipped";
  }
  return (
    COMPLETED_NODE_STATUSES.has(trailingStatus) || trailingStatus === "pending"
  );
}

/** Durable helper terminal state with an optional live-broker overlay. */
export function backgroundAgentTrailingNodeForSession(input: {
  projectId: string;
  helperSessionId: string;
  workflowRunId: string;
  workflowRunStatus: RunStateV1["status"];
  activeState?: ActiveBackgroundAgentState;
}): BackgroundAgentTrailingNodeInput | undefined {
  const durable = latestChatTurnRun(input.projectId, input.helperSessionId);
  const durableStatus =
    durable?.agentId === "workflow-rescue" &&
    durable.workflowRunId === input.workflowRunId
      ? durable.status === "completed"
        ? "succeeded"
        : durable.status === "failed"
          ? "failed"
          : undefined
      : undefined;
  const activeStatus = input.activeState
    ? input.activeState === "error"
      ? "failed"
      : input.activeState
    : undefined;
  const status =
    activeStatus && trailingStatusAllowed(input.workflowRunStatus, activeStatus)
      ? activeStatus
      : durableStatus &&
          trailingStatusAllowed(input.workflowRunStatus, durableStatus)
        ? durableStatus
        : undefined;
  if (!status) return undefined;
  return {
    slotId: "background-agent",
    agentId: "workflow-rescue",
    status,
  };
}

function latestExecutionForNode(
  executions: WorkflowNodeExecutionState[],
  nodeId: string,
): WorkflowNodeExecutionState | undefined {
  return executions
    .filter((execution) => execution.nodeId === nodeId)
    .sort(
      (left, right) =>
        right.attempt - left.attempt ||
        (right.finishedAt ?? right.startedAt ?? 0) -
          (left.finishedAt ?? left.startedAt ?? 0) ||
        right.executionId.localeCompare(left.executionId),
    )[0];
}

function projectionUpdatedAt(run: WorkflowRunRecord): number {
  const executionTimestamps = Object.values(run.state.executions).flatMap(
    (execution) => [execution.startedAt ?? 0, execution.finishedAt ?? 0],
  );
  return Math.max(
    run.manifest.createdAt,
    run.state.startedAt ?? 0,
    run.state.finishedAt ?? 0,
    run.state.interruptedAt ?? 0,
    ...executionTimestamps,
  );
}

function defaultAttachedNodeId(run: WorkflowRunRecord): string | undefined {
  const executions = Object.values(run.state.executions);
  const latestExecution = [...executions].sort(
    (left, right) =>
      (right.finishedAt ?? right.startedAt ?? 0) -
        (left.finishedAt ?? left.startedAt ?? 0) ||
      right.attempt - left.attempt ||
      right.executionId.localeCompare(left.executionId),
  )[0];
  if (latestExecution) return latestExecution.nodeId;

  const graphEdges = run.manifest.graph.edges as Array<{ from: string }>;
  const graphNodes = run.manifest.graph.nodes as Array<{ id: string }>;
  const nodesWithOutgoingEdges = new Set(graphEdges.map((edge) => edge.from));
  return (
    graphNodes.find((node) => !nodesWithOutgoingEdges.has(node.id))?.id ??
    run.manifest.graph.entryNodeId
  );
}

/**
 * Project durable workflow state into the frozen, JSON-safe RunState v1 shape.
 * The final parse is the fail-closed boundary: callers never receive a value
 * that the canonical validator rejects.
 */
export function projectWorkflowRunStateV1(
  run: WorkflowRunRecord,
  options: ProjectWorkflowRunOptions = {},
): RunStateV1 {
  const executions = Object.values(run.state.executions);
  const graphNodes = run.manifest.graph.nodes as Array<{ id: string }>;
  const graphEdges = run.manifest.graph.edges as Array<{
    id: string;
    from: string;
    to: string;
  }>;
  const nodes: RunStateV1["nodes"] = graphNodes.map((graphNode) => {
    const execution = latestExecutionForNode(executions, graphNode.id);
    const status =
      execution?.status ??
      (run.state.status === "succeeded" ? "skipped" : "pending");
    return {
      id: graphNode.id,
      status,
      progress: {
        completed: COMPLETED_NODE_STATUSES.has(status) ? 1 : 0,
        total: 1,
        message: status,
      },
      ...(execution ? { executionId: execution.executionId } : {}),
    };
  });

  const errorNodeId =
    options.chatStreamError?.nodeId ??
    executions.find((execution) => execution.status === "failed")?.nodeId;
  const requestedTrailingNode = options.backgroundAgentTrailingNode;
  const trailingNode = requestedTrailingNode
    ? {
        ...requestedTrailingNode,
        nodeId: requestedTrailingNode.nodeId ?? defaultAttachedNodeId(run),
      }
    : undefined;
  const candidate: RunStateV1 = {
    schemaVersion: 1,
    runId: run.manifest.id,
    workflowId: run.manifest.workflowId,
    workflowRevision: run.manifest.workflowRevision,
    status: run.state.status,
    nodes,
    topology: {
      nodes: graphNodes.map((node) => ({ id: node.id })),
      edges: graphEdges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
      })),
    },
    ...(trailingNode ? { backgroundAgentTrailingNode: trailingNode } : {}),
    ...(options.chatStreamError
      ? {
          errorRouting: {
            source: "chat-stream" as const,
            surface: true as const,
            ...(errorNodeId ? { nodeId: errorNodeId } : {}),
            error: {
              code: options.chatStreamError.code,
              message: options.chatStreamError.message,
              retryable: options.chatStreamError.retryable,
            },
          },
        }
      : {}),
    updatedAt: projectionUpdatedAt(run),
  };

  return parseRunStateV1(JSON.stringify(candidate));
}
