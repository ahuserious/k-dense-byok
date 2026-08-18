// danbot-byok — web/src/lib/session-dag-projection-promote.ts
//
// The verb in the owner's sentence: "even if not a DAG initially, the LLM's
// logs should be able to TURN INTO a DAG here & be viewed live."
//
// Round 1 and round 2 delivered the view. This is the conversion: a chat
// session's folded graph plus its retained frames become a real
// `WorkflowGraphDocument` that `PUT /dag-workflows/:id` accepts under its CAS
// contract — the same typed document the workflow registry lists and the runner
// executes, not a console-local lookalike.
//
// Three rules govern everything below.
//
//   1. NOTHING IS INVENTED. Every node's prompt is user text this fold actually
//      retained. A turn whose prompt text is not in the retained ring is NOT
//      promoted — it is reported as unrepresentable, because a plausible
//      substitute would be a fabricated instruction the user never wrote.
//
//   2. NOTHING IS DROPPED SILENTLY. The typed node union (agent,
//      research-until-goal, council, fusion, prompt-optimization, best-of-n,
//      evidence-gate, lean4) has no member that means "a tool call" or "a
//      delegated subagent", so tools, subagents, delegated DAG runs, collapsed
//      groups, and unmodelled event nodes cannot become nodes. Each one is
//      listed in `unrepresented` with the reason, and the dialog shows that list
//      beside the nodes it will create.
//
//   3. NOTHING IS MUTATED. This module is a pure function of a projection and
//      its frames. It performs no request, touches no session, and the write it
//      feeds is a create against a NEW workflow id.
//
// The document is deliberately conservative: read-only workspaces, Kady Current
// as the model, and a straight chain of `agent` nodes in conversation order.
// That is a faithful, runnable first draft of the conversation.
//
// Where it lands, as this build ships: Scientific Pipelines → Workflow registry,
// whose `Details & run` surface reviews it and runs it. The workspace tab called
// "Builder" is the vendored pipeline-engine iframe and cannot open a typed
// `WorkflowGraphDocument`; nothing in this repo can edit one yet, so no copy here
// may send a reader there. (Lane W3 is building the typed authoring path. When it
// lands, this comment and the dialog's success banner are the two places that
// need rewording.)

"use client";

import type {
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowLimits,
  WorkflowModelRequest,
} from "@/lib/dag-workflows";
import {
  childrenOf,
  framesForNode,
  type SessionFrame,
  type SessionGraphNode,
  type SessionGraphNodeKind,
  type SessionGraphProjection,
} from "@/lib/session-dag-projection";

/** `^[a-z][a-z0-9_-]{0,63}$` — server/src/workflows/store.ts WORKFLOW_ID_RE. */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Instruction fields are bounded at 32 KiB by the typed schema. */
export const MAX_PROMPT_LENGTH = 32_768;
/** ShortTextSchema, used for `name`. */
export const MAX_NAME_LENGTH = 256;
/** DescriptionSchema, used for node and workflow descriptions. */
export const MAX_DESCRIPTION_LENGTH = 4_096;
/**
 * Server cap is 256 nodes. The promote path stops well short of it: a promoted
 * draft with 64 sequential agent nodes is already past what anyone reviews in a
 * dialog, and the truncation is stated rather than silent.
 */
export const MAX_PROMOTED_NODES = 64;

/** One turn that becomes one typed `agent` node. */
export interface PromotedNodePlan {
  /** Typed node id — identifier syntax, so `turn:3` becomes `turn-3`. */
  id: string;
  /** The projection node this came from, for the preview's provenance column. */
  sourceNodeId: string;
  name: string;
  prompt: string;
  /** Tool and subagent labels observed inside the turn, in graph order. */
  observedWork: string[];
  terminal: boolean;
}

/** Something in the session that the typed node union cannot express. */
export interface UnrepresentedPart {
  sourceNodeId: string;
  kind: SessionGraphNodeKind;
  label: string;
  reason: string;
}

export interface SessionPromotionPlan {
  /** Target workflow id; also the document's own `id` (the store requires both to match). */
  workflowId: string;
  name: string;
  nodes: PromotedNodePlan[];
  edges: WorkflowGraphEdge[];
  unrepresented: UnrepresentedPart[];
  /**
   * The document to PUT, or null when the session yields no promotable node.
   * `blockedReason` then says why, in the reader's terms.
   */
  document: WorkflowGraphDocument | null;
  blockedReason: string | null;
}

export interface SessionPromotionOptions {
  workflowId: string;
  /** Rail title of the chat, used in the workflow name and description. */
  sessionTitle: string;
  sessionId: string;
  projectName: string;
}

/**
 * Kady Current: the model the user already has selected, requested exactly.
 * Naming a provider and a model here would be inventing a decision the chat
 * never recorded — the receipts the runner writes later are what say which
 * model actually served the node.
 */
export const PROMOTED_MODEL_REQUEST: WorkflowModelRequest = {
  requested: {
    source: "kady-current",
    auth: { kind: "kady-current" },
    reasoning: "high",
  },
  resolution: { mode: "exact" },
};

/**
 * Limits sized to the promoted shape: one model call and one iteration per
 * agent node, which is exactly what `deriveWorkflowNodeDemand` charges an
 * `agent` node, plus the subagent slot such a node needs. The dialog prints them.
 */
export function promotedWorkflowLimits(nodeCount: number): WorkflowLimits {
  const nodes = Math.max(1, nodeCount);
  return {
    maxIterations: nodes,
    maxModelCalls: nodes,
    maxParallelism: 1,
    // Not zero. Every model-driven node needs one Pi-subagent execution slot:
    // `deriveWorkflowNodeDemand` sets `minimumConcurrentSubagents: 1` for any
    // node with a model call (server/src/workflows/validate.ts:534-545), and the
    // server rejects `maxSubagents: 0` with `node-subagent-demand-exceeds-limit`.
    // This lane found that by running the real validator over the real document,
    // not by reading the schema.
    maxSubagents: 1,
    timeoutMs: 3_600_000,
    maxTokens: 1_000_000,
    maxCostUsd: 5,
    maxRetries: 0,
  };
}

function clamp(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** Collapse a free-form string to the typed identifier alphabet. */
function toIdentifier(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const seeded = /^[a-z]/.test(slug) ? slug : `${fallback}-${slug}`;
  const bounded = seeded.slice(0, 64).replace(/-+$/, "");
  return WORKFLOW_ID_PATTERN.test(bounded) ? bounded : fallback;
}

/** Default target id for a session, e.g. `chat-session-e2e`. */
export function promotedWorkflowId(sessionId: string): string {
  return toIdentifier(`chat-${sessionId}`, "chat-session");
}

export function isPromotableWorkflowId(workflowId: string): boolean {
  return WORKFLOW_ID_PATTERN.test(workflowId);
}

/** The user text a turn carries, whole, from the frames the ring still holds. */
function promptForTurn(
  projection: SessionGraphProjection,
  frames: readonly SessionFrame[],
  turn: SessionGraphNode,
): string {
  const parts: string[] = [];
  for (const frame of framesForNode(projection, frames, turn.id)) {
    if (frame.type !== "message_start") continue;
    if (frame.role !== "user") continue;
    const content = typeof frame.content === "string" ? frame.content.trim() : "";
    if (content) parts.push(content);
  }
  return clamp(parts.join("\n\n"), MAX_PROMPT_LENGTH);
}

const UNREPRESENTABLE_REASON: Record<string, string> = {
  tool:
    "A tool call is not a typed node kind — the union has no member for it. Its name is kept on the turn's node description.",
  // Deliberately not the `tool` sentence. The projector hangs a subagent under
  // the `subagent` TOOL call, not under the turn (session-dag-projection.ts:
  // `parentId: node.id`), so it is a grandchild of the turn and never reaches
  // `observedWork` below. The delegation is recorded; this agent's name is not.
  subagent:
    "A delegated subagent is not a typed node kind. The turn's node description records the `subagent` call that ran it, but not this agent's name — the created document does not carry it.",
  group:
    "These tool calls were already collapsed by the live graph's per-turn width bound, so their identities are not in the projection.",
  dag:
    "This is a link to a typed run that already exists; promoting the chat must not copy or re-create it.",
  event:
    "An unmodelled server frame. The taxonomy renders it as an event node rather than guessing at its meaning, and a guess is exactly what a typed node would be.",
  session: "The session root becomes the workflow itself, not a node inside it.",
};

/**
 * Turn a session's live graph into a typed workflow document.
 *
 * The mapping is one `agent` node per conversation turn, chained in sequence
 * order with unconditional edges, entry at the first turn and the last turn
 * terminal — the shape the conversation actually had. Everything the typed
 * union cannot express is returned in `unrepresented` rather than dropped, and
 * a turn with no retained user text is unrepresentable rather than invented.
 */
export function planSessionPromotion(
  projection: SessionGraphProjection,
  frames: readonly SessionFrame[],
  options: SessionPromotionOptions,
): SessionPromotionPlan {
  const workflowId = options.workflowId;
  const name = clamp(
    `Promoted from chat: ${options.sessionTitle || options.sessionId}`,
    MAX_NAME_LENGTH,
  );
  const unrepresented: UnrepresentedPart[] = [];
  const nodes: PromotedNodePlan[] = [];

  const turns = projection.nodes
    .filter((node) => node.kind === "turn")
    .sort((left, right) => left.createdAtSeq - right.createdAtSeq);

  for (const node of projection.nodes) {
    if (node.kind === "turn" || node.kind === "session") continue;
    unrepresented.push({
      sourceNodeId: node.id,
      kind: node.kind,
      label: node.collapsedCount ? `${node.label} (${node.collapsedCount})` : node.label,
      reason: UNREPRESENTABLE_REASON[node.kind] ?? "No typed node kind expresses this.",
    });
  }

  for (const turn of turns) {
    if (nodes.length >= MAX_PROMOTED_NODES) {
      unrepresented.push({
        sourceNodeId: turn.id,
        kind: "turn",
        label: turn.label,
        reason: `Past the ${MAX_PROMOTED_NODES}-node bound this promote applies; shorten the chat or promote a narrower window.`,
      });
      continue;
    }
    const prompt = promptForTurn(projection, frames, turn);
    if (!prompt) {
      unrepresented.push({
        sourceNodeId: turn.id,
        kind: "turn",
        label: turn.label,
        reason:
          "No user prompt text for this turn is in the retained frames, and a node needs a real instruction. Inventing one would put words in the chat's mouth.",
      });
      continue;
    }
    const observedWork = childrenOf(projection, turn.id)
      .filter((child) => child.kind === "tool" || child.kind === "subagent")
      .map((child) => child.label);
    nodes.push({
      id: toIdentifier(turn.id, `turn-${nodes.length + 1}`),
      sourceNodeId: turn.id,
      name: clamp(turn.label, MAX_NAME_LENGTH),
      prompt,
      observedWork,
      terminal: false,
    });
  }

  if (nodes.length === 0) {
    return {
      workflowId,
      name,
      nodes,
      edges: [],
      unrepresented,
      document: null,
      blockedReason:
        "No turn in this session carries user prompt text the console still holds, so there is nothing to promote without inventing an instruction.",
    };
  }

  nodes[nodes.length - 1].terminal = true;
  const edges: WorkflowGraphEdge[] = [];
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    edges.push({
      id: `edge-${index + 1}`,
      from: nodes[index].id,
      to: nodes[index + 1].id,
      condition: "always",
    });
  }

  const description = clamp(
    [
      `Promoted from chat session ${options.sessionId} in ${options.projectName}.`,
      `One agent node per conversation turn, in order. Tool calls and subagent`,
      `delegations observed in the chat are recorded on each node's description;`,
      `the typed node union has no member that executes them, so they are not`,
      `nodes here. Review before running.`,
    ].join(" "),
    MAX_DESCRIPTION_LENGTH,
  );

  const document: WorkflowGraphDocument = {
    schemaVersion: "1.0",
    id: workflowId,
    name,
    description,
    entryNodeId: nodes[0].id,
    defaultModel: PROMOTED_MODEL_REQUEST,
    limits: promotedWorkflowLimits(nodes.length),
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: nodes.map((node) => ({
      kind: "agent" as const,
      id: node.id,
      name: node.name,
      description: clamp(
        node.observedWork.length > 0
          ? `Chat turn ${node.sourceNodeId}. Observed in the chat: ${node.observedWork.join(", ")}.`
          : `Chat turn ${node.sourceNodeId}. No tool call was observed in this turn.`,
        MAX_DESCRIPTION_LENGTH,
      ),
      terminal: node.terminal,
      // A promoted draft is a reading of a conversation, not a licence to
      // write: nothing about this document should be able to touch the project
      // until someone edits the saved definition and grants it a write path.
      workspace: { isolation: "read-only" as const, writePaths: [] },
      prompt: node.prompt,
    })),
    edges,
  };

  return { workflowId, name, nodes, edges, unrepresented, document, blockedReason: null };
}
