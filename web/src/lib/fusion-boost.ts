// danbot-byok — web/src/lib/fusion-boost.ts
//
// Row 25: "Fusion boost" — a POLICY over the node kinds that already exist, not
// an engine and not a new kind.
//
// `fusion` (server/src/workflows/schema.ts:461) and `council` (:417) already
// execute. Row 25 asks for a toggle plus per-stage checkboxes that cause the
// EXISTING `fusion` kind to be used at the named stages. So this module adds
// nothing to the document vocabulary: it inserts ordinary `fusion` nodes into
// an ordinary `WorkflowGraphDocument`, which the existing validator accepts and
// the existing executor dispatches. There is no schema change here and none is
// needed — which matters, because `schema.ts` is frozen (NodeSpec v1) and every
// object in it is `additionalProperties: false`, so a lane that needed a new
// field would be blocked rather than clever.
//
// THE FOUR STAGES, AND WHY TWO OF THEM ARE DISABLED.
// Row 25 names four stages. Measured against the node kinds that exist in this
// tree — `agent`, `research-until-goal`, `council`, `fusion`, `best-of-n`,
// `evidence-gate`, `lean4` — only two of the four have an underlying kind to
// attach to:
//
//   planning            -> a `fusion` node ahead of the entry node       AVAILABLE
//   verification-gate   -> a `fusion` node after the terminal nodes      AVAILABLE
//   elevation-to-DAG    -> needs an `elevate-to-DAG` kind                ABSENT
//   hypothesis          -> needs a `hypothesis` kind                     ABSENT
//
// The two absent kinds are Team B's lane F5 work and are not in this tree yet.
// Per master brief §3 Gate B and §6.7 the correct outcome for those is a
// checkbox rendered DISABLED WITH THE REASON — not a hidden checkbox, and not a
// live-looking one over a value that would be dropped. `FUSION_BOOST_STAGES`
// below carries that reason as data so the UI cannot forget to show it and the
// two cannot drift apart.

import type {
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowModelRequest,
} from "@/lib/dag-workflows";
import { workflowHandoverConditions } from "./stitch-workflows";

export type FusionBoostStageId =
  | "planning"
  | "elevation-to-dag"
  | "hypothesis"
  | "verification-gate";

export interface FusionBoostStage {
  id: FusionBoostStageId;
  label: string;
  description: string;
  /**
   * Whether the stage can be bound in THIS tree. When false the UI must render
   * the control disabled and show `unavailableReason` — the reason travels with
   * the stage so the control and its explanation cannot drift apart.
   */
  available: boolean;
  unavailableReason?: string;
}

export const FUSION_BOOST_STAGES: readonly FusionBoostStage[] = [
  {
    id: "planning",
    label: "Planning",
    description: "Run a fusion panel before the workflow's first node, and plan from its synthesis.",
    available: true,
  },
  {
    id: "elevation-to-dag",
    label: "Elevation to DAG",
    description: "Run a fusion panel at the point a plan is elevated into a DAG.",
    available: false,
    unavailableReason: "Requires the elevate-to-DAG node kind, landing in lane F5.",
  },
  {
    id: "hypothesis",
    label: "Hypothesis generation, proving and disproving",
    description: "Run a fusion panel over hypothesis generation and its proof attempts.",
    available: false,
    unavailableReason: "Requires the hypothesis node kind, landing in lane F5.",
  },
  {
    id: "verification-gate",
    label: "Verification gate",
    description: "Run a fusion panel over the finished work before the workflow ends.",
    available: true,
  },
];

export type FusionBoostSelection = Partial<Record<FusionBoostStageId, boolean>>;

export interface FusionBoostConfig {
  /** The master toggle. When false NOTHING is inserted, whatever the stages say. */
  enabled: boolean;
  stages: FusionBoostSelection;
}

export const FUSION_BOOST_DEFAULT: FusionBoostConfig = {
  enabled: false,
  stages: {},
};

export interface FusionBoostOptions {
  /**
   * Used when the document has no `defaultModel`. The host supplies
   * `exactKadyCurrentModel()`; keeping it a parameter rather than an import is
   * what lets this module be imported by the server test suite, which has no
   * `@/` path alias.
   */
  fallbackModel?: WorkflowModelRequest | undefined;
}

/** Node ids this module owns. Stable, so a re-apply replaces rather than stacks. */
export const FUSION_BOOST_NODE_IDS: Record<"planning" | "verification-gate", string> = {
  planning: "fusion-boost-planning",
  "verification-gate": "fusion-boost-verification",
};

const FUSION_BOOST_NODE_ID_SET = new Set(Object.values(FUSION_BOOST_NODE_IDS));

export class FusionBoostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionBoostError";
  }
}

export interface FusionBoostResult {
  document: WorkflowGraphDocument;
  /** Stage ids that actually inserted a node, in application order. */
  appliedStages: FusionBoostStageId[];
  /** Node ids inserted, parallel to `appliedStages`. */
  insertedNodeIds: string[];
}

/**
 * `true` when the stage is one this tree can bind. Used by the UI to decide
 * `disabled`, and by `applyFusionBoost` to refuse to act on a stage it cannot
 * honour — so a caller that ignored the UI still cannot produce a document
 * claiming a stage that does not exist.
 */
export function isFusionBoostStageAvailable(stageId: FusionBoostStageId): boolean {
  return FUSION_BOOST_STAGES.find((stage) => stage.id === stageId)?.available === true;
}

export function fusionBoostStage(stageId: FusionBoostStageId): FusionBoostStage {
  const stage = FUSION_BOOST_STAGES.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Unknown fusion-boost stage: ${stageId}`);
  return stage;
}

/**
 * A `kady-panel` fusion node.
 *
 * `kady-panel` rather than `openrouter-router` because the OpenRouter mode
 * needs a router AND a judge model the author has not chosen, whereas the panel
 * mode needs only members and a synthesizer, and #54 records that hosted-Fusion
 * sampling controls are silently dropped on the supervised transport — so
 * routing a boost through the hosted plugin by default would be building on the
 * one part of fusion that is known to lose values.
 *
 * Three members: the schema allows 2..32 (`KadyPanelFusionSchema`), and three
 * is the smallest panel where a synthesizer has a genuine majority to read.
 */
function fusionNode(
  id: string,
  name: string,
  goal: string,
  model: WorkflowModelRequest,
  terminal: boolean,
): WorkflowGraphNode {
  return {
    id,
    name,
    kind: "fusion",
    terminal,
    workspace: { isolation: "read-only", writePaths: [] },
    goal,
    fusion: {
      mode: "kady-panel",
      members: [
        { id: "member-a", role: "First independent reading", model },
        { id: "member-b", role: "Second independent reading", model },
        { id: "member-c", role: "Adversarial reading", model },
      ],
      synthesizer: model,
      rounds: 1,
    },
    preserveMinorityReports: true,
  } as WorkflowGraphNode;
}

/** Strip any node this module previously inserted, and every edge touching it. */
function withoutPreviousBoost(document: WorkflowGraphDocument): WorkflowGraphDocument {
  const removed = document.nodes.filter((node) => FUSION_BOOST_NODE_ID_SET.has(node.id));
  if (removed.length === 0) return document;

  const removedIds = new Set(removed.map((node) => node.id));
  const nodes = document.nodes.filter((node) => !removedIds.has(node.id));
  const edges = document.edges.filter(
    (edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to),
  );

  // Removing the planning node orphans the entry pointer; removing the
  // verification node leaves the demoted former terminals nonterminal with no
  // outgoing edge, which validate.ts:1821 rejects as an unmarked sink. Both are
  // repaired here so that turning the toggle OFF returns the document to a
  // shape the server still accepts.
  const hasOutgoing = new Set(edges.map((edge) => edge.from));
  const repaired = nodes.map((node) =>
    hasOutgoing.has(node.id) ? node : ({ ...node, terminal: true } as WorkflowGraphNode),
  );
  const entryNodeId = removedIds.has(document.entryNodeId)
    ? (document.edges.find((edge) => edge.from === document.entryNodeId)?.to ??
      document.entryNodeId)
    : document.entryNodeId;

  return { ...document, entryNodeId, nodes: repaired, edges };
}

/**
 * Apply the fusion-boost policy to a document.
 *
 * Idempotent: applying twice produces the same document, because a previous
 * boost is stripped first. `enabled: false` therefore genuinely REMOVES the
 * fusion nodes rather than leaving the last ones in place — which is what makes
 * the Gate B claim ("with it off, a fusion call does not run") true of the
 * artefact and not just of the checkbox.
 */
export function applyFusionBoost(
  input: WorkflowGraphDocument,
  config: FusionBoostConfig,
  options: FusionBoostOptions = {},
): FusionBoostResult {
  const base = withoutPreviousBoost(input);
  if (!config.enabled) {
    return { document: base, appliedStages: [], insertedNodeIds: [] };
  }

  // The model is supplied, never invented. A fusion panel is three members plus
  // a synthesizer, and quietly picking a model for four slots the author never
  // chose is the kind of silent decision this wave is auditing. The host passes
  // `exactKadyCurrentModel()`; this module stays free of that dependency so the
  // policy can be tested from the server suite as well as the web one.
  const model = base.defaultModel ?? options.fallbackModel;
  if (!model) {
    throw new FusionBoostError(
      "Fusion boost needs a model: this workflow has no defaultModel and no fallback was supplied.",
    );
  }
  const nodes: WorkflowGraphNode[] = [...base.nodes];
  const edges: WorkflowGraphEdge[] = [...base.edges];
  const appliedStages: FusionBoostStageId[] = [];
  const insertedNodeIds: string[] = [];
  let entryNodeId = base.entryNodeId;

  if (config.stages.planning === true && isFusionBoostStageAvailable("planning")) {
    const id = FUSION_BOOST_NODE_IDS.planning;
    nodes.unshift(
      fusionNode(
        id,
        "Fusion boost — planning",
        "Produce a plan for this workflow's goal. Return the plan, its evidence, and the disagreements the panel did not resolve.",
        model,
        false,
      ),
    );
    // The boost node becomes the entry, so it has no incoming edge
    // (validate.ts:1609) and the old entry keeps exactly one new predecessor.
    edges.push({ id: "fusion-boost-planning-edge", from: id, to: entryNodeId, condition: "always" });
    entryNodeId = id;
    appliedStages.push("planning");
    insertedNodeIds.push(id);
  }

  if (config.stages["verification-gate"] === true && isFusionBoostStageAvailable("verification-gate")) {
    const id = FUSION_BOOST_NODE_IDS["verification-gate"];
    // Every current terminal hands over to the verification panel, and the
    // panel becomes the sole terminal. Same demotion rule as the stitch: a
    // terminal node may not have outgoing edges (validate.ts:1812), and once
    // demoted it needs a condition family valid for that node. Evidence-routed
    // terminals reject `always`, so reuse the stitch's shared rule.
    const terminals = nodes.filter((node) => node.terminal);
    if (terminals.length > 0) {
      for (const [index, terminal] of terminals.entries()) {
        const position = nodes.findIndex((node) => node.id === terminal.id);
        nodes[position] = { ...terminal, terminal: false } as WorkflowGraphNode;
        for (const condition of workflowHandoverConditions(base, terminal)) {
          edges.push({
            id: `fusion-boost-verify-edge-${String(index + 1)}-${condition}`,
            from: terminal.id,
            to: id,
            condition,
          });
        }
      }
      nodes.push(
        fusionNode(
          id,
          "Fusion boost — verification gate",
          "Verify the work this workflow produced. Return whether it holds up, the evidence for that judgement, and any minority report.",
          model,
          true,
        ),
      );
      appliedStages.push("verification-gate");
      insertedNodeIds.push(id);
    }
  }

  return {
    document: { ...base, entryNodeId, nodes, edges },
    appliedStages,
    insertedNodeIds,
  };
}

/**
 * Read the boost back off a document.
 *
 * The UI's checkbox state is derived from the DOCUMENT rather than held beside
 * it, so a saved-and-reloaded workflow shows the boost it actually carries. A
 * checkbox that remembered its own value would be exactly the accepted-then-
 * discarded pattern this wave exists to stop (#54, #55).
 */
export function readFusionBoost(document: WorkflowGraphDocument): FusionBoostConfig {
  const present = new Set(
    document.nodes.filter((node) => FUSION_BOOST_NODE_ID_SET.has(node.id)).map((node) => node.id),
  );
  const stages: FusionBoostSelection = {};
  if (present.has(FUSION_BOOST_NODE_IDS.planning)) stages.planning = true;
  if (present.has(FUSION_BOOST_NODE_IDS["verification-gate"])) stages["verification-gate"] = true;
  return { enabled: present.size > 0, stages };
}
