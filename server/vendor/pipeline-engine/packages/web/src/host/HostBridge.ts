/**
 * Host mode for the vendored workflow builder.
 *
 * ALL of the embedding logic lives here. The call sites in
 * `components/workflows/` are a handful of lines each, on purpose: this package
 * is vendored, and an upstream re-sync must be a re-sync rather than an
 * archaeology exercise. Nothing outside `src/host/` may grow host-specific
 * behaviour.
 *
 * The model is host-authoritative. The embedding application owns a typed
 * workflow document; this canvas is a PROJECTION of it. The host pushes a
 * `GraphViewModel`; the canvas answers with DELTAS (`moveNode`, `addEdge`, …).
 * The canvas never returns a document, so the fields it was never given — model
 * credentials, skills, databases, prompts — cannot be lost in a round-trip.
 *
 * The wire contract mirrors the host's copy at `web/src/lib/builder-bridge.ts`
 * in the outer repository. The two files are duplicated across an origin
 * boundary and MUST be edited together; `BUILDER_BRIDGE_VERSION` is the
 * tripwire, and an envelope with an unknown `v` is dropped rather than guessed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge } from '@xyflow/react';

import type { NodeHarness } from '@/lib/api';
import { layoutWithDagre } from '@/lib/dag-layout';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';

export const BUILDER_BRIDGE_VERSION = 1;
export const BUILDER_BRIDGE_MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Position noise below this many pixels is not an edit worth reporting. */
const POSITION_EPSILON = 0.5;
/** React Flow reports a position per pointer move; deltas are batched instead. */
const DELTA_DEBOUNCE_MS = 250;

const HOST_TO_FRAME_TYPES = new Set([
  'builder.init',
  'builder.loadGraph',
  'builder.setSourceList',
  'builder.setIssues',
  'builder.applyPatch',
  'builder.setMode',
  'builder.loadEnginePipeline',
]);

export interface BridgeEnvelope<TPayload = unknown> {
  v: number;
  id: string;
  type: string;
  payload: TPayload;
}

export interface HostSourceEntry {
  id: string;
  label: string;
  description?: string;
  badge?: string;
}

export interface HostSourceGroup {
  id: string;
  label: string;
  entries: HostSourceEntry[];
}

export interface HostGraphViewNode {
  id: string;
  label: string;
  kind: string;
  glyph: 'prompt' | 'command' | 'bash' | 'loop' | 'approval';
  summary?: string;
  harness?: NodeHarness;
  terminal: boolean;
  position?: { x: number; y: number };
  specDigest: string;
  editableFields: readonly string[];
  unrendered?: boolean;
}

export interface HostGraphViewEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
}

export interface HostGraphViewModel {
  version: number;
  documentId: string;
  name: string;
  description?: string;
  entryNodeId: string;
  graphSha256: string | null;
  mode: 'typed' | 'engine';
  nodes: HostGraphViewNode[];
  edges: HostGraphViewEdge[];
}

export interface HostIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  nodeId?: string;
}

export type HostCanvasDeltaOp =
  | { op: 'moveNode'; nodeId: string; position: { x: number; y: number }; specDigest?: string }
  | { op: 'renameNode'; nodeId: string; name: string; specDigest?: string }
  | { op: 'setHarness'; nodeId: string; harness: NodeHarness | null; specDigest?: string }
  | {
      op: 'addNode';
      nodeId: string;
      name: string;
      position?: { x: number; y: number };
      harness?: NodeHarness;
    }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'addEdge'; edgeId: string; from: string; to: string }
  | { op: 'removeEdge'; edgeId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read host mode off the URL. Absent or malformed means "behave exactly as before". */
export function readHostMode(search: string): { hostMode: boolean; hostOrigin: string | null } {
  const params = new URLSearchParams(search);
  if (params.get('host') !== 'kady') return { hostMode: false, hostOrigin: null };
  const declared = params.get('hostOrigin');
  if (!declared) return { hostMode: false, hostOrigin: null };
  try {
    // Normalised through URL so a trailing slash or a path cannot smuggle a
    // value that `postMessage` would reject at send time.
    return { hostMode: true, hostOrigin: new URL(declared).origin };
  } catch {
    return { hostMode: false, hostOrigin: null };
  }
}

export function decodeEnvelope(data: unknown): BridgeEnvelope | null {
  if (typeof data !== 'string') return null;
  if (new TextEncoder().encode(data).byteLength > BUILDER_BRIDGE_MAX_PAYLOAD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.v !== BUILDER_BRIDGE_VERSION) return null;
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) return null;
  if (!('payload' in parsed)) return null;
  return parsed as unknown as BridgeEnvelope;
}

function parseViewModel(payload: unknown): HostGraphViewModel | null {
  if (!isRecord(payload) || !isRecord(payload.view)) return null;
  const view = payload.view as Partial<HostGraphViewModel>;
  if (typeof view.documentId !== 'string' || !Array.isArray(view.nodes) || !Array.isArray(view.edges)) {
    return null;
  }
  return view as HostGraphViewModel;
}

function parseSourceGroups(payload: unknown): HostSourceGroup[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.groups)) return null;
  return payload.groups.filter(
    (group): group is HostSourceGroup =>
      isRecord(group) && typeof group.id === 'string' && Array.isArray(group.entries)
  );
}

/**
 * Project the host's view model onto the React Flow canvas.
 *
 * Positions come from the typed document when it has them. When ANY node lacks
 * one the whole graph is auto-laid-out instead of mixing authored coordinates
 * with zeros, which would stack half the graph in the corner.
 */
export function viewToFlow(view: HostGraphViewModel): { nodes: DagFlowNode[]; edges: Edge[] } {
  const dependenciesById = new Map<string, string[]>();
  for (const edge of view.edges) {
    dependenciesById.set(edge.to, [...(dependenciesById.get(edge.to) ?? []), edge.from]);
  }

  const nodes: DagFlowNode[] = view.nodes.map((node, index) => ({
    id: node.id,
    type: 'dagNode',
    position: node.position ?? { x: 0, y: index * 100 },
    data: {
      id: node.id,
      label: node.label,
      nodeType: 'prompt',
      ...(node.summary ? { promptText: node.summary } : {}),
      ...(node.harness ? { settings: { harness: node.harness } } : {}),
      depends_on: dependenciesById.get(node.id) ?? [],
    },
  }));

  const edges: Edge[] = view.edges.map(edge => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: 'smoothstep',
  }));

  const everyNodePositioned = view.nodes.every(node => node.position !== undefined);
  if (everyNodePositioned) return { nodes, edges };
  return layoutWithDagre(nodes, edges);
}

/** Mirrors the typed schema's identifier rule so a canvas id can never fail validation. */
export function sanitizeIdentifier(value: string): string {
  const lowered = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const prefixed = /^[a-z]/.test(lowered) ? lowered : `e-${lowered}`;
  return prefixed.slice(0, 64);
}

function nodeHarness(node: DagFlowNode): NodeHarness | undefined {
  const settings = node.data.settings;
  return settings && typeof settings === 'object' ? settings.harness : undefined;
}

/**
 * What the canvas was last seeded with: the host's view AND the exact React
 * Flow projection built from it.
 *
 * Both halves are needed. Node identity and `specDigest` come from the view;
 * POSITIONS must be compared against the projection, because a typed node with
 * no authored position is laid out by dagre — comparing against the absent
 * field would report every auto-laid-out node as "moved" the instant it loads.
 */
export interface HostCanvasBaseline {
  view: HostGraphViewModel;
  nodes: readonly DagFlowNode[];
  edges: readonly Edge[];
}

export function baselineFor(view: HostGraphViewModel): HostCanvasBaseline {
  const projected = viewToFlow(view);
  return { view, nodes: projected.nodes, edges: projected.edges };
}

/**
 * Derive canvas deltas by comparing the current canvas with the baseline the
 * host last pushed. Diffing rather than intercepting each mutation keeps the
 * call sites tiny and covers every path that can change the graph — drag, drop,
 * delete, undo, keyboard — without a hook in each one.
 */
export function diffToDeltas(
  baseline: HostCanvasBaseline,
  nodes: readonly DagFlowNode[],
  edges: readonly Edge[]
): HostCanvasDeltaOp[] {
  const { view } = baseline;
  const ops: HostCanvasDeltaOp[] = [];
  const viewNodesById = new Map(view.nodes.map(node => [node.id, node]));
  const baselinePositionsById = new Map(
    baseline.nodes.map(node => [node.id, node.position] as const)
  );
  const canvasNodeIds = new Set(nodes.map(node => node.id));

  for (const node of nodes) {
    const before = viewNodesById.get(node.id);
    if (!before) {
      ops.push({
        op: 'addNode',
        nodeId: sanitizeIdentifier(node.id),
        name: node.data.label,
        position: { x: node.position.x, y: node.position.y },
        ...(nodeHarness(node) ? { harness: nodeHarness(node)! } : {}),
      });
      continue;
    }
    const previous = baselinePositionsById.get(node.id);
    if (
      previous === undefined ||
      Math.abs(previous.x - node.position.x) > POSITION_EPSILON ||
      Math.abs(previous.y - node.position.y) > POSITION_EPSILON
    ) {
      ops.push({
        op: 'moveNode',
        nodeId: node.id,
        position: { x: node.position.x, y: node.position.y },
        specDigest: before.specDigest,
      });
    }
    if (node.data.label !== before.label) {
      ops.push({
        op: 'renameNode',
        nodeId: node.id,
        name: node.data.label,
        specDigest: before.specDigest,
      });
    }
    const harness = nodeHarness(node);
    if (harness !== before.harness) {
      ops.push({
        op: 'setHarness',
        nodeId: node.id,
        harness: harness ?? null,
        specDigest: before.specDigest,
      });
    }
  }

  for (const node of view.nodes) {
    if (!canvasNodeIds.has(node.id)) ops.push({ op: 'removeNode', nodeId: node.id });
  }

  const viewEdgeIds = new Set(baseline.edges.map(edge => edge.id));
  const canvasEdgeIds = new Set(edges.map(edge => edge.id));
  for (const edge of edges) {
    if (viewEdgeIds.has(edge.id)) continue;
    ops.push({
      op: 'addEdge',
      edgeId: sanitizeIdentifier(edge.id),
      from: edge.source,
      to: edge.target,
    });
  }
  for (const edge of view.edges) {
    if (!canvasEdgeIds.has(edge.id)) ops.push({ op: 'removeEdge', edgeId: edge.id });
  }

  return ops;
}

export interface HostBridgeState {
  /** False everywhere except inside the embedding host — every call site guards on this. */
  hostMode: boolean;
  connected: boolean;
  sourceGroups: HostSourceGroup[];
  /** The view the host most recently pushed; null until it does. */
  view: HostGraphViewModel | null;
  issues: HostIssue[];
  /**
   * An engine-native pipeline the host wants loaded through the builder's own
   * loader. `seq` increments per request so asking for the SAME pipeline twice
   * is still two requests.
   */
  enginePipelineRequest: { id: string; seq: number } | null;
  requestSource: (groupId: string, entryId: string) => void;
  requestSave: () => void;
  /**
   * Declare that the canvas has stopped showing the host's view.
   *
   * Dropping the baseline is the load-bearing half: with no baseline
   * `syncCanvas` derives nothing, so an engine pipeline loaded onto this canvas
   * cannot be diffed against the host's typed document and "applied" to it.
   */
  detachCanvas: () => void;
  /**
   * Report the canvas as it now stands. The hook diffs it against the last
   * pushed view, debounces, and posts only real changes.
   */
  syncCanvas: (nodes: readonly DagFlowNode[], edges: readonly Edge[]) => void;
}

export function useHostBridge(): HostBridgeState {
  const { hostMode, hostOrigin } = useMemo(
    () => readHostMode(typeof window === 'undefined' ? '' : window.location.search),
    []
  );

  const [connected, setConnected] = useState(false);
  const [sourceGroups, setSourceGroups] = useState<HostSourceGroup[]>([]);
  const [view, setView] = useState<HostGraphViewModel | null>(null);
  const [issues, setIssues] = useState<HostIssue[]>([]);
  const [enginePipelineRequest, setEnginePipelineRequest] = useState<
    { id: string; seq: number } | null
  >(null);
  const engineRequestSeq = useRef(0);

  const sequence = useRef(0);
  const baselineRef = useRef<HostCanvasBaseline | null>(null);
  const pendingSync = useRef<ReturnType<typeof setTimeout> | null>(null);

  const post = useCallback(
    (type: string, payload: unknown): void => {
      if (!hostMode || hostOrigin === null || typeof window === 'undefined') return;
      const parent = window.parent;
      if (!parent || parent === window) return;
      sequence.current += 1;
      const serialized = JSON.stringify({
        v: BUILDER_BRIDGE_VERSION,
        id: `frame-${sequence.current}`,
        type,
        payload,
      });
      if (new TextEncoder().encode(serialized).byteLength > BUILDER_BRIDGE_MAX_PAYLOAD_BYTES) return;
      parent.postMessage(serialized, hostOrigin);
    },
    [hostMode, hostOrigin]
  );

  useEffect(() => {
    if (!hostMode || hostOrigin === null || typeof window === 'undefined') return;
    const onMessage = (event: MessageEvent): void => {
      // Strict both ways: the declared host origin AND the actual parent window.
      if (event.origin !== hostOrigin || event.source !== window.parent) return;
      const envelope = decodeEnvelope(event.data);
      if (envelope === null || !HOST_TO_FRAME_TYPES.has(envelope.type)) return;
      switch (envelope.type) {
        case 'builder.init':
          setConnected(true);
          return;
        case 'builder.setSourceList': {
          const groups = parseSourceGroups(envelope.payload);
          if (groups) setSourceGroups(groups);
          return;
        }
        case 'builder.loadGraph': {
          const next = parseViewModel(envelope.payload);
          if (!next) return;
          // The baseline is refreshed on EVERY pushed view, including the one
          // the host sends back after applying a delta. Without that, the next
          // drag would carry a `specDigest` the host has already moved past and
          // be rejected as stale.
          baselineRef.current = baselineFor(next);
          setView(next);
          return;
        }
        case 'builder.setIssues': {
          if (!isRecord(envelope.payload) || !Array.isArray(envelope.payload.issues)) return;
          setIssues(envelope.payload.issues as HostIssue[]);
          return;
        }
        case 'builder.loadEnginePipeline': {
          if (!isRecord(envelope.payload) || typeof envelope.payload.workflowId !== 'string') return;
          engineRequestSeq.current += 1;
          setEnginePipelineRequest({
            id: envelope.payload.workflowId,
            seq: engineRequestSeq.current,
          });
          return;
        }
        default:
          // builder.applyPatch and builder.setMode are reserved by the protocol
          // and not acted on yet; ignoring them keeps additions non-breaking.
          return;
      }
    };
    window.addEventListener('message', onMessage);
    post('builder.ready', { protocolVersion: BUILDER_BRIDGE_VERSION });
    return (): void => {
      window.removeEventListener('message', onMessage);
      if (pendingSync.current !== null) clearTimeout(pendingSync.current);
    };
  }, [hostMode, hostOrigin, post]);

  const requestSource = useCallback(
    (groupId: string, entryId: string): void => {
      post('builder.requestSource', { groupId, entryId });
    },
    [post]
  );

  const requestSave = useCallback((): void => {
    post('builder.requestSave', {});
  }, [post]);

  const detachCanvas = useCallback((): void => {
    if (!hostMode) return;
    if (pendingSync.current !== null) {
      // A delta batch already scheduled against the OLD baseline would still
      // describe the host's document, so it is cancelled rather than allowed
      // to land after the canvas has moved on.
      clearTimeout(pendingSync.current);
      pendingSync.current = null;
    }
    baselineRef.current = null;
    setView(null);
    post('builder.canvasDetached', {});
  }, [hostMode, post]);

  const syncCanvas = useCallback(
    (nodes: readonly DagFlowNode[], edges: readonly Edge[]): void => {
      if (!hostMode) return;
      if (pendingSync.current !== null) clearTimeout(pendingSync.current);
      pendingSync.current = setTimeout(() => {
        pendingSync.current = null;
        const current = baselineRef.current;
        if (!current) return;
        const ops = diffToDeltas(current, nodes, edges);
        if (ops.length === 0) return;
        post('builder.delta', { ops });
      }, DELTA_DEBOUNCE_MS);
    },
    [hostMode, post]
  );

  return {
    hostMode,
    connected,
    sourceGroups,
    view,
    issues,
    enginePipelineRequest,
    requestSource,
    requestSave,
    detachCanvas,
    syncCanvas,
  };
}

/** `<groupId>:<entryId>`, the value the host-fed `<option>` carries. */
export function hostSourceValue(groupId: string, entryId: string): string {
  return `${groupId}:${entryId}`;
}

export function parseHostSourceValue(value: string): { groupId: string; entryId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { groupId: value.slice(0, separator), entryId: value.slice(separator + 1) };
}
