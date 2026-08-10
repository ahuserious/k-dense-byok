export type ScientificWorkflowTemplateCategory =
  | "finance"
  | "ml"
  | "literature";

export type ScientificWorkflowTemplateDomain =
  | "Finance & Economics"
  | "Machine Learning & AI"
  | "Literature & Research";

export type ScientificWorkflowRequiredCapability =
  | "prompt-analysis"
  | "read-uploaded-files";

export interface ScientificWorkflowRequiredInput {
  key: string;
  label: string;
}

export interface ScientificWorkflowRequiredFile {
  key: string;
  label: string;
  minimumCount: number;
}

export interface ScientificWorkflowPreconditions {
  requiredInputs: readonly ScientificWorkflowRequiredInput[];
  requiredFiles: readonly ScientificWorkflowRequiredFile[];
  requiredCapabilities: readonly ScientificWorkflowRequiredCapability[];
}

export interface ScientificWorkflowPreconditionContext {
  goal?: unknown;
  variables?: Readonly<Record<string, unknown>>;
  files?: Readonly<Record<string, readonly string[]>>;
  capabilities?: readonly string[];
}

export interface ScientificWorkflowPreconditionIssue {
  kind: "goal" | "variable" | "file" | "capability";
  key: string;
  message: string;
}

export type ScientificWorkflowDeliberation =
  | {
      kind: "best-of-n";
      goal: string;
    }
  | {
      kind: "council" | "fusion";
      goal: string;
      perspectives: readonly [string, string, ...string[]];
    };

export interface ScientificWorkflowTemplateDefinition
  extends ScientificWorkflowPreconditions {
  id: string;
  sourceWorkflowId: string;
  suggestedWorkflowId: string;
  name: string;
  description: string;
  category: ScientificWorkflowTemplateCategory;
  domain: ScientificWorkflowTemplateDomain;
  researchGoal: string;
  completionCriteria: readonly [string, string, ...string[]];
  analysisPrompt: string;
  deliberation: ScientificWorkflowDeliberation;
  synthesisPrompt: string;
}

function hasRequiredValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

export function validateScientificWorkflowTemplatePreconditions(
  preconditions: ScientificWorkflowPreconditions,
  context: ScientificWorkflowPreconditionContext,
): ScientificWorkflowPreconditionIssue[] {
  const issues: ScientificWorkflowPreconditionIssue[] = [];
  if (!hasRequiredValue(context.goal)) {
    issues.push({ kind: "goal", key: "goal", message: "A non-empty analysis goal is required." });
  }

  for (const input of preconditions.requiredInputs) {
    if (!hasRequiredValue(context.variables?.[input.key])) {
      issues.push({
        kind: "variable",
        key: input.key,
        message: `${input.label} is required.`,
      });
    }
  }

  for (const file of preconditions.requiredFiles) {
    const readableFiles = (context.files?.[file.key] ?? []).filter(
      (path) => path.trim().length > 0,
    );
    if (readableFiles.length < file.minimumCount) {
      issues.push({ kind: "file", key: file.key, message: `${file.label} is required.` });
    }
  }

  const availableCapabilities = new Set(context.capabilities ?? []);
  for (const capability of preconditions.requiredCapabilities) {
    if (!availableCapabilities.has(capability)) {
      issues.push({
        kind: "capability",
        key: capability,
        message: `Required runtime capability is unavailable: ${capability}.`,
      });
    }
  }
  return issues;
}
