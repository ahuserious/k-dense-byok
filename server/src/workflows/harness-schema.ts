/**
 * The harness literal union as a TypeBox schema, *derived* from the registry.
 *
 * `schema.ts` spells the union out literal by literal on purpose: `HarnessSchema`
 * is a frozen NodeSpec v1 surface, `s11/lane-briefs-20260818/freeze-check.py`
 * reads exactly that block out of `schema.ts` to check every literal against
 * `docs/contracts/NODESPEC-V1.md`, and a written-out union is what keeps
 * `Static<typeof HarnessSchema>` a union of literals rather than `string`. A
 * compile-time guard there already fails the build if it and the registry
 * disagree.
 *
 * `prompt-opt-schema.ts` is the other TypeBox surface carrying the same union,
 * and it cannot import `schema.ts` — `schema.ts` imports *it*
 * (`PromptOptimizationNodeSpecV1Schema` exists precisely to avoid that cycle).
 * Round 1 therefore left it a hand-written five-literal copy that silently
 * rejected `deepseek` / `grok-cli` / `oh-my-pi` on prompt-optimization nodes
 * while every other node kind accepted them.
 *
 * This module is the third point both can reach: one mapped expression over
 * `WORKFLOW_HARNESS_IDS`, with `Type.Unsafe` restoring the literal static type
 * the mapped form would otherwise widen. There is no literal spelled here, so
 * there is nothing to keep in sync — adding a harness is still one registry row.
 * `harness-registry.test.ts` pins that `PromptOptimizationNodeSchema` accepts
 * every registry id and nothing else.
 */
import { Type } from "typebox";
import { WORKFLOW_HARNESS_IDS, type WorkflowHarnessId } from "./harness-registry.ts";

export const HarnessLiteralSchema = Type.Unsafe<WorkflowHarnessId>(
  Type.Union(WORKFLOW_HARNESS_IDS.map((id) => Type.Literal(id))),
);
