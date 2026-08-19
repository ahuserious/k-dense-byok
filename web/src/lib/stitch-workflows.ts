// danbot-byok — web/src/lib/stitch-workflows.ts
//
// Row 22: stitch two or more saved workflows into ONE typed workflow whose
// phases execute in order.
//
// WHY THIS IS A FLATTEN AND NOT A REFERENCE, which is the whole design.
// `meta.compositeOf` is the repo's existing — and only — composition
// provenance field (server/src/workflows/schema.ts:346-361). Its own doc
// comment says what it is for:
//
//     Additive, optional, and deliberately outside validation semantics:
//     nothing in validate.ts branches on it, and it exists so an imported or
//     stitched-in node can name its source WITHOUT THE EXECUTOR EVER
//     CONSULTING IT.
//
// and it is named "Flatten provenance for a node that arrived as part of a
// stitched subgraph". So the field RECORDS that a flatten happened; it does not
// instruct anything to resolve. That is not a limitation to route around — it
// is the contract, and it decides the shape of this module:
//
//   * the ORDERING is real, and it is carried by real EDGES — phase N's former
//     terminal nodes gain outgoing edges into phase N+1's entry node, so the
//     ordinary DAG scheduler runs the phases in sequence with no new concept;
//   * the PROVENANCE is carried by `meta.compositeOf` + `provenance`, pinned to
//     the exact source revision by `sourceGraphSha256`, so a stitched node can
//     always name the workflow and revision it came from.
//
// Nothing here invents a field and nothing here needs a schema change. The
// composed document is an ordinary `WorkflowGraphDocument` that the existing
// `POST /dag-workflows/validate` accepts and the existing runner executes.
//
// THE VALIDATOR RULES THIS FUNCTION IS WRITTEN AGAINST (server/src/workflows/
// validate.ts — read, not assumed). Getting any of these wrong produces a
// document the server refuses, so they are listed with their line numbers:
//
//   :1537 entry node must exist            :1609 entry node has no incoming edge
//   :1620 every node reachable from entry  :1775 the graph is acyclic
//   :1812 a terminal node has NO outgoing edges
//   :1821 a sink node MUST be marked terminal
//   :1826 at least one terminal node       :1839 every node reaches a terminal
//   :1650/:1657 a NONTERMINAL node needs a success+failure pair or one
//         unconditional route, and :1641 forbids mixing the two styles
//   :1703-1745 an EVIDENCE-ROUTED node routes with evidence-supported /
//         evidence-unsupported instead, and :1688 forbids `always` on one
//   :241  every artifact's writerNodeId must name a node that exists
//   :1567 (from, to, condition) must be unique
//
// The consequence that is easy to miss: phase N's terminals STOP being
// terminal. They gain an outgoing edge, so :1812 would reject them, and once
// nonterminal they fall under :1650/:1657 and need a route condition of the
// right family. `bridgeEdgesFrom` below is exactly that rule.

import type {
  WorkflowEvidencePolicy,
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowGraphNode,
} from "@/lib/dag-workflows";

/** Identifier bound from `IdentifierSchema` — `^[a-z][a-z0-9_-]*$`, 1..64. */
const MAX_IDENTIFIER_LENGTH = 64;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * `compositeOf.kind` and `provenance.source` for a stitched-in node.
 *
 * The literal is NOT chosen here: `web/src/lib/typed-canvas-adapter.fixture.ts:95`
 * already models a composed node as
 * `compositeOf: { kind: "dag-workflow", sourceId: … }` with a matching
 * `provenance: { source: "dag-workflow", id: … }`. Matching that fixture keeps
 * one vocabulary in the tree instead of two.
 */
export const STITCH_COMPOSITE_KIND = "dag-workflow";

export interface StitchPhaseInput {
  /** The saved workflow being stitched in, exactly as the server returned it. */
  document: WorkflowGraphDocument;
  /** The saved workflow's id — what `compositeOf.sourceId` records. */
  sourceId: string;
  /**
   * The exact revision's graph hash, when known. Recorded as
   * `compositeOf.sourceGraphSha256` so a stitched node names not just its
   * source workflow but the precise revision it was taken from. Omitted rather
   * than faked when the caller does not have it — the field is optional and a
   * wrong hash is worse than an absent one.
   */
  graphSha256?: string | undefined;
  /** Human label for the phase; defaults to the source document's name. */
  label?: string | undefined;
  /**
   * Identifier prefix for this phase's nodes, edges and artifacts. Defaults to
   * `p<n>-`.
   *
   * An explicit `""` keeps the phase's ids EXACTLY as they were, which is what
   * "add this saved workflow onto the workflow I am already editing" needs: the
   * document already on the canvas must not have every node id rewritten each
   * time another phase is appended, or a second append would produce
   * `p1-p1-head` and the author's node references would churn for no reason.
   */
  idPrefix?: string | undefined;
}

export interface StitchedPhaseReport {
  sourceId: string;
  label: string;
  /** Prefix applied to every id this phase contributed. */
  prefix: string;
  /** The phase's entry node id IN THE COMPOSED DOCUMENT. */
  entryNodeId: string;
  /** Every node id this phase contributed, composed-document ids, in order. */
  nodeIds: string[];
  /**
   * The phase's terminal nodes BEFORE stitching — composed-document ids.
   * For every phase but the last these were demoted to nonterminal and are the
   * nodes that hand over to the next phase. This is the list a Gate B check
   * asserts against: each of these must reach `node_succeeded` before any node
   * of the following phase reaches `node_started`.
   */
  handoverNodeIds: string[];
}

export interface StitchResult {
  document: WorkflowGraphDocument;
  phases: StitchedPhaseReport[];
}

export class StitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StitchError";
  }
}

/** `node.evidence ?? graph.evidence` — mirrors `effectiveWorkflowEvidencePolicy`. */
function effectiveEvidencePolicy(
  document: WorkflowGraphDocument,
  node: WorkflowGraphNode,
): WorkflowEvidencePolicy {
  return node.evidence ?? document.evidence;
}

/** Mirrors validate.ts `usesEvidenceRoutes` (:1693-1701). */
function usesEvidenceRoutes(
  document: WorkflowGraphDocument,
  node: WorkflowGraphNode,
): boolean {
  if (node.kind === "evidence-gate") return true;
  const policy = effectiveEvidencePolicy(document, node);
  return policy.enabled && policy.onUnsupportedOutput === "route";
}

/**
 * Namespace one identifier into the composed document.
 *
 * Truncates rather than overflowing: `IdentifierSchema` caps at 64 characters,
 * and a prefixed id that runs past it produces a document the server refuses
 * with a message about the id, which reads like a bug in the user's workflow
 * rather than in the stitch. `taken` guarantees uniqueness after truncation —
 * two long ids that share a 64-character prefix would otherwise collide
 * silently and merge two distinct nodes into one.
 */
function namespacedId(prefix: string, original: string, taken: Set<string>): string {
  let candidate = `${prefix}${original}`;
  if (candidate.length > MAX_IDENTIFIER_LENGTH) {
    candidate = candidate.slice(0, MAX_IDENTIFIER_LENGTH);
  }
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tail = `-${String(suffix)}`;
    const head = candidate.slice(0, MAX_IDENTIFIER_LENGTH - tail.length);
    const disambiguated = `${head}${tail}`;
    if (!taken.has(disambiguated)) {
      taken.add(disambiguated);
      return disambiguated;
    }
  }
  throw new StitchError(`Could not find a free identifier for ${original}.`);
}

/**
 * The handover edges out of one of phase N's former terminal nodes.
 *
 * The condition family is not a style choice — it is what validate.ts accepts
 * for that node:
 *   * an evidence-routed node MUST use `evidence-supported`, and additionally
 *     `evidence-unsupported` when its policy routes unsupported output
 *     (:1717-1735); `always` on such a node is rejected outright (:1688).
 *   * every other nonterminal node is satisfied by a single unconditional
 *     route (:1644 `if (alwaysCount > 0) continue;`).
 *
 * Routing BOTH evidence outcomes into the next phase is deliberate: a stitch
 * says "run phase 2 after phase 1", not "run phase 2 only if phase 1 liked its
 * evidence". Dropping the unsupported branch would silently strand the run.
 */
function bridgeEdgesFrom(
  sourceDocument: WorkflowGraphDocument,
  sourceNode: WorkflowGraphNode,
  fromId: string,
  toId: string,
  edgeIds: Set<string>,
): WorkflowGraphEdge[] {
  const makeId = (hint: string) => namespacedId("", hint, edgeIds);

  if (!usesEvidenceRoutes(sourceDocument, sourceNode)) {
    return [{ id: makeId(`stitch-${fromId}-to-${toId}`), from: fromId, to: toId, condition: "always" }];
  }

  const edges: WorkflowGraphEdge[] = [
    {
      id: makeId(`stitch-ok-${fromId}-to-${toId}`),
      from: fromId,
      to: toId,
      condition: "evidence-supported",
    },
  ];
  const onUnsupportedOutput = sourceNode.kind === "evidence-gate"
    ? sourceNode.onUnsupportedOutput
    : effectiveEvidencePolicy(sourceDocument, sourceNode).onUnsupportedOutput;
  // :1745 rejects an unsupported edge when the policy does NOT route, so this
  // edge is conditional on the policy rather than always emitted.
  if (onUnsupportedOutput === "route") {
    edges.push({
      id: makeId(`stitch-no-${fromId}-to-${toId}`),
      from: fromId,
      to: toId,
      condition: "evidence-unsupported",
    });
  }
  return edges;
}

export interface StitchOptions {
  /** Id of the composed workflow. Must satisfy `IdentifierSchema`. */
  id: string;
  /** Name of the composed workflow. */
  name: string;
  description?: string | undefined;
}

/**
 * Compose `phases` into one workflow that runs them in order.
 *
 * Phase 0 supplies the composed document's `limits`, `evidence`, `rescue`,
 * `defaultModel` and `preconditions`. That is a decision, not an oversight, and
 * it is recorded in docs/adr/F6-stitch-model.md: these are WORKFLOW-WIDE
 * settings with no meaningful merge (two different `limits` objects cannot both
 * hold), and merging `preconditions` across phases would produce duplicate
 * keys, which validate.ts:302 rejects. Per-node `limits`, `rescue` and
 * `evidence` travel with their own nodes and are untouched, so a phase that
 * configured a node keeps that configuration.
 */
export function stitchWorkflows(
  phases: readonly StitchPhaseInput[],
  options: StitchOptions,
): StitchResult {
  if (phases.length < 2) {
    throw new StitchError("A stitch needs at least two workflows.");
  }
  if (!IDENTIFIER_PATTERN.test(options.id) || options.id.length > MAX_IDENTIFIER_LENGTH) {
    throw new StitchError(
      `The composed workflow id must be lower-case, start with a letter, and be at most ${String(MAX_IDENTIFIER_LENGTH)} characters.`,
    );
  }

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const artifactIds = new Set<string>();

  const composedNodes: WorkflowGraphNode[] = [];
  const composedEdges: WorkflowGraphEdge[] = [];
  const composedArtifacts: WorkflowGraphDocument["artifacts"] = [];
  const reports: StitchedPhaseReport[] = [];

  for (const [phaseIndex, phase] of phases.entries()) {
    const prefix = phase.idPrefix ?? `p${String(phaseIndex + 1)}-`;
    const label = phase.label ?? phase.document.name;
    const idMap = new Map<string, string>();

    for (const node of phase.document.nodes) {
      idMap.set(node.id, namespacedId(prefix, node.id, nodeIds));
    }

    const phaseEntryId = idMap.get(phase.document.entryNodeId);
    if (phaseEntryId === undefined) {
      throw new StitchError(
        `Workflow ${phase.sourceId} names entry node ${phase.document.entryNodeId}, which it does not contain.`,
      );
    }

    // A node is a HANDOVER node when it is terminal in its own phase. It is
    // demoted below for every phase except the last, because a terminal node
    // may not have outgoing edges (validate.ts:1812).
    const handoverNodeIds: string[] = [];
    const isLastPhase = phaseIndex === phases.length - 1;

    for (const node of phase.document.nodes) {
      const composedId = idMap.get(node.id)!;
      if (node.terminal) handoverNodeIds.push(composedId);

      composedNodes.push({
        ...node,
        id: composedId,
        terminal: node.terminal && isLastPhase,
        meta: {
          ...node.meta,
          compositeOf: {
            kind: STITCH_COMPOSITE_KIND,
            sourceId: phase.sourceId,
            ...(phase.graphSha256 ? { sourceGraphSha256: phase.graphSha256 } : {}),
            label,
          },
        },
        // `provenance` mirrors `compositeOf` because the fixture at
        // typed-canvas-adapter.fixture.ts:95-101 carries both for a composed
        // node. An existing `provenance` is NOT overwritten: a node that
        // already named an outside origin keeps saying so.
        provenance: node.provenance ?? {
          source: STITCH_COMPOSITE_KIND,
          id: phase.sourceId,
          ...(phase.graphSha256 ? { sha256: phase.graphSha256 } : {}),
        },
      } as WorkflowGraphNode);
    }

    for (const edge of phase.document.edges) {
      const from = idMap.get(edge.from);
      const to = idMap.get(edge.to);
      if (from === undefined || to === undefined) {
        throw new StitchError(
          `Workflow ${phase.sourceId} has edge ${edge.id} pointing at a node it does not contain.`,
        );
      }
      composedEdges.push({
        ...edge,
        id: namespacedId(prefix, edge.id, edgeIds),
        from,
        to,
      });
    }

    for (const artifact of phase.document.artifacts ?? []) {
      const writerNodeId = idMap.get(artifact.writerNodeId);
      if (writerNodeId === undefined) {
        throw new StitchError(
          `Workflow ${phase.sourceId} has artifact ${artifact.id} written by a node it does not contain.`,
        );
      }
      composedArtifacts.push({
        ...artifact,
        id: namespacedId(prefix, artifact.id, artifactIds),
        writerNodeId,
      });
    }

    reports.push({
      sourceId: phase.sourceId,
      label,
      prefix,
      entryNodeId: phaseEntryId,
      nodeIds: phase.document.nodes.map((node) => idMap.get(node.id)!),
      handoverNodeIds,
    });
  }

  // Phase N's former terminals hand over to phase N+1's entry. This is the
  // ONLY thing that makes the composition ordered, and it is ordinary DAG
  // topology — no new scheduler concept, nothing for the executor to learn.
  for (const [phaseIndex, phase] of phases.entries()) {
    if (phaseIndex === phases.length - 1) break;
    const report = reports[phaseIndex]!;
    const nextEntryId = reports[phaseIndex + 1]!.entryNodeId;
    const sourceNodeByComposedId = new Map(
      phase.document.nodes.map((node, index) => [report.nodeIds[index]!, node] as const),
    );
    if (report.handoverNodeIds.length === 0) {
      throw new StitchError(
        `Workflow ${phase.sourceId} has no terminal node, so nothing can hand over to the next phase.`,
      );
    }
    for (const handoverId of report.handoverNodeIds) {
      const sourceNode = sourceNodeByComposedId.get(handoverId)!;
      composedEdges.push(
        ...bridgeEdgesFrom(phase.document, sourceNode, handoverId, nextEntryId, edgeIds),
      );
    }
  }

  const first = phases[0]!.document;
  const document: WorkflowGraphDocument = {
    schemaVersion: "1.0",
    id: options.id,
    name: options.name,
    ...(options.description ? { description: options.description } : {}),
    entryNodeId: reports[0]!.entryNodeId,
    ...(first.defaultModel ? { defaultModel: first.defaultModel } : {}),
    limits: first.limits,
    ...(first.rescue ? { rescue: first.rescue } : {}),
    evidence: first.evidence,
    ...(composedArtifacts.length > 0 ? { artifacts: composedArtifacts } : {}),
    ...(first.preconditions ? { preconditions: first.preconditions } : {}),
    nodes: composedNodes,
    edges: composedEdges,
  };
  return { document, phases: reports };
}

/**
 * The phase each node of a composed document belongs to, read back out of
 * `meta.compositeOf`.
 *
 * This is the reading half of the write above, and it is what proves the
 * provenance is load-bearing rather than decorative: a composed document that
 * has been saved and re-read still says which workflow every node came from.
 */
export function readStitchPhases(
  document: WorkflowGraphDocument,
): { sourceId: string; label: string; nodeIds: string[] }[] {
  const order: string[] = [];
  const bySource = new Map<string, { sourceId: string; label: string; nodeIds: string[] }>();
  for (const node of document.nodes) {
    const composite = node.meta?.compositeOf;
    if (!composite) continue;
    const existing = bySource.get(composite.sourceId);
    if (existing) {
      existing.nodeIds.push(node.id);
      continue;
    }
    order.push(composite.sourceId);
    bySource.set(composite.sourceId, {
      sourceId: composite.sourceId,
      label: composite.label ?? composite.sourceId,
      nodeIds: [node.id],
    });
  }
  return order.map((sourceId) => bySource.get(sourceId)!);
}
