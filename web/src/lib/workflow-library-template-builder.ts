import type {
  ScientificWorkflowTemplateDefinition,
} from "../data/dag-workflow-templates";
import type { WorkflowGraphNode } from "./dag-workflows";
import { exactKadyCurrentModel } from "./dag-workflow-builder";

const READ_ONLY_WORKSPACE = {
  isolation: "read-only" as const,
  writePaths: [] as string[],
};

function readOnlyWorkspace() {
  return { ...READ_ONLY_WORKSPACE, writePaths: [] };
}

function executionBoundary(
  definition: ScientificWorkflowTemplateDefinition,
): string {
  return definition.executionMode === "prompt-analysis-only"
    ? "Runtime boundary: perform prompt-driven analysis, planning, code generation for human review, or interpretation of user-supplied results only. Do not claim to execute training, evaluation, or other compute, and label generated code as unexecuted. "
    : "";
}

function deliberationNode(
  definition: ScientificWorkflowTemplateDefinition,
): WorkflowGraphNode {
  const boundedGoal = `${executionBoundary(definition)}${definition.deliberation.goal}`;
  const common = {
    id: "deliberate",
    name: "Deliberate and Challenge",
    description:
      "Use independent perspectives only where they improve the scientific decision.",
    terminal: false,
    workspace: readOnlyWorkspace(),
    position: { x: 720, y: 120 },
  };

  if (definition.deliberation.kind === "best-of-n") {
    return {
      ...common,
      kind: "best-of-n",
      goal: boundedGoal,
      candidateCount: 2,
      model: exactKadyCurrentModel(),
      evaluator: exactKadyCurrentModel(),
    };
  }

  const members = definition.deliberation.perspectives.map((role, index) => ({
    id: `perspective-${index + 1}`,
    role,
    model: exactKadyCurrentModel(),
  }));

  if (definition.deliberation.kind === "council") {
    return {
      ...common,
      kind: "council",
      goal: boundedGoal,
      members,
      chair: exactKadyCurrentModel(),
      rounds: 2,
      preserveMinorityReports: true,
    };
  }

  return {
    ...common,
    kind: "fusion",
    goal: boundedGoal,
    fusion: {
      mode: "kady-panel",
      members,
      synthesizer: exactKadyCurrentModel(),
      rounds: 1,
    },
    preserveMinorityReports: true,
  };
}

export function createScientificWorkflowTemplateNodes(
  definition: ScientificWorkflowTemplateDefinition,
): WorkflowGraphNode[] {
  const runtimeBoundary = executionBoundary(definition);

  return [
    {
      id: "research",
      name: "Research Inputs and Evidence",
      description:
        "Resolve material inputs and establish traceable evidence before analysis.",
      kind: "research-until-goal",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 80, y: 120 },
      goal: `${runtimeBoundary}${definition.researchGoal}`,
      completionCriteria: [...definition.completionCriteria],
      model: exactKadyCurrentModel(),
      limits: { maxIterations: 6, maxModelCalls: 7, maxSubagents: 4 },
    },
    {
      id: "analyze",
      name: "Perform Domain Analysis",
      description:
        "Apply the source workflow's ordered scientific method and reproducibility controls.",
      kind: "agent",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 400, y: 120 },
      prompt: `${runtimeBoundary}${definition.analysisPrompt}`,
      model: exactKadyCurrentModel(),
    },
    deliberationNode(definition),
    {
      id: "draft-synthesis",
      name: "Synthesize Candidate Result",
      description:
        "Integrate the research, analysis, and preserved deliberation into a result for evidence review.",
      kind: "agent",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      prompt: `${runtimeBoundary}${definition.synthesisPrompt}`,
      model: exactKadyCurrentModel(),
      // Gate this payload in place so the final reporter receives the reviewed
      // synthesis itself rather than a standalone gate node's decision record.
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: false,
        onUnsupportedOutput: "rescue",
        evaluator: exactKadyCurrentModel(),
      },
    },
    {
      id: "final-report",
      name: "Report Supported Result",
      description:
        "Consume the evidence-approved candidate result directly and report only supported conclusions.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1360, y: 120 },
      prompt: `${runtimeBoundary}Use the directly received evidence-approved candidate result as the report's substantive input. Preserve material uncertainty and dissent, distinguish completed work from proposed work, name only verified artifact paths, and state missing inputs and limitations.`,
      model: exactKadyCurrentModel(),
    },
  ];
}
