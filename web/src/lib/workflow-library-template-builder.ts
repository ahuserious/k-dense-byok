import type {
  ScientificWorkflowTemplateDefinition,
} from "../data/dag-workflow-templates";
import type { WorkflowGraphNode } from "./dag-workflows";
import { exactKadyCurrentModel } from "./dag-workflow-builder";

const READ_ONLY_WORKSPACE = {
  isolation: "read-only" as const,
  writePaths: [] as string[],
};

export const PROMPT_ANALYSIS_ONLY_BOUNDARY =
  "Runtime boundary: this workflow performs prompt-only model reasoning over user-provided text and readable project files. It has no web, computation, database, or file-writing capability. Treat calculations, source searches, code, and deliverables as proposed analysis steps only; never claim that work ran or that an artifact exists. ";

export function promptAnalysisOnlyInstruction(instruction: string): string {
  return `${PROMPT_ANALYSIS_ONLY_BOUNDARY}${instruction}`;
}

function readOnlyWorkspace() {
  return { ...READ_ONLY_WORKSPACE, writePaths: [] };
}

function deliberationNode(
  definition: ScientificWorkflowTemplateDefinition,
): WorkflowGraphNode {
  const boundedGoal = promptAnalysisOnlyInstruction(definition.deliberation.goal);
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
  return [
    {
      id: "research",
      name: "Review Provided Context",
      description:
        "Inventory user-provided material and identify missing context before analysis planning.",
      kind: "research-until-goal",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 80, y: 120 },
      goal: promptAnalysisOnlyInstruction(definition.researchGoal),
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
      prompt: promptAnalysisOnlyInstruction(definition.analysisPrompt),
      model: exactKadyCurrentModel(),
    },
    deliberationNode(definition),
    {
      id: "draft-synthesis",
      name: "Synthesize Candidate Result",
      description:
        "Integrate provided context, model reasoning, and preserved deliberation into an analysis draft.",
      kind: "agent",
      terminal: false,
      workspace: readOnlyWorkspace(),
      position: { x: 1040, y: 120 },
      prompt: promptAnalysisOnlyInstruction(definition.synthesisPrompt),
      model: exactKadyCurrentModel(),
    },
    {
      id: "final-report",
      name: "Report Analysis Plan",
      description:
        "Report model reasoning as analysis or planning, clearly separated from observed results.",
      kind: "agent",
      terminal: true,
      workspace: readOnlyWorkspace(),
      position: { x: 1360, y: 120 },
      prompt: promptAnalysisOnlyInstruction(
        "Use the directly received candidate reasoning as the report input. Preserve material uncertainty and dissent, distinguish user-provided observations from proposed work, do not claim external verification or created artifacts, and state missing inputs and limitations.",
      ),
      model: exactKadyCurrentModel(),
    },
  ];
}
