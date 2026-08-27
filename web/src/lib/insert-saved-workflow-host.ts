// danbot-byok — web/src/lib/insert-saved-workflow-host.ts
//
// BLD-24b / D14 host half of `insert-saved-workflow`.
//
// The palette writes `application/kady-saved-workflow` (a workflow id). The
// iframe cannot read a cross-origin dataTransfer, so the host drop layer
// reconstructs the B9 payload (workflowId, revision, graphSha256, nodes,
// edges, dropPoint) and posts it over the existing bridge.
//
// Drag = insert (PA-2). Architect elevation stays the explicit Elevate action.
// The typed document is stitched rather than left as a disconnected group so
// Save remains reachable (`unreachable-node` would refuse the write).
//
// Three-state insert. `bridge.post()` resolving is not success.
//   Posted   → "Inserting…" after the host→frame post. No stitch.
//   Accepted → builder.savedWorkflowInsertAccepted { workflowId, nodeCount }
//              → "Confirm the insertion in the canvas". Overlay is open; the
//              host document is unchanged until Confirm.
//   Settled  → builder.savedWorkflowInserted after overlay Confirm, with the
//              engine's canvas node count (never the host payload length) /
//              cancelled (reason verbatim, including overlay Cancel) / timeout.
//
// THE HOST OWNS WHEN AN ATTEMPT ENDS (cycle 5).
//   * Every drop mints an `attemptToken`. `workflowId` says WHICH WORKFLOW, not
//     WHICH ATTEMPT, so an ack is honoured only when its token is the LIVE
//     attempt's. An ack with a stale or missing token is dropped, never
//     applied to a later drop.
//   * When the host's bound elapses it does not merely release its own lock: it
//     posts `abandon-saved-workflow-insert` so the engine dismisses that
//     overlay, and it refuses anything that attempt produces afterwards. The
//     host never accepts a late settlement — the timeout status stands.

import type { StoredDagWorkflowDefinition, WorkflowGraphDocument } from "@/lib/dag-workflows";
import { stitchWorkflows } from "@/lib/stitch-workflows";
import { typedToView, type GraphViewModel } from "@/lib/typed-graph-view";

export const INSERT_SAVED_WORKFLOW_TYPE = "insert-saved-workflow" as const;

/**
 * Host → frame: this attempt is over on the host side; dismiss its overlay.
 * Sent when the host's ack bound elapses. The engine replies with nothing —
 * the host settled the attempt before it sent this.
 */
export const ABANDON_SAVED_WORKFLOW_INSERT_TYPE = "abandon-saved-workflow-insert" as const;

/** Frame → host: overlay is open and the engine received the command. */
export const SAVED_WORKFLOW_INSERT_ACCEPTED_TYPE = "builder.savedWorkflowInsertAccepted" as const;

/** Posted: command left the host. Not success. */
export const SAVED_WORKFLOW_INSERTING_STATUS = "Inserting…" as const;

/** Accepted: engine overlay is open; user must confirm or cancel. */
export const SAVED_WORKFLOW_INSERT_CONFIRM_STATUS = "Confirm the insertion in the canvas" as const;

/** B9 cancel reply with no `reason` (user Cancel / Escape). */
export const SAVED_WORKFLOW_INSERT_CANCELLED_REASON = "cancelled" as const;

/** Visible failure when the engine never settles the pending insert. */
export const SAVED_WORKFLOW_INSERT_TIMEOUT_STATUS =
  "Saved-workflow insert timed out waiting for the canvas." as const;

/** Second drop while an insert is still pending. */
export const SAVED_WORKFLOW_INSERT_IN_PROGRESS_STATUS =
  "A saved-workflow insert is already waiting for confirmation." as const;

/** Mutable so WV cases can exercise the timeout path without a 15s sleep. */
export const savedWorkflowInsertHostSettings = {
  ackTimeoutMs: 15_000,
  /**
   * How long after abandoning an attempt the host keeps refusing that attempt's
   * output. `abandon-saved-workflow-insert` is asynchronous, so a Confirm click
   * already queued in the frame can still produce an ack and a `builder.delta`
   * after the host has given up. Within this window the host drops both and
   * re-pushes its authoritative view; it does not depend on the engine having
   * processed the abandon in time.
   */
  abandonGraceMs: 2_000,
};

let savedWorkflowInsertAttemptCounter = 0;

/**
 * Per-attempt identity, minted at post time. Monotonic so ordering is legible
 * in a frame transcript, with a random suffix so a remounted host cannot reuse
 * a token the engine still has in flight.
 */
export function nextSavedWorkflowInsertAttemptToken(): string {
  savedWorkflowInsertAttemptCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `swi-${String(savedWorkflowInsertAttemptCounter)}-${random}`;
}

/**
 * Named refusals from B9's planner (`insertSavedWorkflowRefusalReason`).
 * Surfaced verbatim in the host `role="status"` region.
 */
export const INSERT_SAVED_WORKFLOW_REFUSAL_REASONS = [
  "malformed-payload",
  "payload-duplicate-node-id",
  "payload-duplicate-edge-id",
  "payload-dangling-edge",
  "payload-cross-canvas-edge",
] as const;

export type InsertSavedWorkflowRefusalReason =
  (typeof INSERT_SAVED_WORKFLOW_REFUSAL_REASONS)[number];

export function formatInsertedSavedWorkflowStatus(nodeCount: number): string {
  return `Inserted ${String(nodeCount)} nodes`;
}

/** Prefer the engine's inserted node ids; fall back to `nodeCount`. */
export function insertedCountFromAck(ack: SavedWorkflowInsertedAck): number {
  return ack.nodeIds.length > 0 ? ack.nodeIds.length : ack.nodeCount;
}

export interface InsertSavedWorkflowDropPoint {
  x: number;
  y: number;
}

export interface InsertSavedWorkflowHostPayload {
  workflowId: string;
  revision: number;
  graphSha256: string;
  nodes: GraphViewModel["nodes"];
  edges: GraphViewModel["edges"];
  dropPoint: InsertSavedWorkflowDropPoint;
  /** Identity of THIS attempt; echoed by the engine on every reply frame. */
  attemptToken: string;
  /**
   * BF-56 — THIS host declaring, at post time, which of the existing graph's
   * nodes it will connect into the inserted group when it settles the insert.
   * The engine's confirmation dialog states exactly this list and infers
   * nothing, so the words a user reads and the edges this host then creates are
   * one fact rather than two derivations that agree only when both halves
   * happen to run in the same process.
   */
  settlement: { connectsFromNodeIds: string[] };
}

/** Host → frame payload for {@link ABANDON_SAVED_WORKFLOW_INSERT_TYPE}. */
export interface AbandonSavedWorkflowInsertCommand {
  workflowId: string;
  attemptToken: string;
}

export function parseSavedWorkflowDragRaw(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const workflowId = (parsed as { workflowId?: unknown }).workflowId;
      if (typeof workflowId === "string" && workflowId.trim().length > 0) {
        return workflowId.trim();
      }
    }
  } catch {
    // Palette writes a bare workflow id, not JSON.
  }
  return trimmed;
}

export function iframeRelativeDropPoint(
  iframeRect: Pick<DOMRect, "left" | "top">,
  clientX: number,
  clientY: number,
): InsertSavedWorkflowDropPoint {
  return { x: clientX - iframeRect.left, y: clientY - iframeRect.top };
}

/**
 * BF-56 — the existing-graph nodes THIS host will hand over to the inserted
 * group when it settles the insert.
 *
 * `applySavedWorkflowInsertToHostDocument` composes `[current, definition]`
 * through `stitchWorkflows`, and `stitchWorkflows` bridges from every node of
 * phase 0 whose `terminal` is true (stitch-workflows.ts:299 collects them,
 * :382-387 creates the edges). So `terminal === true` — NOT "has no outgoing
 * edge" — is the predicate the confirmation dialog has to state.
 *
 * The two coincide for any document the server accepted, because
 * `validateTerminals` requires every sink to be terminal (`unterminated-sink`,
 * server/src/workflows/validate.ts:2503) and forbids a terminal node any
 * outgoing edge (`terminal-has-outgoing-edge`, validate.ts:2496). They diverge
 * on a canvas mid-edit — an unwired draft not yet marked terminal, a node
 * marked terminal that still has an outgoing edge — and mid-edit is exactly
 * when a user drops a saved workflow onto the canvas. Cycle 1 stated the other
 * predicate and was wrong in both directions.
 */
export function savedWorkflowInsertConnectsFromNodeIds(
  current: Pick<WorkflowGraphDocument, "nodes">,
): string[] {
  return current.nodes.filter((node) => node.terminal === true).map((node) => node.id);
}

export function buildInsertSavedWorkflowPayload(
  definition: Pick<StoredDagWorkflowDefinition, "id" | "revision" | "graphSha256" | "graph">,
  dropPoint: InsertSavedWorkflowDropPoint,
  attemptToken: string,
  /**
   * The document this host is about to insert INTO. Required, not optional:
   * omitting the declaration is what BF-30 looked like from the engine's side,
   * and a caller must not be able to reintroduce it by leaving off an argument.
   */
  current: Pick<WorkflowGraphDocument, "nodes">,
): InsertSavedWorkflowHostPayload {
  const view = typedToView(definition.graph, { graphSha256: definition.graphSha256 });
  return {
    workflowId: definition.id,
    revision: definition.revision,
    graphSha256: definition.graphSha256,
    nodes: view.nodes,
    edges: view.edges,
    dropPoint,
    attemptToken,
    settlement: { connectsFromNodeIds: savedWorkflowInsertConnectsFromNodeIds(current) },
  };
}

export function applySavedWorkflowInsertToHostDocument(
  current: WorkflowGraphDocument,
  currentGraphSha256: string | null,
  definition: Pick<StoredDagWorkflowDefinition, "id" | "graphSha256" | "graph">,
): WorkflowGraphDocument {
  const { document } = stitchWorkflows(
    [
      {
        document: current,
        sourceId: current.id,
        ...(currentGraphSha256 ? { graphSha256: currentGraphSha256 } : {}),
        label: current.name,
        idPrefix: "",
      },
      {
        document: definition.graph,
        sourceId: definition.id,
        graphSha256: definition.graphSha256,
        label: definition.graph.name,
        idPrefix: `${definition.id}-`,
      },
    ],
    { id: current.id, name: current.name },
  );
  // Stitch keeps phase-0 limits. A 1-node fixture capped at 2 model calls
  // cannot save after two more agent nodes land (validate.ts sums demand).
  const incomingLimits = definition.graph.limits;
  const maxModelCalls = Math.max(
    document.limits.maxModelCalls,
    incomingLimits.maxModelCalls,
    document.nodes.length * 2,
  );
  const maxTokens = Math.max(document.limits.maxTokens, incomingLimits.maxTokens);
  const maxCostUsd = Math.max(document.limits.maxCostUsd, incomingLimits.maxCostUsd);
  if (
    maxModelCalls === document.limits.maxModelCalls
    && maxTokens === document.limits.maxTokens
    && maxCostUsd === document.limits.maxCostUsd
  ) {
    return document;
  }
  return {
    ...document,
    limits: {
      ...document.limits,
      maxModelCalls,
      maxTokens,
      maxCostUsd,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseInsertPayloadStructural(payload: unknown): {
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string; from: string; to: string }>;
} | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.workflowId !== "string" || payload.workflowId.length === 0) return null;
  if (typeof payload.revision !== "number" || !Number.isFinite(payload.revision)) return null;
  if (typeof payload.graphSha256 !== "string" || payload.graphSha256.length === 0) return null;
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) return null;
  if (!Array.isArray(payload.edges)) return null;
  const nodes: Array<{ id: string }> = [];
  for (const entry of payload.nodes) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return null;
    nodes.push({ id: entry.id });
  }
  const edges: Array<{ id: string; from: string; to: string }> = [];
  for (const entry of payload.edges) {
    if (!isRecord(entry)) return null;
    const from = typeof entry.from === "string"
      ? entry.from
      : typeof entry.source === "string"
        ? entry.source
        : "";
    const to = typeof entry.to === "string"
      ? entry.to
      : typeof entry.target === "string"
        ? entry.target
        : "";
    if (!from || !to) return null;
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `${from}-${to}`;
    edges.push({ id, from, to });
  }
  return { nodes, edges };
}

/**
 * Host copy of B9 `insertSavedWorkflowRefusalReason`. Canvas ids distinguish
 * `payload-cross-canvas-edge` from `payload-dangling-edge`; omit them to match
 * parse-time classification.
 */
export function insertSavedWorkflowRefusalReason(
  payload: unknown,
  canvasNodeIds?: ReadonlySet<string>,
): InsertSavedWorkflowRefusalReason | null {
  const parsed = parseInsertPayloadStructural(payload);
  if (!parsed) return "malformed-payload";
  const payloadNodeIds = new Set<string>();
  for (const node of parsed.nodes) {
    if (payloadNodeIds.has(node.id)) return "payload-duplicate-node-id";
    payloadNodeIds.add(node.id);
  }
  const payloadEdgeIds = new Set<string>();
  for (const edge of parsed.edges) {
    if (payloadEdgeIds.has(edge.id)) return "payload-duplicate-edge-id";
    payloadEdgeIds.add(edge.id);
  }
  for (const edge of parsed.edges) {
    const fromMissing = !payloadNodeIds.has(edge.from);
    const toMissing = !payloadNodeIds.has(edge.to);
    if (!fromMissing && !toMissing) continue;
    if (
      canvasNodeIds
      && ((fromMissing && canvasNodeIds.has(edge.from)) || (toMissing && canvasNodeIds.has(edge.to)))
    ) {
      return "payload-cross-canvas-edge";
    }
    return "payload-dangling-edge";
  }
  return null;
}

export interface SavedWorkflowInsertAcceptedAck {
  workflowId: string;
  nodeCount: number;
  attemptToken: string;
}

export interface SavedWorkflowInsertedAck {
  workflowId: string;
  nodeCount: number;
  nodeIds: string[];
  attemptToken: string;
}

export interface SavedWorkflowInsertCancelledAck {
  workflowId: string;
  reason: string;
  attemptToken: string;
}

/**
 * The attempt token an engine reply frame carries.
 *
 * A reply with no token is NOT a reply to any live attempt: every attempt this
 * host posts mints one and the engine echoes it. Returning null here is what
 * makes a tokenless ack unusable rather than usable-by-workflowId.
 */
function parseAttemptToken(payload: Record<string, unknown>): string | null {
  const token = payload.attemptToken;
  if (typeof token !== "string" || token.length === 0) return null;
  return token;
}

/** Engine `builder.savedWorkflowInsertAccepted`. */
export function parseSavedWorkflowInsertAcceptedAck(
  payload: unknown,
): SavedWorkflowInsertAcceptedAck | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.workflowId !== "string" || payload.workflowId.length === 0) return null;
  if (typeof payload.nodeCount !== "number" || !Number.isFinite(payload.nodeCount)) return null;
  const attemptToken = parseAttemptToken(payload);
  if (attemptToken === null) return null;
  return { workflowId: payload.workflowId, nodeCount: payload.nodeCount, attemptToken };
}

/** B9 `builder.savedWorkflowInserted` (`SavedWorkflowInsertedDetail`). */
export function parseSavedWorkflowInsertedAck(payload: unknown): SavedWorkflowInsertedAck | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.workflowId !== "string" || payload.workflowId.length === 0) return null;
  if (typeof payload.nodeCount !== "number" || !Number.isFinite(payload.nodeCount)) return null;
  const attemptToken = parseAttemptToken(payload);
  if (attemptToken === null) return null;
  const nodeIds = Array.isArray(payload.nodeIds)
    ? payload.nodeIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return { workflowId: payload.workflowId, nodeCount: payload.nodeCount, nodeIds, attemptToken };
}

/**
 * Engine `builder.savedWorkflowInsertCancelled`. A `reason` string (the five
 * planner refusals, or any other) is surfaced verbatim when present; missing
 * reason is `cancelled`.
 */
export function parseSavedWorkflowInsertCancelledAck(
  payload: unknown,
): SavedWorkflowInsertCancelledAck | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.workflowId !== "string" || payload.workflowId.length === 0) return null;
  const attemptToken = parseAttemptToken(payload);
  if (attemptToken === null) return null;
  const reason = typeof payload.reason === "string" && payload.reason.length > 0
    ? payload.reason
    : SAVED_WORKFLOW_INSERT_CANCELLED_REASON;
  return { workflowId: payload.workflowId, reason, attemptToken };
}

/**
 * Does this engine reply belong to the attempt the host is currently waiting
 * on? Both halves are required: `workflowId` alone lets an ack from a released
 * drop settle the NEXT drop of the same saved workflow.
 */
export function ackMatchesLiveAttempt<TAttempt extends { workflowId: string; attemptToken: string }>(
  live: TAttempt | null,
  ack: { workflowId: string; attemptToken: string },
): live is TAttempt {
  if (live === null) return false;
  return live.workflowId === ack.workflowId && live.attemptToken === ack.attemptToken;
}
