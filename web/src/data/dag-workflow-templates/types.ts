export type ScientificWorkflowTemplateCategory =
  | "finance"
  | "ml"
  | "literature";

export type ScientificWorkflowTemplateDomain =
  | "Finance & Economics"
  | "Machine Learning & AI"
  | "Literature & Research";

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

export interface ScientificWorkflowTemplateDefinition {
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
  executionMode?: "prompt-analysis-only";
}
