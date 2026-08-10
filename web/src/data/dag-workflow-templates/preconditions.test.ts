import { describe, expect, it } from "vitest";

import workflowsData from "../workflows.json";
import {
  SCIENTIFIC_WORKFLOW_TEMPLATES,
  validateScientificWorkflowTemplatePreconditions,
} from ".";

const sourceWorkflowById = new Map(
  workflowsData.map((workflow) => [workflow.id, workflow]),
);
const templatesRequiringFiles = SCIENTIFIC_WORKFLOW_TEMPLATES.filter(
  (template) => template.requiredFiles.length > 0,
);
const templatesRequiringVariables = SCIENTIFIC_WORKFLOW_TEMPLATES.filter(
  (template) => template.requiredInputs.length > 0,
);

function validContext(template: (typeof SCIENTIFIC_WORKFLOW_TEMPLATES)[number]) {
  const minimumFiles = Math.max(
    0,
    ...template.requiredFiles.map((file) => file.minimumCount),
  );
  return {
    goal: "Analyze the supplied material and return a bounded planning result.",
    variables: Object.fromEntries(
      template.requiredInputs.map((input) => [input.key, `provided-${input.key}`]),
    ),
    files: Array.from({ length: minimumFiles }, (_, index) =>
      `user_data/input-${index + 1}.dat`
    ),
    capabilities: ["prompt-analysis", "read-uploaded-files"],
  };
}

describe("Scientific workflow template preconditions (Tier A)", () => {
  it("matches the source inventory and required-precondition counts", () => {
    expect(templatesRequiringFiles).toHaveLength(11);
    expect(templatesRequiringVariables).toHaveLength(14);

    for (const template of SCIENTIFIC_WORKFLOW_TEMPLATES) {
      const source = sourceWorkflowById.get(template.sourceWorkflowId);
      expect(source, template.sourceWorkflowId).toBeDefined();
      expect(template.requiredInputs.map((input) => input.key)).toEqual(
        source!.placeholders
          .filter((placeholder) => placeholder.required)
          .map((placeholder) => placeholder.key),
      );
      expect(template.requiredFiles.length > 0).toBe(source!.requiresFiles);
      expect(template.requiredCapabilities).toContain("prompt-analysis");
      expect((template.requiredCapabilities as readonly string[]).includes("read-uploaded-files")).toBe(
        source!.requiresFiles,
      );
    }
  });

  it.each(SCIENTIFIC_WORKFLOW_TEMPLATES)(
    "rejects an empty goal for $id",
    (template) => {
      const issues = validateScientificWorkflowTemplatePreconditions(template, {
        ...validContext(template),
        goal: "  ",
      });
      expect(issues).toContainEqual(expect.objectContaining({ kind: "goal", key: "goal" }));
    },
  );

  it.each(templatesRequiringFiles)(
    "rejects missing uploaded files for $id",
    (template) => {
      const issues = validateScientificWorkflowTemplatePreconditions(template, {
        ...validContext(template),
        files: [],
      });
      expect(issues).toContainEqual(expect.objectContaining({ kind: "file" }));
    },
  );

  it.each(templatesRequiringVariables)(
    "rejects a missing required variable for $id",
    (template) => {
      const missingInput = template.requiredInputs[0]!;
      const context = validContext(template);
      const issues = validateScientificWorkflowTemplatePreconditions(template, {
        ...context,
        variables: { ...context.variables, [missingInput.key]: "" },
      });
      expect(issues).toContainEqual(expect.objectContaining({
        kind: "variable",
        key: missingInput.key,
      }));
    },
  );

  it.each(SCIENTIFIC_WORKFLOW_TEMPLATES)(
    "accepts all declared preconditions for $id",
    (template) => {
      expect(
        validateScientificWorkflowTemplatePreconditions(template, validContext(template)),
      ).toEqual([]);
    },
  );
});
