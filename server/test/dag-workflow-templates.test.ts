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

  it("returns the original run on an exact lost-response retry without re-validating changed preconditions", async () => {
    const [{ buildApp }, { ensureProjectExists, resolvePaths }] = await Promise.all([
      import("../src/index.ts"),
      import("../src/projects.ts"),
    ]);
    projectSequence += 1;
    const projectId = `s10-preconditions-${projectSequence}`;
    ensureProjectExists(projectId);
    const paths = resolvePaths(projectId);
    const app = await buildApp({ workflowController: null });
    const template = SCIENTIFIC_WORKFLOW_TEMPLATES[0];
    const templateGraph = createDagWorkflowTemplateGraph(
      template.id,
      template.suggestedWorkflowId,
      template.name,
      template.description,
    );
    const { preconditions: _initialPreconditions, ...graph } = templateGraph;
    const requestPayload = {
      requestId: "lost-response-retry",
      expectedWorkflowRevision: 1,
      input: { goal: "Original admitted goal", variables: {} },
    };

    try {
      const saved = await app.inject({
        method: "PUT",
        url: `/dag-workflows/${graph.id}`,
        headers: { "x-project-id": projectId },
        payload: graph,
      });
      expect(saved.statusCode).toBe(201);

      const first = await app.inject({
        method: "POST",
        url: `/dag-workflows/${graph.id}/runs`,
        headers: { "x-project-id": projectId },
        payload: requestPayload,
      });
      expect(first.statusCode).toBe(202);

      const changedGraph = {
        ...graph,
        name: "Changed after admission",
        preconditions: {
          requiredInputs: [{ key: "new_required_value", label: "New required value" }],
          requiredFiles: [],
          requiredCapabilities: [],
        },
      };
      const changed = await app.inject({
        method: "PUT",
        url: `/dag-workflows/${graph.id}`,
        headers: {
          "x-project-id": projectId,
          "if-match": "1",
        },
        payload: changedGraph,
      });
      expect(changed.statusCode).toBe(200);

      const retry = await app.inject({
        method: "POST",
        url: `/dag-workflows/${graph.id}/runs`,
        headers: { "x-project-id": projectId },
        payload: requestPayload,
      });
      expect(retry.statusCode).toBe(202);
      expect(retry.json().manifest).toEqual(first.json().manifest);
      expect(retry.json().manifest).toMatchObject({
        workflowRevision: 1,
        graph: { name: graph.name },
      });
    } finally {
      await app.close();
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("serializes a definition update with run admission so no run validates an old graph then snapshots the new graph", async () => {
    const [{ WorkflowStore, WorkflowPreconditionError }, { ensureProjectExists, resolvePaths }] = await Promise.all([
      import("../src/workflows/store.ts"),
      import("../src/projects.ts"),
    ]);
    projectSequence += 1;
    const projectId = `s10-preconditions-${projectSequence}`;
    ensureProjectExists(projectId);
    const paths = resolvePaths(projectId);
    const store = new WorkflowStore();
    const template = SCIENTIFIC_WORKFLOW_TEMPLATES[0];
    const generatedOldGraph = createDagWorkflowTemplateGraph(
      template.id,
      template.suggestedWorkflowId,
      "Old admissible graph",
      template.description,
    );
    const { preconditions: _oldPreconditions, ...oldGraph } = generatedOldGraph;
    const newGraph = {
      ...oldGraph,
      name: "New guarded graph",
      preconditions: {
        requiredInputs: [{ key: "new_required_value", label: "New required value" }],
        requiredFiles: [],
        requiredCapabilities: [],
      },
    };
    store.saveDefinition(projectId, oldGraph.id, oldGraph);

    try {
      const update = Promise.resolve().then(() =>
        store.saveDefinition(projectId, oldGraph.id, newGraph, { expectedRevision: 1 })
      );
      const admission = Promise.resolve().then(() => {
        try {
          return store.createRun(projectId, {
            workflowId: oldGraph.id,
            requestId: "definition-admission-race",
            requestedBy: "user",
            input: { goal: "Goal valid only for the old graph", variables: {} },
          });
        } catch (error) {
          if (error instanceof WorkflowPreconditionError) return error;
          throw error;
        }
      });
      const [, outcome] = await Promise.all([update, admission]);

      if (outcome instanceof WorkflowPreconditionError) {
        expect(outcome.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "variable", key: "new_required_value" }),
        ]));
      } else {
        expect(outcome).toMatchObject({
          workflowRevision: 1,
          graph: { name: "Old admissible graph" },
        });
      }
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });
});
