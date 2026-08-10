import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
} from "../../web/src/lib/dag-workflow-templates.ts";
import {
  SCIENTIFIC_WORKFLOW_TEMPLATES,
} from "../../web/src/data/dag-workflow-templates/index.ts";
import type { WorkflowGraphDocument } from "../src/workflows/schema.ts";
import { buildWorkflowEvidenceSourceCatalog } from "../src/workflows/evidence-policy.ts";
import { validateWorkflowGraphDocument } from "../src/workflows/validate.ts";

function expectFinalNodeConsumesCandidateReasoning(
  graph: WorkflowGraphDocument,
): void {
  const finalNodes = graph.nodes.filter((node) => node.terminal);
  expect(finalNodes).toHaveLength(1);
  const finalNode = finalNodes[0];
  const finalInputEdges = graph.edges.filter((edge) => edge.to === finalNode.id);
  expect(finalInputEdges).toHaveLength(1);
  expect(finalInputEdges[0].condition).toBe("always");

  const candidateReasoningNode = graph.nodes.find(
    (node) => node.id === finalInputEdges[0].from,
  );
  expect(candidateReasoningNode).toBeDefined();
  expect(graph.edges).toContainEqual(expect.objectContaining({
    from: candidateReasoningNode?.id,
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
      expectFinalNodeConsumesCandidateReasoning(validation.document);
    },
  );

  it.each(DAG_WORKFLOW_TEMPLATES)(
    "does not ship an empty-catalog evidence pass in $id",
    (template) => {
      const graph = createDagWorkflowTemplateGraph(
        template.id,
        template.suggestedWorkflowId,
        template.name,
        template.description,
      );
      const observedSourceCatalog = buildWorkflowEvidenceSourceCatalog(undefined, []);
      expect(observedSourceCatalog).toEqual([]);

      const policies = [
        graph.evidence,
        ...graph.nodes.flatMap((node) => node.evidence ? [node.evidence] : []),
      ];
      expect(policies.every((policy) =>
        !policy.enabled || policy.minimumIndependentSources > 0
      )).toBe(true);
      const evaluatorReturnedSupported = true;
      expect(policies.some((policy) =>
        policy.enabled && evaluatorReturnedSupported &&
        observedSourceCatalog.length >= policy.minimumIndependentSources
      )).toBe(false);
    },
  );
});

describe("POST-INTEGRATION(S10)", () => {
  const templatesRequiringFiles = SCIENTIFIC_WORKFLOW_TEMPLATES.filter(
    (template) => template.requiredFiles.length > 0,
  );
  const templatesRequiringVariables = SCIENTIFIC_WORKFLOW_TEMPLATES.filter(
    (template) => template.requiredInputs.length > 0,
  );
  let projectSequence = 0;

  async function expectAdmissionRejected(
    template: (typeof SCIENTIFIC_WORKFLOW_TEMPLATES)[number],
    scenario: "empty-goal" | "missing-file" | "missing-variable",
  ): Promise<void> {
    const [{ buildApp }, { ensureProjectExists, resolvePaths }] = await Promise.all([
      import("../src/index.ts"),
      import("../src/projects.ts"),
    ]);
    projectSequence += 1;
    const projectId = `s10-preconditions-${projectSequence}`;
    ensureProjectExists(projectId);
    const paths = resolvePaths(projectId);
    const app = await buildApp({ workflowController: null });

    try {
      if (scenario !== "missing-file") {
        const minimumFiles = Math.max(
          0,
          ...template.requiredFiles.map((file) => file.minimumCount),
        );
        fs.mkdirSync(paths.uploadDir, { recursive: true });
        for (let index = 0; index < minimumFiles; index += 1) {
          fs.writeFileSync(
            path.join(paths.uploadDir, `input-${index + 1}.dat`),
            "user supplied\n",
          );
        }
      }

      const graph = {
        ...createDagWorkflowTemplateGraph(
          template.id,
          template.suggestedWorkflowId,
          template.name,
          template.description,
        ),
        preconditions: {
          requiredInputs: template.requiredInputs,
          requiredFiles: template.requiredFiles,
          requiredCapabilities: template.requiredCapabilities,
        },
      };
      const saved = await app.inject({
        method: "PUT",
        url: `/dag-workflows/${template.suggestedWorkflowId}`,
        headers: { "x-project-id": projectId },
        payload: graph,
      });
      expect(saved.statusCode).toBe(201);

      const variables = Object.fromEntries(
        template.requiredInputs.map((input) => [input.key, "provided"]),
      );
      if (scenario === "missing-variable" && template.requiredInputs[0]) {
        delete variables[template.requiredInputs[0].key];
      }
      const response = await app.inject({
        method: "POST",
        url: `/dag-workflows/${template.suggestedWorkflowId}/runs`,
        headers: { "x-project-id": projectId },
        payload: {
          requestId: `${scenario}-${template.id}`,
          expectedWorkflowRevision: 1,
          input: {
            goal: scenario === "empty-goal" ? "" : "Bounded analysis goal",
            variables,
          },
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "WORKFLOW_PRECONDITION_FAILED",
      });

      const runs = await app.inject({
        method: "GET",
        url: "/dag-workflow-runs",
        headers: { "x-project-id": projectId },
      });
      expect(runs.json()).toMatchObject({ runs: [] });
    } finally {
      await app.close();
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  }

  it.each(SCIENTIFIC_WORKFLOW_TEMPLATES)(
    "POST rejects an empty goal for $id before createRun",
    (template) => expectAdmissionRejected(template, "empty-goal"),
  );

  it.each(templatesRequiringFiles)(
    "POST rejects a missing required upload for $id before createRun",
    (template) => expectAdmissionRejected(template, "missing-file"),
  );

  it.each(templatesRequiringVariables)(
    "POST rejects a missing required variable for $id before createRun",
    (template) => expectAdmissionRejected(template, "missing-variable"),
  );
});
