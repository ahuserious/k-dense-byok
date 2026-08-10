import { describe, expect, it } from "vitest";

import type {
  WorkflowGraphDocument,
  WorkflowModelRequest,
} from "./dag-workflows";
import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
} from "./dag-workflow-templates";

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
  expect(graph.edges.at(-1)?.condition).toBe("evidence-supported");
  expect(nodeById.get(graph.edges.at(-1)!.from)?.kind).toBe("evidence-gate");
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
    "builds $id as a bounded, evidence-gated exact Pi (Kady) DAG",
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
        evidence: { enabled: true, onUnsupportedOutput: "rescue" },
      });
      const deliberationNode = graph.nodes.find((node) =>
        ["best-of-n", "council", "fusion"].includes(node.kind)
      );
      expect(deliberationNode).toBeDefined();
      if (deliberationNode?.kind === "best-of-n") {
        expect(deliberationNode).toMatchObject({ candidateCount: 2 });
      }
      expect(graph.nodes.find((node) => node.kind === "evidence-gate")).toMatchObject({
        terminal: false,
        onUnsupportedOutput: "rescue",
      });
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

  it("ships a bounded byom-dag-fusion research path with trusted Lean verification", () => {
    const graph = createDagWorkflowTemplateGraph(
      "byom-dag-fusion-mathematical-research",
      "mathematical-research",
      "Mathematical research",
    );

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "research-until-goal",
      "best-of-n",
      "lean4",
      "evidence-gate",
      "agent",
    ]);
    expect(graph.nodes.find((node) => node.kind === "lean4")).toMatchObject({
      mode: "solve",
      theorem: "∀ n : Nat, n + 0 = n",
      mathlib: true,
      skill: "byom-dag-fusion",
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: true,
        onUnsupportedOutput: "rescue",
      },
    });
  });
});
