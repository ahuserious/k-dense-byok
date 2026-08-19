// danbot-byok — web/src/lib/best-of-n-branches.ts
//
// Row 33: project a real `best-of-n` run into n branches carrying REAL
// per-candidate state.
//
// THE HONEST PART, FIRST, BECAUSE IT SHAPES EVERYTHING BELOW.
// Row 33 asks for "n live PARALLEL branches". The executor is not parallel.
// `server/src/workflows/kady-node-executor.ts:2862-2872`:
//
//     if (node.kind === "best-of-n") {
//       const count = node.candidateCount ?? node.candidateModels?.length ?? 2;
//       const candidates: AnalysisResult[] = [];
//       for (let index = 1; index <= count; index += 1) {
//         candidates.push(await delegate({ slotId: `candidate-${index}`, ...
//
// `await` INSIDE the loop — candidate k+1 is not even declared until candidate
// k has resolved. So this module deliberately does NOT report anything that
// would let a view imply concurrency: `BestOfNBranch.state` is derived per
// candidate from that candidate's own slot, and candidates the run has not
// reached yet report `not-started` rather than `pending`, because "pending"
// reads as "queued alongside the others" and that is not what is happening.
// `SEQUENTIAL_CANDIDATES_NOTICE` is the sentence the UI must show. Changing the
// executor is Orchestrator B's file, requested in W/requests/c-f6-5.md.
//
// WHERE THE STATE ACTUALLY COMES FROM — two sources, because one is not enough:
//
//   * PER-CANDIDATE PROGRESS lives in the run's execution state.
//     `run-state.ts:1648` writes `execution.modelCallSlots[slot.id] = slot` on
//     `model_slot_declared` with NO receipt, and `:1685` sets `slot.receipt` on
//     `model_resolved`. So: absent slot = not started, slot without receipt =
//     in flight, slot with receipt = resolved. That is a real, per-run,
//     observable signal and it is what drives the branches.
//   * THE WINNER AND THE SCORES do NOT reach run state. `WorkflowRunState`
//     (`run-state.ts:216-231`) reduces artifacts, receipts, gate and evidence
//     decisions — there is no generic node-output field. The best-of-n output
//     `{ kind: "best-of-n", winner, scores, ... }` rides on the
//     `node_succeeded` EVENT as `data.output` (`run-state.ts:1770`). So the
//     winner is read from the event log.
//
// A view driven by `candidateCount` alone with no slot data would fail this
// row. `candidateCount` supplies only the branch COUNT — which is legitimately
// topology, n candidates exist by definition — and every branch's STATE is read
// from that branch's own slot.
//
// RESILIENCE (#62). `WorkflowRunState.executions` is typed `Record<string,
// unknown>` on the client (`dag-workflows.ts:365`) — deliberately opaque. Every
// read below is guarded, and a malformed-but-200 body yields an empty
// projection instead of throwing in render phase.

import type {
  WorkflowRunEvent,
  WorkflowRunRecord,
} from "@/lib/dag-workflows";

export const SEQUENTIAL_CANDIDATES_NOTICE =
  "Candidates run one at a time, in order — the executor resolves each before starting the next.";

export type BestOfNBranchState = "not-started" | "in-flight" | "resolved";

export interface BestOfNBranch {
  /** 1-based, matching the executor's `candidate-${index}`. */
  index: number;
  slotId: string;
  state: BestOfNBranchState;
  /** True only once an evaluator has actually named this candidate. */
  winner: boolean;
  /** The evaluator's score, when it has produced one. */
  score?: number;
}

export interface BestOfNProjection {
  nodeId: string;
  nodeName: string;
  candidateCount: number;
  branches: BestOfNBranch[];
  evaluator: { slotId: string; state: BestOfNBranchState };
  /** Present once the evaluator has chosen. 1-based. */
  winnerIndex?: number;
  /** The evaluator's stated reason, when the run produced one. */
  rationale?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The candidate count the EXECUTOR will use.
 *
 * Mirrors `kady-node-executor.ts:2863` exactly — `candidateCount ??
 * candidateModels?.length ?? 2`. Reading only `candidateCount` would draw the
 * wrong number of branches for a node that configured `candidateModels`
 * instead, and the drawing would look authoritative while being wrong.
 */
export function candidateCountForNode(node: unknown): number {
  if (!isRecord(node)) return 0;
  const declared = node.candidateCount;
  if (typeof declared === "number" && Number.isInteger(declared) && declared >= 2) {
    return declared;
  }
  const models = node.candidateModels;
  if (Array.isArray(models) && models.length >= 2) return models.length;
  return 2;
}

/** The slot map for the execution of `nodeId`, or `{}` if none is legible. */
function slotsForNode(record: WorkflowRunRecord, nodeId: string): Record<string, unknown> {
  const executions = record.state.executions;
  if (!isRecord(executions)) return {};
  for (const execution of Object.values(executions)) {
    if (!isRecord(execution)) continue;
    if (execution.nodeId !== nodeId) continue;
    const slots = execution.modelCallSlots;
    if (isRecord(slots)) return slots;
  }
  return {};
}

function slotState(slots: Record<string, unknown>, slotId: string): BestOfNBranchState {
  const slot = slots[slotId];
  if (!isRecord(slot)) return "not-started";
  return isRecord(slot.receipt) ? "resolved" : "in-flight";
}

/**
 * The evaluator's verdict for `nodeId`, read off the `node_succeeded` event.
 *
 * Returns nothing at all when the run has not produced one — an absent verdict
 * must render as "not decided", never as "candidate 1 won by default".
 */
function evaluationFromEvents(
  events: readonly WorkflowRunEvent[],
  nodeId: string,
): { winnerIndex?: number; rationale?: string; scores: Map<number, number> } {
  const scores = new Map<number, number>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "node_succeeded" || event.nodeId !== nodeId) continue;
    const output = event.data?.output;
    if (!isRecord(output) || output.kind !== "best-of-n") continue;

    const rawScores = output.scores;
    if (Array.isArray(rawScores)) {
      for (const entry of rawScores) {
        if (!isRecord(entry)) continue;
        const candidate = entry.candidate;
        const score = entry.score;
        if (typeof candidate === "number" && typeof score === "number") {
          scores.set(candidate, score);
        }
      }
    }
    const winner = output.winner;
    const rationale = output.rationale;
    return {
      ...(typeof winner === "number" && Number.isInteger(winner) && winner >= 1
        ? { winnerIndex: winner }
        : {}),
      ...(typeof rationale === "string" && rationale.length > 0 ? { rationale } : {}),
      scores,
    };
  }
  return { scores };
}

/**
 * Every `best-of-n` node in the run, projected into branches.
 *
 * `events` may be empty — a run that is still going has no `node_succeeded`
 * yet, and the branches must still light up from slot state alone. That is the
 * live case and it is the one that matters.
 */
export function projectBestOfNRuns(
  record: WorkflowRunRecord,
  events: readonly WorkflowRunEvent[] = [],
): BestOfNProjection[] {
  const nodes = record.manifest?.graph?.nodes;
  if (!Array.isArray(nodes)) return [];

  const projections: BestOfNProjection[] = [];
  for (const node of nodes) {
    if (!isRecord(node) || node.kind !== "best-of-n") continue;
    const nodeId = typeof node.id === "string" ? node.id : null;
    if (nodeId === null) continue;

    const candidateCount = candidateCountForNode(node);
    const slots = slotsForNode(record, nodeId);
    const evaluation = evaluationFromEvents(events, nodeId);

    const branches: BestOfNBranch[] = [];
    for (let index = 1; index <= candidateCount; index += 1) {
      const slotId = `candidate-${String(index)}`;
      const score = evaluation.scores.get(index);
      branches.push({
        index,
        slotId,
        state: slotState(slots, slotId),
        winner: evaluation.winnerIndex === index,
        ...(typeof score === "number" ? { score } : {}),
      });
    }

    projections.push({
      nodeId,
      nodeName: typeof node.name === "string" ? node.name : nodeId,
      candidateCount,
      branches,
      evaluator: {
        slotId: "candidate-evaluator",
        state: slotState(slots, "candidate-evaluator"),
      },
      ...(evaluation.winnerIndex !== undefined ? { winnerIndex: evaluation.winnerIndex } : {}),
      ...(evaluation.rationale !== undefined ? { rationale: evaluation.rationale } : {}),
    });
  }
  return projections;
}
