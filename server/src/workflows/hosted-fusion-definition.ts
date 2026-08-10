import type { ModelRequest, RequestedModel, WorkflowNode } from "./schema.ts";

export type HostedOpenRouterFusionNode = Extract<
  WorkflowNode,
  { kind: "fusion" }
> & {
  fusion: Extract<
    Extract<WorkflowNode, { kind: "fusion" }>["fusion"],
    { mode: "openrouter-router" }
  >;
};

export interface EffectiveHostedFusionSlot {
  id: string;
  request: ModelRequest;
}

export interface EffectiveHostedFusionDefinition {
  reasoningEffort: RequestedModel["reasoning"];
  fusion: HostedOpenRouterFusionNode["fusion"];
  slots: EffectiveHostedFusionSlot[];
  accounting: {
    panelCalls: number;
    judgeCalls: 2;
    modelCallCount: number;
  };
}

export function hostedFusionAccounting(panelCalls: number): EffectiveHostedFusionDefinition["accounting"] {
  if (!Number.isSafeInteger(panelCalls) || panelCalls < 1) {
    throw new Error("Hosted Fusion requires at least one bounded panel call.");
  }
  return {
    panelCalls,
    judgeCalls: 2,
    modelCallCount: panelCalls + 2,
  };
}

type HostedFusionMember = HostedOpenRouterFusionNode["fusion"]["members"][number];

export function effectiveHostedFusionDefinitionFromFusion(
  authoredFusion: HostedOpenRouterFusionNode["fusion"],
  reasoningOverride?: RequestedModel["reasoning"],
): EffectiveHostedFusionDefinition {
  const reasoningEffort = reasoningOverride ?? authoredFusion.router.requested.reasoning;
  const fusion: HostedOpenRouterFusionNode["fusion"] = {
    ...structuredClone(authoredFusion),
    router: reasoningOverride === undefined
      ? structuredClone(authoredFusion.router)
      : requestWithReasoning(authoredFusion.router, reasoningEffort),
    members: authoredFusion.members.map((member: HostedFusionMember) => ({
      ...structuredClone(member),
      model: reasoningOverride === undefined
        ? structuredClone(member.model)
        : requestWithReasoning(member.model, reasoningEffort),
    })),
    judge: reasoningOverride === undefined
      ? structuredClone(authoredFusion.judge)
      : requestWithReasoning(authoredFusion.judge, reasoningEffort),
  };
  const slots: EffectiveHostedFusionSlot[] = [
    ...fusion.members.map((member: HostedFusionMember) => ({
      id: `fusion-panel-${member.id}`,
      request: structuredClone(member.model),
    })),
    { id: "fusion-judge-deliberation", request: structuredClone(fusion.judge) },
    { id: "fusion-judge-final", request: structuredClone(fusion.judge) },
  ];
  return {
    reasoningEffort,
    fusion,
    slots,
    accounting: hostedFusionAccounting(fusion.members.length),
  };
}

function requestWithReasoning(
  request: ModelRequest,
  reasoningEffort: RequestedModel["reasoning"],
): ModelRequest {
  const effective = structuredClone(request);
  effective.requested.reasoning = reasoningEffort;
  if (effective.resolution.mode === "explicit-fallback") {
    for (const alternative of effective.resolution.alternatives) {
      alternative.reasoning = reasoningEffort;
    }
  }
  return effective;
}

/**
 * The one effective Hosted Fusion definition. NodeSpec reasoning overrides
 * router, panel, judge, duplicate judge slots, accounting, receipt checks, and
 * the eventual provider configuration as one immutable value.
 */
export function effectiveHostedFusionDefinition(
  node: HostedOpenRouterFusionNode,
): EffectiveHostedFusionDefinition {
  return effectiveHostedFusionDefinitionFromFusion(
    node.fusion,
    node.settings?.reasoningEffort,
  );
}

/** Materialize the effective definition immediately before the S4 executor. */
export function materializeEffectiveHostedFusionNode(
  node: HostedOpenRouterFusionNode,
): HostedOpenRouterFusionNode {
  const effective = effectiveHostedFusionDefinition(node);
  const settings = { ...(node.settings ?? {}) };
  delete settings.reasoningEffort;
  const { settings: _authoredSettings, ...baseNode } = structuredClone(node);
  return {
    ...baseNode,
    fusion: effective.fusion,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}
