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
  LEAN4_PROOF_EVIDENCE,
  createDefaultWorkflowGraph,
  createKadyPanelFusionConfiguration,
  exactKadyCurrentModel,
} from "./dag-workflow-builder";
import { createScientificWorkflowTemplateNodes } from "./workflow-library-template-builder";

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
      "Research the task, compare two independent modeling paths, convene a council, and require evidence before reporting.",
    category: "ml",
    domain: "Machine Learning & AI",
  },
  {
    id: "reproducible-data-analysis",
    suggestedWorkflowId: "reproducible-data-analysis",
    name: "Reproducible Data Analysis",
    description:
      "Scope the data, compare two analysis paths, fuse independent reviews, and verify support before reporting.",
    category: "data",
    domain: "Data & Analysis",
  },
  {
    id: "byom-dag-fusion-mathematical-research",
    suggestedWorkflowId: "byom-dag-fusion-mathematical-research",
    name: "Mathematical Research with Lean 4",
    description:
      "Research a mathematical claim, compare two formalization paths, machine-check the selected theorem with Lean 4 and Mathlib, and gate the final report on observed support.",
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
      goal: "Define a supported machine-learning problem statement and evaluation plan.",
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
      goal: "Propose two independently reasoned modeling and feature-engineering paths, then select the stronger supported path.",
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
      goal: "Reach a transparent recommendation on the selected modeling path and preserve material objections.",
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
      id: "evidence-check",
      name: "Evidence Gate",
      description: "Stop unsupported conclusions and invoke workflow rescue when needed.",
      kind: "evidence-gate",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      checks: ["citations", "claim-support", "unsupported-output"],
      artifactIds: [],
      evaluator: exactKadyCurrentModel(),
      onUnsupportedOutput: "rescue",
    },
    {
      id: "final-recommendation",
      name: "Final Model Recommendation",
      description: "Report the supported recommendation, validation plan, and unresolved uncertainty.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1360, y: 120 },
      prompt: "Produce the final machine-learning recommendation using only evidence that passed the gate. Include validation steps, limitations, and preserved council dissent.",
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
      prompt: "Inspect the available project context and define a reproducible analysis plan, including missing-data checks, assumptions, and suitable evaluation criteria.",
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
      goal: "Generate two reproducible analysis paths with explicit assumptions, diagnostics, and failure conditions, then choose the stronger supported path.",
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
      goal: "Fuse methodological and domain reviews of the selected analysis path into one traceable recommendation.",
      fusion: createKadyPanelFusionConfiguration(),
      preserveMinorityReports: true,
    },
    {
      id: "evidence-check",
      name: "Evidence Gate",
      description: "Require supported claims before a final analysis is reported.",
      kind: "evidence-gate",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      checks: ["citations", "claim-support", "unsupported-output"],
      artifactIds: [],
      evaluator: exactKadyCurrentModel(),
      onUnsupportedOutput: "rescue",
    },
    {
      id: "final-analysis",
      name: "Report Supported Analysis",
      description: "Summarize the method, findings, diagnostics, and remaining uncertainty.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1360, y: 120 },
      prompt: "Report only the analysis supported by the evidence gate. Include assumptions, diagnostics, reproducibility steps, limitations, and any unresolved disagreement.",
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
      goal: "State a precise mathematical claim with explicit assumptions and enough evidence to formalize it.",
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
      goal: "Produce two independent Lean 4 formalization strategies, compare their assumptions and Mathlib dependencies, and select the best-supported path.",
      candidateCount: 2,
      model: exactKadyCurrentModel(),
      evaluator: exactKadyCurrentModel(),
    },
    {
      id: "lean-proof",
      name: "Lean 4 Proof",
      description: "Use byom-dag-fusion to propose a proof body for an exact host-owned proposition, then machine-check it.",
      kind: "lean4",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 720, y: 120 },
      goal: "Translate the selected formalization into Lean 4 and accept it only after the trusted local verifier succeeds.",
      theorem: "∀ n : Nat, n + 0 = n",
      mode: "solve",
      solverModel: exactKadyCurrentModel(),
      mathlib: true,
      skill: "byom-dag-fusion",
      evidence: { ...LEAN4_PROOF_EVIDENCE },
    },
    {
      id: "mathematical-evidence-check",
      name: "Mathematical Evidence Gate",
      description: "Check that the verified formal statement supports the researched claim without hiding translation gaps.",
      kind: "evidence-gate",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      checks: ["citations", "claim-support", "unsupported-output"],
      artifactIds: [],
      evaluator: exactKadyCurrentModel(),
      onUnsupportedOutput: "rescue",
    },
    {
      id: "report-mathematical-result",
      name: "Report the Verified Result",
      description: "Separate the machine-checked theorem from the broader research claim and remaining uncertainty.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1360, y: 120 },
      prompt: "Report the mathematical result using only evidence that passed the gate. State exactly what Lean checked, all assumptions and Mathlib dependencies, any gap between the formal theorem and the research claim, citations, and unresolved uncertainty.",
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
      condition: "evidence-supported",
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
    entryNodeId: nodes[0].id,
    nodes,
    edges: sequentialEdges(nodes.map((node) => node.id)),
  };
}
