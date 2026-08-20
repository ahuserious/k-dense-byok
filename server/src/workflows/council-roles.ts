import { DEFAULT_SCIENTIST_PERSONAS } from "./reasoning-style.ts";
import type { WorkflowNode } from "./schema.ts";

/** Palette defaults for row 29: 4 heads + 1 judge (chair) + 1 fuser. */
export const DEFAULT_COUNCIL_HEAD_COUNT = 4;
export const DEFAULT_COUNCIL_JUDGE_COUNT = 1;
export const DEFAULT_COUNCIL_FUSER_COUNT = 1;

type CouncilNode = Extract<WorkflowNode, { kind: "council" }>;
type CouncilMember = CouncilNode["members"][number];

export type CouncilHeadSelectionMode = "auto" | "manual";
export type CouncilRosterSource =
  | "authored"
  | "inbound-reasoning-style"
  | "mimeographs"
  | "workflow-type";

export interface CouncilRosterSelection {
  mode: CouncilHeadSelectionMode;
  source: CouncilRosterSource;
  members: CouncilMember[];
  personalityRefs: string[];
}

export interface CouncilRecruitmentObservation {
  recruited: number;
  maxRecruits: number;
  reason?: string;
}

export function councilMaxRecruits(node: Extract<WorkflowNode, { kind: "council" }>): number {
  return node.maxRecruits ?? 0;
}

/**
 * Recruits cannot exceed the authored bound, and that bound cannot exceed the
 * effective maxSubagents the node was admitted under.
 */
export function effectiveCouncilRecruitmentBound(
  node: Extract<WorkflowNode, { kind: "council" }>,
  maxSubagents: number,
): number {
  return Math.min(councilMaxRecruits(node), Math.max(0, maxSubagents));
}

export function councilRecruitmentObservation(
  recruited: number,
  maxRecruits: number,
  reason?: string,
): CouncilRecruitmentObservation {
  const bound = Math.max(0, maxRecruits);
  const count = Math.min(Math.max(0, recruited), bound);
  return reason
    ? { recruited: count, maxRecruits: bound, reason }
    : { recruited: count, maxRecruits: bound };
}

export function inboundReasoningStyleRefs(inbound: readonly { output?: unknown }[]): string[] {
  const refs: string[] = [];
  for (const item of inbound) {
    const output = item.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    const record = output as Record<string, unknown>;
    if (record.kind !== "reasoning-style") continue;
    const list = record.personalityRefs;
    if (!Array.isArray(list)) continue;
    for (const ref of list) {
      if (typeof ref === "string" && ref.length > 0 && !refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
}

function applyPersonaRefsToMembers(
  members: readonly CouncilMember[],
  refs: readonly string[],
): CouncilMember[] {
  return members.map((member, index) => ({
    ...member,
    role: refs[index % refs.length] ?? member.role,
  }));
}

/**
 * Bind `headSelection` to the members that actually run.
 *
 * Omitted `headSelection` stays authored unless a reasoning-style inbound
 * supplies refs (row 35). Explicit `manual` keeps the authored roster even
 * when inbound refs exist. Explicit `auto` picks inbound, then mimeographs,
 * then the 4 workflow-type scientist defaults.
 */
export function selectCouncilHeads(
  node: CouncilNode,
  inboundRefs: readonly string[] = [],
): CouncilRosterSelection {
  const mode: CouncilHeadSelectionMode = node.headSelection ??
    (inboundRefs.length > 0 ? "auto" : "manual");
  switch (mode) {
    case "manual":
      return {
        mode,
        source: "authored",
        members: [...node.members],
        personalityRefs: node.members.map((member) => member.role),
      };
    case "auto": {
      const mimeographRefs = node.settings?.deliberation?.mimeographs?.personalityRefs ?? [];
      const refs = inboundRefs.length > 0
        ? [...inboundRefs]
        : mimeographRefs.length > 0
        ? [...mimeographRefs]
        : [...DEFAULT_SCIENTIST_PERSONAS];
      const source: CouncilRosterSource = inboundRefs.length > 0
        ? "inbound-reasoning-style"
        : mimeographRefs.length > 0
        ? "mimeographs"
        : "workflow-type";
      return {
        mode,
        source,
        members: applyPersonaRefsToMembers(node.members, refs),
        personalityRefs: refs.slice(0, node.members.length),
      };
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled council headSelection ${String(_exhaustive)}.`);
    }
  }
}
