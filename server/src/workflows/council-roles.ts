import type { WorkflowNode } from "./schema.ts";

/** Palette defaults for row 29: 4 heads + 1 judge (chair) + 1 fuser. */
export const DEFAULT_COUNCIL_HEAD_COUNT = 4;
export const DEFAULT_COUNCIL_JUDGE_COUNT = 1;
export const DEFAULT_COUNCIL_FUSER_COUNT = 1;

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
