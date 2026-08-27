/**
 * BF-30 / BF-55 / BF-56 — the words the insert-saved-workflow confirmation
 * dialog says, derived from what the party that SETTLES the insert has declared
 * it will do, and spoken in the names the user can see on the canvas.
 *
 * WHY THIS IS A MODULE AND NOT A STRING IN THE JSX
 * ------------------------------------------------
 * The append branch used to state, flatly:
 *
 *     No edges will be created to the existing graph — stitch points stay
 *     available to connect.
 *
 * That is true of the ENGINE's half of the confirm (`confirmInsertSavedWorkflow`
 * concatenates `before.edges` with `previewEdges` and creates nothing else), and
 * false of the ACTION a user of the embedding host took. The host settles the
 * same confirm by re-composing its typed document through `stitchWorkflows`
 * (web/src/lib/insert-saved-workflow-host.ts), which routes every phase-0 node
 * with `terminal === true` into the inserted group's entry
 * (web/src/lib/stitch-workflows.ts:299, :382-387) and pushes the result back
 * onto this canvas. The settled canvas therefore carried an edge the dialog
 * promised it would not — observed as
 * `stitch-always-writeup-to-p3-bld24-cancel-saved-mta203oo-0-7y6x4v`.
 *
 * That edge is not an overreach to delete. Without it the inserted nodes are
 * unreachable from the entry node and the server refuses the Save outright
 * (`unreachable-node`, server/src/workflows/validate.ts:2476), so a user who
 * accepted the old promise would be left holding a workflow they cannot save.
 * The code is right and the copy was wrong.
 *
 * WHAT CYCLE 1 GOT WRONG, AND WHY THE INPUT LOOKS LIKE THIS
 * ---------------------------------------------------------
 * Cycle 1 computed the claim HERE, from this canvas's own shape ("an existing
 * node with no outgoing edge is an end node"). Two independent reviewers
 * disproved that by running it:
 *
 *   * BF-56 — on the STANDALONE engine (no host attached, :13091) nothing
 *     stitches, so a dialog that inferred the claim from the canvas promised
 *     edges that the same Confirm then did not create. That is BF-30 inverted,
 *     inside the build offered as its fix. Reproduced again in cycle 2: the
 *     dialog named two end nodes and the settled canvas held 4 nodes / 1 edge,
 *     zero stitch edges.
 *   * "no outgoing edge" is not the predicate the host stitches on. A node
 *     marked terminal that still carries an outgoing edge is handed over by
 *     `stitchWorkflows` and was NOT named by the cycle-1 dialog (an unannounced
 *     edge — BF-30 again); an unwired draft node that is not yet marked terminal
 *     was named and never connected (an over-promise). The two predicates
 *     coincide only for a document the server already accepted, because
 *     `validateTerminals` makes every sink terminal
 *     (`unterminated-sink`, validate.ts:2503) and forbids a terminal node any
 *     outgoing edge (`terminal-has-outgoing-edge`, validate.ts:2496). Mid-edit,
 *     they diverge — and mid-edit is when a user drops a saved workflow.
 *
 * So the claim is no longer INFERRED here. It is DECLARED by the settling party
 * and carried in the insert payload (`InsertSavedWorkflowPayload.settlement`).
 * `settlementConnectsFromNodeIds === null` means nobody declared a settlement,
 * which is the truth on the standalone engine, and the dialog then states the
 * retained "no edges will be created" sentence — which is then true.
 *
 * The claim is returned alongside the words as data so a test can assert the
 * two things that must never drift apart again: what the dialog SAYS will gain
 * a connection, and what the settled document ACTUALLY connects. A test of
 * either one alone would have passed on the day this defect was introduced.
 *
 * BF-55 — NAMES, NOT IDS
 * ----------------------
 * The sentence names each node the way its card is drawn. Cycle 1 rendered raw
 * ids: a user read "your end node node-a9e723f9-fc6c-4874-a3b3-218f5e793a06"
 * for a card labelled `Prompt`, while the same dialog listed the INSERTED nodes
 * by label two lines below. One dialog, two naming schemes, and the one making
 * the promise was the one the user could not act on. `claim.connectedFromNodeIds`
 * keeps the ids, because ids are what a gate can compare against an edge set;
 * `claim.connectedFromDisplayNames` is what the sentence says.
 *
 * `replace` is unchanged. That branch replaces an empty canvas, has no existing
 * graph to connect to, and never made the promise.
 *
 * This module deliberately imports nothing, and that is load-bearing rather than
 * tidy. The engine's own modules reach their neighbours through the engine's
 * `@/` alias, which no other package's TypeScript program can resolve — a web
 * test that imports `insert-saved-workflow.ts` compiles under vitest (esbuild
 * erases the type-only imports) but puts four TS2307s into `web`'s otherwise
 * clean `tsc`. So the contract that has to cross the package boundary lives
 * here, in a file with no imports at all: the engine (bun test), the host web
 * app (vitest + jsdom) and the server (vitest, no path aliases) all read the
 * exact same sentence from the exact same source. That property is no longer
 * asserted in prose only — `insert-saved-workflow-copy.test.ts` reads this
 * file's source and fails if an import or require statement appears in it.
 */

export type SavedWorkflowInsertCopyMode = 'replace' | 'append';

/** Just enough of a canvas edge to find the graph's ends. */
export interface SavedWorkflowInsertCopyCanvasEdge {
  source: string;
  target: string;
}

/**
 * An existing canvas node as the user sees it: the id the graph uses and the
 * label the card shows. `label` is optional because a canvas node is not
 * obliged to carry one.
 */
export interface SavedWorkflowInsertCopyNode {
  id: string;
  label?: string | null;
}

export interface SavedWorkflowInsertCopyInput {
  mode: SavedWorkflowInsertCopyMode;
  workflowId: string;
  insertedNodeCount: number;
  /**
   * BF-56. The existing-graph node ids the party that SETTLES this insert has
   * declared it will connect into the inserted group's entry node.
   *
   *   * `null`  — nobody declared a settlement. Nothing outside the engine will
   *               touch the document, so confirming creates no cross edge and
   *               the dialog says exactly that. This is the standalone engine.
   *   * `[]`    — a settling party is attached and declares it will connect
   *               nothing. Same sentence, different reason.
   *   * ids     — those nodes, and only those, gain an outgoing edge.
   *
   * This field is REQUIRED rather than optional on purpose: an omitted
   * declaration and a declared-empty one are the difference between BF-30 and
   * its fix, and a caller must not be able to lose that distinction by
   * forgetting an argument.
   */
  settlementConnectsFromNodeIds: readonly string[] | null;
  /**
   * The existing canvas. Used only to turn the declared ids into the names the
   * user is looking at; a node that is not here is named by its id.
   */
  existingNodes: readonly SavedWorkflowInsertCopyNode[];
}

/**
 * The checkable half of the copy.
 *
 * `connectedFromNodeIds` are EXISTING-graph node ids the dialog tells the user
 * will gain an outgoing edge into the inserted group when they confirm. Empty
 * means the dialog promised no edge would be created, and a settled document
 * with a cross edge then contradicts the dialog — which is the whole assertion.
 *
 * `connectedFromDisplayNames` is the same list in the words the sentence uses,
 * index for index, so a gate can assert the body really says what the claim
 * claims without re-deriving the names.
 */
export interface SavedWorkflowInsertConnectionClaim {
  connectedFromNodeIds: string[];
  connectedFromDisplayNames: string[];
}

export interface SavedWorkflowInsertCopy {
  title: string;
  body: string;
  claim: SavedWorkflowInsertConnectionClaim;
}

/** Verbatim the pre-BF-30 append sentence — now used only when it is TRUE. */
export const SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE =
  'No edges will be created to the existing graph — stitch points stay available to connect.';

export const SAVED_WORKFLOW_INSERT_REPLACE_TITLE = 'Replace empty canvas with saved workflow?';
export const SAVED_WORKFLOW_INSERT_APPEND_TITLE =
  'Insert saved workflow as a disconnected group?';

/**
 * The name to call one existing node in the sentence.
 *
 * The rule, in order, and every branch of it is gated:
 *
 *   1. the label the card shows, trimmed — this is the common case and the
 *      point of BF-55;
 *   2. if that label is not unique on the canvas, the label followed by the id
 *      in parentheses, because "an edge is created from your end node Prompt"
 *      is worse than useless when three cards read `Prompt`;
 *   3. the raw id, when the node has no label, only whitespace for a label, or
 *      is not on this canvas at all. An id the user cannot map to a card is a
 *      poor name, but it is an HONEST one, and it is the only identifier that
 *      certainly exists.
 */
export function savedWorkflowInsertNodeDisplayName(
  nodeId: string,
  existingNodes: readonly SavedWorkflowInsertCopyNode[],
): string {
  let label: string | null = null;
  for (const node of existingNodes) {
    if (node.id !== nodeId) continue;
    const trimmed = typeof node.label === 'string' ? node.label.trim() : '';
    label = trimmed.length > 0 ? trimmed : null;
    break;
  }
  if (label === null) return nodeId;
  for (const node of existingNodes) {
    if (node.id === nodeId) continue;
    const trimmed = typeof node.label === 'string' ? node.label.trim() : '';
    if (trimmed === label) return `${label} (${nodeId})`;
  }
  return label;
}

/**
 * The existing graph's end nodes: the ones with no outgoing edge.
 *
 * This is the STITCH-POINT predicate, not the dialog's claim — the two were the
 * same function in cycle 1 and that is what BF-56 punished. `collectStitchPoints`
 * uses it to decide which existing nodes the user may hand-wire into the group;
 * an isolated node has no outgoing edge and is therefore offered, which is the
 * case a surviving mutant exploited and which is now pinned by
 * `insert-saved-workflow-copy.test.ts`.
 */
export function existingGraphExitNodeIds(
  nodes: readonly { id: string }[],
  edges: readonly SavedWorkflowInsertCopyCanvasEdge[],
): string[] {
  const withOutgoing = new Set<string>();
  for (const edge of edges) withOutgoing.add(edge.source);
  const exits: string[] = [];
  for (const node of nodes) {
    if (!withOutgoing.has(node.id)) exits.push(node.id);
  }
  return exits;
}

export function savedWorkflowInsertConnectionClaim(
  input: SavedWorkflowInsertCopyInput,
): SavedWorkflowInsertConnectionClaim {
  const empty: SavedWorkflowInsertConnectionClaim = {
    connectedFromNodeIds: [],
    connectedFromDisplayNames: [],
  };
  if (input.mode === 'replace') return empty;
  if (input.settlementConnectsFromNodeIds === null) return empty;
  const seen = new Set<string>();
  const connectedFromNodeIds: string[] = [];
  for (const nodeId of input.settlementConnectsFromNodeIds) {
    if (nodeId.length === 0 || seen.has(nodeId)) continue;
    seen.add(nodeId);
    connectedFromNodeIds.push(nodeId);
  }
  return {
    connectedFromNodeIds,
    connectedFromDisplayNames: connectedFromNodeIds.map(nodeId =>
      savedWorkflowInsertNodeDisplayName(nodeId, input.existingNodes),
    ),
  };
}

function nameList(names: readonly string[]): string {
  const quoted = names.map(name => `“${name}”`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length === 2) return `${quoted[0]!} and ${quoted[1]!}`;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]!}`;
}

/**
 * Title and body for the confirmation dialog.
 *
 * The append body states no edge COUNT on purpose. A node whose evidence policy
 * routes unsupported output hands over on two conditions rather than one
 * (`workflowHandoverConditions`), so an edge count computed here would be wrong
 * for exactly the graphs that are hardest to reason about. The set of nodes that
 * gain a connection is exact, and it is what the claim carries.
 */
export function savedWorkflowInsertCopy(
  input: SavedWorkflowInsertCopyInput,
): SavedWorkflowInsertCopy {
  const claim = savedWorkflowInsertConnectionClaim(input);
  if (input.mode === 'replace') {
    return {
      title: SAVED_WORKFLOW_INSERT_REPLACE_TITLE,
      body: `This canvas is empty. Confirm to load ${String(input.insertedNodeCount)} nodes from ${input.workflowId}.`,
      claim,
    };
  }

  const opening = `Append ${String(input.insertedNodeCount)} nodes from ${input.workflowId} at the drop point.`;
  if (claim.connectedFromNodeIds.length === 0) {
    return {
      title: SAVED_WORKFLOW_INSERT_APPEND_TITLE,
      body: `${opening} ${SAVED_WORKFLOW_INSERT_NO_EDGES_SENTENCE}`,
      claim,
    };
  }

  const plural = claim.connectedFromDisplayNames.length > 1;
  const connection = plural
    ? `edges are created from your end nodes ${nameList(claim.connectedFromDisplayNames)}`
    : `an edge is created from your end node ${nameList(claim.connectedFromDisplayNames)}`;
  return {
    title: SAVED_WORKFLOW_INSERT_APPEND_TITLE,
    body:
      `${opening} The group lands disconnected, then ${connection} into the group's first node,`
      + ' so the inserted nodes stay reachable and this workflow can still be saved.'
      + " The group's remaining stitch points stay available to connect.",
    claim,
  };
}
