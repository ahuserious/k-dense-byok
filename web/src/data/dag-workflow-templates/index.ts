import { FINANCE_WORKFLOW_TEMPLATES } from "./finance";
import { LITERATURE_WORKFLOW_TEMPLATES } from "./literature";
import { MACHINE_LEARNING_WORKFLOW_TEMPLATES } from "./machine-learning";

import type { ScientificWorkflowTemplateDefinition } from "./types";
export { validateScientificWorkflowTemplatePreconditions } from "./types";

export const SCIENTIFIC_WORKFLOW_TEMPLATES = [
  ...FINANCE_WORKFLOW_TEMPLATES,
  ...MACHINE_LEARNING_WORKFLOW_TEMPLATES,
  ...LITERATURE_WORKFLOW_TEMPLATES,
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];

export type ScientificWorkflowTemplate =
  (typeof SCIENTIFIC_WORKFLOW_TEMPLATES)[number];

export type {
  ScientificWorkflowDeliberation,
  ScientificWorkflowPreconditionContext,
  ScientificWorkflowPreconditionIssue,
  ScientificWorkflowPreconditions,
  ScientificWorkflowRequiredCapability,
  ScientificWorkflowRequiredFile,
  ScientificWorkflowRequiredInput,
  ScientificWorkflowTemplateCategory,
  ScientificWorkflowTemplateDefinition,
  ScientificWorkflowTemplateDomain,
} from "./types";
