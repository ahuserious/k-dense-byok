import { describe, expect, it } from "vitest";

import type {
  WorkflowGraphDocument,
  WorkflowModelRequest,
} from "./dag-workflows";
import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
} from "./dag-workflow-templates";

const BANNED_UNAVAILABLE_CAPABILITY_VERBS =
  /\b(fetch|download|backtest|train|execute|write-file|query-database)\b/i;

function modelRequests(graph: WorkflowGraphDocument): WorkflowModelRequest[] {
  const requests = graph.defaultModel ? [graph.defaultModel] : [];
  if (graph.evidence.evaluator) requests.push(graph.evidence.evaluator);
  for (const node of graph.nodes) {
    if (node.evidence?.evaluator) requests.push(node.evidence.evaluator);
    if ("model" in node && node.model) requests.push(node.model);
    if (node.kind === "best-of-n") {
      requests.push(...(node.candidateModels ?? []));
      if (node.evaluator) requests.push(node.evaluator);
    } else if (node.kind === "council") {
      requests.push(...node.members.map((member) => member.model), node.chair);
    } else if (node.kind === "fusion") {
      requests.push(...node.fusion.members.map((member) => member.model));
      if (node.fusion.mode === "kady-panel") {
        requests.push(node.fusion.synthesizer);
      } else {
        requests.push(node.fusion.router, node.fusion.judge);
      }
    } else if (node.kind === "evidence-gate" && node.evaluator) {
      requests.push(node.evaluator);
    } else if (node.kind === "lean4" && node.solverModel) {
      requests.push(node.solverModel);
    }
  }
  return requests;
}

function expectValidTemplateTopology(graph: WorkflowGraphDocument) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const pending = [graph.entryNodeId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...graph.edges.filter((edge) => edge.from === current).map((edge) => edge.to));
  }

  expect(nodeById.has(graph.entryNodeId)).toBe(true);
  expect(reachable).toEqual(new Set(graph.nodes.map((node) => node.id)));
  expect(graph.nodes.filter((node) => node.terminal)).toHaveLength(1);
  expect(graph.nodes.at(-1)?.terminal).toBe(true);
  expect(graph.edges).toHaveLength(graph.nodes.length - 1);
  const finalNode = graph.nodes.at(-1)!;
  const finalInputEdges = graph.edges.filter((edge) => edge.to === finalNode.id);
  expect(finalInputEdges).toHaveLength(1);
  expect(finalInputEdges[0].condition).toBe("always");
  const candidateReasoningNode = nodeById.get(finalInputEdges[0].from);
  expect(candidateReasoningNode).toBeDefined();
  expect(reachable.has(candidateReasoningNode!.id)).toBe(true);
  expect(graph.edges.some((edge) =>
    edge.from === candidateReasoningNode!.id && edge.to === finalNode.id
  )).toBe(true);
}

describe("native DAG workflow templates", () => {
  it("publishes explicit K-Dense domain and category metadata", () => {
    expect(DAG_WORKFLOW_TEMPLATES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "ml-model-selection-review",
        category: "ml",
        domain: "Machine Learning & AI",
      }),
      expect.objectContaining({
        id: "reproducible-data-analysis",
        category: "data",
        domain: "Data & Analysis",
      }),
      expect.objectContaining({
        id: "byom-dag-fusion-mathematical-research",
        category: "ml",
        domain: "Machine Learning & AI",
      }),
    ]));
  });

  it("covers twenty source workflows across finance, ML, and literature", () => {
    const sourceTemplates = DAG_WORKFLOW_TEMPLATES.filter(
      (template) => "sourceWorkflowId" in template,
    );
    expect(sourceTemplates).toHaveLength(20);
    expect(
      sourceTemplates.reduce<Record<string, number>>((counts, template) => {
        counts[template.category] = (counts[template.category] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ finance: 6, ml: 7, literature: 7 });
  });

  it.each(DAG_WORKFLOW_TEMPLATES)(
    "builds $id as a bounded prompt-analysis-only exact Pi (Kady) DAG",
    (template) => {
      const graph = createDagWorkflowTemplateGraph(
        template.id,
        "project-workflow",
        "Project workflow",
        "Project-specific description",
      );

      expect(graph).toMatchObject({
        id: "project-workflow",
        name: "Project workflow",
        description: "Project-specific description",
        rescue: { enabled: true, maxAttempts: 2 },
        evidence: { enabled: false },
      });
      const deliberationNode = graph.nodes.find((node) =>
        ["best-of-n", "council", "fusion"].includes(node.kind)
      );
      expect(deliberationNode).toBeDefined();
      if (deliberationNode?.kind === "best-of-n") {
        expect(deliberationNode).toMatchObject({ candidateCount: 2 });
      }
      expect(graph.evidence.minimumIndependentSources).toBeGreaterThan(0);
      expect(graph.nodes.some((node) => node.kind === "evidence-gate")).toBe(false);
      expect(graph.nodes.some((node) => node.evidence?.enabled)).toBe(false);
      for (const node of graph.nodes) {
        if (node.kind === "research-until-goal") {
          expect(node.limits).toMatchObject({
            maxIterations: 6,
            maxModelCalls: 7,
          });
        }
      }
      for (const request of modelRequests(graph)) {
        expect(request).toEqual({
          requested: {
            source: "kady-current",
            auth: { kind: "kady-current" },
            reasoning: "high",
          },
          resolution: { mode: "exact" },
        });
      }
      expectValidTemplateTopology(graph);
    },
  );

  it("uses the template description when no project description is supplied", () => {
    const template = DAG_WORKFLOW_TEMPLATES[0];
    const graph = createDagWorkflowTemplateGraph(
      template.id,
      "default-description",
      "Default description",
    );

    expect(graph.description).toBe(template.description);
  });

  it.each(DAG_WORKFLOW_TEMPLATES)(
    "keeps every $id instruction within prompt-only runtime capabilities",
    (template) => {
      const graph = createDagWorkflowTemplateGraph(
        template.id,
        template.suggestedWorkflowId,
        template.name,
      );
      const modelInstructions = graph.nodes.flatMap((node): string[] => {
        if (node.kind === "agent") return [node.prompt];
        if (
          node.kind === "research-until-goal" ||
          node.kind === "best-of-n" ||
          node.kind === "council" ||
          node.kind === "fusion"
        ) {
          return [node.goal];
        }
        return [];
      });
      expect(modelInstructions).not.toHaveLength(0);
      for (const instruction of modelInstructions) {
        expect(instruction).toContain("Runtime boundary:");
        expect(instruction).toContain("prompt-only model reasoning");
        expect(instruction).not.toMatch(BANNED_UNAVAILABLE_CAPABILITY_VERBS);
      }
    },
  );

  it("ships mathematical formalization as an unverified prompt-analysis plan", () => {
    const graph = createDagWorkflowTemplateGraph(
      "byom-dag-fusion-mathematical-research",
      "mathematical-research",
      "Mathematical research",
    );

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "research-until-goal",
      "best-of-n",
      "agent",
      "agent",
    ]);
    const proofPlan = graph.nodes.find((node) => node.id === "formal-proof-plan");
    expect(proofPlan).toMatchObject({ kind: "agent" });
    if (proofPlan?.kind === "agent") {
      expect(proofPlan.prompt).toContain("unverified until a human runs an authorized verifier");
    }
    expect(graph.nodes.some((node) => node.kind === "lean4")).toBe(false);
  });
});
