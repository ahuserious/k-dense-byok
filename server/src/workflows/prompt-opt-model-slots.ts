import type { ModelRequest } from "./schema.ts";
import type { PromptOptimizationNode } from "./prompt-opt-schema.ts";

export interface PromptOptimizationModelCallSlot {
  id: string;
  request: ModelRequest;
}

function resolvedRoleRequest(
  node: PromptOptimizationNode,
  request: ModelRequest,
  hostedFusion: boolean,
): ModelRequest {
  const resolved = structuredClone(request);
  const reasoning = node.settings?.reasoningEffort;
  // This mirrors resolveNodeSpecV1: hosted OpenRouter Fusion exposes one
  // topology-wide reasoning value, while typed council/Kady-panel role calls
  // inherit an explicit node reasoning override.
  if (reasoning !== undefined && !(hostedFusion && reasoning === "high")) {
    resolved.requested.reasoning = reasoning;
    if (resolved.resolution.mode === "explicit-fallback") {
      for (const alternative of resolved.resolution.alternatives) {
        alternative.reasoning = reasoning;
      }
    }
  }
  return resolved;
}

/** Stable outer slot identity for one provider call inside an optimization iteration. */
export function promptOptimizationOuterModelCallSlotId(
  iteration: number,
  childSlotId: string,
): string {
  return `po-i${iteration}-${childSlotId}`;
}

function childSlots(node: PromptOptimizationNode): PromptOptimizationModelCallSlot[] {
  if (!node.fusionDeliberation.enabled) {
    const council = node.fusionDeliberation.council;
    const slots: PromptOptimizationModelCallSlot[] = [];
    for (let round = 1; round <= council.rounds; round += 1) {
      for (const member of council.members) {
        slots.push({
          id: `council-round-${round}-member-${member.id}`,
          request: resolvedRoleRequest(node, member.model, false),
        });
      }
      slots.push({
        id: `council-round-${round}-chair`,
        request: resolvedRoleRequest(node, council.chair, false),
      });
    }
    return slots;
  }

  const fusion = node.fusionDeliberation.fusion;
  if (!fusion) return [];
  if (fusion.mode === "openrouter-router") {
    return [
      ...fusion.members.map((member) => ({
        id: `fusion-panel-${member.id}`,
        request: resolvedRoleRequest(node, member.model, true),
      })),
      {
        id: "fusion-judge-deliberation",
        request: resolvedRoleRequest(node, fusion.judge, true),
      },
      {
        id: "fusion-judge-final",
        request: resolvedRoleRequest(node, fusion.judge, true),
      },
    ];
  }

  const slots: PromptOptimizationModelCallSlot[] = [];
  for (let round = 1; round <= fusion.rounds; round += 1) {
    for (const member of fusion.members) {
      slots.push({
        id: `fusion-round-${round}-member-${member.id}`,
        request: resolvedRoleRequest(node, member.model, false),
      });
    }
  }
  slots.push({
    id: "fusion-synthesizer",
    request: resolvedRoleRequest(node, fusion.synthesizer, false),
  });
  return slots;
}

/**
 * Static receipt inventory used by RunState admission and replay. The outer
 * prompt node owns these durable slots; synthetic child execution merely maps
 * its normal council/fusion slot ids into this iteration-prefixed namespace.
 */
export function promptOptimizationModelCallSlots(
  node: PromptOptimizationNode,
): PromptOptimizationModelCallSlot[] {
  const perIteration = childSlots(node);
  const slots: PromptOptimizationModelCallSlot[] = [];
  for (let iteration = 1; iteration <= node.iterations; iteration += 1) {
    for (const childSlot of perIteration) {
      slots.push({
        id: promptOptimizationOuterModelCallSlotId(iteration, childSlot.id),
        request: structuredClone(childSlot.request),
      });
    }
  }
  return slots;
}

/** Requests accepted by RunState receipt replay for the outer prompt node. */
export function promptOptimizationModelRequests(
  node: PromptOptimizationNode,
): ModelRequest[] {
  return childSlots(node).map((slot) => structuredClone(slot.request));
}

/** Hosted Fusion receipts retain the compound runtime used by the typed child. */
export function promptOptimizationAllowsCompoundRuntime(
  node: PromptOptimizationNode,
  runtime: string,
): boolean {
  return node.fusionDeliberation.enabled &&
    node.fusionDeliberation.fusion?.mode === "openrouter-router" &&
    runtime === "openrouter-fusion";
}
