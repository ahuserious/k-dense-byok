// danbot-byok — web/src/lib/typed-graph-view.ts
//
// The GraphViewModel: the ONLY shape that crosses from the Kady host to the
// vendored builder iframe, and the shape lane W4 renders a DAG run with.
//
// FROZEN at the end of W3-R1. Additive optional fields may be appended in later
// rounds; existing field names and meanings may not change, because W4 imports
// `GraphViewModel`/`typedToView` and the vendored `src/host/HostBridge.ts`
// consumes the same wire shape across an origin boundary.
//
// Two invariants make this file load-bearing rather than decorative:
//
//   1. The iframe never receives a `WorkflowGraphDocument`. It receives this
//      projection, so typed fields the canvas cannot edit (skills, databases,
//      subagents, autonomy, model auth, prompts/goals, retries, provenance,
//      and any unknown key) are structurally impossible to lose in a
//      round-trip: they are never sent, so they are never sent back.
//   2. The iframe never returns a document either — it returns deltas keyed by
//      node id (see typed-canvas-adapter.ts). `specDigest` lets the host detect
//      that a delta was computed against a stale projection.
//
// typed-graph-view.test.ts asserts (1) against the serialized view, and the
// vendored HostBridge.test.ts asserts it again on the far side of the boundary.

import type {
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeHarness,
  WorkflowNodePosition,
} from "@/lib/dag-workflows";

export const GRAPH_VIEW_MODEL_VERSION = 1 as const;

/**
 * The canvas glyph the vendored builder draws. It is a rendering hint, not a
 * typed node kind: every Kady typed node kind is drawn with the `prompt` glyph
 * today, and the authoritative kind travels beside it in `kind`.
 */
export type GraphViewNodeGlyph = "prompt" | "command" | "bash" | "loop" | "approval";

/** Run-status overlay. Written by lane W4 from run events; never by the host editor. */
export type GraphViewNodeStatus =
  | "pending"
  | "running"
  | "ok"
  | "error"
  | "cancelled";

/**
 * The fields a delta may set on a node. Anything outside this allowlist is
 * rejected by `applyDelta` — the allowlist is the contract, not a suggestion.
 */
export const GRAPH_VIEW_EDITABLE_FIELDS = ["name", "position", "harness"] as const;
export type GraphViewEditableField = (typeof GRAPH_VIEW_EDITABLE_FIELDS)[number];

export interface GraphViewNode {
  id: string;
  /** Human label drawn on the node. Author-written; never a prompt body. */
  label: string;
  /** Typed node kind (`agent`, `fusion`, …) or `unrendered` for an opaque node. */
  kind: string;
  glyph: GraphViewNodeGlyph;
  /** Author-written one-line description, when the node has one. */
  summary?: string;
  harness?: WorkflowNodeHarness;
  terminal: boolean;
  position?: WorkflowNodePosition;
  /**
   * Digest of the whole typed node as the host currently holds it. Not a
   * security boundary — a stale-projection detector. A delta whose
   * `specDigest` no longer matches the host's node is rejected rather than
   * applied to a node the author was not looking at.
   */
  specDigest: string;
  editableFields: readonly GraphViewEditableField[];
  /**
   * A node the canvas cannot represent (an unknown kind reached the document
   * through a YAML/Split hand-edit). Rendered read-only and opaque; preserved
   * byte-for-byte on save because the host, not the canvas, owns the document.
   */
  unrendered?: boolean;
  status?: GraphViewNodeStatus;
}

export interface GraphViewEdge {
  id: string;
  from: string;
  to: string;
  condition?: WorkflowGraphEdge["condition"];
}

export interface GraphViewViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphViewModel {
  version: typeof GRAPH_VIEW_MODEL_VERSION;
  documentId: string;
  name: string;
  description?: string;
  entryNodeId: string;
  /** Hash of the document this view projects, when the host knows it. */
  graphSha256: string | null;
  /** `typed` = the Kady typed route owns save/run. `engine` = the legacy path. */
  mode: "typed" | "engine";
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  viewport?: GraphViewViewport;
}

export interface TypedToViewOptions {
  graphSha256?: string | null;
  mode?: GraphViewModel["mode"];
  /** W4 run overlay: status per node id. */
  statusByNodeId?: Readonly<Record<string, GraphViewNodeStatus>>;
  viewport?: GraphViewViewport;
}

/**
 * A 128-bit FNV-1a digest over the canonically ordered node. Deliberately not
 * SHA-256: `typedToView` is called synchronously on every host render and
 * WebCrypto digests are async. This value never authenticates anything; it
 * only answers "is the delta I just received about the node I last projected?"
 */
export function nodeSpecDigest(node: WorkflowGraphNode): string {
  const serialized = stableStringify(node);
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}

/**
 * Key-sorted JSON, local to the digest above. The persisted-document canonical
 * form lives in typed-canvas-adapter.ts and must mirror the SERVER's
 * canonicalizer byte-for-byte; this one only has to be stable.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function nodeHarness(node: WorkflowGraphNode): WorkflowNodeHarness | undefined {
  return node.settings?.harness;
}

/**
 * Project one typed node. Every field is copied deliberately: this function is
 * an allowlist, so a new typed field added upstream reaches the iframe only
 * when someone edits this function on purpose.
 */
function projectNode(
  node: WorkflowGraphNode,
  status?: GraphViewNodeStatus,
): GraphViewNode {
  const harness = nodeHarness(node);
  return {
    id: node.id,
    label: node.name,
    kind: node.kind,
    glyph: "prompt",
    ...(node.description ? { summary: node.description } : {}),
    ...(harness ? { harness } : {}),
    terminal: node.terminal,
    ...(node.position ? { position: { x: node.position.x, y: node.position.y } } : {}),
    specDigest: nodeSpecDigest(node),
    editableFields: GRAPH_VIEW_EDITABLE_FIELDS,
    ...(status ? { status } : {}),
  };
}

/**
 * Project a typed document into the view the canvas renders.
 *
 * Pure and synchronous. `graphSha256` is passed in rather than computed here
 * because the authoritative hash is the server's, and computing a second one
 * locally would invite the two to disagree.
 */
export function typedToView(
  document: WorkflowGraphDocument,
  options: TypedToViewOptions = {},
): GraphViewModel {
  const statusByNodeId = options.statusByNodeId ?? {};
  return {
    version: GRAPH_VIEW_MODEL_VERSION,
    documentId: document.id,
    name: document.name,
    ...(document.description ? { description: document.description } : {}),
    entryNodeId: document.entryNodeId,
    graphSha256: options.graphSha256 ?? null,
    mode: options.mode ?? "typed",
    nodes: document.nodes.map((node) => projectNode(node, statusByNodeId[node.id])),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.condition ? { condition: edge.condition } : {}),
    })),
    ...(options.viewport ?? document.ui?.viewport
      ? { viewport: options.viewport ?? document.ui?.viewport }
      : {}),
  };
}

/** Node ids in the view, in document order. Convenience for W4's overlay fold. */
export function viewNodeIds(view: GraphViewModel): string[] {
  return view.nodes.map((node) => node.id);
}
