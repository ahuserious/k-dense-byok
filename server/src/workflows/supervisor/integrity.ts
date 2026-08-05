import crypto from "node:crypto";
import type {
  DagFusionDelegationIdentity,
  DagFusionDelegationUsageSettlement,
} from "../../../pi-packages/dag-fusion-drive/index.ts";
import type {
  WorkflowSupervisorOperationKind,
  WorkflowSupervisorSettlementStatus,
  WorkflowSupervisorTerminalOutcome,
} from "./journal.ts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Workflow supervisor integrity inputs must be JSON-serializable.");
  }
  return encoded;
}

export function workflowSupervisorDigest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function workflowSupervisorOperationId(
  kind: WorkflowSupervisorOperationKind,
  projectId: string,
  identity: DagFusionDelegationIdentity,
): string {
  const digest = workflowSupervisorDigest({
    version: 1,
    kind,
    projectId,
    identity,
  });
  return `wsop_${digest.slice(0, 40)}`;
}

export function workflowSupervisorSettlementStatus(
  settlement: DagFusionDelegationUsageSettlement,
): WorkflowSupervisorSettlementStatus {
  if (
    settlement.reason === "caller-cancelled" ||
    settlement.reason === "caller-aborted" ||
    settlement.responseStatus === "cancelled" ||
    settlement.responseStatus === "interrupted"
  ) return "aborted";
  if (
    settlement.reason === "host-timeout" ||
    settlement.responseStatus === "timed_out"
  ) return "timed-out";
  if (
    settlement.reason === "terminal-response" &&
    settlement.responseStatus === "completed" &&
    settlement.usage !== undefined
  ) return "completed";
  return "failed";
}

export function workflowSupervisorTerminalOutcome(
  settlement: DagFusionDelegationUsageSettlement | undefined,
): WorkflowSupervisorTerminalOutcome {
  if (!settlement) return "failed";
  const status = workflowSupervisorSettlementStatus(settlement);
  if (status === "completed") return "completed";
  if (status === "aborted") return "aborted";
  if (status === "timed-out") return "timed-out";
  return "failed";
}

export function workflowSupervisorMachineCode(error: unknown): string {
  const value = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof value === "string" && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value)) {
    return value;
  }
  return "SUPERVISOR_OPERATION_FAILED";
}
