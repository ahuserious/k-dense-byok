import type { NodeSpecV1, WorkflowNode, WorkflowSettingsV1 } from "./schema.ts";

export type NodeSpecEnforcementUnit = "S4" | "S5";

export interface PendingNodeSpecEnforcement {
  code: string;
  pathSuffix: string;
  field: string;
  unit: NodeSpecEnforcementUnit;
  owner: string;
}

function pending(
  code: string,
  pathSuffix: string,
  field: string,
  unit: NodeSpecEnforcementUnit,
  owner = unit === "S4"
    ? "per-node-control unit (S4)"
    : "deliberation/personality-store unit (S5)",
): PendingNodeSpecEnforcement {
  return { code, pathSuffix, field, unit, owner };
}

/** Non-default NodeSpec fields that are frozen but not yet bound to execution. */
export function pendingNodeSpecEnforcements(
  settings: NodeSpecV1 | undefined,
): PendingNodeSpecEnforcement[] {
  if (!settings) return [];
  const findings: PendingNodeSpecEnforcement[] = [];
  if (
    settings.deliberation?.personalityStoreRef !== undefined ||
    (settings.deliberation?.bestOfNPersonalityCount !== undefined &&
      settings.deliberation.bestOfNPersonalityCount !== 2) ||
    (settings.deliberation?.mimeographs?.mode !== undefined &&
      settings.deliberation.mimeographs.mode !== "auto") ||
    (settings.deliberation?.mimeographs?.personalityRefs?.length ?? 0) > 0
  ) {
    findings.push(pending(
      "node-deliberation-enforcement-pending",
      "deliberation",
      "deliberation",
      "S5",
    ));
  }
  return findings;
}

/** Node-kind-specific fields awaiting the owning runtime's effective definition. */
export function pendingNodeKindSpecEnforcements(
  node: WorkflowNode,
): PendingNodeSpecEnforcement[] {
  if (
    node.kind === "fusion" &&
    node.fusion.mode === "openrouter-router" &&
    node.settings?.reasoningEffort !== undefined &&
    node.settings.reasoningEffort !== "high"
  ) {
    return [pending(
      "hosted-fusion-reasoning-enforcement-pending",
      "reasoningEffort",
      "reasoningEffort on hosted Fusion",
      "S5",
      "fusion-topology unit (S5)",
    )];
  }
  return [];
}

/** Non-default workflow settings that would otherwise bypass the node-level gate. */
export function pendingWorkflowSettingsEnforcements(
  settings: WorkflowSettingsV1 | undefined,
): PendingNodeSpecEnforcement[] {
  if (!settings) return [];
  const findings: PendingNodeSpecEnforcement[] = [];
  return findings;
}

export function pendingNodeSpecEnforcementMessage(
  finding: PendingNodeSpecEnforcement,
): string {
  return `NodeSpec ${finding.field} is frozen in the contract, but enforcement lands in the ${finding.owner}; non-default values fail closed until ${finding.unit} enforcement.`;
}
