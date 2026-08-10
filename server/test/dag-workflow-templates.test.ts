import { describe, expect, it } from "vitest";

import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
} from "../../web/src/lib/dag-workflow-templates.ts";
import { validateWorkflowGraphDocument } from "../src/workflows/validate.ts";

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
    },
  );
});
