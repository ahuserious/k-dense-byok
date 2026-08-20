// danbot-byok — web/src/lib/baby-view.ts
//
// Row 18's data half: WHICH pipeline the chat's baby view is previewing, and
// how a real `WorkflowGraphDocument` becomes coordinates small enough to draw
// inside a 12rem square.
//
// Two rules govern this module.
//
//   1. THE PREVIEW SHOWS A REAL DOCUMENT OR IT SHOWS NOTHING. There is no
//      placeholder graph, no sample topology and no "example pipeline" in this
//      file. Every node and edge the rail draws came out of
//      `GET /dag-workflows/:id`. When no pipeline exists, the resolver returns
//      `kind: "none"` and the rail renders a designed empty state.
//
//   2. A MALFORMED 200 MUST NOT REACH JSX. Defect #62 is exactly this: the
//      shared client helper `listDagWorkflowDefinitions` (dag-workflows.ts:629)
//      ends in `return body.workflows` — a CAST, not a check — so a successful
//      response without that array yields `undefined` and throws in whatever
//      render phase maps it. That file belongs to S1 and is not this lane's to
//      widen or to fix, so the check lives here at the point of use: every
//      value is shape-checked before it leaves this module, and any failure
//      becomes an `error` state whose text names the reader's next action and
//      carries no filesystem path (#71).
//
// The module is deliberately free of React and of DOM access. The rail component
// owns polling and rendering; this owns "what is true" and "where does it sit".

"use client";

import {
  listDagWorkflowDefinitions,
  readDagWorkflowDefinition,
  type DagWorkflowDefinitionSummary,
  type WorkflowGraphDocument,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "@/lib/dag-workflows";
import { fetchSessionWorkflowRunLink } from "@/lib/console-live-sources";

/**
 * Why this document is the "current" pipeline. The rail PRINTS this, because
 * "the pipeline linked to this chat" and "the pipeline you last edited" are
 * different claims and a preview that conflates them is lying about provenance.
 */
export type CurrentPipelineSource = "session-link" | "project-recent";

export interface CurrentPipeline {
  kind: "pipeline";
  source: CurrentPipelineSource;
  workflowId: string;
  revision: number;
  document: WorkflowGraphDocument;
}

export interface NoCurrentPipeline {
  kind: "none";
  /** Reader-facing, in the reader's terms. Never a path, never a status code. */
  reason: string;
}

export interface CurrentPipelineError {
  kind: "error";
  /** Reader-facing and action-naming. Never a path, never a status code (#71). */
  message: string;
}

export type CurrentPipelineResult = CurrentPipeline | NoCurrentPipeline | CurrentPipelineError;

/** The one sentence the rail shows when nothing has gone wrong and nothing exists. */
export const NO_PIPELINE_REASON =
  "No pipeline in this project yet. Elevate a conversation, or build one in Scientific Pipelines.";

/** The one sentence the rail shows when a read failed or answered nonsense. */
export const PIPELINE_READ_ERROR =
  "The pipeline preview could not read this project's pipelines. Try again, or open Scientific Pipelines to check the workflow registry.";

/** How the rail labels each provenance, so the claim is legible and not inferred. */
export const PIPELINE_SOURCE_LABEL: Record<CurrentPipelineSource, string> = {
  "session-link": "Linked to this chat",
  "project-recent": "Most recent in this project",
};

// --- defensive validation --------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A node this preview is willing to DRAW. Deliberately narrower than the typed
 * union: the preview reads `id`, `name` and `kind` and nothing else, so a node
 * carrying an unknown `kind` is still drawable (it is a real node in a real
 * document) while a node missing an `id` is not (it cannot be an edge endpoint).
 */
export function isDrawableNode(value: unknown): value is WorkflowGraphNode {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.name) && isNonEmptyString(value.kind);
}

export function isDrawableEdge(value: unknown): value is WorkflowGraphEdge {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.from) && isNonEmptyString(value.to);
}

/**
 * The whole-document check. `nodes` and `edges` must BE arrays — the failure
 * behind #62 is precisely a field that was assumed to be one.
 */
export function isDrawableDocument(value: unknown): value is WorkflowGraphDocument {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name)) return false;
  return Array.isArray(value.nodes) && Array.isArray(value.edges);
}

function isDefinitionSummary(value: unknown): value is DagWorkflowDefinitionSummary {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && typeof value.updatedAt === "number";
}

// --- resolution ------------------------------------------------------------

/**
 * The three reads this resolver makes, injectable so a test can drive the whole
 * resolution with real documents and no network. The defaults are the shared
 * client helpers — this lane adds no second HTTP path to the same endpoints.
 */
export interface CurrentPipelineReaders {
  readSessionLink: typeof fetchSessionWorkflowRunLink;
  listDefinitions: typeof listDagWorkflowDefinitions;
  readDefinition: typeof readDagWorkflowDefinition;
}

const DEFAULT_READERS: CurrentPipelineReaders = {
  readSessionLink: fetchSessionWorkflowRunLink,
  listDefinitions: listDagWorkflowDefinitions,
  readDefinition: readDagWorkflowDefinition,
};

async function readDocument(
  projectId: string,
  workflowId: string,
  readers: CurrentPipelineReaders,
): Promise<{ document: WorkflowGraphDocument; revision: number } | null> {
  const versioned = await readers.readDefinition(projectId, workflowId);
  if (!isRecord(versioned)) return null;
  const definition = versioned.definition;
  if (!isRecord(definition)) return null;
  if (!isDrawableDocument(definition.graph)) return null;
  const revision = typeof definition.revision === "number" ? definition.revision : 0;
  return { document: definition.graph, revision };
}

/**
 * Resolve the pipeline the reader is actually working with.
 *
 * Order, and why:
 *   1. The workflow this chat session is delegated to
 *      (`GET /sessions/:id/workflow-run-state`), PROVIDED the project's own
 *      registry still lists it. This is the literal answer to "the actual
 *      current pipeline" for this chat.
 *   2. The project's most recently updated definition. A chat with no delegated
 *      run still has a pipeline its reader is building, and showing nothing
 *      there would be less true than showing that one — PROVIDED the rail says
 *      which of the two it is, which is what `source` is for.
 *   3. Nothing. A designed empty state, not a blank box.
 *
 * The registry list is read BEFORE any definition, including the linked one,
 * and a definition is never requested for an id the list does not carry. Two
 * reasons, and the second is the load-bearing one:
 *   - a session can outlive the workflow it was delegated to (deleted, renamed,
 *     or created in another project), and asking for it anyway turns a stale
 *     link into an error state the reader can do nothing about. Falling back to
 *     the project's most recent pipeline is both true and useful.
 *   - it bounds what this rail asks of the backend to ids the backend has just
 *     told us exist, so a new surface cannot spray reads at unknown paths.
 *
 * A failure at any step returns `error`, never a partially-true pipeline.
 */
export async function resolveCurrentPipeline(
  projectId: string,
  sessionId: string | null,
  readers: CurrentPipelineReaders = DEFAULT_READERS,
): Promise<CurrentPipelineResult> {
  let linkedWorkflowId: string | null = null;
  if (sessionId) {
    try {
      const link = await readers.readSessionLink(projectId, sessionId);
      if (link && isNonEmptyString(link.workflowId)) linkedWorkflowId = link.workflowId;
    } catch {
      // A session with no delegated run is the common case and answers
      // `{state:null}`; a failure here must not blank a preview the project
      // list can still fill. Fall through to the project-recent source.
      linkedWorkflowId = null;
    }
  }

  let summaries: unknown;
  try {
    summaries = await readers.listDefinitions(projectId);
  } catch {
    return { kind: "error", message: PIPELINE_READ_ERROR };
  }
  // #62's exact shape: a successful body without the array. Guarding here means
  // `undefined` never reaches a `.filter` in this module or a `.map` in JSX.
  if (!Array.isArray(summaries)) return { kind: "error", message: PIPELINE_READ_ERROR };

  let linked: DagWorkflowDefinitionSummary | null = null;
  let newest: DagWorkflowDefinitionSummary | null = null;
  for (const summary of summaries) {
    if (!isDefinitionSummary(summary)) continue;
    if (linkedWorkflowId !== null && summary.id === linkedWorkflowId) linked = summary;
    if (newest === null || summary.updatedAt > newest.updatedAt) newest = summary;
  }

  const chosen = linked ?? newest;
  if (chosen === null) return { kind: "none", reason: NO_PIPELINE_REASON };
  const source: CurrentPipelineSource = linked === null ? "project-recent" : "session-link";

  try {
    const read = await readDocument(projectId, chosen.id, readers);
    if (read === null) return { kind: "error", message: PIPELINE_READ_ERROR };
    return {
      kind: "pipeline",
      source,
      workflowId: chosen.id,
      revision: read.revision,
      document: read.document,
    };
  } catch {
    return { kind: "error", message: PIPELINE_READ_ERROR };
  }
}

// --- projection to a 12rem square ------------------------------------------

export interface PreviewNode {
  id: string;
  /** The document's own node name. Not truncated here — the view decides. */
  label: string;
  kind: string;
  /** 1-based, drawn as the badge that IS legible at this size. */
  index: number;
  terminal: boolean;
  /** Unit coordinates in [0,1]; the view multiplies by its viewBox. */
  x: number;
  y: number;
}

export interface PreviewEdge {
  id: string;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PipelinePreview {
  name: string;
  nodes: PreviewNode[];
  edges: PreviewEdge[];
  /** Counts of what was DRAWN, which is what the footer is entitled to claim. */
  nodeCount: number;
  edgeCount: number;
  /**
   * Nodes the document carried that the drawing does not show — undrawable or
   * past `MAX_PREVIEW_NODES`. Stated in the footer, never hidden.
   */
  droppedNodeCount: number;
}

/**
 * At 12rem a graph past this many nodes is a grey smear. Past it the preview
 * draws the first N in document order and the footer SAYS so — a silent
 * truncation would make the node count a lie.
 */
export const MAX_PREVIEW_NODES = 24;

/**
 * Layer index of each node: the length of the longest edge chain that reaches
 * it. A node no edge reaches stays at 0, which puts an orphan in the first
 * column rather than dropping it from a preview that claims to show the graph.
 *
 * Bounded relaxation rather than a topological sort, because the edge list is a
 * document field and a document may carry a cycle. `nodeIds.length` passes is
 * enough for any acyclic chain, and a cycle simply stops improving — the rail
 * must terminate on a hostile document, not hang.
 */
function computeDepths(nodeIds: string[], edges: WorkflowGraphEdge[]): Map<string, number> {
  const depths = new Map<string, number>();
  for (const id of nodeIds) depths.set(id, 0);

  for (let pass = 0; pass < nodeIds.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const fromDepth = depths.get(edge.from);
      const toDepth = depths.get(edge.to);
      if (fromDepth === undefined || toDepth === undefined) continue;
      if (toDepth >= fromDepth + 1) continue;
      depths.set(edge.to, fromDepth + 1);
      changed = true;
    }
    if (!changed) break;
  }
  return depths;
}

/**
 * Turn a real document into unit coordinates that always fit the square,
 * whatever the node count. Positions the document already carries are ignored
 * on purpose: canvas positions are authored for a full-size builder and, scaled
 * into 12rem, they overlap into an unreadable clump. A derived layered layout
 * is a truthful drawing of the same topology at a size that can carry it.
 */
export function projectPipelinePreview(document: WorkflowGraphDocument): PipelinePreview {
  const rawNodes = Array.isArray(document.nodes) ? document.nodes : [];
  const drawable: WorkflowGraphNode[] = [];
  for (const node of rawNodes) {
    if (isDrawableNode(node)) drawable.push(node);
  }
  const shown = drawable.slice(0, MAX_PREVIEW_NODES);
  // Counts BOTH causes: a node the document carried that this preview could not
  // validate, and a node past the cap. The footer prints this, so a node that
  // left the drawing for either reason is stated rather than silently absent.
  const droppedNodeCount = rawNodes.length - shown.length;
  const shownIds = new Set(shown.map((node) => node.id));

  const rawEdges = Array.isArray(document.edges) ? document.edges : [];
  const edges: WorkflowGraphEdge[] = [];
  for (const edge of rawEdges) {
    if (!isDrawableEdge(edge)) continue;
    if (!shownIds.has(edge.from) || !shownIds.has(edge.to)) continue;
    edges.push(edge);
  }

  const ids = shown.map((node) => node.id);
  const depths = computeDepths(ids, edges);

  // Group by depth so each column can be spread down the square evenly.
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const depth = depths.get(id) ?? 0;
    const column = columns.get(depth);
    if (column) column.push(id);
    else columns.set(depth, [id]);
  }
  const depthValues = [...columns.keys()].sort((a, b) => a - b);
  const columnCount = depthValues.length;

  const positions = new Map<string, { x: number; y: number }>();
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const depth = depthValues[columnIndex];
    const column = columns.get(depth) ?? [];
    const x = columnCount === 1 ? 0.5 : columnIndex / (columnCount - 1);
    for (let rowIndex = 0; rowIndex < column.length; rowIndex += 1) {
      const y = column.length === 1 ? 0.5 : rowIndex / (column.length - 1);
      positions.set(column[rowIndex], { x, y });
    }
  }

  const previewNodes: PreviewNode[] = [];
  for (let i = 0; i < shown.length; i += 1) {
    const node = shown[i];
    const position = positions.get(node.id) ?? { x: 0.5, y: 0.5 };
    previewNodes.push({
      id: node.id,
      label: node.name,
      kind: node.kind,
      index: i + 1,
      terminal: node.terminal === true,
      x: position.x,
      y: position.y,
    });
  }

  const previewEdges: PreviewEdge[] = [];
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    previewEdges.push({ id: edge.id, from: edge.from, to: edge.to, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }

  return {
    name: typeof document.name === "string" ? document.name : "",
    nodes: previewNodes,
    edges: previewEdges,
    nodeCount: previewNodes.length,
    edgeCount: previewEdges.length,
    droppedNodeCount,
  };
}

/**
 * The footer sentence. It states what was DRAWN and, when the document held
 * more, says so — the whole point of `droppedNodeCount` and `MAX_PREVIEW_NODES`
 * is that the number under the drawing is never a claim the drawing cannot back.
 */
export function previewSummaryLine(preview: PipelinePreview, revision: number): string {
  const nodes = `${preview.nodeCount} node${preview.nodeCount === 1 ? "" : "s"}`;
  const edges = `${preview.edgeCount} edge${preview.edgeCount === 1 ? "" : "s"}`;
  const dropped = preview.droppedNodeCount > 0 ? ` · ${preview.droppedNodeCount} not shown` : "";
  return `${nodes} · ${edges} · rev ${revision}${dropped}`;
}
