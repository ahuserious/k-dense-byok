import type {
  FixedRequestedModel,
  WorkflowEdgeCondition,
  WorkflowEvidencePolicy,
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowModelRequest,
  WorkflowNodePosition,
  WorkflowRequestedModel,
  WorkflowRescuePolicy,
} from "@/lib/dag-workflows";

export const WORKFLOW_NODE_KINDS = [
  "agent",
  "research-until-goal",
  "council",
  "fusion",
  "best-of-n",
  "evidence-gate",
  "lean4",
] as const satisfies readonly WorkflowGraphNode["kind"][];

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const WORKFLOW_EDGE_CONDITIONS = [
  "always",
  "success",
  "failure",
  "evidence-supported",
  "evidence-unsupported",
] as const satisfies readonly WorkflowEdgeCondition[];

export const DEFAULT_WORKFLOW_RESCUE: WorkflowRescuePolicy = {
  enabled: true,
  maxAttempts: 2,
  triggers: [
    "failure",
    "stalled",
    "unsupported-output",
    "pre-compaction",
    "post-compaction",
  ],
};

export const DEFAULT_WORKFLOW_EVIDENCE: WorkflowEvidencePolicy = {
  enabled: true,
  minimumIndependentSources: 2,
  requireArtifactReferences: false,
  onUnsupportedOutput: "rescue",
};

export const LEAN4_PROOF_EVIDENCE: WorkflowEvidencePolicy = {
  enabled: true,
  minimumIndependentSources: 0,
  requireArtifactReferences: true,
  onUnsupportedOutput: "rescue",
};

const READ_ONLY_WORKSPACE = {
  isolation: "read-only" as const,
  writePaths: [] as string[],
};

export function cloneWorkflowGraph(
  graph: WorkflowGraphDocument,
): WorkflowGraphDocument {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraphDocument;
}

export function exactKadyCurrentModel(
  reasoning: WorkflowRequestedModel["reasoning"] = "high",
): WorkflowModelRequest {
  return {
    requested: {
      source: "kady-current",
      auth: { kind: "kady-current" },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

export function exactFixedModel(
  provider: string,
  model: string,
  authKind: FixedRequestedModel["auth"]["kind"],
  reasoning: FixedRequestedModel["reasoning"] = "high",
): WorkflowModelRequest {
  return {
    requested: {
      source: "fixed",
      provider,
      model,
      auth: { kind: authKind },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

export function fallbackAlternativeFor(
  requested: WorkflowRequestedModel,
  index = 0,
): WorkflowRequestedModel {
  if (requested.source === "kady-current") {
    return {
      source: "fixed",
      provider: "openrouter",
      model: index === 0 ? "anthropic/claude-sonnet-4" : `fallback/model-${index + 1}`,
      auth: { kind: "api-key" },
      reasoning: requested.reasoning,
    };
  }
  if (index === 0) {
    return {
      source: "kady-current",
      auth: { kind: "kady-current" },
      reasoning: requested.reasoning,
    };
  }
  return {
    source: "fixed",
    provider: "openrouter",
    model: `fallback/model-${index + 1}`,
    auth: { kind: "api-key" },
    reasoning: requested.reasoning,
  };
}

export function workflowNodePosition(
  node: WorkflowGraphNode,
  index: number,
): WorkflowNodePosition {
  return node.position ?? {
    x: 80 + (index % 3) * 320,
    y: 80 + Math.floor(index / 3) * 260,
  };
}

export function createDefaultWorkflowNode(
  kind: WorkflowNodeKind,
  id: string,
  position: WorkflowNodePosition,
): WorkflowGraphNode {
  const common = {
    id,
    name: nodeKindLabel(kind),
    terminal: true,
    workspace: { ...READ_ONLY_WORKSPACE, writePaths: [] },
    position,
  };

  switch (kind) {
    case "agent":
      return { ...common, kind, prompt: "Complete this workflow step." };
    case "research-until-goal":
      return {
        ...common,
        kind,
        goal: "Research until the stated goal is supported.",
        completionCriteria: ["The goal is supported by independent evidence."],
        limits: { maxIterations: 8, maxSubagents: 4 },
      };
    case "council":
      return {
        ...common,
        kind,
        goal: "Reach a reasoned council recommendation while preserving dissent.",
        members: [
          { id: "perspective-a", role: "Primary perspective", model: exactKadyCurrentModel() },
          { id: "perspective-b", role: "Critical perspective", model: exactKadyCurrentModel() },
        ],
        chair: exactKadyCurrentModel(),
        rounds: 2,
        preserveMinorityReports: true,
      };
    case "fusion":
      return {
        ...common,
        kind,
        goal: "Fuse independent model analyses without hiding disagreement.",
        fusion: {
          mode: "kady-panel",
          members: [
            { id: "analyst-a", role: "Analyst A", model: exactKadyCurrentModel() },
            { id: "analyst-b", role: "Analyst B", model: exactKadyCurrentModel() },
          ],
          synthesizer: exactKadyCurrentModel(),
          rounds: 1,
        },
        preserveMinorityReports: true,
      };
    case "best-of-n":
      return {
        ...common,
        kind,
        goal: "Generate independent paths and select the strongest supported result.",
        candidateCount: 2,
      };
    case "evidence-gate":
      return {
        ...common,
        kind,
        terminal: false,
        checks: ["citations", "claim-support", "unsupported-output"],
        artifactIds: [],
        onUnsupportedOutput: "rescue",
      };
    case "lean4":
      return {
        ...common,
        kind,
        goal: "Machine-check the mathematical claim.",
        theorem: "theorem kady_example : 1 + 1 = 2 := by norm_num",
        mode: "verify",
        mathlib: true,
        skill: "byom-dag-fusion",
        evidence: { ...LEAN4_PROOF_EVIDENCE },
      };
  }
}

export function createOpenRouterFusionConfiguration() {
  return {
    mode: "openrouter-router" as const,
    router: exactFixedModel("openrouter", "openrouter/fusion", "api-key"),
    members: [
      {
        id: "panel-a",
        role: "Panel A",
        model: exactFixedModel(
          "openrouter",
          "anthropic/claude-sonnet-4",
          "api-key",
        ),
      },
      {
        id: "panel-b",
        role: "Panel B",
        model: exactFixedModel("openrouter", "openai/gpt-5", "api-key"),
      },
    ],
    judge: exactFixedModel(
      "openrouter",
      "anthropic/claude-opus-4",
      "api-key",
    ),
  };
}

export function createKadyPanelFusionConfiguration() {
  return {
    mode: "kady-panel" as const,
    members: [
      { id: "analyst-a", role: "Analyst A", model: exactKadyCurrentModel() },
      { id: "analyst-b", role: "Analyst B", model: exactKadyCurrentModel() },
    ],
    synthesizer: exactKadyCurrentModel(),
    rounds: 1,
  };
}

export function createDefaultWorkflowGraph(
  id: string,
  name: string,
  description?: string,
): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name,
    ...(description?.trim() ? { description: description.trim() } : {}),
    entryNodeId: "start",
    defaultModel: exactKadyCurrentModel(),
    limits: {
      maxIterations: 20,
      maxModelCalls: 80,
      maxParallelism: 4,
      maxSubagents: 8,
      timeoutMs: 600_000,
      maxTokens: 1_000_000,
      maxCostUsd: 50,
      maxRetries: 2,
    },
    rescue: { ...DEFAULT_WORKFLOW_RESCUE, triggers: [...DEFAULT_WORKFLOW_RESCUE.triggers] },
    evidence: { ...DEFAULT_WORKFLOW_EVIDENCE },
    artifacts: [],
    nodes: [
      {
        id: "start",
        name: "Start",
        kind: "agent",
        terminal: true,
        workspace: { ...READ_ONLY_WORKSPACE, writePaths: [] },
        position: { x: 80, y: 100 },
        prompt: "Complete the workflow goal using the configured evidence policy.",
      },
    ],
    edges: [],
  };
}

export function isWorkflowIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

export function nodeKindLabel(kind: WorkflowNodeKind): string {
  switch (kind) {
    case "agent": return "Agent";
    case "research-until-goal": return "Research Until Goal";
    case "council": return "Council";
    case "fusion": return "Fusion";
    case "best-of-n": return "Best of N";
    case "evidence-gate": return "Evidence Gate";
    case "lean4": return "Lean 4";
  }
}

export function nextNodeId(
  graph: WorkflowGraphDocument,
  kind: WorkflowNodeKind,
): string {
  const stem = kind === "research-until-goal"
    ? "research"
    : kind === "evidence-gate"
      ? "gate"
      : kind === "best-of-n"
        ? "best"
        : kind;
  const existing = new Set(graph.nodes.map((node) => node.id));
  if (!existing.has(stem)) return stem;
  for (let suffix = 2; suffix <= 10_000; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate another ${kind} node id.`);
}

export function addDefaultNode(
  graph: WorkflowGraphDocument,
  kind: WorkflowNodeKind,
): { graph: WorkflowGraphDocument; nodeId: string } {
  if (graph.nodes.length >= 256) {
    throw new Error("A workflow may contain at most 256 nodes.");
  }
  const nodeId = nextNodeId(graph, kind);
  const index = graph.nodes.length;
  const position = {
    x: 80 + (index % 3) * 320,
    y: 80 + Math.floor(index / 3) * 260,
  };
  return {
    graph: { ...graph, nodes: [...graph.nodes, createDefaultWorkflowNode(kind, nodeId, position)] },
    nodeId,
  };
}

export function updateNodePosition(
  graph: WorkflowGraphDocument,
  nodeId: string,
  position: WorkflowNodePosition,
): WorkflowGraphDocument {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (
      node.id === nodeId ? { ...node, position: { ...position } } : node
    )),
  };
}

export function replaceWorkflowNode(
  graph: WorkflowGraphDocument,
  replacement: WorkflowGraphNode,
): WorkflowGraphDocument {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === replacement.id ? replacement : node),
  };
}

export function allowedConditionsForSource(
  source: WorkflowGraphNode,
  workflowEvidence?: WorkflowGraphDocument["evidence"],
): WorkflowEdgeCondition[] {
  const evidencePolicy = source.evidence ?? workflowEvidence;
  const usesEvidenceRoutes = source.kind === "evidence-gate" || (
    evidencePolicy?.enabled === true && evidencePolicy.onUnsupportedOutput === "route"
  );
  return usesEvidenceRoutes
    ? ["evidence-supported", "evidence-unsupported"]
    : ["always", "success", "failure"];
}

function graphCanReach(
  graph: WorkflowGraphDocument,
  from: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function validateNewEdge(
  graph: WorkflowGraphDocument,
  edge: Omit<WorkflowGraphEdge, "id">,
): string | null {
  const source = graph.nodes.find((node) => node.id === edge.from);
  const target = graph.nodes.find((node) => node.id === edge.to);
  if (!source) return "Select an existing source node.";
  if (!target) return "Select an existing target node.";
  if (source.id === target.id) return "A workflow node cannot connect to itself.";
  if (source.terminal) return "Clear Terminal on the source node before adding an outgoing edge.";
  if (target.id === graph.entryNodeId) return "The entry node cannot have an incoming edge.";
  const condition = edge.condition ?? "always";
  const evidencePolicy = source.evidence ?? graph.evidence;
  const usesEvidenceRoutes = source.kind === "evidence-gate" || (
    evidencePolicy.enabled && evidencePolicy.onUnsupportedOutput === "route"
  );
  if (!allowedConditionsForSource(source, graph.evidence).includes(condition)) {
    return usesEvidenceRoutes
      ? "Evidence-routed nodes require an evidence-supported or evidence-unsupported edge."
      : "Only evidence-routed nodes may use evidence edge conditions.";
  }
  if (
    usesEvidenceRoutes &&
    condition === "evidence-unsupported" &&
    (source.kind === "evidence-gate"
      ? source.onUnsupportedOutput !== "route"
      : evidencePolicy.onUnsupportedOutput !== "route")
  ) {
    return "Set the node's unsupported-output policy to route before adding this edge.";
  }
  if (!usesEvidenceRoutes) {
    const outgoingConditions = graph.edges
      .filter((candidate) => candidate.from === source.id)
      .map((candidate) => candidate.condition ?? "always");
    const addingAlways = condition === "always";
    const hasAlways = outgoingConditions.includes("always");
    const hasOutcomeRoute = outgoingConditions.some(
      (candidate) => candidate === "success" || candidate === "failure",
    );
    if ((addingAlways && hasOutcomeRoute) || (!addingAlways && hasAlways)) {
      return "Use unconditional fan-out or success/failure routes from a node, not both.";
    }
  }
  if (graph.edges.some((candidate) => (
    candidate.from === edge.from &&
    candidate.to === edge.to &&
    (candidate.condition ?? "always") === condition
  ))) {
    return "That source, target, and condition already exist.";
  }
  if (graphCanReach(graph, edge.to, edge.from)) {
    return "That edge would create a cycle in the outer workflow graph.";
  }
  if (graph.edges.length >= 1_024) {
    return "A workflow may contain at most 1,024 edges.";
  }
  return null;
}

function nextEdgeId(graph: WorkflowGraphDocument): string {
  const existing = new Set(graph.edges.map((edge) => edge.id));
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = `edge-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate another edge id.");
}

export function addWorkflowEdge(
  graph: WorkflowGraphDocument,
  edge: Omit<WorkflowGraphEdge, "id">,
): { graph: WorkflowGraphDocument; error: string | null } {
  const error = validateNewEdge(graph, edge);
  if (error) return { graph, error };
  return {
    graph: {
      ...graph,
      edges: [...graph.edges, { id: nextEdgeId(graph), ...edge }],
    },
    error: null,
  };
}

export function removeWorkflowEdge(
  graph: WorkflowGraphDocument,
  edgeId: string,
): WorkflowGraphDocument {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

export function nodeRemovalBlocker(
  graph: WorkflowGraphDocument,
  nodeId: string,
): string | null {
  if (!graph.nodes.some((node) => node.id === nodeId)) {
    return "The selected node no longer exists in this workflow snapshot.";
  }
  if (graph.nodes.length <= 1) return "A workflow must retain at least one node.";
  if (graph.entryNodeId === nodeId) return "Choose a different entry node before removing this node.";
  if (graph.edges.some((edge) => edge.from === nodeId || edge.to === nodeId)) {
    return "Remove every incoming and outgoing edge before removing this node.";
  }
  if ((graph.artifacts ?? []).some((artifact) => artifact.writerNodeId === nodeId)) {
    return "Reassign or remove artifacts written by this node before removing it.";
  }
  return null;
}

export function removeWorkflowNode(
  graph: WorkflowGraphDocument,
  nodeId: string,
): { graph: WorkflowGraphDocument; error: string | null } {
  const error = nodeRemovalBlocker(graph, nodeId);
  if (error) return { graph, error };
  return {
    graph: { ...graph, nodes: graph.nodes.filter((node) => node.id !== nodeId) },
    error: null,
  };
}

export function requestedModelSummary(model: WorkflowRequestedModel): string {
  if (model.source === "kady-current") {
    return `Pi (Kady) current · ${model.auth.kind} · ${model.reasoning}`;
  }
  const profile = model.auth.profile ? `:${model.auth.profile}` : "";
  return `${model.provider}/${model.model} · ${model.auth.kind}${profile} · ${model.reasoning}`;
}

export function modelRequestSummary(request: WorkflowModelRequest): string {
  const requested = requestedModelSummary(request.requested);
  if (request.resolution.mode === "exact") return `${requested} · exact`;
  return `${requested} · explicit fallback (${request.resolution.alternatives.length})`;
}
