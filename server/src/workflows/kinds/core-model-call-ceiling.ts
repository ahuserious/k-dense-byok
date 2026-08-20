import {
  isHostedFusionWithoutPolicyEvaluator,
  workflowNodeCoreModelCallCeiling as destCoreModelCallCeiling,
  type HarnessDispatchReachability,
  type WorkflowNodeCallCeilingInputs,
} from "../harness-dispatch-reachability.ts";
import type { WorkflowNode } from "../schema.ts";

/**
 * F5-owned ceiling. Dest `harness-dispatch-reachability.ts` stays byte-identical
 * so this lane does not take F2's file. New kinds and council extensions are
 * counted here; dest kinds reuse dest arithmetic.
 */
export function f5WorkflowNodeCoreModelCallCeiling(
  node: WorkflowNode,
  inputs: WorkflowNodeCallCeilingInputs,
): number {
  switch (node.kind) {
    case "elevate-to-dag":
    case "reasoning-style":
    case "workflow-ref":
      return 0;
    case "hypothesis":
      return (node.hypothesisCount ?? 2) + 1;
    case "formatted-output":
      return 1;
    case "council":
      return destCoreModelCallCeiling(node, inputs) +
        (node.fuser ? 1 : 0) +
        (node.maxRecruits ?? 0) * node.rounds;
    case "evidence-gate":
      if (node.evaluatorMode === "council" && node.council) {
        return (node.council.members.length + 1) * (node.council.rounds ?? 1);
      }
      return destCoreModelCallCeiling(node, inputs);
    case "research-until-goal":
    case "fusion":
    case "best-of-n":
    case "lean4":
    case "agent":
    case "prompt-optimization":
      return destCoreModelCallCeiling(node, inputs);
    default: {
      const _exhaustive: never = node;
      throw new Error(
        `Unhandled workflow node kind ${String((_exhaustive as WorkflowNode).kind)}.`,
      );
    }
  }
}

export function f5WorkflowHarnessDispatchReachability(
  node: WorkflowNode,
  inputs: WorkflowNodeCallCeilingInputs & {
    readonly requiresEvidencePolicyEvaluation: boolean;
  },
): HarnessDispatchReachability {
  const callCeiling = f5WorkflowNodeCoreModelCallCeiling(node, inputs) +
    (inputs.requiresEvidencePolicyEvaluation ? 1 : 0);
  const hostedFusionWithoutPolicyEvaluator = isHostedFusionWithoutPolicyEvaluator(
    node,
    inputs.requiresEvidencePolicyEvaluation,
  );
  const reachesDispatchDecision = callCeiling > 0 &&
    !hostedFusionWithoutPolicyEvaluator;
  return {
    reachesDispatchDecision,
    callCeiling,
    hostedFusionWithoutPolicyEvaluator,
    unreachableReason: reachesDispatchDecision
      ? undefined
      : hostedFusionWithoutPolicyEvaluator
      ? "hosted-fusion-only"
      : "no-model-calls",
  };
}
