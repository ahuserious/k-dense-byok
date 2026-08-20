/**
 * Does `harness` reach a dispatch decision for this node at all? — gap (B).
 *
 * `kady-node-executor.ts` asks for a delegation session only when
 * `requiresPiSubagent`, which is
 *
 *     callCeiling > 0 && !hostedFusionWithoutPolicyEvaluator
 *
 * When that is false the node starts no CLI child, so `harness` reaches no
 * decision and is silently discarded — the exact shape of #55. Round 1 of this
 * lane closed only the second conjunct at validation, which left `lean4` with
 * `mode: "verify"` and an `evidence-gate` with no evaluator accepting (and then
 * discarding) `harness: "grok-cli"`. Both conjuncts are computed here, in one
 * pure module that the executor and the validator both call, so the production
 * predicate and the validation predicate cannot drift.
 *
 * Pure by construction: no `node:fs`, no executor imports. The two runtime
 * quantities the ceiling depends on that this module cannot derive from the node
 * alone — the effective iteration limit and the prompt-optimization slot count —
 * are parameters, and each caller supplies them the same way.
 */
import { promptOptimizationModelCallSlots } from "./prompt-opt-model-slots.ts";
import type { WorkflowNode } from "./schema.ts";

export interface WorkflowNodeCallCeilingInputs {
  /**
   * The node's effective iteration limit, i.e. `min(graph.maxIterations,
   * node.limits.maxIterations ?? graph.maxIterations)`. The schema floors both
   * at 1, so this is never zero and `research-until-goal` always reaches the
   * decision.
   */
  readonly maxIterations: number;
}

/**
 * The node's core model-call ceiling — `maximumModelCalls` minus the evidence
 * policy-evaluation slot, which is a graph-level question and is added by the
 * caller. Every branch mirrors `kady-node-executor.ts` `maximumModelCalls`, and
 * that function now delegates to this one so "mirrors" is a fact rather than a
 * hope.
 */
export function workflowNodeCoreModelCallCeiling(
  node: WorkflowNode,
  inputs: WorkflowNodeCallCeilingInputs,
): number {
  switch (node.kind) {
    case "research-until-goal":
      return inputs.maxIterations;
    case "council":
      return (node.members.length + 1) * node.rounds;
    case "fusion":
      return node.fusion.mode === "openrouter-router"
        ? node.fusion.members.length + 2
        : node.fusion.members.length * node.fusion.rounds + 1;
    case "best-of-n":
      return (node.candidateCount ?? node.candidateModels?.length ?? 2) + 1;
    case "evidence-gate":
      return node.evaluator ||
          node.checks.some((check) => check !== "artifact-exists")
        ? 1
        : 0;
    case "lean4":
      return node.mode === "solve" ? 1 : 0;
    case "agent":
      return 1;
    case "prompt-optimization":
      return promptOptimizationModelCallSlots(node).length;
    case "elevate-to-dag":
    case "reasoning-style":
    case "workflow-ref":
      return 0;
    case "hypothesis":
      return (node.hypothesisCount ?? 2) + 1;
    case "formatted-output":
      return 1;
    default: {
      const _exhaustive: never = node;
      throw new Error(
        `Unhandled workflow node kind ${String((_exhaustive as WorkflowNode).kind)}.`,
      );
    }
  }
}

/**
 * The second conjunct: a hosted-Fusion node whose whole ceiling is served by the
 * OpenRouter router, with no evidence-policy evaluation, has model calls but no
 * delegated child.
 */
export function isHostedFusionWithoutPolicyEvaluator(
  node: WorkflowNode,
  requiresEvidencePolicyEvaluation: boolean,
): boolean {
  return node.kind === "fusion" &&
    node.fusion.mode === "openrouter-router" &&
    !requiresEvidencePolicyEvaluation;
}

export interface HarnessDispatchReachability {
  /** True exactly when the executor's `requiresPiSubagent` would be true. */
  readonly reachesDispatchDecision: boolean;
  /** The full ceiling, evidence-policy slot included. */
  readonly callCeiling: number;
  readonly hostedFusionWithoutPolicyEvaluator: boolean;
  /**
   * Why the decision is unreachable, for a message that names the next action.
   * `undefined` when it is reachable.
   */
  readonly unreachableReason: "no-model-calls" | "hosted-fusion-only" | undefined;
}

/**
 * The one predicate. `requiresEvidencePolicyEvaluation` is
 * `requiresWorkflowEvidencePolicyEvaluation(graph, node)` at both call sites;
 * it lives in `evidence-policy.ts` and is passed in so this module stays free of
 * the graph type's dependencies.
 */
export function workflowHarnessDispatchReachability(
  node: WorkflowNode,
  inputs: WorkflowNodeCallCeilingInputs & {
    readonly requiresEvidencePolicyEvaluation: boolean;
  },
): HarnessDispatchReachability {
  const callCeiling = workflowNodeCoreModelCallCeiling(node, inputs) +
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
