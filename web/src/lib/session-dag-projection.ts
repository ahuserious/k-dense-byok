// danbot-byok — web/src/lib/session-dag-projection.ts
//
// Pure fold that turns a chat session's LLM log (the `ClientFrame` stream
// retained by the server's run broker and served by GET /sessions/:id/run/state)
// into a directed graph the Console can render live — "even if not a DAG
// initially, the LLM's logs should be able to turn into a DAG here".
//
// The vocabulary this folds is bound in code, not guessed: it is exactly what
// server/src/agent/events.ts `toClientFrame()` emits plus the frames
// server/src/api/sessions.ts publishes directly (`run_start`, `cost`, `error`,
// `done`). docs/inventory/run-state-v1-event-taxonomy.md is the derived
// taxonomy; every frame type NOT modelled here degrades to an `event:<seq>`
// node rather than being dropped or crashing the projection.
//
// The fold is deliberately free of Date.now(), Math.random(), and DOM access:
// polling, elapsed times, and rendering live in console-live-sources.ts and
// components/console/live-*.tsx. Four invariants are unit-tested in
// session-dag-projection.test.ts:
//   1. idempotent          project(project(s,E),E) === project(s,E)
//   2. incremental == full  chunked folding === one-shot folding
//   3. order tolerant       an event naming an unseen parent creates a
//                           placeholder that a later event fills in
//   4. bounded              >12 tool calls per turn collapse into a counted
//                           group node, at most 200 nodes are rendered, and at
//                           most 500 event sequences are retained per source

/** Node kinds, per the W4.2 projection spec. */
export type SessionGraphNodeKind =
  | "session"
  | "turn"
  | "tool"
  | "subagent"
  | "dag"
  | "group"
  | "event";

/** Five statuses, deliberately narrower than the run-state node statuses. */
export type SessionGraphNodeStatus =
  | "pending"
  | "running"
  | "ok"
  | "error"
  | "cancelled";

export type SessionGraphEdgeKind =
  | "turn"
  | "tool"
  | "subagent"
  | "dag"
  | "group"
  | "event"
  | "back";

export interface SessionGraphNode {
  /** `<kind>:<stable id>` — never an array position. */
  id: string;
  kind: SessionGraphNodeKind;
  label: string;
  status: SessionGraphNodeStatus;
  /** Depth from the session root; the root is 0. */
  depth: number;
  /** Sequence number of the frame that created the node (creation order). */
  createdAtSeq: number;
  /** Secondary line in the node card (tool args summary, prompt excerpt, …). */
  detail?: string;
  /** Number of children folded away — group nodes only. */
  collapsedCount?: number;
  /** Created by a reference from a later event before its own start arrived. */
  placeholder?: boolean;
  /** Children were dropped because MAX_DEPTH was reached ("deeper graph collapsed"). */
  deeperCollapsed?: boolean;
  /** This node is the target of at least one delegation cycle. */
  cyclic?: boolean;
}

export interface SessionGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: SessionGraphEdgeKind;
}

export interface SessionGraphProjection {
  sessionId: string;
  nodes: SessionGraphNode[];
  edges: SessionGraphEdge[];
  /** Highest frame sequence folded so far; the polling cursor. */
  cursor: number;
  /** Retained frame sequences (bounded ring), ascending. */
  retainedSeqs: number[];
  /** True once MAX_RENDERED_NODES was reached — renders a "graph truncated" chip. */
  truncated: boolean;
  /** True once a child was refused because of MAX_DEPTH. */
  depthCollapsed: boolean;
  /** How many edges were reclassified as back-edges (delegation cycles). */
  backEdgeCount: number;
  /** How many frames the ring buffer evicted; the drawer offers "load older". */
  droppedFrames: number;
}

/** One frame as retained by the run broker: the client frame plus its seq. */
export interface SessionFrame {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/** The chat run's coarse lifecycle, straight off GET /sessions/:id/run/state. */
export type SessionRunStatus = "none" | "running" | "complete";

/** Optional typed-workflow delegation, from GET /sessions/:id/workflow-run-state. */
export interface SessionWorkflowRunLink {
  runId: string;
  workflowId: string;
  status: string;
}

export interface ProjectSessionGraphOptions {
  runStatus?: SessionRunStatus;
  workflowRun?: SessionWorkflowRunLink | null;
}

/** >12 tool calls in one turn collapse into a counted group node. */
export const MAX_TOOLS_PER_TURN = 12;
/** Hard cap on rendered nodes; beyond it the projection sets `truncated`. */
export const MAX_RENDERED_NODES = 200;
/** Per-source ring buffer of retained frame sequences. */
export const MAX_RETAINED_FRAMES = 500;
/** Subagent/delegation expansion depth, counted from the session root. */
export const MAX_DEPTH = 3;

/**
 * Frame types this fold models explicitly. Anything else becomes an
 * `event:<seq>` node so an unmodelled server frame degrades to a readable
 * chain instead of vanishing.
 */
export const MODELLED_FRAME_TYPES: ReadonlySet<string> = new Set([
  "run_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "text_delta",
  "thinking_delta",
  "tool_start",
  "tool_update",
  "tool_end",
  "queue_update",
  "retry",
  "context_usage",
  "cost",
  "error",
  "done",
]);

/**
 * Frame types that carry no graph meaning at all: they neither create a node
 * nor change one. Kept separate from MODELLED_FRAME_TYPES so the taxonomy doc
 * and this file cannot drift apart silently.
 */
const IGNORED_FRAME_TYPES = new Set([
  "agent_start",
  "message_end",
  "text_delta",
  "thinking_delta",
  "queue_update",
  "context_usage",
  "cost",
]);

const SUBAGENT_TOOL_NAME = "subagent";

export function sessionRootId(sessionId: string): string {
  return `session:${sessionId}`;
}

export function emptySessionGraph(sessionId: string): SessionGraphProjection {
  return {
    sessionId,
    nodes: [
      {
        id: sessionRootId(sessionId),
        kind: "session",
        label: sessionId,
        status: "pending",
        depth: 0,
        createdAtSeq: 0,
      },
    ],
    edges: [],
    cursor: 0,
    retainedSeqs: [],
    truncated: false,
    depthCollapsed: false,
    backEdgeCount: 0,
    droppedFrames: 0,
  };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstLine(value: string, maxLength = 120): string {
  const line = value.split("\n", 1)[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

/** Human summary of a tool call's arguments, mirroring tool-activity.tsx. */
function toolDetail(args: unknown): string {
  if (typeof args === "string") return firstLine(args);
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const command = record.command ?? record.path ?? record.file_path ??
    record.filePath ?? record.pattern ?? record.query ?? record.task ??
    record.prompt ?? record.description;
  if (typeof command === "string") return firstLine(command);
  const keys = Object.keys(record);
  return keys.length > 0 ? keys.join(", ") : "";
}

/** Agent names named by a `subagent` tool call, in declaration order. */
function subagentNames(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const names: string[] = [];
  const pushName = (value: unknown) => {
    if (typeof value === "string" && value && !names.includes(value)) {
      names.push(value);
    }
  };
  pushName(record.agent);
  if (Array.isArray(record.tasks)) {
    for (const task of record.tasks) {
      if (task && typeof task === "object") {
        pushName((task as Record<string, unknown>).agent);
      }
    }
  }
  return names;
}

function workflowRunStatus(status: string): SessionGraphNodeStatus {
  if (status === "queued") return "pending";
  if (status === "succeeded") return "ok";
  if (status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  return "running";
}

/**
 * Mutable working set for one fold. Every field is either copied from `prev` or
 * derived from it, so folding `[a, b]` in one call and `[a]` then `[b]` in two
 * calls produce the same projection.
 */
interface FoldState {
  sessionId: string;
  nodes: Map<string, SessionGraphNode>;
  edges: Map<string, SessionGraphEdge>;
  /** node id -> parent node id, for ancestry (cycle) checks. */
  parents: Map<string, string>;
  cursor: number;
  retained: number[];
  truncated: boolean;
  depthCollapsed: boolean;
  backEdgeCount: number;
  droppedFrames: number;
}

function loadState(previous: SessionGraphProjection): FoldState {
  const nodes = new Map(previous.nodes.map((node) => [node.id, { ...node }]));
  const edges = new Map(previous.edges.map((edge) => [edge.id, { ...edge }]));
  const parents = new Map<string, string>();
  for (const edge of previous.edges) {
    if (edge.kind !== "back" && !parents.has(edge.to)) parents.set(edge.to, edge.from);
  }
  return {
    sessionId: previous.sessionId,
    nodes,
    edges,
    parents,
    cursor: previous.cursor,
    retained: [...previous.retainedSeqs],
    truncated: previous.truncated,
    depthCollapsed: previous.depthCollapsed,
    backEdgeCount: previous.backEdgeCount,
    droppedFrames: previous.droppedFrames,
  };
}

function saveState(state: FoldState): SessionGraphProjection {
  // Creation order is (createdAtSeq, id) so the rendered order is a pure
  // function of the folded set — never of the arrival order.
  const nodes = [...state.nodes.values()].sort((left, right) =>
    left.createdAtSeq - right.createdAtSeq ||
    left.depth - right.depth ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const edges = [...state.edges.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return {
    sessionId: state.sessionId,
    nodes,
    edges,
    cursor: state.cursor,
    retainedSeqs: [...state.retained],
    truncated: state.truncated,
    depthCollapsed: state.depthCollapsed,
    backEdgeCount: state.backEdgeCount,
    droppedFrames: state.droppedFrames,
  };
}

/**
 * Has this sequence already been folded? Anything at or below the retained
 * window's floor is treated as folded: it either was folded and evicted, or it
 * is older than everything we still remember, and replaying it would double
 * count.
 */
function alreadyFolded(state: FoldState, seq: number): boolean {
  if (state.retained.length === 0) return false;
  // Only once the ring has evicted does "below the floor" mean "already
  // folded". Before that, an out-of-order frame below the floor is genuinely
  // new and must still create or fill its node.
  if (state.droppedFrames > 0 && seq < state.retained[0]) return true;
  // Retained sequences stay small (<= MAX_RETAINED_FRAMES) and sorted.
  return binarySearch(state.retained, seq) >= 0;
}

function binarySearch(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle] === target) return middle;
    if (values[middle] < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function retain(state: FoldState, seq: number): void {
  let index = state.retained.length;
  while (index > 0 && state.retained[index - 1] > seq) index -= 1;
  state.retained.splice(index, 0, seq);
  while (state.retained.length > MAX_RETAINED_FRAMES) {
    state.retained.shift();
    state.droppedFrames += 1;
  }
}

function depthOf(state: FoldState, nodeId: string): number {
  return state.nodes.get(nodeId)?.depth ?? 0;
}

function isAncestor(state: FoldState, candidate: string, nodeId: string): boolean {
  let current: string | undefined = nodeId;
  const guard = new Set<string>();
  while (current !== undefined && !guard.has(current)) {
    if (current === candidate) return true;
    guard.add(current);
    current = state.parents.get(current);
  }
  return false;
}

interface EnsureNodeInput {
  id: string;
  kind: SessionGraphNodeKind;
  label: string;
  status: SessionGraphNodeStatus;
  seq: number;
  parentId?: string;
  edgeKind?: SessionGraphEdgeKind;
  detail?: string;
  placeholder?: boolean;
  /**
   * Override the derived depth. Turns chain root -> turn:1 -> turn:2 -> …, but
   * that chain is conversation order, not delegation nesting, so every turn
   * sits at depth 1 and MAX_DEPTH stays a statement about subagent expansion.
   */
  depth?: number;
}

/**
 * Create the node if it is new, otherwise fill in what a placeholder was
 * missing. Returns the node, or null when the graph refused it (node cap or
 * depth cap). Never mutates an already-authoritative label/detail with a
 * placeholder's.
 */
function ensureNode(state: FoldState, input: EnsureNodeInput): SessionGraphNode | null {
  const existing = state.nodes.get(input.id);
  if (existing) {
    if (existing.placeholder && !input.placeholder) {
      existing.placeholder = undefined;
      existing.label = input.label;
      if (input.detail !== undefined) existing.detail = input.detail;
      // Filling a placeholder must not un-finish it: a `tool_start` that
      // arrives after its own `tool_end` supplies the label and args, not the
      // status.
      if (existing.status === "pending") existing.status = input.status;
    }
    if (input.parentId) linkNode(state, input.parentId, existing, input.edgeKind ?? "event");
    return existing;
  }

  const parentDepth = input.parentId === undefined ? -1 : depthOf(state, input.parentId);
  const depth = input.depth ?? parentDepth + 1;
  if (depth > MAX_DEPTH) {
    state.depthCollapsed = true;
    const parent = input.parentId ? state.nodes.get(input.parentId) : undefined;
    if (parent) parent.deeperCollapsed = true;
    return null;
  }
  if (state.nodes.size >= MAX_RENDERED_NODES) {
    state.truncated = true;
    return null;
  }

  const node: SessionGraphNode = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    status: input.status,
    depth,
    createdAtSeq: input.seq,
    ...(input.detail !== undefined && input.detail !== "" ? { detail: input.detail } : {}),
    ...(input.placeholder ? { placeholder: true } : {}),
  };
  state.nodes.set(node.id, node);
  if (input.parentId) linkNode(state, input.parentId, node, input.edgeKind ?? "event");
  return node;
}

/** Add a parent→child edge, demoting it to a back-edge when it closes a cycle. */
function linkNode(
  state: FoldState,
  parentId: string,
  node: SessionGraphNode,
  kind: SessionGraphEdgeKind,
): void {
  if (parentId === node.id) return;
  const edgeId = `${parentId}->${node.id}`;
  if (state.edges.has(edgeId)) return;
  if (isAncestor(state, node.id, parentId)) {
    state.edges.set(edgeId, { id: edgeId, from: parentId, to: node.id, kind: "back" });
    state.backEdgeCount += 1;
    node.cyclic = true;
    return;
  }
  state.edges.set(edgeId, { id: edgeId, from: parentId, to: node.id, kind });
  if (!state.parents.has(node.id)) state.parents.set(node.id, parentId);
}

/** Turn nodes in creation order; the newest is the open turn. */
function turnNodes(state: FoldState): SessionGraphNode[] {
  return [...state.nodes.values()]
    .filter((node) => node.kind === "turn")
    .sort((left, right) => left.createdAtSeq - right.createdAtSeq);
}

function currentTurn(state: FoldState): SessionGraphNode | null {
  const turns = turnNodes(state);
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

/**
 * Open a new turn. The chain is root -> turn:1 -> turn:2 -> …, so a long
 * session reads top-to-bottom as the conversation did.
 */
function openTurn(state: FoldState, seq: number, label?: string): SessionGraphNode | null {
  const turns = turnNodes(state);
  const ordinal = turns.length + 1;
  const previousTurn = turns[turns.length - 1];
  return ensureNode(state, {
    id: `turn:${ordinal}`,
    kind: "turn",
    label: label && label !== "" ? label : `Turn ${ordinal}`,
    status: "running",
    seq,
    parentId: previousTurn ? previousTurn.id : sessionRootId(state.sessionId),
    edgeKind: "turn",
    depth: 1,
  });
}

/** The turn a tool/subagent/dag node hangs off, creating one if none is open. */
function requireTurn(state: FoldState, seq: number): SessionGraphNode | null {
  return currentTurn(state) ?? openTurn(state, seq);
}

function childCount(state: FoldState, parentId: string, kinds: SessionGraphNodeKind[]): number {
  let count = 0;
  for (const edge of state.edges.values()) {
    if (edge.from !== parentId || edge.kind === "back") continue;
    const child = state.nodes.get(edge.to);
    if (child && kinds.includes(child.kind)) count += 1;
  }
  return count;
}

/** The counted "N more tool calls" node for an over-wide turn. */
function groupInto(state: FoldState, turn: SessionGraphNode, seq: number): void {
  const groupId = `group:${turn.id}`;
  const group = ensureNode(state, {
    id: groupId,
    kind: "group",
    label: "Additional tool calls",
    status: "running",
    seq,
    parentId: turn.id,
    edgeKind: "group",
  });
  if (!group) return;
  group.collapsedCount = (group.collapsedCount ?? 0) + 1;
  group.detail = `${group.collapsedCount} more tool call${group.collapsedCount === 1 ? "" : "s"}`;
}

function markRunningDescendantsDone(state: FoldState): void {
  for (const node of state.nodes.values()) {
    if (node.status === "running" && node.kind !== "session") node.status = "ok";
  }
}

function applyFrame(state: FoldState, frame: SessionFrame): void {
  const root = state.nodes.get(sessionRootId(state.sessionId));
  if (IGNORED_FRAME_TYPES.has(frame.type)) return;

  switch (frame.type) {
    case "run_start": {
      if (root) {
        root.status = "running";
        const runId = textOf(frame.runId);
        if (runId) root.detail = runId;
      }
      return;
    }
    case "turn_start": {
      openTurn(state, frame.seq);
      return;
    }
    case "message_start": {
      if (frame.role !== "user") return;
      const prompt = firstLine(textOf(frame.content));
      const turn = currentTurn(state);
      // A user message always begins a turn; reuse the open turn only when it
      // has no prompt text yet (turn_start fires just before the message).
      if (turn && turn.detail === undefined) {
        if (prompt) turn.detail = prompt;
        return;
      }
      const opened = openTurn(state, frame.seq);
      if (opened && prompt) opened.detail = prompt;
      return;
    }
    case "turn_end": {
      const turn = currentTurn(state);
      if (turn && turn.status === "running") turn.status = "ok";
      return;
    }
    case "tool_start":
    case "tool_update":
    case "tool_end": {
      applyToolFrame(state, frame);
      return;
    }
    case "retry": {
      const turn = currentTurn(state);
      if (turn) {
        const attempt = typeof frame.attempt === "number" ? frame.attempt : undefined;
        turn.detail = attempt === undefined
          ? "retrying"
          : `retry ${attempt}/${typeof frame.max === "number" ? frame.max : "?"}`;
      }
      return;
    }
    case "error": {
      const budget = frame.kind === "budget";
      if (root) root.status = budget ? "cancelled" : "error";
      const turn = currentTurn(state);
      if (turn) {
        turn.status = budget ? "cancelled" : "error";
        const message = firstLine(textOf(frame.message));
        if (message) turn.detail = message;
      }
      return;
    }
    case "agent_end":
    case "done": {
      markRunningDescendantsDone(state);
      if (root && root.status === "running") root.status = "ok";
      return;
    }
    default: {
      // Unrecognised frame type — the taxonomy's documented fallback. The
      // switch above and MODELLED_FRAME_TYPES must agree; the projector test
      // asserts that no modelled type reaches this arm.
      const turn = requireTurn(state, frame.seq);
      ensureNode(state, {
        id: `event:${frame.seq}`,
        kind: "event",
        label: frame.type,
        status: "ok",
        seq: frame.seq,
        parentId: turn ? turn.id : sessionRootId(state.sessionId),
        edgeKind: "event",
        detail: firstLine(textOf(frame.message)),
      });
    }
  }
}

function applyToolFrame(state: FoldState, frame: SessionFrame): void {
  const toolCallId = textOf(frame.toolCallId) || `seq-${frame.seq}`;
  const toolName = textOf(frame.toolName) || "tool";
  const nodeId = `tool:${toolCallId}`;
  const existing = state.nodes.get(nodeId);
  const turn = requireTurn(state, frame.seq);
  if (!turn) return;

  // A tool node is only created by tool_start; tool_update/tool_end arriving
  // first create a placeholder that tool_start later fills in.
  if (!existing) {
    const withinWidth = childCount(state, turn.id, ["tool", "subagent", "dag"]) < MAX_TOOLS_PER_TURN;
    if (!withinWidth) {
      groupInto(state, turn, frame.seq);
      return;
    }
  }

  const isStart = frame.type === "tool_start";
  const status: SessionGraphNodeStatus = frame.type === "tool_end"
    ? (frame.isError === true ? "error" : "ok")
    : "running";
  const node = ensureNode(state, {
    id: nodeId,
    kind: "tool",
    label: toolName,
    status,
    seq: frame.seq,
    parentId: turn.id,
    edgeKind: "tool",
    ...(isStart ? { detail: toolDetail(frame.args) } : {}),
    ...(isStart ? {} : { placeholder: existing === undefined }),
  });
  if (!node) return;
  // tool_end is authoritative over tool_start for status; tool_update is not.
  if (frame.type === "tool_end") node.status = status;
  else if (isStart && node.status !== "ok" && node.status !== "error") node.status = "running";
  if (isStart && node.label !== toolName) node.label = toolName;

  if (toolName !== SUBAGENT_TOOL_NAME) return;
  // A `subagent` call fans out to one child per named agent, so a delegation
  // reads as delegation rather than as one opaque tool row.
  const names = isStart ? subagentNames(frame.args) : [];
  for (const name of names) {
    ensureNode(state, {
      id: `agent:${toolCallId}:${name}`,
      kind: "subagent",
      label: name,
      status: node.status === "ok" || node.status === "error" ? node.status : "running",
      seq: frame.seq,
      parentId: node.id,
      edgeKind: "subagent",
    });
  }
  if (frame.type === "tool_end") {
    for (const edge of state.edges.values()) {
      if (edge.from !== node.id || edge.kind !== "subagent") continue;
      const child = state.nodes.get(edge.to);
      if (child && child.status === "running") child.status = node.status;
    }
  }
}

function applyWorkflowLink(state: FoldState, link: SessionWorkflowRunLink): void {
  const turn = currentTurn(state);
  const node = ensureNode(state, {
    id: `dag:${link.runId}`,
    kind: "dag",
    label: link.workflowId,
    status: workflowRunStatus(link.status),
    seq: state.cursor,
    parentId: turn ? turn.id : sessionRootId(state.sessionId),
    edgeKind: "dag",
    detail: link.runId,
  });
  if (node) node.status = workflowRunStatus(link.status);
}

function applyRunStatus(state: FoldState, runStatus: SessionRunStatus): void {
  const root = state.nodes.get(sessionRootId(state.sessionId));
  if (!root) return;
  if (runStatus === "running") {
    if (root.status !== "error" && root.status !== "cancelled") root.status = "running";
    return;
  }
  if (runStatus === "complete" && root.status === "running") root.status = "ok";
}

/**
 * Fold `frames` into `previous`. Frames already folded (by sequence) are
 * skipped, which is what makes the fold idempotent and lets the console poll
 * the whole retained buffer instead of needing a server-side cursor.
 */
export function projectSessionGraph(
  previous: SessionGraphProjection,
  frames: readonly SessionFrame[],
  options: ProjectSessionGraphOptions = {},
): SessionGraphProjection {
  const state = loadState(previous);
  const fresh = frames
    .filter((frame) => Number.isSafeInteger(frame.seq) && !alreadyFolded(state, frame.seq))
    .sort((left, right) => left.seq - right.seq);

  for (const frame of fresh) {
    retain(state, frame.seq);
    if (frame.seq > state.cursor) state.cursor = frame.seq;
    applyFrame(state, frame);
  }

  if (options.workflowRun) applyWorkflowLink(state, options.workflowRun);
  if (options.runStatus) applyRunStatus(state, options.runStatus);
  return saveState(state);
}

/** Convenience for tests and first paint: fold a whole buffer from scratch. */
export function projectSession(
  sessionId: string,
  frames: readonly SessionFrame[],
  options: ProjectSessionGraphOptions = {},
): SessionGraphProjection {
  return projectSessionGraph(emptySessionGraph(sessionId), frames, options);
}

/** Children of a node, in creation order — the rail and canvas both need it. */
export function childrenOf(
  projection: SessionGraphProjection,
  nodeId: string,
): SessionGraphNode[] {
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  const children: SessionGraphNode[] = [];
  for (const edge of projection.edges) {
    if (edge.from !== nodeId || edge.kind === "back") continue;
    const child = byId.get(edge.to);
    if (child) children.push(child);
  }
  return children.sort((left, right) => left.createdAtSeq - right.createdAtSeq);
}

/** One-line reason string for chips above the canvas. */
export function projectionNotices(projection: SessionGraphProjection): string[] {
  const notices: string[] = [];
  if (projection.truncated) {
    notices.push(`Graph truncated at ${MAX_RENDERED_NODES} nodes`);
  }
  if (projection.depthCollapsed) notices.push("Deeper graph collapsed");
  if (projection.backEdgeCount > 0) {
    notices.push(
      `${projection.backEdgeCount} back-edge${projection.backEdgeCount === 1 ? "" : "s"}`,
    );
  }
  if (projection.droppedFrames > 0) {
    notices.push(`${projection.droppedFrames} older events dropped`);
  }
  return notices;
}
