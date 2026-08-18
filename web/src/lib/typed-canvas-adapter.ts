// danbot-byok — web/src/lib/typed-canvas-adapter.ts
//
// The host side of the canvas-as-projection model.
//
// The vendored builder emits DELTAS (`moveNode`, `addEdge`, …) against the
// GraphViewModel it was given. This module applies them to the authoritative
// typed `WorkflowGraphDocument` the Kady host holds. Because the canvas never
// hands back a document, every typed field it was never shown — skills,
// databases, subagents, autonomy, model auth, prompts, retries, provenance,
// unknown keys — survives an edit untouched by construction.
//
// It also owns the client half of the graph hash. `canonicalDocumentJson`
// mirrors the SERVER's canonicalizer (server/src/workflows/store.ts
// `canonicalize`) byte-for-byte: recursive key sort, plain objects only,
// finite numbers only, no `undefined`. `dag-workflows-validate.test.ts` pins
// the two implementations against a shared fixture.

import type {
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeHarness,
  WorkflowNodePosition,
} from "@/lib/dag-workflows";
import {
  typedToView,
  type GraphViewModel,
  type TypedToViewOptions,
} from "@/lib/typed-graph-view";

/** Mirrors `IdentifierSchema` in server/src/workflows/schema.ts. */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]*$/;
const IDENTIFIER_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 256;
const POSITION_LIMIT = 1_000_000;

export type CanvasDeltaOp =
  | {
      op: "moveNode";
      nodeId: string;
      position: WorkflowNodePosition;
      specDigest?: string;
    }
  | { op: "renameNode"; nodeId: string; name: string; specDigest?: string }
  | {
      op: "setHarness";
      nodeId: string;
      harness: WorkflowNodeHarness | null;
      specDigest?: string;
    }
  | {
      op: "addNode";
      nodeId: string;
      name: string;
      prompt?: string;
      position?: WorkflowNodePosition;
      harness?: WorkflowNodeHarness;
    }
  | { op: "removeNode"; nodeId: string }
  | {
      op: "addEdge";
      edgeId: string;
      from: string;
      to: string;
      condition?: WorkflowGraphEdge["condition"];
    }
  | { op: "removeEdge"; edgeId: string };

export type CanvasDeltaRejectionCode =
  | "delta/unknown-op"
  | "delta/unknown-node"
  | "delta/unknown-edge"
  | "delta/duplicate-node"
  | "delta/duplicate-edge"
  | "delta/invalid-id"
  | "delta/invalid-value"
  | "delta/stale-digest"
  | "delta/edge-endpoint-missing"
  | "delta/unrendered-node";

export interface CanvasDeltaRejection {
  op: string;
  code: CanvasDeltaRejectionCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ApplyDeltaResult {
  /** The new document. Referentially identical to the input when nothing applied. */
  document: WorkflowGraphDocument;
  applied: CanvasDeltaOp[];
  rejected: CanvasDeltaRejection[];
  /** The entry node was reassigned because the previous one was removed. */
  entryNodeReassigned: boolean;
}

const HARNESS_VALUES: readonly WorkflowNodeHarness[] = [
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "copilot",
];

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length <= IDENTIFIER_MAX_LENGTH
    && IDENTIFIER_PATTERN.test(value)
  );
}

function isValidCoordinate(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= -POSITION_LIMIT
    && value <= POSITION_LIMIT
  );
}

function isValidPosition(value: unknown): value is WorkflowNodePosition {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isValidCoordinate(candidate.x) && isValidCoordinate(candidate.y);
}

function reject(
  rejections: CanvasDeltaRejection[],
  operation: CanvasDeltaOp | { op: string },
  code: CanvasDeltaRejectionCode,
  message: string,
  identifiers: { nodeId?: string; edgeId?: string } = {},
): void {
  rejections.push({ op: operation.op, code, message, ...identifiers });
}

/**
 * A node created from the canvas. A typed `agent` node is the only kind the
 * canvas can express without an inspector round-trip, so that is what a canvas
 * "add" means; every other kind is authored through the typed surfaces.
 *
 * The workspace is read-only and the model is left unset (the document's
 * `defaultModel` applies), which keeps a canvas-created node inside the same
 * safety envelope as a template-created one.
 */
function createAgentNode(operation: Extract<CanvasDeltaOp, { op: "addNode" }>): WorkflowGraphNode {
  return {
    id: operation.nodeId,
    name: operation.name.slice(0, NAME_MAX_LENGTH),
    kind: "agent",
    terminal: false,
    workspace: { isolation: "read-only", writePaths: [] },
    prompt: operation.prompt?.trim() ? operation.prompt : operation.name,
    ...(operation.position ? { position: { ...operation.position } } : {}),
    ...(operation.harness ? { settings: { harness: operation.harness } } : {}),
  };
}

/**
 * Apply canvas deltas to the authoritative typed document.
 *
 * Every op is validated against the document BEFORE anything is mutated on a
 * clone, and a rejected op never partially applies. Node and edge ORDER is
 * preserved (new entries append), so ids stay stable across an edit session and
 * the canonical hash changes only for the fields that actually changed.
 */
export function applyDelta(
  document: WorkflowGraphDocument,
  ops: readonly CanvasDeltaOp[],
): ApplyDeltaResult {
  const rejected: CanvasDeltaRejection[] = [];
  const applied: CanvasDeltaOp[] = [];
  if (ops.length === 0) {
    return { document, applied, rejected, entryNodeReassigned: false };
  }

  const next = structuredClone(document);
  const nodeIndexById = new Map(next.nodes.map((node, index) => [node.id, index]));
  const edgeIds = new Set(next.edges.map((edge) => edge.id));
  let entryNodeReassigned = false;

  const nodeAt = (
    operation: CanvasDeltaOp & { nodeId: string; specDigest?: string },
  ): WorkflowGraphNode | null => {
    const index = nodeIndexById.get(operation.nodeId);
    if (index === undefined) {
      reject(rejected, operation, "delta/unknown-node", `No such node: ${operation.nodeId}`, {
        nodeId: operation.nodeId,
      });
      return null;
    }
    return next.nodes[index];
  };

  for (const operation of ops) {
    switch (operation.op) {
      case "moveNode": {
        if (!isValidPosition(operation.position)) {
          reject(rejected, operation, "delta/invalid-value", "Position must be finite and within ±1e6.", {
            nodeId: operation.nodeId,
          });
          break;
        }
        const node = nodeAt(operation);
        if (!node) break;
        node.position = { x: operation.position.x, y: operation.position.y };
        applied.push(operation);
        break;
      }
      case "renameNode": {
        if (typeof operation.name !== "string" || operation.name.trim() === "") {
          reject(rejected, operation, "delta/invalid-value", "A node name may not be empty.", {
            nodeId: operation.nodeId,
          });
          break;
        }
        const node = nodeAt(operation);
        if (!node) break;
        node.name = operation.name.slice(0, NAME_MAX_LENGTH);
        applied.push(operation);
        break;
      }
      case "setHarness": {
        if (operation.harness !== null && !HARNESS_VALUES.includes(operation.harness)) {
          reject(rejected, operation, "delta/invalid-value", `Unknown harness: ${String(operation.harness)}`, {
            nodeId: operation.nodeId,
          });
          break;
        }
        const node = nodeAt(operation);
        if (!node) break;
        if (operation.harness === null) {
          if (node.settings) delete node.settings.harness;
        } else {
          node.settings = { ...node.settings, harness: operation.harness };
        }
        applied.push(operation);
        break;
      }
      case "addNode": {
        if (!isValidIdentifier(operation.nodeId)) {
          reject(rejected, operation, "delta/invalid-id", `Not a valid node id: ${String(operation.nodeId)}`, {
            nodeId: operation.nodeId,
          });
          break;
        }
        if (nodeIndexById.has(operation.nodeId)) {
          reject(rejected, operation, "delta/duplicate-node", `Node already exists: ${operation.nodeId}`, {
            nodeId: operation.nodeId,
          });
          break;
        }
        if (typeof operation.name !== "string" || operation.name.trim() === "") {
          reject(rejected, operation, "delta/invalid-value", "A node name may not be empty.", {
            nodeId: operation.nodeId,
          });
          break;
        }
        if (operation.position !== undefined && !isValidPosition(operation.position)) {
          reject(rejected, operation, "delta/invalid-value", "Position must be finite and within ±1e6.", {
            nodeId: operation.nodeId,
          });
          break;
        }
        nodeIndexById.set(operation.nodeId, next.nodes.length);
        next.nodes.push(createAgentNode(operation));
        applied.push(operation);
        break;
      }
      case "removeNode": {
        const index = nodeIndexById.get(operation.nodeId);
        if (index === undefined) {
          reject(rejected, operation, "delta/unknown-node", `No such node: ${operation.nodeId}`, {
            nodeId: operation.nodeId,
          });
          break;
        }
        next.nodes.splice(index, 1);
        nodeIndexById.clear();
        next.nodes.forEach((node, position) => nodeIndexById.set(node.id, position));
        for (const edge of next.edges) {
          if (edge.from === operation.nodeId || edge.to === operation.nodeId) edgeIds.delete(edge.id);
        }
        next.edges = next.edges.filter(
          (edge) => edge.from !== operation.nodeId && edge.to !== operation.nodeId,
        );
        if (next.entryNodeId === operation.nodeId && next.nodes.length > 0) {
          // Deterministic and visible: the first remaining node in document
          // order becomes the entry. Leaving a dangling entry id would make the
          // very next validate fail with an error the author cannot act on.
          next.entryNodeId = next.nodes[0].id;
          entryNodeReassigned = true;
        }
        applied.push(operation);
        break;
      }
      case "addEdge": {
        if (!isValidIdentifier(operation.edgeId)) {
          reject(rejected, operation, "delta/invalid-id", `Not a valid edge id: ${String(operation.edgeId)}`, {
            edgeId: operation.edgeId,
          });
          break;
        }
        if (edgeIds.has(operation.edgeId)) {
          reject(rejected, operation, "delta/duplicate-edge", `Edge already exists: ${operation.edgeId}`, {
            edgeId: operation.edgeId,
          });
          break;
        }
        if (!nodeIndexById.has(operation.from) || !nodeIndexById.has(operation.to)) {
          reject(
            rejected,
            operation,
            "delta/edge-endpoint-missing",
            `Edge ${operation.edgeId} names a node that is not in the document.`,
            { edgeId: operation.edgeId },
          );
          break;
        }
        edgeIds.add(operation.edgeId);
        next.edges.push({
          id: operation.edgeId,
          from: operation.from,
          to: operation.to,
          condition: operation.condition ?? "always",
        });
        applied.push(operation);
        break;
      }
      case "removeEdge": {
        if (!edgeIds.has(operation.edgeId)) {
          reject(rejected, operation, "delta/unknown-edge", `No such edge: ${operation.edgeId}`, {
            edgeId: operation.edgeId,
          });
          break;
        }
        edgeIds.delete(operation.edgeId);
        next.edges = next.edges.filter((edge) => edge.id !== operation.edgeId);
        applied.push(operation);
        break;
      }
      default: {
        const unknown = operation as { op: string };
        reject(rejected, unknown, "delta/unknown-op", `Unsupported canvas delta: ${unknown.op}`);
        break;
      }
    }
  }

  if (applied.length === 0) {
    return { document, applied, rejected, entryNodeReassigned: false };
  }
  return { document: next, applied, rejected, entryNodeReassigned };
}

/**
 * Reject deltas whose `specDigest` no longer describes the host's node.
 *
 * Split out from `applyDelta` so the host can decide what a stale delta means
 * (in R1: drop it and re-push the view) without the adapter guessing.
 */
export function rejectStaleDeltas(
  view: GraphViewModel,
  ops: readonly CanvasDeltaOp[],
): { fresh: CanvasDeltaOp[]; stale: CanvasDeltaRejection[] } {
  const digestByNodeId = new Map(view.nodes.map((node) => [node.id, node.specDigest]));
  const fresh: CanvasDeltaOp[] = [];
  const stale: CanvasDeltaRejection[] = [];
  for (const operation of ops) {
    const digest = "specDigest" in operation ? operation.specDigest : undefined;
    const nodeId = "nodeId" in operation ? operation.nodeId : undefined;
    if (digest === undefined || nodeId === undefined || digestByNodeId.get(nodeId) === digest) {
      fresh.push(operation);
      continue;
    }
    stale.push({
      op: operation.op,
      code: "delta/stale-digest",
      message: `Delta for ${nodeId} was computed against an older projection.`,
      nodeId,
    });
  }
  return { fresh, stale };
}

/** The projection the iframe is given. Named for symmetry with `applyDelta`. */
export function viewFromDoc(
  document: WorkflowGraphDocument,
  options: TypedToViewOptions = {},
): GraphViewModel {
  return typedToView(document, options);
}

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("Document contains a non-finite number.");
    return value;
  }
  if (typeof value !== "object") {
    throw new CanonicalJsonError("Document must contain only JSON values.");
  }
  if (ancestors.has(value)) throw new CanonicalJsonError("Document contains a circular reference.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError("Document must contain plain JSON objects.");
    }
    // A null-prototype accumulator preserves a literal `__proto__` key as data
    // instead of invoking Object.prototype's setter and changing the digest —
    // the server's canonicalizer does the same, and the two must not diverge.
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new CanonicalJsonError(`Document field ${key} is undefined.`);
      output[key] = canonicalize(item, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * RFC-8785-style canonical JSON, byte-identical to the server's.
 *
 * Give it the NORMALIZED document — the one `POST /dag-workflows/validate`
 * returns — because that is what the server hashes. Hashing a pre-normalized
 * draft would produce a different, meaningless value.
 */
export function canonicalDocumentJson(document: WorkflowGraphDocument): string {
  return JSON.stringify(canonicalize(document, new Set<object>()));
}

/**
 * SHA-256 over `canonicalDocumentJson`, matching `graphSha256` on the server.
 *
 * Async because WebCrypto is; the parity fixture in
 * server/test/dag-workflows-validate.test.ts pins this against the real route.
 */
export async function documentGraphSha256(document: WorkflowGraphDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDocumentJson(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
