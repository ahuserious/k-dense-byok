import { describe, expect, it } from "vitest";

import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
} from "../../web/src/lib/dag-workflow-templates.ts";
import type { WorkflowGraphDocument } from "../src/workflows/schema.ts";
import { buildWorkflowEvidenceSourceCatalog } from "../src/workflows/evidence-policy.ts";
import { validateWorkflowGraphDocument } from "../src/workflows/validate.ts";

function expectFinalNodeConsumesEvidenceApprovedOutput(
  graph: WorkflowGraphDocument,
): void {
  const finalNodes = graph.nodes.filter((node) => node.terminal);
  expect(finalNodes).toHaveLength(1);
  const finalNode = finalNodes[0];
  const finalInputEdges = graph.edges.filter((edge) => edge.to === finalNode.id);
  expect(finalInputEdges).toHaveLength(1);
  expect(finalInputEdges[0].condition).toBe("always");

  const evidenceReviewedNode = graph.nodes.find(
    (node) => node.id === finalInputEdges[0].from,
  );
  expect(evidenceReviewedNode?.evidence).toMatchObject({
    enabled: true,
    minimumIndependentSources: 0,
    onUnsupportedOutput: "rescue",
  });
  expect(graph.edges).toContainEqual(expect.objectContaining({
    from: evidenceReviewedNode?.id,
    to: finalNode.id,
  }));
}

describe("Scientific DAG workflow template validation", () => {
  it.each(DAG_WORKFLOW_TEMPLATES)(
    "validates $id through validateWorkflowGraphDocument",
    (template) => {
      const graph = createDagWorkflowTemplateGraph(
        template.id,
        template.suggestedWorkflowId,
        template.name,
        template.description,
      );
      const validation = validateWorkflowGraphDocument(graph);

      if (!validation.ok) {
        throw new Error(JSON.stringify(validation.issues, null, 2));
      }
      expect(validation.document).toMatchObject({
        id: template.suggestedWorkflowId,
        name: template.name,
      });
      expectFinalNodeConsumesEvidenceApprovedOutput(validation.document);
    },
  );

  it.each(DAG_WORKFLOW_TEMPLATES)(
    "does not let model-authored source-count text satisfy a numeric gate in $id",
    (template) => {
      const graph = createDagWorkflowTemplateGraph(
        template.id,
        template.suggestedWorkflowId,
        template.name,
        template.description,
      );
      const modelAuthoredCatalog = buildWorkflowEvidenceSourceCatalog(
        { evidence: ["I consulted 99 authenticated sources."] },
        [],
      );
      expect(modelAuthoredCatalog).toHaveLength(1);

      const policies = [
        graph.evidence,
        ...graph.nodes.flatMap((node) => node.evidence ? [node.evidence] : []),
      ];
      expect(policies.every((policy) => policy.minimumIndependentSources === 0)).toBe(true);
      expect(policies.some((policy) =>
        policy.minimumIndependentSources > 0 &&
        modelAuthoredCatalog.length >= policy.minimumIndependentSources
      )).toBe(false);
    },
  );
});
