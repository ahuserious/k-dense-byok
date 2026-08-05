import type { LedgerAuthType } from "../cost/billing.ts";
import {
  billingForProvider,
  normalizeUsageCost,
} from "../cost/billing.ts";
import type { DagFusionDelegationUsageSettlement } from "../../pi-packages/dag-fusion-drive/index.ts";
import type {
  SettleWorkflowBudgetInput,
  WorkflowBudgetSettlementStatus,
} from "./budget.ts";

export const SUPERVISED_WORKFLOW_BUDGET_DESCRIPTOR_VERSION = 1 as const;

const RESERVATION_ID_PATTERN = /^wbres_[a-f0-9]{32}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LEDGER_AUTH_TYPES = new Set<LedgerAuthType>([
  "api_key",
  "oauth",
  "local",
  "none",
]);

/**
 * Credential-free accounting facts that may cross the local supervisor
 * boundary. Billing mode is intentionally derived from provider + authType so
 * backend and supervisor cannot persist two contradictory policy decisions.
 */
export interface SupervisedWorkflowBudgetDescriptorV1 {
  version: typeof SUPERVISED_WORKFLOW_BUDGET_DESCRIPTOR_VERSION;
  reservationId: string;
  runId: string;
  executionId: string;
  attempt: number;
  slotId: string;
  provider: string;
  authType: LedgerAuthType;
}

export interface CreateSupervisedWorkflowBudgetDescriptorInput {
  reservationId: string;
  runId: string;
  executionId: string;
  attempt: number;
  slotId: string;
  provider: string;
  authKind: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ledgerAuthType(authKind: string): LedgerAuthType {
  switch (authKind) {
    case "oauth":
      return "oauth";
    case "local":
    case "custom":
      return "local";
    case "api-key":
      return "api_key";
    default:
      // Unknown auth must retain the billing policy's fail-closed PAYG path.
      return "none";
  }
}

/** Build the only descriptor shape accepted by supervised transports. */
export function createSupervisedWorkflowBudgetDescriptor(
  input: CreateSupervisedWorkflowBudgetDescriptorInput,
): SupervisedWorkflowBudgetDescriptorV1 {
  return parseSupervisedWorkflowBudgetDescriptor({
    version: SUPERVISED_WORKFLOW_BUDGET_DESCRIPTOR_VERSION,
    reservationId: input.reservationId,
    runId: input.runId,
    executionId: input.executionId,
    attempt: input.attempt,
    slotId: input.slotId,
    provider: input.provider,
    authType: ledgerAuthType(input.authKind),
  });
}

/** Strict, credential-safe validation for values received across local IPC. */
export function parseSupervisedWorkflowBudgetDescriptor(
  value: unknown,
): SupervisedWorkflowBudgetDescriptorV1 {
  if (!isPlainRecord(value)) {
    throw new Error("Workflow budget descriptor must be a plain object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 8 ||
    keys[0] !== "attempt" ||
    keys[1] !== "authType" ||
    keys[2] !== "executionId" ||
    keys[3] !== "provider" ||
    keys[4] !== "reservationId" ||
    keys[5] !== "runId" ||
    keys[6] !== "slotId" ||
    keys[7] !== "version"
  ) {
    throw new Error("Workflow budget descriptor has unexpected fields.");
  }
  if (value.version !== SUPERVISED_WORKFLOW_BUDGET_DESCRIPTOR_VERSION) {
    throw new Error("Workflow budget descriptor version is unsupported.");
  }
  if (
    typeof value.reservationId !== "string" ||
    !RESERVATION_ID_PATTERN.test(value.reservationId)
  ) {
    throw new Error("Workflow budget descriptor reservation id is invalid.");
  }
  const identityFields = [
    ["run id", value.runId],
    ["execution id", value.executionId],
    ["slot id", value.slotId],
  ] as const;
  for (const [label, identity] of identityFields) {
    if (typeof identity !== "string" || !IDENTITY_PATTERN.test(identity)) {
      throw new Error(`Workflow budget descriptor ${label} is invalid.`);
    }
  }
  const runId = value.runId as string;
  const executionId = value.executionId as string;
  const slotId = value.slotId as string;
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    throw new Error("Workflow budget descriptor attempt is invalid.");
  }
  if (
    typeof value.provider !== "string" ||
    !PROVIDER_PATTERN.test(value.provider)
  ) {
    throw new Error("Workflow budget descriptor provider is invalid.");
  }
  if (!LEDGER_AUTH_TYPES.has(value.authType as LedgerAuthType)) {
    throw new Error("Workflow budget descriptor auth type is invalid.");
  }
  return {
    version: SUPERVISED_WORKFLOW_BUDGET_DESCRIPTOR_VERSION,
    reservationId: value.reservationId,
    runId,
    executionId,
    attempt: value.attempt as number,
    slotId,
    provider: value.provider,
    authType: value.authType as LedgerAuthType,
  };
}

function settlementStatus(
  settlement: DagFusionDelegationUsageSettlement,
): WorkflowBudgetSettlementStatus {
  if (
    settlement.reason === "caller-cancelled" ||
    settlement.reason === "caller-aborted" ||
    settlement.responseStatus === "cancelled" ||
    settlement.responseStatus === "interrupted"
  ) {
    return "aborted";
  }
  if (
    settlement.reason === "host-timeout" ||
    settlement.responseStatus === "timed_out"
  ) {
    return "timed-out";
  }
  if (
    settlement.reason === "terminal-response" &&
    settlement.responseStatus === "completed" &&
    settlement.usage !== undefined
  ) {
    return "completed";
  }
  return "failed";
}

function settlementReason(settlement: DagFusionDelegationUsageSettlement): string {
  const response = settlement.responseStatus ?? "no-response";
  const usage = settlement.usage ? "observed" : "missing";
  return `dag-fusion:${settlement.reason}:${response}:usage-${usage}`;
}

/**
 * Canonical Dag Fusion -> durable budget intent projection. Calling this in
 * either process produces the same idempotency input for the budget store.
 */
export function settleWorkflowBudgetInputForDagFusion(
  descriptor: SupervisedWorkflowBudgetDescriptorV1,
  settlement: DagFusionDelegationUsageSettlement,
): SettleWorkflowBudgetInput {
  const stableDescriptor = parseSupervisedWorkflowBudgetDescriptor(descriptor);
  const usage = settlement.usage;
  const normalizedUsage = usage
    ? (() => {
        const billing = billingForProvider(
          stableDescriptor.provider,
          stableDescriptor.authType,
        );
        const normalizedCost = normalizeUsageCost(usage.cost, billing);
        return {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          // Cached prompt tokens are already represented in input.
          total: usage.input + usage.output,
          cost: normalizedCost.costUsd,
        };
      })()
    : undefined;
  return {
    status: settlementStatus(settlement),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
    reason: settlementReason(settlement),
  };
}
