"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangleIcon, BotIcon, GitBranchIcon } from "lucide-react";
import { apiFetch } from "@/lib/projects";
import { cn } from "@/lib/utils";

export type RunStateV1Status =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "paused"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunStateV1NodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted"
  | "cancelled";

export interface RunStateV1Projection {
  schemaVersion: 1;
  runId: string;
  workflowId: string;
  workflowRevision: number;
  status: RunStateV1Status;
  nodes: Array<{
    id: string;
    status: RunStateV1NodeStatus;
    progress: { completed: number; total: number; message?: string };
    executionId?: string;
  }>;
  topology: {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string; from: string; to: string }>;
  };
  backgroundAgentTrailingNode?: {
    slotId: string;
    agentId: string;
    nodeId?: string;
    status: RunStateV1NodeStatus;
  };
  errorRouting?: {
    source: "chat-stream";
    surface: true;
    nodeId?: string;
    error: { code: string; message: string; retryable: boolean };
  };
  updatedAt: number;
}

const RUN_STATUSES = new Set<RunStateV1Status>([
  "queued",
  "running",
  "waiting",
  "blocked",
  "paused",
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
]);
const NODE_STATUSES = new Set<RunStateV1NodeStatus>([
  "pending",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
]);
const TERMINAL_NODE_STATUSES = new Set<RunStateV1NodeStatus>([
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
]);
const STATUS_COHERENCE: Record<
  RunStateV1Status,
  ReadonlySet<RunStateV1NodeStatus>
> = {
  queued: new Set(["pending"]),
  running: NODE_STATUSES,
  waiting: NODE_STATUSES,
  blocked: NODE_STATUSES,
  paused: NODE_STATUSES,
  interrupted: TERMINAL_NODE_STATUSES,
  succeeded: new Set(["succeeded", "skipped"]),
  failed: TERMINAL_NODE_STATUSES,
  cancelled: TERMINAL_NODE_STATUSES,
};
const TERMINAL_RUN_STATUSES = new Set<RunStateV1Status>([
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    IDENTIFIER.test(value)
  );
}

function nodeStatus(value: unknown): value is RunStateV1NodeStatus {
  return (
    typeof value === "string" &&
    NODE_STATUSES.has(value as RunStateV1NodeStatus)
  );
}

function validationError(message: string): never {
  throw new Error(`Invalid RunState v1 projection: ${message}`);
}

/** Browser-side fail-closed mirror of the frozen RunState v1 validation rules. */
export function parseRunStateV1Projection(
  value: unknown,
): RunStateV1Projection {
  const state = record(value);
  if (
    !state ||
    !hasOnlyKeys(state, [
      "schemaVersion",
      "runId",
      "workflowId",
      "workflowRevision",
      "status",
      "nodes",
      "topology",
      "backgroundAgentTrailingNode",
      "errorRouting",
      "updatedAt",
    ])
  )
    validationError("invalid root object");
  if (state.schemaVersion !== 1) validationError("schemaVersion must be 1");
  if (!identifier(state.runId) || !identifier(state.workflowId)) {
    validationError("invalid run or workflow id");
  }
  if (
    !Number.isSafeInteger(state.workflowRevision) ||
    Number(state.workflowRevision) < 1
  ) {
    validationError("workflowRevision must be positive");
  }
  if (
    typeof state.status !== "string" ||
    !RUN_STATUSES.has(state.status as RunStateV1Status)
  ) {
    validationError("invalid run status");
  }
  const status = state.status as RunStateV1Status;
  if (!Array.isArray(state.nodes) || state.nodes.length > 256) {
    validationError("invalid nodes array");
  }
  const parsedNodes: RunStateV1Projection["nodes"] = [];
  const stateNodeIds = new Set<string>();
  for (const candidate of state.nodes) {
    const node = record(candidate);
    if (
      !node ||
      !hasOnlyKeys(node, ["id", "status", "progress", "executionId"]) ||
      !identifier(node.id) ||
      !nodeStatus(node.status)
    ) {
      validationError("invalid node");
    }
    if (stateNodeIds.has(node.id)) validationError("duplicate state node id");
    stateNodeIds.add(node.id);
    if (!STATUS_COHERENCE[status].has(node.status))
      validationError("incoherent node status");
    const progress = record(node.progress);
    if (
      !progress ||
      !hasOnlyKeys(progress, ["completed", "total", "message"]) ||
      !Number.isSafeInteger(progress.completed) ||
      Number(progress.completed) < 0 ||
      !Number.isSafeInteger(progress.total) ||
      Number(progress.total) < 1 ||
      Number(progress.completed) > Number(progress.total) ||
      (progress.message !== undefined &&
        (typeof progress.message !== "string" ||
          progress.message.length < 1 ||
          progress.message.length > 512)) ||
      (node.executionId !== undefined && !identifier(node.executionId))
    ) {
      validationError("invalid node progress");
    }
    parsedNodes.push({
      id: node.id,
      status: node.status,
      progress: {
        completed: Number(progress.completed),
        total: Number(progress.total),
        ...(typeof progress.message === "string"
          ? { message: progress.message }
          : {}),
      },
      ...(typeof node.executionId === "string"
        ? { executionId: node.executionId }
        : {}),
    });
  }
  if (
    status === "succeeded" &&
    !parsedNodes.some((node) => node.status === "succeeded")
  ) {
    validationError("succeeded run requires a succeeded node");
  }

  const topology = record(state.topology);
  if (
    !topology ||
    !hasOnlyKeys(topology, ["nodes", "edges"]) ||
    !Array.isArray(topology.nodes) ||
    topology.nodes.length > 256 ||
    !Array.isArray(topology.edges) ||
    topology.edges.length > 1024
  ) {
    validationError("invalid topology");
  }
  const topologyNodes: RunStateV1Projection["topology"]["nodes"] = [];
  const topologyNodeIds = new Set<string>();
  for (const candidate of topology.nodes) {
    const node = record(candidate);
    if (
      !node ||
      !hasOnlyKeys(node, ["id"]) ||
      !identifier(node.id) ||
      topologyNodeIds.has(node.id)
    )
      validationError("invalid topology node");
    topologyNodeIds.add(node.id);
    topologyNodes.push({ id: node.id });
  }
  if ([...stateNodeIds].some((id) => !topologyNodeIds.has(id))) {
    validationError("state node absent from topology");
  }
  const topologyEdges: RunStateV1Projection["topology"]["edges"] = [];
  const edgeIds = new Set<string>();
  for (const candidate of topology.edges) {
    const edge = record(candidate);
    if (
      !edge ||
      !hasOnlyKeys(edge, ["id", "from", "to"]) ||
      !identifier(edge.id) ||
      !identifier(edge.from) ||
      !identifier(edge.to) ||
      edgeIds.has(edge.id) ||
      !topologyNodeIds.has(edge.from) ||
      !topologyNodeIds.has(edge.to)
    )
      validationError("invalid topology edge");
    edgeIds.add(edge.id);
    topologyEdges.push({ id: edge.id, from: edge.from, to: edge.to });
  }

  let backgroundAgentTrailingNode: RunStateV1Projection["backgroundAgentTrailingNode"];
  if (state.backgroundAgentTrailingNode !== undefined) {
    const trailing = record(state.backgroundAgentTrailingNode);
    if (
      !trailing ||
      !hasOnlyKeys(trailing, ["slotId", "agentId", "nodeId", "status"]) ||
      !identifier(trailing.slotId) ||
      !identifier(trailing.agentId) ||
      !nodeStatus(trailing.status) ||
      !STATUS_COHERENCE[status].has(trailing.status) ||
      (trailing.nodeId !== undefined &&
        (!identifier(trailing.nodeId) || !topologyNodeIds.has(trailing.nodeId)))
    ) {
      validationError("invalid background-agent trailing node");
    }
    backgroundAgentTrailingNode = {
      slotId: trailing.slotId,
      agentId: trailing.agentId,
      status: trailing.status,
      ...(typeof trailing.nodeId === "string"
        ? { nodeId: trailing.nodeId }
        : {}),
    };
  }

  let errorRouting: RunStateV1Projection["errorRouting"];
  if (state.errorRouting !== undefined) {
    const routing = record(state.errorRouting);
    const error = record(routing?.error);
    if (
      !routing ||
      !hasOnlyKeys(routing, ["source", "surface", "nodeId", "error"]) ||
      routing.source !== "chat-stream" ||
      routing.surface !== true ||
      (routing.nodeId !== undefined &&
        (!identifier(routing.nodeId) ||
          !topologyNodeIds.has(routing.nodeId))) ||
      !error ||
      !hasOnlyKeys(error, ["code", "message", "retryable"]) ||
      typeof error.code !== "string" ||
      error.code.length < 1 ||
      error.code.length > 64 ||
      typeof error.message !== "string" ||
      error.message.length < 1 ||
      error.message.length > 2048 ||
      typeof error.retryable !== "boolean"
    ) {
      validationError("invalid error routing");
    }
    errorRouting = {
      source: "chat-stream",
      surface: true,
      ...(typeof routing.nodeId === "string" ? { nodeId: routing.nodeId } : {}),
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    };
  }
  if (!Number.isSafeInteger(state.updatedAt) || Number(state.updatedAt) < 0) {
    validationError("invalid updatedAt");
  }

  return structuredClone({
    schemaVersion: 1,
    runId: state.runId,
    workflowId: state.workflowId,
    workflowRevision: Number(state.workflowRevision),
    status,
    nodes: parsedNodes,
    topology: { nodes: topologyNodes, edges: topologyEdges },
    ...(backgroundAgentTrailingNode ? { backgroundAgentTrailingNode } : {}),
    ...(errorRouting ? { errorRouting } : {}),
    updatedAt: Number(state.updatedAt),
  });
}

export function isTerminalRunState(status: RunStateV1Status): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

interface PollingOptions {
  fetchProjection: () => Promise<RunStateV1Projection | null>;
  onProjection: (projection: RunStateV1Projection | null) => void;
  intervalMs?: number;
}

/** In-process timer polling; terminal projections deliberately schedule no next poll. */
export function startChatRunStatePolling(options: PollingOptions): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = async () => {
    let projection: RunStateV1Projection | null = null;
    try {
      projection = await options.fetchProjection();
      if (!cancelled) options.onProjection(projection);
    } catch {
      if (!cancelled) options.onProjection(null);
    }
    if (!cancelled && (!projection || !isTerminalRunState(projection.status))) {
      timer = setTimeout(poll, options.intervalMs ?? 1_500);
    }
  };
  void poll();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

export function useChatLiveGraphProjection(options: {
  projectId: string;
  sessionId: string | null;
  enabled: boolean;
  restartKey: string;
}): RunStateV1Projection | null {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    projection: RunStateV1Projection | null;
  } | null>(null);
  useEffect(() => {
    if (!options.enabled || !options.sessionId) return;
    const sessionId = options.sessionId;
    return startChatRunStatePolling({
      fetchProjection: async () => {
        const response = await apiFetch(
          `/sessions/${encodeURIComponent(sessionId)}/workflow-run-state`,
          {},
          options.projectId,
        );
        if (!response.ok)
          throw new Error(`workflow run state failed: ${response.status}`);
        const body = (await response.json()) as { state?: unknown };
        return body.state === null || body.state === undefined
          ? null
          : parseRunStateV1Projection(body.state);
      },
      onProjection: (projection) => setSnapshot({ sessionId, projection }),
    });
  }, [
    options.enabled,
    options.projectId,
    options.restartKey,
    options.sessionId,
  ]);
  return snapshot?.sessionId === options.sessionId ? snapshot.projection : null;
}

const STATUS_STYLE: Record<RunStateV1NodeStatus, string> = {
  pending: "border-zinc-700 bg-zinc-900 text-zinc-300",
  running: "border-cyan-500/70 bg-cyan-950/40 text-cyan-200",
  waiting: "border-amber-500/70 bg-amber-950/40 text-amber-200",
  blocked: "border-orange-500/70 bg-orange-950/40 text-orange-200",
  succeeded: "border-emerald-500/70 bg-emerald-950/40 text-emerald-200",
  failed: "border-red-500/70 bg-red-950/40 text-red-200",
  skipped: "border-zinc-700 bg-zinc-900/60 text-zinc-500",
  interrupted: "border-violet-500/70 bg-violet-950/40 text-violet-200",
  cancelled: "border-zinc-600 bg-zinc-900 text-zinc-400",
};

export function ChatLiveGraph({
  projection,
}: {
  projection: RunStateV1Projection;
}) {
  const trailing = projection.backgroundAgentTrailingNode;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-auto p-5"
      aria-label="Live workflow graph"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <GitBranchIcon className="size-4 text-cyan-400" />
            {projection.workflowId}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {projection.runId} · revision {projection.workflowRevision}
          </div>
        </div>
        <span className="rounded-full border px-2 py-1 text-[11px] uppercase tracking-wide">
          {projection.status}
        </span>
      </header>

      {projection.errorRouting && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-500/50 bg-red-950/30 p-3 text-sm text-red-100"
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangleIcon className="size-4" /> Chat stream error
          </div>
          <p className="mt-1 text-xs text-red-200/90">
            {projection.errorRouting.error.message}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {projection.nodes.map((node) => {
          const percentage = Math.round(
            (node.progress.completed / node.progress.total) * 100,
          );
          return (
            <article
              key={node.id}
              data-node-id={node.id}
              className={cn("rounded-lg border p-3", STATUS_STYLE[node.status])}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs font-medium">
                  {node.id}
                </span>
                <span className="text-[10px] uppercase tracking-wide">
                  {node.status}
                </span>
              </div>
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/30"
                role="progressbar"
                aria-label={`${node.id} progress`}
                aria-valuemin={0}
                aria-valuemax={node.progress.total}
                aria-valuenow={node.progress.completed}
              >
                <div
                  className="h-full rounded-full bg-current transition-[width]"
                  style={{ width: `${percentage}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] opacity-80">
                {node.progress.completed}/{node.progress.total}
                {node.progress.message ? ` · ${node.progress.message}` : ""}
              </div>
            </article>
          );
        })}
      </div>

      {projection.topology.edges.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Workflow edges">
          {projection.topology.edges.map((edge) => (
            <span
              key={edge.id}
              className="rounded border bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground"
            >
              {edge.from} → {edge.to}
            </span>
          ))}
        </div>
      )}

      {trailing && (
        <article
          className={cn(
            "mt-5 ml-auto w-full max-w-sm rounded-lg border p-3",
            STATUS_STYLE[trailing.status],
          )}
          data-trailing-node={trailing.slotId}
          data-attached-to={trailing.nodeId}
        >
          <div className="mb-2 text-[10px] text-muted-foreground">
            {trailing.nodeId
              ? `${trailing.nodeId} → background agent`
              : "Background agent"}
          </div>
          <div className="flex items-center gap-2">
            <BotIcon className="size-4" />
            <span className="font-mono text-xs">{trailing.agentId}</span>
            <span className="ml-auto text-[10px] uppercase tracking-wide">
              {trailing.status}
            </span>
          </div>
        </article>
      )}
    </section>
  );
}

export function ChatLiveGraphTabs({
  projection,
  conversation,
}: {
  projection: RunStateV1Projection | null;
  conversation: ReactNode;
}) {
  const [selected, setSelected] = useState<"conversation" | "dag">(
    projection &&
      (!isTerminalRunState(projection.status) || projection.errorRouting)
      ? "dag"
      : "conversation",
  );
  const surfacedRunId = useRef<string | null>(null);
  useEffect(() => {
    if (!projection) return;
    const isNewRun = surfacedRunId.current !== projection.runId;
    if (
      projection.errorRouting?.surface ||
      (isNewRun && !isTerminalRunState(projection.status))
    ) {
      setSelected("dag");
    }
    surfacedRunId.current = projection.runId;
  }, [
    projection?.errorRouting?.surface,
    projection?.runId,
    projection?.status,
  ]);

  if (!projection) return <>{conversation}</>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-1 border-b px-4 py-2"
        role="tablist"
        aria-label="Chat middle pane"
      >
        <button
          type="button"
          role="tab"
          aria-selected={selected === "conversation"}
          onClick={() => setSelected("conversation")}
          className={cn(
            "rounded px-3 py-1 text-xs",
            selected === "conversation"
              ? "bg-muted font-medium"
              : "text-muted-foreground",
          )}
        >
          Conversation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={selected === "dag"}
          onClick={() => setSelected("dag")}
          className={cn(
            "rounded px-3 py-1 text-xs",
            selected === "dag"
              ? "bg-muted font-medium"
              : "text-muted-foreground",
          )}
        >
          Scientific DAG
        </button>
      </div>
      {selected === "dag" ? (
        <ChatLiveGraph projection={projection} />
      ) : (
        conversation
      )}
    </div>
  );
}
