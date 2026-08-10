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

function deliberationNode(
  definition: ScientificWorkflowTemplateDefinition,
): WorkflowGraphNode {
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
      goal: definition.deliberation.goal,
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
      goal: definition.deliberation.goal,
      members,
      chair: exactKadyCurrentModel(),
      rounds: 2,
      preserveMinorityReports: true,
    };
  }

  return {
    ...common,
    kind: "fusion",
    goal: definition.deliberation.goal,
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
      goal: definition.researchGoal,
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
      prompt: definition.analysisPrompt,
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
      prompt: definition.synthesisPrompt,
      model: exactKadyCurrentModel(),
    },
    {
      id: "evidence-gate",
      name: "Evidence Gate",
      description:
        "Reject unsupported claims, fabricated references, and unearned completion claims before reporting.",
      kind: "evidence-gate",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 1360, y: 120 },
      checks: ["citations", "claim-support", "unsupported-output"],
      artifactIds: [],
      evaluator: exactKadyCurrentModel(),
      onUnsupportedOutput: "rescue",
    },
    {
      id: "final-report",
      name: "Report Supported Result",
      description:
        "Return only claims and deliverables that survived the evidence gate.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1680, y: 120 },
      prompt:
        "Revise the candidate result using only evidence that passed the gate. Preserve material uncertainty and dissent, distinguish completed work from proposed work, name every verified artifact path, and state missing inputs and limitations.",
      model: exactKadyCurrentModel(),
    },
  ];
}
