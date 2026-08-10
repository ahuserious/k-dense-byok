import type {
  WorkflowGraphDocument,
  WorkflowGraphEdge,
  WorkflowGraphNode,
} from "@/lib/dag-workflows";
import {
  SCIENTIFIC_WORKFLOW_TEMPLATES,
  type ScientificWorkflowTemplateCategory,
  type ScientificWorkflowTemplateDomain,
} from "../data/dag-workflow-templates";
import {
  createDefaultWorkflowGraph,
  createKadyPanelFusionConfiguration,
  exactKadyCurrentModel,
} from "./dag-workflow-builder";
import {
  createScientificWorkflowTemplateNodes,
  promptAnalysisOnlyInstruction,
} from "./workflow-library-template-builder";

export type DagWorkflowTemplateCategory =
  | "ml"
  | "data"
  | ScientificWorkflowTemplateCategory;
export type DagWorkflowTemplateDomain =
  | "Machine Learning & AI"
  | "Data & Analysis"
  | ScientificWorkflowTemplateDomain;

export interface DagWorkflowTemplateMetadata {
  id: string;
  suggestedWorkflowId: string;
  name: string;
  description: string;
  category: DagWorkflowTemplateCategory;
  domain: DagWorkflowTemplateDomain;
  sourceWorkflowId?: string;
}

export const DAG_WORKFLOW_TEMPLATES = [
  {
    id: "ml-model-selection-review",
    suggestedWorkflowId: "ml-model-selection-review",
    name: "ML Model Selection Review",
    description:
      "Plan a model-selection analysis, compare two reasoning paths, and preserve a council's limitations and dissent.",
    category: "ml",
    domain: "Machine Learning & AI",
  },
  {
    id: "reproducible-data-analysis",
    suggestedWorkflowId: "reproducible-data-analysis",
    name: "Reproducible Data Analysis",
    description:
      "Plan a reproducible analysis over user-provided material and fuse independent methodological reviews.",
    category: "data",
    domain: "Data & Analysis",
  },
  {
    id: "byom-dag-fusion-mathematical-research",
    suggestedWorkflowId: "byom-dag-fusion-mathematical-research",
    name: "Mathematical Formalization Plan",
    description:
      "Clarify a mathematical claim, compare formalization paths, and draft a Lean-oriented proof plan without claiming verification ran.",
    category: "ml",
    domain: "Machine Learning & AI",
  },
  ...SCIENTIFIC_WORKFLOW_TEMPLATES,
] as const satisfies readonly DagWorkflowTemplateMetadata[];

export type DagWorkflowTemplateId = (typeof DAG_WORKFLOW_TEMPLATES)[number]["id"];
export type DagWorkflowTemplate = (typeof DAG_WORKFLOW_TEMPLATES)[number];

const READ_ONLY_WORKSPACE = {
  isolation: "read-only" as const,
  writePaths: [] as string[],
};

function readOnlyWorkspace() {
  return { ...READ_ONLY_WORKSPACE, writePaths: [] };
}

function mlModelSelectionNodes(): WorkflowGraphNode[] {
  return [
    {
      id: "research-problem",
      name: "Research Problem and Constraints",
      description: "Establish the scientific question, data constraints, and evaluation criteria.",
      kind: "research-until-goal",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 80, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "Define a machine-learning problem statement and evaluation plan from user-provided context.",
      ),
      completionCriteria: [
        "The target, available evidence, and leakage risks are explicit.",
        "Success metrics and validation constraints are justified.",
      ],
      model: exactKadyCurrentModel(),
      limits: { maxIterations: 6, maxModelCalls: 7, maxSubagents: 4 },
    },
    {
      id: "candidate-paths",
      name: "Compare Modeling Paths",
      description: "Generate two independent approaches before evaluating either one.",
      kind: "best-of-n",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 400, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "Propose two independently reasoned modeling and feature-engineering plans, then compare their assumptions.",
      ),
      candidateCount: 2,
      model: exactKadyCurrentModel(),
      evaluator: exactKadyCurrentModel(),
    },
    {
      id: "review-council",
      name: "Model Review Council",
      description: "Stress-test validity, robustness, and scientific usefulness while preserving dissent.",
      kind: "council",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 720, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "Reach a transparent planning recommendation and preserve material objections without claiming model evaluation occurred.",
      ),
      members: [
        {
          id: "methodologist",
          role: "Statistical validity and experimental design",
          model: exactKadyCurrentModel(),
        },
        {
          id: "ml-reviewer",
          role: "Model robustness, leakage, and deployment risk",
          model: exactKadyCurrentModel(),
        },
      ],
      chair: exactKadyCurrentModel(),
      rounds: 2,
      preserveMinorityReports: true,
    },
    {
      id: "final-recommendation",
      name: "Final Model Recommendation",
      description: "Report the supported recommendation, validation plan, and unresolved uncertainty.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      prompt: promptAnalysisOnlyInstruction(
        "Use the directly received council reasoning to produce a model-selection plan for review. Include proposed validation steps, limitations, and preserved dissent.",
      ),
      model: exactKadyCurrentModel(),
    },
  ];
}

function reproducibleDataAnalysisNodes(): WorkflowGraphNode[] {
  return [
    {
      id: "scope-analysis",
      name: "Scope Data and Assumptions",
      description: "Define the question, variables, data quality checks, and statistical assumptions.",
      kind: "agent",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 80, y: 120 },
      prompt: promptAnalysisOnlyInstruction(
        "Review the available project context and define a reproducible analysis plan, including missing-data checks, assumptions, and suitable evaluation criteria.",
      ),
      model: exactKadyCurrentModel(),
    },
    {
      id: "analysis-paths",
      name: "Compare Analysis Paths",
      description: "Develop and evaluate two independent analysis strategies.",
      kind: "best-of-n",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 400, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "Generate two reproducible analysis plans with explicit assumptions, diagnostics, and failure conditions, then compare them.",
      ),
      candidateCount: 2,
      model: exactKadyCurrentModel(),
      evaluator: exactKadyCurrentModel(),
    },
    {
      id: "fuse-reviews",
      name: "Fuse Independent Reviews",
      description: "Combine independent Pi (Kady) reviews without hiding disagreement.",
      kind: "fusion",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 720, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "Fuse methodological and domain reviews of the selected analysis plan into one traceable recommendation.",
      ),
      fusion: createKadyPanelFusionConfiguration(),
      preserveMinorityReports: true,
    },
    {
      id: "final-analysis",
      name: "Report Supported Analysis",
      description: "Summarize the method, findings, diagnostics, and remaining uncertainty.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      prompt: promptAnalysisOnlyInstruction(
        "Use the directly received fused reasoning to report an analysis plan. Include assumptions, proposed diagnostics, reproducibility steps, limitations, and unresolved disagreement.",
      ),
      model: exactKadyCurrentModel(),
    },
  ];
}

function mathematicalResearchNodes(): WorkflowGraphNode[] {
  return [
    {
      id: "research-mathematical-claim",
      name: "Research the Mathematical Claim",
      description: "Establish the claim, definitions, assumptions, and authoritative supporting sources.",
      kind: "research-until-goal",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 80, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "State a precise mathematical claim from user-provided context with explicit assumptions and enough detail to plan a formalization.",
      ),
      completionCriteria: [
        "Every symbol, domain, hypothesis, and target conclusion is explicit.",
        "The informal claim is supported by traceable mathematical sources or a complete derivation.",
        "Known translation gaps between the research claim and a Lean statement are identified.",
      ],
      model: exactKadyCurrentModel(),
      limits: { maxIterations: 6, maxModelCalls: 7, maxSubagents: 4 },
    },
    {
      id: "formalization-paths",
      name: "Compare Formalization Paths",
      description: "Develop two independent routes from the informal claim to a Lean-ready statement.",
      kind: "best-of-n",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 400, y: 120 },
      goal: promptAnalysisOnlyInstruction(
        "Produce two independent Lean 4 formalization strategies, compare their assumptions and possible Mathlib dependencies, and recommend a review path.",
      ),
      candidateCount: 2,
      model: exactKadyCurrentModel(),
      evaluator: exactKadyCurrentModel(),
    },
    {
      id: "formal-proof-plan",
      name: "Lean 4 Proof Plan",
      description: "Draft a Lean-oriented formalization for human review without claiming local verification.",
      kind: "agent",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 720, y: 120 },
      prompt: promptAnalysisOnlyInstruction(
        "Draft a Lean 4 statement and proof strategy for `∀ n : Nat, n + 0 = n`, list possible Mathlib dependencies, and label all code as unverified until a human runs an authorized verifier.",
      ),
      model: exactKadyCurrentModel(),
    },
    {
      id: "report-mathematical-result",
      name: "Report the Proposed Formalization",
      description: "Report the proposed, unverified formalization, its assumptions, and remaining review gaps.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      prompt: promptAnalysisOnlyInstruction(
        "Use the directly received formalization reasoning to report the proposed theorem, assumptions, possible Mathlib dependencies, gaps from the informal claim, and unresolved uncertainty. State explicitly that no Lean verification occurred.",
      ),
      model: exactKadyCurrentModel(),
    },
  ];
}

function sequentialEdges(nodeIds: string[]): WorkflowGraphEdge[] {
  const ordinaryEdges: WorkflowGraphEdge[] = nodeIds.slice(0, -2).map((from, index) => ({
    id: `edge-${index + 1}`,
    from,
    to: nodeIds[index + 1],
    condition: "always",
  }));
  return [
    ...ordinaryEdges,
    {
      id: `edge-${nodeIds.length - 1}`,
      from: nodeIds[nodeIds.length - 2],
      to: nodeIds[nodeIds.length - 1],
      condition: "always",
    },
  ];
}

export function findDagWorkflowTemplate(
  templateId: string,
): DagWorkflowTemplate | undefined {
  return DAG_WORKFLOW_TEMPLATES.find((template) => template.id === templateId);
}

export function createDagWorkflowTemplateGraph(
  templateId: DagWorkflowTemplateId,
  workflowId: string,
  workflowName: string,
  description?: string,
): WorkflowGraphDocument {
  const template = findDagWorkflowTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown DAG workflow template: ${templateId}`);
  }

  const base = createDefaultWorkflowGraph(
    workflowId,
    workflowName,
    description ?? template.description,
  );
  const scientificTemplate = SCIENTIFIC_WORKFLOW_TEMPLATES.find(
    (candidate) => candidate.id === template.id,
  );
  const nodes = scientificTemplate
    ? createScientificWorkflowTemplateNodes(scientificTemplate)
    : template.id === "ml-model-selection-review"
      ? mlModelSelectionNodes()
      : template.id === "reproducible-data-analysis"
        ? reproducibleDataAnalysisNodes()
        : mathematicalResearchNodes();

  return {
    ...base,
    evidence: {
      ...base.evidence,
      enabled: false,
    },
    entryNodeId: nodes[0].id,
    ...(scientificTemplate
      ? {
          preconditions: {
            requiredInputs: scientificTemplate.requiredInputs.map((input) => ({ ...input })),
            requiredFiles: scientificTemplate.requiredFiles.map((file) => ({ ...file })),
            requiredCapabilities: [...scientificTemplate.requiredCapabilities],
          },
        }
      : {}),
    nodes,
    edges: sequentialEdges(nodes.map((node) => node.id)),
  };
}
