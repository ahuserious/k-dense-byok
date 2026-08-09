import type { NodeSpecV1, WorkflowSettingsV1 } from "./schema.ts";

export type NodeSpecEnforcementUnit = "S4" | "S5";

export interface PendingNodeSpecEnforcement {
  code: string;
  pathSuffix: string;
  field: string;
  unit: NodeSpecEnforcementUnit;
}

function pending(
  code: string,
  pathSuffix: string,
  field: string,
  unit: NodeSpecEnforcementUnit,
): PendingNodeSpecEnforcement {
  return { code, pathSuffix, field, unit };
}

/** Non-default NodeSpec fields that are frozen but not yet bound to execution. */
export function pendingNodeSpecEnforcements(
  settings: NodeSpecV1 | undefined,
): PendingNodeSpecEnforcement[] {
  if (!settings) return [];
  const findings: PendingNodeSpecEnforcement[] = [];
  if (
    settings.conditions?.when !== undefined ||
    (settings.conditions?.exists?.length ?? 0) > 0
  ) {
    findings.push(pending(
      "node-conditions-enforcement-pending",
      "conditions",
      "conditions",
      "S4",
    ));
  }
  if (settings.harness !== undefined && settings.harness !== "pi") {
    findings.push(pending("node-harness-enforcement-pending", "harness", "harness", "S4"));
  }
  if (
    (settings.hyperparameters?.temperature !== undefined &&
      settings.hyperparameters.temperature !== 1) ||
    (settings.hyperparameters?.top_p !== undefined && settings.hyperparameters.top_p !== 1) ||
    Object.keys(settings.hyperparameters?.sampling ?? {}).length > 0
  ) {
    findings.push(pending(
      "node-hyperparameters-enforcement-pending",
      "hyperparameters",
      "hyperparameters",
      "S4",
    ));
  }
  if ((settings.databases?.length ?? 0) > 0) {
    findings.push(pending(
      "node-databases-enforcement-pending",
      "databases",
      "databases",
      "S4",
    ));
  }
  if (settings.skills?.mode !== undefined && settings.skills.mode !== "auto") {
    findings.push(pending(
      "node-skills-mode-enforcement-pending",
      "skills/mode",
      "skills.mode",
      "S4",
    ));
  }
  if ((settings.skills?.list?.length ?? 0) > 0) {
    findings.push(pending(
      "node-skills-list-enforcement-pending",
      "skills/list",
      "skills.list",
      "S4",
    ));
  }
  if (settings.subagents?.mode !== undefined && settings.subagents.mode !== "auto") {
    findings.push(pending(
      "node-subagents-mode-enforcement-pending",
      "subagents/mode",
      "subagents.mode",
      "S4",
    ));
  }
  if (settings.autonomy !== undefined && settings.autonomy !== "strict") {
    findings.push(pending(
      "node-autonomy-enforcement-pending",
      "autonomy",
      "autonomy",
      "S4",
    ));
  }
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
  if (settings.billingMode !== undefined && settings.billingMode !== "inherit") {
    findings.push(pending(
      "node-billing-mode-enforcement-pending",
      "billingMode",
      "billingMode",
      "S4",
    ));
  }
  return findings;
}

/** Non-default workflow settings that would otherwise bypass the node-level gate. */
export function pendingWorkflowSettingsEnforcements(
  settings: WorkflowSettingsV1 | undefined,
): PendingNodeSpecEnforcement[] {
  if (!settings) return [];
  const findings: PendingNodeSpecEnforcement[] = [];
  if (settings.defaultHarness !== undefined && settings.defaultHarness !== "pi") {
    findings.push(pending(
      "workflow-default-harness-enforcement-pending",
      "defaultHarness",
      "workflow defaultHarness",
      "S4",
    ));
  }
  if ((settings.databases?.length ?? 0) > 0) {
    findings.push(pending(
      "workflow-databases-enforcement-pending",
      "databases",
      "workflow databases",
      "S4",
    ));
  }
  return findings;
}

export function pendingNodeSpecEnforcementMessage(
  finding: PendingNodeSpecEnforcement,
): string {
  const owner = finding.unit === "S4"
    ? "per-node-control unit (S4)"
    : "deliberation/personality-store unit (S5)";
  return `NodeSpec ${finding.field} is frozen in the contract, but enforcement lands in the ${owner}; non-default values fail closed until ${finding.unit} enforcement.`;
}
