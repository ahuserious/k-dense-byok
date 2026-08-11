/**
 * Durable DAG cost reservations.
 *
 * Admission, renewal, settlement, and stale recovery share one project lock,
 * so independent backend processes cannot both spend the same remaining cap.
 * Terminal records stay on disk as the workflow cost audit; callers must not
 * also ledger the same workflow usage as an ordinary session cost row.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { projectCostSummary } from "../cost/ledger.ts";
import {
  billingCountsTowardBudget,
  type BillingContext,
} from "../cost/billing.ts";
import { resolvePaths, type ProjectPaths } from "../projects.ts";
import { apiRelative, isWithin } from "../sandbox-fs.ts";

export const WORKFLOW_BUDGET_RESERVATION_VERSION = 1 as const;
export const DEFAULT_WORKFLOW_BUDGET_LEASE_MS = 26 * 60 * 60 * 1_000;
export const MAX_WORKFLOW_BUDGET_LEASE_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_WORKFLOW_BUDGET_RECORD_BYTES = 64 * 1_024;

const MIN_WORKFLOW_BUDGET_LEASE_MS = 1_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVATION_ID_RE = /^wbres_[a-f0-9]{32}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PIPELINE_ADMISSION_ID_RE = /^kadypipe_[a-f0-9]{32}$/;
const ENGINE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const INSTANCE_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "aborted",
  "timed-out",
  "stale",
] as const;

export type WorkflowBudgetSettlementStatus = Exclude<
  WorkflowBudgetReservationStatus,
  "active" | "stale"
>;
export type WorkflowBudgetReservationStatus =
  | "active"
  | "completed"
  | "failed"
  | "aborted"
  | "timed-out"
  | "stale";

export type WorkflowBudgetErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "LOCK_TIMEOUT"
  | "CORRUPT";

export class WorkflowBudgetError extends Error {
  constructor(
    readonly code: WorkflowBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowBudgetError";
  }
}

export interface WorkflowBudgetUsageInput {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface StoredWorkflowBudgetUsageV1 {
  input: number;
  output: number;
  total: number;
  costUsd: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface WorkflowBudgetSettlementV1 {
  settlementId: string;
  status: Exclude<WorkflowBudgetReservationStatus, "active">;
  settledAt: number;
  usageComplete: boolean;
  observedUsage?: StoredWorkflowBudgetUsageV1;
  incrementalUsage: StoredWorkflowBudgetUsageV1;
  chargedCostUsd: number;
  limitExceeded: boolean;
  reason?: string;
}

export interface PipelineReservationIntentV1 {
  admissionId: string;
  workflowName: string;
  engineAdmissionKey: string;
  correlationLabel: string;
  projectLabel: string;
  requestSha256: string;
  workflowRevisionSha256: string;
  workflowNodeCount: number;
  nodeIds: string[];
  capCountedNodeIds: string[];
  ownerInstanceId: string;
}

export interface WorkflowBudgetReservationV1 {
  version: typeof WORKFLOW_BUDGET_RESERVATION_VERSION;
  id: string;
  projectId: string;
  runId: string;
  runMaxCostUsd: number;
  runMaxTokens: number;
  runMaxModelCalls: number;
  modelCallCount: number;
  requestSha256: string;
  status: WorkflowBudgetReservationStatus;
  maxCostUsd: number;
  maxTokens: number;
  reservedCostUsd: number;
  initialUsage: StoredWorkflowBudgetUsageV1;
  leaseDurationMs: number;
  leaseGeneration: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  pipelineAdmissionIntent?: PipelineReservationIntentV1;
  settlement?: WorkflowBudgetSettlementV1;
}

export interface ReserveWorkflowBudgetInput {
  projectId: string;
  reservationId: string;
  runId: string;
  runMaxCostUsd: number;
  runMaxTokens: number;
  runMaxModelCalls: number;
  modelCallCount: number;
  maxCostUsd: number;
  maxTokens: number;
  initialUsage?: WorkflowBudgetUsageInput;
  leaseDurationMs?: number;
  pipelineAdmissionIntent?: PipelineReservationIntentV1;
}

export interface SettleWorkflowBudgetInput {
  status: WorkflowBudgetSettlementStatus;
  usage?: WorkflowBudgetUsageInput;
  reason?: string;
}

export interface WorkflowBudgetReservationHandle {
  record: WorkflowBudgetReservationV1;
  settle(input: SettleWorkflowBudgetInput): Promise<WorkflowBudgetReservationV1>;
  renew(leaseDurationMs?: number): Promise<WorkflowBudgetReservationV1>;
}

export interface WorkflowBudgetSummary {
  activeReservedUsd: number;
  settledSpentUsd: number;
  settledTokens: number;
  activeCount: number;
  settledCount: number;
  staleCount: number;
}

export interface WorkflowRunBudgetCeilings {
  maxCostUsd: number;
  maxTokens: number;
  maxModelCalls: number;
}

export interface PipelineNodeBudgetHook {
  nodeId: string;
  /** Engine-derived worst-case provider invocations; legacy direct callers default to one. */
  modelCallCount?: number;
  maxTokens: number;
  maxCostUsd: number;
  declaredBillingMode: "inherit" | "api" | "subscription";
  billing: BillingContext;
}

export interface PipelineBudgetAdmission {
  admissionId: string;
  runId: string;
  workflowNodeCount: number;
  hooks: PipelineNodeBudgetHook[];
  handle: WorkflowBudgetReservationHandle;
}

export type PipelineAdmissionStatus =
  | "intent"
  | "dispatching"
  | "indeterminate"
  | "dispatched"
  | "settling"
  | "settled";

export interface PipelineSettlementIntentV1 extends SettleWorkflowBudgetInput {
  engineRunId?: string;
}

export const PIPELINE_ADMISSION_VERSION = 1 as const;
export const PIPELINE_ADMISSION_LABEL_PREFIX = "KADY_PIPELINE_ADMISSION:" as const;
export const PIPELINE_PROJECT_LABEL_PREFIX = "KADY_PIPELINE_PROJECT:" as const;
export const PIPELINE_ADMISSION_OWNER_INSTANCE_ID = crypto.randomUUID();

export interface PipelineAdmissionRecordV1 {
  version: typeof PIPELINE_ADMISSION_VERSION;
  admissionId: string;
  projectId: string;
  workflowName: string;
  reservationId: string;
  budgetRunId: string;
  correlationLabel: string;
  projectLabel: string;
  engineAdmissionKey: string;
  requestSha256: string;
  workflowRevisionSha256: string;
  workflowNodeCount: number;
  nodeIds: string[];
  capCountedNodeIds: string[];
  engineRunId?: string;
  ownerInstanceId: string;
  status: PipelineAdmissionStatus;
  settlementIntent?: PipelineSettlementIntentV1;
  createdAt: number;
  updatedAt: number;
}

/**
 * Constant-size, reason-free projection of one run's durable reservations.
 * `missingUsageMaximumTokens` is the persisted token envelope for terminal
 * reservations without observed usage, not a claim about tokens consumed.
 */
export interface WorkflowRunBudgetSummary {
  runId: string;
  reservationCount: number;
  ceilings: WorkflowRunBudgetCeilings | null;
  modelCallCount: number;
  activeReservationCount: number;
  activeReservedMaximumUsd: number;
  activeReservedMaximumTokens: number;
  settledReservationCount: number;
  settledChargedUsd: number;
  observedUsageTokens: number;
  missingUsageMaximumTokens: number;
  staleReservationCount: number;
  fullChargeReservationCount: number;
}

export interface WorkflowBudgetStoreOptions {
  now?: () => number;
  lockWaitMs?: number;
  lockStaleMs?: number;
}

interface StoredBudgetLockV1 {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

function budgetError(code: WorkflowBudgetErrorCode, message: string): never {
  throw new WorkflowBudgetError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cloneRecord(record: WorkflowBudgetReservationV1): WorkflowBudgetReservationV1 {
  return structuredClone(record);
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    budgetError("INVALID_ARGUMENT", `Invalid workflow budget project id: ${projectId}`);
  }
}

function assertReservationId(reservationId: string): void {
  if (!RESERVATION_ID_RE.test(reservationId)) {
    budgetError("INVALID_ARGUMENT", `Invalid workflow budget reservation id: ${reservationId}`);
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    budgetError("INVALID_ARGUMENT", `Invalid workflow budget run id: ${runId}`);
  }
}

function safeMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    budgetError("INVALID_ARGUMENT", `${label} must be a finite USD amount from 0 to 1000000.`);
  }
  return value;
}

function safeTokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100_000_000) {
    budgetError("INVALID_ARGUMENT", `${label} must be an integer from 0 to 100000000.`);
  }
  return value as number;
}

function safeModelCallCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    budgetError("INVALID_ARGUMENT", `${label} must be an integer from 1 to 10000.`);
  }
  return value as number;
}

function safeLeaseDuration(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < MIN_WORKFLOW_BUDGET_LEASE_MS ||
    (value as number) > MAX_WORKFLOW_BUDGET_LEASE_MS
  ) {
    budgetError(
      "INVALID_ARGUMENT",
      `Workflow budget leaseDurationMs must be ${MIN_WORKFLOW_BUDGET_LEASE_MS}-${MAX_WORKFLOW_BUDGET_LEASE_MS}.`,
    );
  }
  return value as number;
}

function emptyUsage(): StoredWorkflowBudgetUsageV1 {
  return { input: 0, output: 0, total: 0, costUsd: 0, cacheRead: 0, cacheWrite: 0 };
}

function normalizeUsage(
  value: WorkflowBudgetUsageInput | undefined,
  label: string,
): StoredWorkflowBudgetUsageV1 {
  if (value === undefined) return emptyUsage();
  if (!isRecord(value)) budgetError("INVALID_ARGUMENT", `${label} must be an object.`);
  return {
    input: safeTokenCount(value.input, `${label}.input`),
    output: safeTokenCount(value.output, `${label}.output`),
    total: safeTokenCount(value.total, `${label}.total`),
    costUsd: safeMoney(value.cost, `${label}.cost`),
    cacheRead: safeTokenCount(value.cacheRead, `${label}.cacheRead`),
    cacheWrite: safeTokenCount(value.cacheWrite, `${label}.cacheWrite`),
  };
}

function isStoredUsage(value: unknown): value is StoredWorkflowBudgetUsageV1 {
  return isRecord(value) &&
    hasOnlyKeys(value, ["input", "output", "total", "costUsd", "cacheRead", "cacheWrite"]) &&
    [value.input, value.output, value.total, value.cacheRead, value.cacheWrite].every(
      (item) => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 100_000_000,
    ) &&
    typeof value.costUsd === "number" && Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 && value.costUsd <= 1_000_000;
}

function incrementalUsage(
  initial: StoredWorkflowBudgetUsageV1,
  observed: StoredWorkflowBudgetUsageV1,
): StoredWorkflowBudgetUsageV1 {
  for (const field of ["input", "output", "total", "cacheRead", "cacheWrite"] as const) {
    if (observed[field] < initial[field]) {
      budgetError("CONFLICT", `Observed workflow usage ${field} is lower than its resume baseline.`);
    }
  }
  if (observed.costUsd + Number.EPSILON < initial.costUsd) {
    budgetError("CONFLICT", "Observed workflow cost is lower than its resume baseline.");
  }
  return {
    input: observed.input - initial.input,
    output: observed.output - initial.output,
    total: observed.total - initial.total,
    costUsd: Math.max(0, observed.costUsd - initial.costUsd),
    cacheRead: observed.cacheRead - initial.cacheRead,
    cacheWrite: observed.cacheWrite - initial.cacheWrite,
  };
}

function usageEquals(
  left: StoredWorkflowBudgetUsageV1,
  right: StoredWorkflowBudgetUsageV1,
): boolean {
  return left.input === right.input && left.output === right.output &&
    left.total === right.total && Math.abs(left.costUsd - right.costUsd) <= 1e-10 &&
    left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite;
}

function isPipelineReservationIntent(
  value: unknown,
  projectId: string,
): value is PipelineReservationIntentV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "admissionId",
    "workflowName",
    "engineAdmissionKey",
    "correlationLabel",
    "projectLabel",
    "requestSha256",
    "workflowRevisionSha256",
    "workflowNodeCount",
    "nodeIds",
    "capCountedNodeIds",
    "ownerInstanceId",
  ])) return false;
  return typeof value.admissionId === "string" && PIPELINE_ADMISSION_ID_RE.test(value.admissionId) &&
    typeof value.workflowName === "string" && value.workflowName.length > 0 && value.workflowName.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value.workflowName) &&
    typeof value.engineAdmissionKey === "string" && PIPELINE_ADMISSION_ID_RE.test(value.engineAdmissionKey) &&
    value.engineAdmissionKey === pipelineEngineAdmissionKey(projectId, value.admissionId) &&
    value.correlationLabel === `${PIPELINE_ADMISSION_LABEL_PREFIX}${value.engineAdmissionKey}` &&
    value.projectLabel === `${PIPELINE_PROJECT_LABEL_PREFIX}${projectId}` &&
    typeof value.requestSha256 === "string" && SHA256_RE.test(value.requestSha256) &&
    typeof value.workflowRevisionSha256 === "string" && SHA256_RE.test(value.workflowRevisionSha256) &&
    Number.isSafeInteger(value.workflowNodeCount) && (value.workflowNodeCount as number) > 0 &&
    Array.isArray(value.nodeIds) && value.nodeIds.length > 0 &&
    value.nodeIds.every((nodeId) => typeof nodeId === "string" && nodeId.length > 0) &&
    new Set(value.nodeIds).size === value.nodeIds.length &&
    Array.isArray(value.capCountedNodeIds) &&
    value.capCountedNodeIds.every((nodeId) =>
      typeof nodeId === "string" && (value.nodeIds as unknown[]).includes(nodeId)
    ) &&
    new Set(value.capCountedNodeIds).size === value.capCountedNodeIds.length &&
    typeof value.ownerInstanceId === "string" && INSTANCE_ID_RE.test(value.ownerInstanceId);
}

function reservationIntent(input: {
  projectId: string;
  reservationId: string;
  runId: string;
  runMaxCostUsd: number;
  runMaxTokens: number;
  runMaxModelCalls: number;
  modelCallCount: number;
  maxCostUsd: number;
  maxTokens: number;
  initialUsage: StoredWorkflowBudgetUsageV1;
  leaseDurationMs: number;
  pipelineAdmissionIntent?: PipelineReservationIntentV1;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    reservationId: input.reservationId,
    runId: input.runId,
    runMaxCostUsd: input.runMaxCostUsd,
    runMaxTokens: input.runMaxTokens,
    runMaxModelCalls: input.runMaxModelCalls,
    modelCallCount: input.modelCallCount,
    maxCostUsd: input.maxCostUsd,
    maxTokens: input.maxTokens,
    initialUsage: input.initialUsage,
    leaseDurationMs: input.leaseDurationMs,
    ...(input.pipelineAdmissionIntent
      ? { pipelineAdmissionIntent: input.pipelineAdmissionIntent }
      : {}),
  };
}

function settlementIntent(input: {
  status: Exclude<WorkflowBudgetReservationStatus, "active">;
  observedUsage?: StoredWorkflowBudgetUsageV1;
  reason?: string;
}): Record<string, unknown> {
  return {
    status: input.status,
    ...(input.observedUsage ? { observedUsage: input.observedUsage } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function isTerminalStatus(value: unknown): value is Exclude<WorkflowBudgetReservationStatus, "active"> {
  return (TERMINAL_STATUSES as readonly unknown[]).includes(value);
}

function isSettlement(value: unknown): value is WorkflowBudgetSettlementV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "settlementId",
    "status",
    "settledAt",
    "usageComplete",
    "observedUsage",
    "incrementalUsage",
    "chargedCostUsd",
    "limitExceeded",
    "reason",
  ])) return false;
  if (
    typeof value.settlementId !== "string" || !SHA256_RE.test(value.settlementId) ||
    !isTerminalStatus(value.status) ||
    !Number.isSafeInteger(value.settledAt) || (value.settledAt as number) < 0 ||
    typeof value.usageComplete !== "boolean" ||
    (value.observedUsage !== undefined && !isStoredUsage(value.observedUsage)) ||
    !isStoredUsage(value.incrementalUsage) ||
    typeof value.chargedCostUsd !== "number" || !Number.isFinite(value.chargedCostUsd) ||
    value.chargedCostUsd < 0 || value.chargedCostUsd > 1_000_000 ||
    typeof value.limitExceeded !== "boolean" ||
    (value.reason !== undefined && (
      typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(value.reason)
    ))
  ) return false;
  const expectedId = digest(settlementIntent({
    status: value.status,
    ...(value.observedUsage ? { observedUsage: value.observedUsage } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  }));
  return value.settlementId === expectedId && value.usageComplete === (value.observedUsage !== undefined);
}

function parseReservation(value: unknown, projectId: string, reservationId: string): WorkflowBudgetReservationV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version",
    "id",
    "projectId",
    "runId",
    "runMaxCostUsd",
    "runMaxTokens",
    "runMaxModelCalls",
    "modelCallCount",
    "requestSha256",
    "status",
    "maxCostUsd",
    "maxTokens",
    "reservedCostUsd",
    "initialUsage",
    "leaseDurationMs",
    "leaseGeneration",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "pipelineAdmissionIntent",
    "settlement",
  ])) {
    budgetError("CORRUPT", `Workflow budget reservation ${reservationId} has an invalid shape.`);
  }
  const status = value.status;
  if (
    value.version !== WORKFLOW_BUDGET_RESERVATION_VERSION ||
    value.id !== reservationId || value.projectId !== projectId ||
    typeof value.runId !== "string" || !RUN_ID_RE.test(value.runId) ||
    typeof value.runMaxCostUsd !== "number" || !Number.isFinite(value.runMaxCostUsd) ||
    value.runMaxCostUsd < 0 || value.runMaxCostUsd > 1_000_000 ||
    !Number.isSafeInteger(value.runMaxTokens) || (value.runMaxTokens as number) < 1 ||
    (value.runMaxTokens as number) > 100_000_000 ||
    !Number.isSafeInteger(value.runMaxModelCalls) || (value.runMaxModelCalls as number) < 1 ||
    (value.runMaxModelCalls as number) > 10_000 ||
    !Number.isSafeInteger(value.modelCallCount) || (value.modelCallCount as number) < 1 ||
    (value.modelCallCount as number) > (value.runMaxModelCalls as number) ||
    typeof value.requestSha256 !== "string" || !SHA256_RE.test(value.requestSha256) ||
    !(status === "active" || isTerminalStatus(status)) ||
    typeof value.maxCostUsd !== "number" || !Number.isFinite(value.maxCostUsd) ||
    value.maxCostUsd < 0 || value.maxCostUsd > 1_000_000 ||
    value.maxCostUsd > value.runMaxCostUsd + Number.EPSILON ||
    !Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) < 1 ||
    (value.maxTokens as number) > 100_000_000 ||
    (value.maxTokens as number) > (value.runMaxTokens as number) ||
    typeof value.reservedCostUsd !== "number" || !Number.isFinite(value.reservedCostUsd) ||
    value.reservedCostUsd < 0 || value.reservedCostUsd > value.maxCostUsd ||
    !isStoredUsage(value.initialUsage) ||
    !Number.isSafeInteger(value.leaseDurationMs) ||
    (value.leaseDurationMs as number) < MIN_WORKFLOW_BUDGET_LEASE_MS ||
    (value.leaseDurationMs as number) > MAX_WORKFLOW_BUDGET_LEASE_MS ||
    !Number.isSafeInteger(value.leaseGeneration) || (value.leaseGeneration as number) < 1 ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < (value.createdAt as number) ||
    !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < (value.createdAt as number) ||
    (value.pipelineAdmissionIntent !== undefined &&
      !isPipelineReservationIntent(value.pipelineAdmissionIntent, projectId)) ||
    (status === "active" ? value.settlement !== undefined : !isSettlement(value.settlement))
  ) {
    budgetError("CORRUPT", `Workflow budget reservation ${reservationId} has invalid fields.`);
  }
  const intent = reservationIntent({
    projectId,
    reservationId,
    runId: value.runId,
    runMaxCostUsd: value.runMaxCostUsd,
    runMaxTokens: value.runMaxTokens as number,
    runMaxModelCalls: value.runMaxModelCalls as number,
    modelCallCount: value.modelCallCount as number,
    maxCostUsd: value.maxCostUsd,
    maxTokens: value.maxTokens as number,
    initialUsage: value.initialUsage,
    leaseDurationMs: value.leaseDurationMs as number,
    ...(value.pipelineAdmissionIntent
      ? { pipelineAdmissionIntent: value.pipelineAdmissionIntent as PipelineReservationIntentV1 }
      : {}),
  });
  if (digest(intent) !== value.requestSha256) {
    budgetError("CORRUPT", `Workflow budget reservation ${reservationId} failed its request digest.`);
  }
  if (Math.abs(value.reservedCostUsd - Math.max(0, value.maxCostUsd - value.initialUsage.costUsd)) > 1e-10) {
    budgetError("CORRUPT", `Workflow budget reservation ${reservationId} has inconsistent reserved cost.`);
  }
  if (status !== "active") {
    const settlement = value.settlement as WorkflowBudgetSettlementV1;
    if (settlement.status !== status || settlement.settledAt !== value.updatedAt) {
      budgetError("CORRUPT", `Workflow budget reservation ${reservationId} has inconsistent settlement state.`);
    }
    let expectedIncremental: StoredWorkflowBudgetUsageV1;
    try {
      expectedIncremental = settlement.observedUsage
        ? incrementalUsage(value.initialUsage, settlement.observedUsage)
        : emptyUsage();
    } catch {
      budgetError("CORRUPT", `Workflow budget reservation ${reservationId} has regressed observed usage.`);
    }
    const expectedCharge = settlement.observedUsage
      ? expectedIncremental.costUsd
      : value.reservedCostUsd;
    const expectedLimitExceeded = settlement.observedUsage !== undefined && (
      settlement.observedUsage.total > (value.maxTokens as number) ||
      settlement.observedUsage.costUsd > value.maxCostUsd + Number.EPSILON
    );
    if (
      !usageEquals(settlement.incrementalUsage, expectedIncremental) ||
      Math.abs(settlement.chargedCostUsd - expectedCharge) > 1e-10 ||
      settlement.limitExceeded !== expectedLimitExceeded
    ) {
      budgetError("CORRUPT", `Workflow budget reservation ${reservationId} has inconsistent charged usage.`);
    }
  }
  return value as unknown as WorkflowBudgetReservationV1;
}

function sameFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return (before.dev === 0 && before.ino === 0) ||
    (before.dev === after.dev && before.ino === after.ino);
}

function assertSafeDirectoryChain(paths: ProjectPaths, target: string, create: boolean): boolean {
  const root = path.resolve(paths.root);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(root, resolvedTarget)) {
    budgetError("INVALID_ARGUMENT", "Workflow budget path escaped its project root.");
  }
  let current = root;
  const components = apiRelative(root, resolvedTarget).split("/").filter(Boolean);
  const allComponents = [root, ...components.map((component) => {
    current = path.join(current, component);
    return current;
  })];
  for (const directory of allComponents) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return false;
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = fs.lstatSync(directory);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      budgetError("CORRUPT", `Workflow budget path component ${path.basename(directory)} is not a real directory.`);
    }
  }
  return true;
}

function readSafeRegularFile(
  paths: ProjectPaths,
  file: string,
  maximumBytes: number,
  label: string,
): Buffer | null {
  const parentExists = assertSafeDirectoryChain(paths, path.dirname(file), false);
  if (!parentExists) return null;
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    budgetError("CORRUPT", `${label} is not a regular managed file.`);
  }
  if (before.size > maximumBytes) budgetError("CORRUPT", `${label} exceeds ${maximumBytes} bytes.`);
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(String((error as NodeJS.ErrnoException).code))) {
      budgetError("CORRUPT", `${label} cannot be opened through a symbolic link.`);
    }
    throw error;
  }
  try {
    const after = fs.fstatSync(fd);
    if (!after.isFile() || !sameFileIdentity(before, after) || after.size > maximumBytes) {
      budgetError("CORRUPT", `${label} changed while it was being opened.`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on some supported Windows filesystems.
  }
}

function reservationPath(paths: ProjectPaths, reservationId: string): string {
  assertReservationId(reservationId);
  const file = path.join(paths.workflowReservationsDir, `${reservationId}.json`);
  if (!isWithin(path.resolve(paths.workflowReservationsDir), path.resolve(file))) {
    budgetError("INVALID_ARGUMENT", "Workflow budget reservation path escaped its directory.");
  }
  return file;
}

function atomicWriteReservation(paths: ProjectPaths, record: WorkflowBudgetReservationV1): void {
  assertSafeDirectoryChain(paths, paths.workflowReservationsDir, true);
  const temporaryDirectory = path.join(paths.workflowBudgetDir, ".reservation-write-tmp");
  assertSafeDirectoryChain(paths, temporaryDirectory, true);
  const file = reservationPath(paths, record.id);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf-8");
  if (bytes.length > MAX_WORKFLOW_BUDGET_RECORD_BYTES) {
    budgetError("CORRUPT", `Workflow budget reservation ${record.id} is too large.`);
  }
  const temporary = path.join(
    temporaryDirectory,
    `${record.id}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const existing = readSafeRegularFile(
      paths,
      file,
      MAX_WORKFLOW_BUDGET_RECORD_BYTES,
      `Workflow budget reservation ${record.id}`,
    );
    void existing;
    fs.renameSync(temporary, file);
    const written = readSafeRegularFile(
      paths,
      file,
      MAX_WORKFLOW_BUDGET_RECORD_BYTES,
      `Workflow budget reservation ${record.id}`,
    );
    if (!written || !written.equals(bytes)) {
      budgetError("CORRUPT", `Workflow budget reservation ${record.id} was not durably replaced.`);
    }
    fsyncDirectory(paths.workflowReservationsDir);
    fsyncDirectory(temporaryDirectory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readReservation(paths: ProjectPaths, reservationId: string): WorkflowBudgetReservationV1 | null {
  const bytes = readSafeRegularFile(
    paths,
    reservationPath(paths, reservationId),
    MAX_WORKFLOW_BUDGET_RECORD_BYTES,
    `Workflow budget reservation ${reservationId}`,
  );
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    budgetError("CORRUPT", `Workflow budget reservation ${reservationId} is malformed JSON.`);
  }
  return parseReservation(parsed, paths.id, reservationId);
}

function pipelineAdmissionsDirectory(paths: ProjectPaths): string {
  return path.join(paths.workflowBudgetDir, "pipeline-admissions");
}

function pipelineAdmissionPath(paths: ProjectPaths, admissionId: string): string {
  if (!PIPELINE_ADMISSION_ID_RE.test(admissionId)) {
    budgetError("INVALID_ARGUMENT", `Invalid pipeline admission id: ${admissionId}`);
  }
  const directory = pipelineAdmissionsDirectory(paths);
  const file = path.join(directory, `${admissionId}.json`);
  if (!isWithin(path.resolve(directory), path.resolve(file))) {
    budgetError("INVALID_ARGUMENT", "Pipeline admission path escaped its directory.");
  }
  return file;
}

function isPipelineSettlementIntent(value: unknown): value is PipelineSettlementIntentV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "usage", "reason", "engineRunId"])) {
    return false;
  }
  if (!(value.status === "completed" || value.status === "failed" ||
    value.status === "aborted" || value.status === "timed-out")) return false;
  if (value.reason !== undefined && (
    typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(value.reason)
  )) return false;
  if (value.engineRunId !== undefined && (
    typeof value.engineRunId !== "string" || !ENGINE_RUN_ID_RE.test(value.engineRunId)
  )) return false;
  if (value.usage !== undefined) {
    try {
      normalizeUsage(value.usage as WorkflowBudgetUsageInput, "pipeline settlement intent usage");
    } catch {
      return false;
    }
  }
  return true;
}

function parsePipelineAdmission(
  value: unknown,
  projectId: string,
  admissionId: string,
): PipelineAdmissionRecordV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version",
    "admissionId",
    "projectId",
    "workflowName",
    "reservationId",
    "budgetRunId",
    "correlationLabel",
    "projectLabel",
    "engineAdmissionKey",
    "requestSha256",
    "workflowRevisionSha256",
    "workflowNodeCount",
    "nodeIds",
    "capCountedNodeIds",
    "engineRunId",
    "ownerInstanceId",
    "status",
    "settlementIntent",
    "createdAt",
    "updatedAt",
  ])) {
    budgetError("CORRUPT", `Pipeline admission ${admissionId} has an invalid shape.`);
  }
  const expectedProjectLabel = `${PIPELINE_PROJECT_LABEL_PREFIX}${projectId}`;
  if (
    value.version !== PIPELINE_ADMISSION_VERSION ||
    value.admissionId !== admissionId ||
    value.projectId !== projectId ||
    typeof value.workflowName !== "string" || value.workflowName.length < 1 ||
    value.workflowName.length > 256 || /[\u0000-\u001f\u007f]/.test(value.workflowName) ||
    typeof value.reservationId !== "string" || !RESERVATION_ID_RE.test(value.reservationId) ||
    typeof value.budgetRunId !== "string" || !RUN_ID_RE.test(value.budgetRunId) ||
    typeof value.engineAdmissionKey !== "string" || !PIPELINE_ADMISSION_ID_RE.test(value.engineAdmissionKey) ||
    value.correlationLabel !== `${PIPELINE_ADMISSION_LABEL_PREFIX}${value.engineAdmissionKey}` ||
    value.projectLabel !== expectedProjectLabel ||
    typeof value.requestSha256 !== "string" || !SHA256_RE.test(value.requestSha256) ||
    typeof value.workflowRevisionSha256 !== "string" || !SHA256_RE.test(value.workflowRevisionSha256) ||
    !Number.isSafeInteger(value.workflowNodeCount) || (value.workflowNodeCount as number) < 1 ||
    !Array.isArray(value.nodeIds) ||
    value.nodeIds.some((nodeId) => typeof nodeId !== "string" || nodeId.length < 1) ||
    new Set(value.nodeIds).size !== value.nodeIds.length ||
    !Array.isArray(value.capCountedNodeIds) ||
    value.capCountedNodeIds.some((nodeId) => typeof nodeId !== "string" || nodeId.length < 1) ||
    new Set(value.capCountedNodeIds).size !== value.capCountedNodeIds.length ||
    value.capCountedNodeIds.some((nodeId) => !(value.nodeIds as unknown[]).includes(nodeId)) ||
    (value.engineRunId !== undefined && (
      typeof value.engineRunId !== "string" || !ENGINE_RUN_ID_RE.test(value.engineRunId)
    )) ||
    typeof value.ownerInstanceId !== "string" || !INSTANCE_ID_RE.test(value.ownerInstanceId) ||
    !(value.status === "intent" || value.status === "dispatching" ||
      value.status === "indeterminate" || value.status === "dispatched" ||
      value.status === "settling" || value.status === "settled") ||
    (value.status === "settling" ? !isPipelineSettlementIntent(value.settlementIntent) :
      value.settlementIntent !== undefined && !isPipelineSettlementIntent(value.settlementIntent)) ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < (value.createdAt as number)
  ) {
    budgetError("CORRUPT", `Pipeline admission ${admissionId} has invalid fields.`);
  }
  return value as unknown as PipelineAdmissionRecordV1;
}

function readPipelineAdmissionRecord(
  paths: ProjectPaths,
  admissionId: string,
): PipelineAdmissionRecordV1 | null {
  const bytes = readSafeRegularFile(
    paths,
    pipelineAdmissionPath(paths, admissionId),
    MAX_WORKFLOW_BUDGET_RECORD_BYTES,
    `Pipeline admission ${admissionId}`,
  );
  if (!bytes) return null;
  try {
    return parsePipelineAdmission(JSON.parse(bytes.toString("utf-8")), paths.id, admissionId);
  } catch (error) {
    if (error instanceof WorkflowBudgetError) throw error;
    budgetError("CORRUPT", `Pipeline admission ${admissionId} is malformed JSON.`);
  }
}

function atomicWritePipelineAdmission(
  paths: ProjectPaths,
  record: PipelineAdmissionRecordV1,
): void {
  const directory = pipelineAdmissionsDirectory(paths);
  assertSafeDirectoryChain(paths, directory, true);
  const temporaryDirectory = path.join(paths.workflowBudgetDir, ".pipeline-admission-write-tmp");
  assertSafeDirectoryChain(paths, temporaryDirectory, true);
  const file = pipelineAdmissionPath(paths, record.admissionId);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf-8");
  if (bytes.length > MAX_WORKFLOW_BUDGET_RECORD_BYTES) {
    budgetError("CORRUPT", `Pipeline admission ${record.admissionId} is too large.`);
  }
  const temporary = path.join(
    temporaryDirectory,
    `${record.admissionId}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const written = readSafeRegularFile(
      paths,
      file,
      MAX_WORKFLOW_BUDGET_RECORD_BYTES,
      `Pipeline admission ${record.admissionId}`,
    );
    if (!written || !written.equals(bytes)) {
      budgetError("CORRUPT", `Pipeline admission ${record.admissionId} was not durably replaced.`);
    }
    fsyncDirectory(directory);
    fsyncDirectory(temporaryDirectory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function listReservations(paths: ProjectPaths): WorkflowBudgetReservationV1[] {
  if (!assertSafeDirectoryChain(paths, paths.workflowReservationsDir, false)) return [];
  const entries = fs.readdirSync(paths.workflowReservationsDir, { withFileTypes: true });
  const reservations: WorkflowBudgetReservationV1[] = [];
  for (const entry of entries) {
    const match = /^(wbres_[a-f0-9]{32})\.json$/.exec(entry.name);
    const legacyTemporary = /^\.(wbres_[a-f0-9]{32})\.([1-9][0-9]*)\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/.exec(
      entry.name,
    );
    if (legacyTemporary) {
      // Older releases staged atomic replacements in this authoritative
      // directory. A crash could leave one behind; accept only that exact,
      // regular-file shape so it cannot permanently brick otherwise-valid
      // reservations. New writes stage outside this directory.
      if (entry.isSymbolicLink() || !entry.isFile()) {
        budgetError("CORRUPT", `Unsafe legacy workflow budget temporary entry: ${entry.name}`);
      }
      const temporaryStat = fs.lstatSync(path.join(paths.workflowReservationsDir, entry.name));
      if (temporaryStat.size > MAX_WORKFLOW_BUDGET_RECORD_BYTES) {
        budgetError("CORRUPT", `Legacy workflow budget temporary entry is too large: ${entry.name}`);
      }
      continue;
    }
    if (!match || entry.isSymbolicLink() || !entry.isFile()) {
      budgetError("CORRUPT", `Unexpected or unsafe workflow budget reservation entry: ${entry.name}`);
    }
    const reservation = readReservation(paths, match[1]);
    if (!reservation) {
      budgetError("CORRUPT", `Workflow budget reservation ${match[1]} disappeared during listing.`);
    }
    reservations.push(reservation);
  }
  const runCeilings = new Map<string, {
    maxCostUsd: number;
    maxTokens: number;
    maxModelCalls: number;
  }>();
  for (const reservation of reservations) {
    const ceiling = runCeilings.get(reservation.runId);
    if (
      ceiling &&
      (Math.abs(ceiling.maxCostUsd - reservation.runMaxCostUsd) > 1e-10 ||
        ceiling.maxTokens !== reservation.runMaxTokens ||
        ceiling.maxModelCalls !== reservation.runMaxModelCalls)
    ) {
      budgetError(
        "CORRUPT",
        `Workflow budget run ${reservation.runId} has inconsistent persisted ceilings.`,
      );
    }
    runCeilings.set(reservation.runId, {
      maxCostUsd: reservation.runMaxCostUsd,
      maxTokens: reservation.runMaxTokens,
      maxModelCalls: reservation.runMaxModelCalls,
    });
  }
  return reservations.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function runCommitment(
  records: WorkflowBudgetReservationV1[],
  runId: string,
): { costUsd: number; tokens: number; modelCalls: number } {
  let costUsd = 0;
  let tokens = 0;
  let modelCalls = 0;
  for (const record of records) {
    if (record.runId !== runId) continue;
    modelCalls += record.modelCallCount;
    if (record.status === "active") {
      costUsd += record.maxCostUsd;
      tokens += record.maxTokens;
      continue;
    }
    costUsd += record.settlement!.chargedCostUsd;
    tokens += record.settlement!.usageComplete
      ? record.settlement!.incrementalUsage.total
      : record.maxTokens;
  }
  if (
    !Number.isFinite(costUsd) ||
    !Number.isSafeInteger(tokens) ||
    !Number.isSafeInteger(modelCalls)
  ) {
    budgetError("CORRUPT", `Workflow budget run ${runId} commitments exceed safe numeric ranges.`);
  }
  return { costUsd, tokens, modelCalls };
}

function addSummaryMoney(total: number, value: number, label: string): number {
  const next = total + value;
  if (!Number.isFinite(next) || next < 0) {
    budgetError("CORRUPT", `Workflow run budget ${label} exceeds the numeric range.`);
  }
  return next;
}

function addSummaryInteger(total: number, value: number, label: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next) || next < 0) {
    budgetError("CORRUPT", `Workflow run budget ${label} exceeds the integer range.`);
  }
  return next;
}

function reconcileExpiredReservations(
  paths: ProjectPaths,
  records: WorkflowBudgetReservationV1[],
  now: number,
): { records: WorkflowBudgetReservationV1[]; reconciled: WorkflowBudgetReservationV1[] } {
  const reason = "Lease reconciliation charged the unobserved reserved maximum.";
  const settlementId = digest(settlementIntent({ status: "stale", reason }));
  const reconciled: WorkflowBudgetReservationV1[] = [];
  const updated = records.map((record) => {
    if (record.status !== "active" || record.expiresAt > now) return record;
    const settlement: WorkflowBudgetSettlementV1 = {
      settlementId,
      status: "stale",
      settledAt: now,
      usageComplete: false,
      incrementalUsage: emptyUsage(),
      chargedCostUsd: record.reservedCostUsd,
      limitExceeded: false,
      reason,
    };
    const stale: WorkflowBudgetReservationV1 = {
      ...record,
      status: "stale",
      updatedAt: now,
      settlement,
    };
    atomicWriteReservation(paths, stale);
    reconciled.push(stale);
    return stale;
  });
  return { records: updated, reconciled };
}

function readProjectSpendLimit(paths: ProjectPaths): number | null {
  const bytes = readSafeRegularFile(paths, paths.projectJson, 64 * 1_024, `Project ${paths.id} metadata`);
  if (!bytes) budgetError("NOT_FOUND", `Project ${paths.id} has no durable metadata.`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch {
    budgetError("CORRUPT", `Project ${paths.id} metadata is malformed JSON.`);
  }
  if (!isRecord(value) || value.id !== paths.id) {
    budgetError("CORRUPT", `Project ${paths.id} metadata does not identify this project.`);
  }
  if (value.spendLimitUsd === null) return null;
  if (
    typeof value.spendLimitUsd !== "number" ||
    !Number.isFinite(value.spendLimitUsd) ||
    value.spendLimitUsd < 0
  ) {
    budgetError("CORRUPT", `Project ${paths.id} has an invalid spendLimitUsd.`);
  }
  // Preserve the application's established semantics: zero means unlimited.
  return value.spendLimitUsd === 0 ? null : value.spendLimitUsd;
}

function parseLock(value: unknown): StoredBudgetLockV1 {
  if (
    !isRecord(value) || !hasOnlyKeys(value, ["version", "token", "pid", "hostname", "createdAt"]) ||
    value.version !== 1 || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
    !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 ||
    typeof value.hostname !== "string" || value.hostname.length < 1 || value.hostname.length > 255 ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
  ) {
    budgetError("CORRUPT", "Workflow budget lock metadata is malformed.");
  }
  return value as unknown as StoredBudgetLockV1;
}

function lockOwnerMayBeAlive(lock: StoredBudgetLockV1): boolean {
  if (lock.hostname !== os.hostname()) return true;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameLockOwner(left: StoredBudgetLockV1, right: StoredBudgetLockV1): boolean {
  return left.token === right.token &&
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.createdAt === right.createdAt;
}

function readLock(paths: ProjectPaths, lockFile: string): StoredBudgetLockV1 | null {
  const bytes = readSafeRegularFile(paths, lockFile, 4_096, "Workflow budget lock");
  if (!bytes) return null;
  try {
    return parseLock(JSON.parse(bytes.toString("utf-8")));
  } catch (error) {
    if (error instanceof WorkflowBudgetError) throw error;
    budgetError("CORRUPT", "Workflow budget lock is malformed JSON.");
  }
}

const projectAdmissionWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function workflowBudgetReservationId(...identity: Array<string | number>): string {
  if (identity.length === 0 || identity.some((part) => String(part).length === 0)) {
    budgetError("INVALID_ARGUMENT", "A workflow budget reservation id needs explicit identity parts.");
  }
  const hash = crypto.createHash("sha256");
  for (const part of identity) hash.update(String(part)).update("\0");
  return `wbres_${hash.digest("hex").slice(0, 32)}`;
}

export class WorkflowBudgetStore {
  private readonly now: () => number;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;

  constructor(options: WorkflowBudgetStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    if (!Number.isSafeInteger(this.lockWaitMs) || this.lockWaitMs < 1) {
      budgetError("INVALID_ARGUMENT", "Workflow budget lockWaitMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.lockStaleMs) || this.lockStaleMs < 1_000) {
      budgetError("INVALID_ARGUMENT", "Workflow budget lockStaleMs must be at least 1000ms.");
    }
  }

  private recoverDeadLock(
    paths: ProjectPaths,
    lockFile: string,
    observed: StoredBudgetLockV1,
    noFollow: number,
  ): boolean {
    if (lockOwnerMayBeAlive(observed)) return false;
    const recoveryFile = path.join(paths.workflowBudgetDir, ".mutation.recovery.lock");
    const recoveryOwner = this.acquireRecoveryLock(paths, recoveryFile, noFollow);
    if (!recoveryOwner) return false;

    try {
      const confirmed = readLock(paths, lockFile);
      if (
        !confirmed ||
        !sameLockOwner(confirmed, observed) ||
        Date.now() - confirmed.createdAt <= this.lockStaleMs ||
        lockOwnerMayBeAlive(confirmed)
      ) return false;
      fs.unlinkSync(lockFile);
      fsyncDirectory(paths.workflowBudgetDir);
      return true;
    } finally {
      const currentRecoveryOwner = readLock(paths, recoveryFile);
      if (!currentRecoveryOwner || !sameLockOwner(currentRecoveryOwner, recoveryOwner)) {
        budgetError("CORRUPT", "Workflow budget recovery lock changed owner before release.");
      }
      fs.unlinkSync(recoveryFile);
      fsyncDirectory(paths.workflowBudgetDir);
    }
  }

  private acquireRecoveryLock(
    paths: ProjectPaths,
    recoveryFile: string,
    noFollow: number,
  ): StoredBudgetLockV1 | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const owner: StoredBudgetLockV1 = {
        version: 1,
        token: crypto.randomBytes(32).toString("hex"),
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: Date.now(),
      };
      try {
        const fd = fs.openSync(
          recoveryFile,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          0o600,
        );
        try {
          fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      // Recovery is itself a recoverable ownership protocol. Never remove a
      // merely old lock while its local owner is alive, and re-read its token
      // immediately before unlinking so a replacement owner is fenced out.
      const observed = readLock(paths, recoveryFile);
      if (
        !observed ||
        Date.now() - observed.createdAt <= this.lockStaleMs ||
        lockOwnerMayBeAlive(observed)
      ) return null;
      const confirmed = readLock(paths, recoveryFile);
      if (
        !confirmed ||
        !sameLockOwner(confirmed, observed) ||
        Date.now() - confirmed.createdAt <= this.lockStaleMs ||
        lockOwnerMayBeAlive(confirmed)
      ) return null;
      try {
        fs.unlinkSync(recoveryFile);
        fsyncDirectory(paths.workflowBudgetDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  /**
   * Serialize a synchronous project-cap check and its durable commitment.
   * The callback must stay synchronous and must not re-enter this lock.
   */
  withProjectCostAdmissionLock<T>(projectId: string, criticalSection: () => T): T {
    assertProjectId(projectId);
    const paths = resolvePaths(projectId);
    assertSafeDirectoryChain(paths, paths.workflowBudgetDir, true);
    const lockFile = path.join(paths.workflowBudgetDir, ".mutation.lock");
    const deadline = Date.now() + this.lockWaitMs;
    const token = crypto.randomBytes(32).toString("hex");
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

    for (;;) {
      let acquired = false;
      try {
        const fd = fs.openSync(
          lockFile,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          0o600,
        );
        try {
          fs.writeFileSync(fd, `${JSON.stringify({
            version: 1,
            token,
            pid: process.pid,
            hostname: os.hostname(),
            createdAt: Date.now(),
          })}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (acquired) {
        try {
          const result = criticalSection();
          if (
            result !== null &&
            (typeof result === "object" || typeof result === "function") &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            budgetError("INVALID_ARGUMENT", "Project cost admission critical sections must be synchronous.");
          }
          return result;
        } finally {
          const current = readLock(paths, lockFile);
          if (!current || current.token !== token) {
            budgetError("CORRUPT", "Workflow budget lock changed owner before release.");
          }
          fs.unlinkSync(lockFile);
          fsyncDirectory(paths.workflowBudgetDir);
        }
      }

      const observed = readLock(paths, lockFile);
      if (!observed) continue;
      if (
        Date.now() - observed.createdAt > this.lockStaleMs &&
        this.recoverDeadLock(paths, lockFile, observed, noFollow)
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        budgetError("LOCK_TIMEOUT", `Timed out waiting for project ${projectId}'s workflow budget lock.`);
      }
      Atomics.wait(projectAdmissionWaitBuffer, 0, 0, Math.min(10, deadline - Date.now()));
    }
  }

  list(projectId: string): WorkflowBudgetReservationV1[] {
    assertProjectId(projectId);
    return listReservations(resolvePaths(projectId)).map(cloneRecord);
  }

  summary(projectId: string): WorkflowBudgetSummary {
    const summary: WorkflowBudgetSummary = {
      activeReservedUsd: 0,
      settledSpentUsd: 0,
      settledTokens: 0,
      activeCount: 0,
      settledCount: 0,
      staleCount: 0,
    };
    for (const record of this.list(projectId)) {
      if (record.status === "active") {
        summary.activeReservedUsd += record.reservedCostUsd;
        summary.activeCount += 1;
        continue;
      }
      summary.settledCount += 1;
      if (record.status === "stale") summary.staleCount += 1;
      summary.settledSpentUsd += record.settlement!.chargedCostUsd;
      summary.settledTokens += record.settlement!.incrementalUsage.total;
    }
    return summary;
  }

  async reserve(input: ReserveWorkflowBudgetInput): Promise<WorkflowBudgetReservationHandle> {
    assertProjectId(input.projectId);
    assertReservationId(input.reservationId);
    assertRunId(input.runId);
    const runMaxCostUsd = safeMoney(input.runMaxCostUsd, "runMaxCostUsd");
    const runMaxTokens = safeTokenCount(input.runMaxTokens, "runMaxTokens");
    if (runMaxTokens < 1) budgetError("INVALID_ARGUMENT", "runMaxTokens must be at least 1.");
    const runMaxModelCalls = safeModelCallCount(input.runMaxModelCalls, "runMaxModelCalls");
    const modelCallCount = safeModelCallCount(input.modelCallCount, "modelCallCount");
    if (modelCallCount > runMaxModelCalls) {
      budgetError("INVALID_ARGUMENT", "A workflow reservation cannot exceed its run model-call ceiling.");
    }
    const maxCostUsd = safeMoney(input.maxCostUsd, "maxCostUsd");
    const maxTokens = safeTokenCount(input.maxTokens, "maxTokens");
    if (maxTokens < 1) budgetError("INVALID_ARGUMENT", "maxTokens must be at least 1.");
    if (maxCostUsd > runMaxCostUsd + Number.EPSILON || maxTokens > runMaxTokens) {
      budgetError("INVALID_ARGUMENT", "A workflow reservation cannot exceed its run-wide ceiling.");
    }
    const initialUsage = normalizeUsage(input.initialUsage, "initialUsage");
    if (initialUsage.total > maxTokens || initialUsage.costUsd > maxCostUsd + Number.EPSILON) {
      budgetError("INVALID_ARGUMENT", "Initial workflow usage already exceeds the requested budget ceiling.");
    }
    const leaseDurationMs = safeLeaseDuration(
      input.leaseDurationMs ?? DEFAULT_WORKFLOW_BUDGET_LEASE_MS,
    );
    if (input.pipelineAdmissionIntent !== undefined &&
      !isPipelineReservationIntent(input.pipelineAdmissionIntent, input.projectId)) {
      budgetError("INVALID_ARGUMENT", "Invalid durable pipeline admission intent.");
    }
    const pipelineAdmissionIntent = input.pipelineAdmissionIntent === undefined
      ? undefined
      : structuredClone(input.pipelineAdmissionIntent);
    const intent = reservationIntent({
      projectId: input.projectId,
      reservationId: input.reservationId,
      runId: input.runId,
      runMaxCostUsd,
      runMaxTokens,
      runMaxModelCalls,
      modelCallCount,
      maxCostUsd,
      maxTokens,
      initialUsage,
      leaseDurationMs,
      ...(pipelineAdmissionIntent ? { pipelineAdmissionIntent } : {}),
    });
    const requestSha256 = digest(intent);

    const record = this.withProjectCostAdmissionLock(input.projectId, () => {
      const paths = resolvePaths(input.projectId);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        budgetError("CORRUPT", "Workflow budget clock returned an invalid timestamp.");
      }
      const reconciled = reconcileExpiredReservations(paths, listReservations(paths), now);
      const reservations = reconciled.records;
      const existing = reservations.find((candidate) => candidate.id === input.reservationId);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          budgetError("CONFLICT", `Workflow budget reservation ${input.reservationId} was reused for different work.`);
        }
        budgetError(
          "CONFLICT",
          `Workflow budget reservation ${input.reservationId} is already ${existing.status}; a second owner was not admitted.`,
        );
      }
      const persistedRunRecord = reservations.find((candidate) => candidate.runId === input.runId);
      if (
        persistedRunRecord &&
        (Math.abs(persistedRunRecord.runMaxCostUsd - runMaxCostUsd) > 1e-10 ||
          persistedRunRecord.runMaxTokens !== runMaxTokens ||
          persistedRunRecord.runMaxModelCalls !== runMaxModelCalls)
      ) {
        budgetError(
          "CONFLICT",
          `Workflow budget run ${input.runId} was already admitted with different run-wide ceilings.`,
        );
      }
      const committed = runCommitment(reservations, input.runId);
      if (
        committed.costUsd + maxCostUsd > runMaxCostUsd + Number.EPSILON ||
        committed.tokens + maxTokens > runMaxTokens ||
        committed.modelCalls + modelCallCount > runMaxModelCalls
      ) {
        budgetError(
          "LIMIT_EXCEEDED",
          `Workflow work would exceed run ${input.runId}'s ceiling: ` +
            `$${committed.costUsd.toFixed(4)} committed + $${maxCostUsd.toFixed(4)} maximum ` +
            `against $${runMaxCostUsd.toFixed(4)}, ${committed.tokens} tokens committed + ` +
            `${maxTokens} maximum against ${runMaxTokens}, ${committed.modelCalls} model calls ` +
            `committed + ${modelCallCount} against ${runMaxModelCalls}.`,
        );
      }

      const limitUsd = readProjectSpendLimit(paths);
      const current = projectCostSummary(input.projectId);
      const reservedCostUsd = Math.max(0, maxCostUsd - initialUsage.costUsd);
      if (
        limitUsd !== null &&
        current.committedUsd + reservedCostUsd > limitUsd + Number.EPSILON
      ) {
        budgetError(
          "LIMIT_EXCEEDED",
          `Workflow work would exceed the project spend limit: ` +
            `$${current.committedUsd.toFixed(4)} committed + ` +
            `$${reservedCostUsd.toFixed(4)} reserved > $${limitUsd.toFixed(4)}.`,
        );
      }
      const created: WorkflowBudgetReservationV1 = {
        version: WORKFLOW_BUDGET_RESERVATION_VERSION,
        id: input.reservationId,
        projectId: input.projectId,
        runId: input.runId,
        runMaxCostUsd,
        runMaxTokens,
        runMaxModelCalls,
        modelCallCount,
        requestSha256,
        status: "active",
        maxCostUsd,
        maxTokens,
        reservedCostUsd,
        initialUsage,
        leaseDurationMs,
        leaseGeneration: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + leaseDurationMs,
        ...(pipelineAdmissionIntent ? { pipelineAdmissionIntent } : {}),
      };
      atomicWriteReservation(paths, created);
      return created;
    });
    return this.handle(record);
  }

  async settle(
    projectId: string,
    reservationId: string,
    input: SettleWorkflowBudgetInput,
  ): Promise<WorkflowBudgetReservationV1> {
    assertProjectId(projectId);
    assertReservationId(reservationId);
    if (!(TERMINAL_STATUSES as readonly string[]).includes(input.status)) {
      budgetError("INVALID_ARGUMENT", `Invalid workflow budget settlement status: ${input.status}`);
    }
    const reason = input.reason?.trim();
    if (reason !== undefined && (
      reason.length < 1 || reason.length > 1_024 || /[\u0000-\u001f\u007f]/.test(reason)
    )) {
      budgetError("INVALID_ARGUMENT", "Workflow budget settlement reason must be 1-1024 printable characters.");
    }
    const observedUsage = input.usage === undefined
      ? undefined
      : normalizeUsage(input.usage, "settlement.usage");
    const settlementId = digest(settlementIntent({
      status: input.status,
      ...(observedUsage ? { observedUsage } : {}),
      ...(reason ? { reason } : {}),
    }));

    return this.withProjectCostAdmissionLock(projectId, () => {
      const paths = resolvePaths(projectId);
      const record = readReservation(paths, reservationId);
      if (!record) budgetError("NOT_FOUND", `No such workflow budget reservation: ${reservationId}`);
      if (record.status !== "active") {
        if (record.settlement?.settlementId === settlementId) return cloneRecord(record);
        budgetError("CONFLICT", `Workflow budget reservation ${reservationId} already settled as ${record.status}.`);
      }
      const incremental = observedUsage
        ? incrementalUsage(record.initialUsage, observedUsage)
        : emptyUsage();
      const chargedCostUsd = observedUsage ? incremental.costUsd : record.reservedCostUsd;
      const settledAt = this.now();
      if (!Number.isSafeInteger(settledAt) || settledAt < record.updatedAt) {
        budgetError("CORRUPT", "Workflow budget clock moved backwards during settlement.");
      }
      const settlement: WorkflowBudgetSettlementV1 = {
        settlementId,
        status: input.status,
        settledAt,
        usageComplete: observedUsage !== undefined,
        ...(observedUsage ? { observedUsage } : {}),
        incrementalUsage: incremental,
        chargedCostUsd,
        limitExceeded: observedUsage !== undefined && (
          observedUsage.total > record.maxTokens ||
          observedUsage.costUsd > record.maxCostUsd + Number.EPSILON
        ),
        ...(reason ? { reason } : {}),
      };
      const settled: WorkflowBudgetReservationV1 = {
        ...record,
        status: input.status,
        updatedAt: settledAt,
        settlement,
      };
      atomicWriteReservation(paths, settled);
      return cloneRecord(settled);
    });
  }

  async renew(
    projectId: string,
    reservationId: string,
    leaseDurationMs?: number,
  ): Promise<WorkflowBudgetReservationV1> {
    assertProjectId(projectId);
    assertReservationId(reservationId);
    return this.withProjectCostAdmissionLock(projectId, () => {
      const paths = resolvePaths(projectId);
      const record = readReservation(paths, reservationId);
      if (!record) budgetError("NOT_FOUND", `No such workflow budget reservation: ${reservationId}`);
      if (record.status !== "active") {
        budgetError("CONFLICT", `Workflow budget reservation ${reservationId} is already ${record.status}.`);
      }
      const duration = safeLeaseDuration(leaseDurationMs ?? record.leaseDurationMs);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < record.updatedAt) {
        budgetError("CORRUPT", "Workflow budget clock moved backwards during renewal.");
      }
      const renewed: WorkflowBudgetReservationV1 = {
        ...record,
        leaseDurationMs: duration,
        leaseGeneration: record.leaseGeneration + 1,
        updatedAt: now,
        expiresAt: now + duration,
      };
      atomicWriteReservation(paths, renewed);
      return cloneRecord(renewed);
    });
  }

  async reconcileStale(projectId: string): Promise<WorkflowBudgetReservationV1[]> {
    assertProjectId(projectId);
    return this.withProjectCostAdmissionLock(projectId, () => {
      const paths = resolvePaths(projectId);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        budgetError("CORRUPT", "Workflow budget clock returned an invalid timestamp.");
      }
      return reconcileExpiredReservations(paths, listReservations(paths), now)
        .reconciled.map(cloneRecord);
    });
  }

  private handle(record: WorkflowBudgetReservationV1): WorkflowBudgetReservationHandle {
    return {
      record: cloneRecord(record),
      settle: (input) => this.settle(record.projectId, record.id, input),
      renew: (leaseDurationMs) => this.renew(record.projectId, record.id, leaseDurationMs),
    };
  }
}

export const workflowBudgetStore = new WorkflowBudgetStore();

/**
 * Shared admission boundary for every subsystem that commits project spend.
 * Read the strict project summary and persist the new commitment inside the
 * callback. It is intentionally synchronous and non-reentrant.
 */
export function withProjectCostAdmissionLock<T>(
  projectId: string,
  criticalSection: () => T,
): T {
  return workflowBudgetStore.withProjectCostAdmissionLock(projectId, criticalSection);
}

export function listWorkflowBudgetReservations(projectId: string): WorkflowBudgetReservationV1[] {
  return workflowBudgetStore.list(projectId);
}

export function workflowBudgetSummary(projectId: string): WorkflowBudgetSummary {
  return workflowBudgetStore.summary(projectId);
}

export function workflowRunBudgetSummary(
  projectId: string,
  runId: string,
): WorkflowRunBudgetSummary {
  assertRunId(runId);
  const records = workflowBudgetStore.list(projectId).filter((record) => record.runId === runId);
  const first = records[0];
  const summary: WorkflowRunBudgetSummary = {
    runId,
    reservationCount: records.length,
    ceilings: first
      ? {
          maxCostUsd: first.runMaxCostUsd,
          maxTokens: first.runMaxTokens,
          maxModelCalls: first.runMaxModelCalls,
        }
      : null,
    modelCallCount: 0,
    activeReservationCount: 0,
    activeReservedMaximumUsd: 0,
    activeReservedMaximumTokens: 0,
    settledReservationCount: 0,
    settledChargedUsd: 0,
    observedUsageTokens: 0,
    missingUsageMaximumTokens: 0,
    staleReservationCount: 0,
    fullChargeReservationCount: 0,
  };

  for (const record of records) {
    summary.modelCallCount = addSummaryInteger(
      summary.modelCallCount,
      record.modelCallCount,
      "model-call count",
    );
    if (record.status === "active") {
      summary.activeReservationCount += 1;
      summary.activeReservedMaximumUsd = addSummaryMoney(
        summary.activeReservedMaximumUsd,
        record.reservedCostUsd,
        "active reserved maximum",
      );
      summary.activeReservedMaximumTokens = addSummaryInteger(
        summary.activeReservedMaximumTokens,
        record.maxTokens,
        "active reserved token maximum",
      );
      continue;
    }

    const settlement = record.settlement!;
    summary.settledReservationCount += 1;
    summary.settledChargedUsd = addSummaryMoney(
      summary.settledChargedUsd,
      settlement.chargedCostUsd,
      "settled charge",
    );
    if (record.status === "stale") summary.staleReservationCount += 1;
    if (settlement.usageComplete) {
      summary.observedUsageTokens = addSummaryInteger(
        summary.observedUsageTokens,
        settlement.incrementalUsage.total,
        "observed token usage",
      );
    } else {
      summary.fullChargeReservationCount += 1;
      summary.missingUsageMaximumTokens = addSummaryInteger(
        summary.missingUsageMaximumTokens,
        record.maxTokens,
        "missing-usage token maximum",
      );
    }
  }
  return summary;
}

export function reserveWorkflowBudget(
  input: ReserveWorkflowBudgetInput,
): Promise<WorkflowBudgetReservationHandle> {
  return workflowBudgetStore.reserve(input);
}

export function pipelineAdmissionCorrelationLabel(admissionId: string): string {
  if (!PIPELINE_ADMISSION_ID_RE.test(admissionId)) {
    budgetError("INVALID_ARGUMENT", `Invalid pipeline admission id: ${admissionId}`);
  }
  return `${PIPELINE_ADMISSION_LABEL_PREFIX}${admissionId}`;
}

export function pipelineAdmissionId(value: string): string {
  if (PIPELINE_ADMISSION_ID_RE.test(value)) return value;
  return `kadypipe_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function pipelineEngineAdmissionKey(projectId: string, admissionId: string): string {
  assertProjectId(projectId);
  if (!PIPELINE_ADMISSION_ID_RE.test(admissionId)) {
    budgetError("INVALID_ARGUMENT", `Invalid pipeline admission id: ${admissionId}`);
  }
  return `kadypipe_${crypto.createHash("sha256")
    .update(`${projectId}\0${admissionId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function pipelineAdmissionProjectLabel(projectId: string): string {
  assertProjectId(projectId);
  return `${PIPELINE_PROJECT_LABEL_PREFIX}${projectId}`;
}

export function pipelineAdmissionIdFromEngineSnapshot(snapshot: unknown): string | undefined {
  const root = isRecord(snapshot) ? snapshot : undefined;
  const run = isRecord(root?.run) ? root.run : root;
  const metadata = isRecord(run?.metadata) ? run.metadata : undefined;
  const metadataId = metadata?.kadyEngineAdmissionKey ?? metadata?.kady_engine_admission_key ??
    metadata?.kadyAdmissionId ?? metadata?.kady_admission_id;
  const validMetadataId = typeof metadataId === "string" && PIPELINE_ADMISSION_ID_RE.test(metadataId)
    ? metadataId
    : undefined;
  const userMessage = run && typeof run.user_message === "string"
    ? run.user_message
    : run && typeof run.userMessage === "string"
      ? run.userMessage
      : undefined;
  if (!userMessage) return validMetadataId;
  const matches = [...userMessage.matchAll(
    /(?:^|\s)KADY_PIPELINE_ADMISSION:(kadypipe_[a-f0-9]{32})(?=\s|$)/g,
  )];
  if (matches.length === 0) return validMetadataId;
  if (matches.length !== 1 || (validMetadataId && validMetadataId !== matches[0][1])) return undefined;
  return matches[0][1];
}

export function pipelineProjectIdFromEngineSnapshot(snapshot: unknown): string | undefined {
  const root = isRecord(snapshot) ? snapshot : undefined;
  const run = isRecord(root?.run) ? root.run : root;
  const metadata = isRecord(run?.metadata) ? run.metadata : undefined;
  const metadataProjectId = metadata?.kadyProjectId ?? metadata?.kady_project_id;
  const validMetadataProjectId = typeof metadataProjectId === "string" && PROJECT_ID_RE.test(metadataProjectId)
    ? metadataProjectId
    : undefined;
  const userMessage = run && typeof run.user_message === "string"
    ? run.user_message
    : run && typeof run.userMessage === "string"
      ? run.userMessage
      : undefined;
  if (!userMessage) return validMetadataProjectId;
  const matches = [...userMessage.matchAll(
    /(?:^|\s)KADY_PIPELINE_PROJECT:([a-z0-9][a-z0-9_-]{0,63})(?=\s|$)/g,
  )];
  if (matches.length === 0) return validMetadataProjectId;
  if (matches.length !== 1 || (validMetadataProjectId && validMetadataProjectId !== matches[0][1])) {
    return undefined;
  }
  return matches[0][1];
}

function pipelineAdmissionRecordFromReservation(
  reservation: WorkflowBudgetReservationV1,
): PipelineAdmissionRecordV1 {
  const intent = reservation.pipelineAdmissionIntent;
  if (!intent) {
    budgetError("CORRUPT", `Workflow reservation ${reservation.id} has no pipeline admission intent.`);
  }
  return {
    version: PIPELINE_ADMISSION_VERSION,
    admissionId: intent.admissionId,
    projectId: reservation.projectId,
    workflowName: intent.workflowName,
    reservationId: reservation.id,
    budgetRunId: reservation.runId,
    correlationLabel: intent.correlationLabel,
    projectLabel: intent.projectLabel,
    engineAdmissionKey: intent.engineAdmissionKey,
    requestSha256: intent.requestSha256,
    workflowRevisionSha256: intent.workflowRevisionSha256,
    workflowNodeCount: intent.workflowNodeCount,
    nodeIds: structuredClone(intent.nodeIds),
    capCountedNodeIds: structuredClone(intent.capCountedNodeIds),
    ownerInstanceId: intent.ownerInstanceId,
    status: reservation.status === "active" ? "intent" : "settled",
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
  };
}

export function persistPipelineAdmission(
  admission: PipelineBudgetAdmission,
  workflowName: string,
  requestSha256: string,
  workflowRevisionSha256: string,
): PipelineAdmissionRecordV1 {
  if (!SHA256_RE.test(requestSha256) || !SHA256_RE.test(workflowRevisionSha256)) {
    budgetError("INVALID_ARGUMENT", "Pipeline admission request and workflow revision digests must be SHA-256.");
  }
  const projectId = admission.handle.record.projectId;
  const admissionId = admission.admissionId;
  const engineAdmissionKey = pipelineEngineAdmissionKey(projectId, admissionId);
  const correlationLabel = pipelineAdmissionCorrelationLabel(engineAdmissionKey);
  const projectLabel = pipelineAdmissionProjectLabel(projectId);
  const nodeIds = admission.hooks.map((hook) => hook.nodeId);
  const capCountedNodeIds = admission.hooks
    .filter((hook) => billingCountsTowardBudget(hook.billing))
    .map((hook) => hook.nodeId);
  const now = Date.now();
  return workflowBudgetStore.withProjectCostAdmissionLock(projectId, () => {
    const paths = resolvePaths(projectId);
    const existing = readPipelineAdmissionRecord(paths, admissionId);
    if (existing) {
      if (
        existing.workflowName === workflowName &&
        existing.reservationId === admission.handle.record.id &&
        existing.budgetRunId === admission.runId &&
        existing.correlationLabel === correlationLabel &&
        existing.projectLabel === projectLabel &&
        existing.engineAdmissionKey === engineAdmissionKey &&
        existing.requestSha256 === requestSha256 &&
        existing.workflowRevisionSha256 === workflowRevisionSha256 &&
        existing.workflowNodeCount === admission.workflowNodeCount &&
        isDeepStrictEqual(existing.nodeIds, nodeIds) &&
        isDeepStrictEqual(existing.capCountedNodeIds, capCountedNodeIds)
      ) return structuredClone(existing);
      budgetError("CONFLICT", `Pipeline admission ${admissionId} already has a different owner.`);
    }
    const reservation = readReservation(paths, admission.handle.record.id);
    if (!reservation || reservation.status !== "active" || reservation.runId !== admission.runId) {
      budgetError("CONFLICT", `Pipeline admission ${admissionId} has no active durable reservation.`);
    }
    if (reservation.pipelineAdmissionIntent) {
      const expected = pipelineAdmissionRecordFromReservation(reservation);
      if (
        expected.workflowName !== workflowName ||
        expected.requestSha256 !== requestSha256 ||
        expected.workflowRevisionSha256 !== workflowRevisionSha256 ||
        expected.workflowNodeCount !== admission.workflowNodeCount ||
        !isDeepStrictEqual(expected.nodeIds, nodeIds) ||
        !isDeepStrictEqual(expected.capCountedNodeIds, capCountedNodeIds)
      ) {
        budgetError("CONFLICT", `Pipeline admission ${admissionId} contradicts its atomic reservation intent.`);
      }
    }
    const record: PipelineAdmissionRecordV1 = {
      version: PIPELINE_ADMISSION_VERSION,
      admissionId,
      projectId,
      workflowName,
      reservationId: reservation.id,
      budgetRunId: reservation.runId,
      correlationLabel,
      projectLabel,
      engineAdmissionKey,
      requestSha256,
      workflowRevisionSha256,
      workflowNodeCount: admission.workflowNodeCount,
      nodeIds,
      capCountedNodeIds,
      ownerInstanceId: PIPELINE_ADMISSION_OWNER_INSTANCE_ID,
      status: "intent",
      createdAt: now,
      updatedAt: now,
    };
    atomicWritePipelineAdmission(paths, record);
    return structuredClone(record);
  });
}

export function updatePipelineAdmission(
  projectId: string,
  admissionId: string,
  update: { status: "dispatching" | "indeterminate" | "dispatched" | "settled"; engineRunId?: string },
): PipelineAdmissionRecordV1 {
  if (update.engineRunId !== undefined && !ENGINE_RUN_ID_RE.test(update.engineRunId)) {
    budgetError("INVALID_ARGUMENT", `Invalid pipeline engine run id: ${update.engineRunId}`);
  }
  return workflowBudgetStore.withProjectCostAdmissionLock(projectId, () => {
    const paths = resolvePaths(projectId);
    const existing = readPipelineAdmissionRecord(paths, admissionId);
    if (!existing) budgetError("NOT_FOUND", `No such pipeline admission: ${admissionId}`);
    if (
      existing.engineRunId !== undefined && update.engineRunId !== undefined &&
      existing.engineRunId !== update.engineRunId
    ) {
      budgetError("CONFLICT", `Pipeline admission ${admissionId} is owned by another engine run.`);
    }
    const transitionAllowed = existing.status === update.status ||
      (existing.status === "intent" && update.status === "dispatching") ||
      ((existing.status === "dispatching" || existing.status === "indeterminate") &&
        update.status === "dispatched") ||
      (existing.status === "settling" && update.status === "settled");
    if (!transitionAllowed) {
      budgetError(
        "CONFLICT",
        `Pipeline admission ${admissionId} cannot transition from ${existing.status} to ${update.status}.`,
      );
    }
    const next: PipelineAdmissionRecordV1 = {
      ...existing,
      ...(update.engineRunId === undefined ? {} : { engineRunId: update.engineRunId }),
      status: update.status,
      updatedAt: Math.max(existing.updatedAt, Date.now()),
    };
    atomicWritePipelineAdmission(paths, next);
    return structuredClone(next);
  });
}

export function beginPipelineAdmissionSettlement(
  projectId: string,
  admissionId: string,
  input: SettleWorkflowBudgetInput,
  engineRunId?: string,
): PipelineAdmissionRecordV1 {
  const settlementIntent: PipelineSettlementIntentV1 = {
    status: input.status,
    ...(input.usage === undefined ? {} : { usage: structuredClone(input.usage) }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(engineRunId === undefined ? {} : { engineRunId }),
  };
  if (!isPipelineSettlementIntent(settlementIntent)) {
    budgetError("INVALID_ARGUMENT", "Invalid pipeline settlement intent.");
  }
  return workflowBudgetStore.withProjectCostAdmissionLock(projectId, () => {
    const paths = resolvePaths(projectId);
    const existing = readPipelineAdmissionRecord(paths, admissionId);
    if (!existing) budgetError("NOT_FOUND", `No such pipeline admission: ${admissionId}`);
    if (existing.status === "settled") return structuredClone(existing);
    if (existing.status === "settling") {
      if (isDeepStrictEqual(existing.settlementIntent, settlementIntent)) {
        return structuredClone(existing);
      }
      budgetError("CONFLICT", `Pipeline admission ${admissionId} already has another settlement intent.`);
    }
    if (existing.engineRunId !== undefined && engineRunId !== undefined &&
      existing.engineRunId !== engineRunId) {
      budgetError("CONFLICT", `Pipeline admission ${admissionId} is owned by another engine run.`);
    }
    const next: PipelineAdmissionRecordV1 = {
      ...existing,
      ...(engineRunId === undefined ? {} : { engineRunId }),
      status: "settling",
      settlementIntent,
      updatedAt: Math.max(existing.updatedAt, Date.now()),
    };
    atomicWritePipelineAdmission(paths, next);
    return structuredClone(next);
  });
}

export async function completePipelineAdmissionSettlement(
  projectId: string,
  admissionId: string,
): Promise<WorkflowBudgetReservationV1> {
  const recovered = recoverPipelineAdmission(projectId, admissionId);
  if (recovered.record.status === "settled") return recovered.admission.handle.record;
  if (recovered.record.status !== "settling" || !recovered.record.settlementIntent) {
    budgetError("CONFLICT", `Pipeline admission ${admissionId} has no durable settlement intent.`);
  }
  const { engineRunId: _engineRunId, ...settlement } = recovered.record.settlementIntent;
  const entry = await recovered.admission.handle.settle(settlement);
  updatePipelineAdmission(projectId, admissionId, {
    status: "settled",
    ...(recovered.record.engineRunId === undefined
      ? {}
      : { engineRunId: recovered.record.engineRunId }),
  });
  return entry;
}

export async function settlePipelineAdmission(
  projectId: string,
  admissionId: string,
  input: SettleWorkflowBudgetInput,
  engineRunId?: string,
): Promise<WorkflowBudgetReservationV1> {
  beginPipelineAdmissionSettlement(projectId, admissionId, input, engineRunId);
  return completePipelineAdmissionSettlement(projectId, admissionId);
}

export function recoverPipelineAdmission(
  projectId: string,
  admissionId: string,
): { record: PipelineAdmissionRecordV1; admission: PipelineBudgetAdmission } {
  const paths = resolvePaths(projectId);
  const record = readPipelineAdmissionRecord(paths, admissionId);
  if (!record) budgetError("NOT_FOUND", `No such pipeline admission: ${admissionId}`);
  const reservation = readReservation(paths, record.reservationId);
  if (!reservation || reservation.runId !== record.budgetRunId) {
    budgetError("CORRUPT", `Pipeline admission ${admissionId} lost its durable reservation owner.`);
  }
  return {
    record: structuredClone(record),
    admission: {
      admissionId,
      runId: record.budgetRunId,
      workflowNodeCount: record.workflowNodeCount,
      hooks: [],
      handle: {
        record: cloneRecord(reservation),
        settle: (input) => workflowBudgetStore.settle(projectId, reservation.id, input),
        renew: (leaseDurationMs) =>
          workflowBudgetStore.renew(projectId, reservation.id, leaseDurationMs),
      },
    },
  };
}

export function findPipelineAdmission(
  projectId: string,
  admissionId: string,
): ReturnType<typeof recoverPipelineAdmission> | undefined {
  const record = readPipelineAdmissionRecord(resolvePaths(projectId), admissionId);
  return record ? recoverPipelineAdmission(projectId, admissionId) : undefined;
}

export function findPipelineAdmissionByEngineKey(
  projectId: string,
  engineAdmissionKey: string,
): ReturnType<typeof recoverPipelineAdmission> | undefined {
  if (!PIPELINE_ADMISSION_ID_RE.test(engineAdmissionKey)) {
    budgetError("INVALID_ARGUMENT", `Invalid pipeline engine admission key: ${engineAdmissionKey}`);
  }
  const record = listPipelineAdmissions(projectId).find(
    (candidate) => candidate.engineAdmissionKey === engineAdmissionKey,
  );
  return record ? recoverPipelineAdmission(projectId, record.admissionId) : undefined;
}

export function recoverPipelineAdmissionIntents(projectId: string): PipelineAdmissionRecordV1[] {
  return workflowBudgetStore.withProjectCostAdmissionLock(projectId, () => {
    const paths = resolvePaths(projectId);
    const recovered: PipelineAdmissionRecordV1[] = [];
    for (const reservation of listReservations(paths)) {
      if (!reservation.pipelineAdmissionIntent) continue;
      const expected = pipelineAdmissionRecordFromReservation(reservation);
      const existing = readPipelineAdmissionRecord(paths, expected.admissionId);
      if (existing) {
        if (
          existing.reservationId !== expected.reservationId ||
          existing.engineAdmissionKey !== expected.engineAdmissionKey ||
          existing.requestSha256 !== expected.requestSha256 ||
          existing.workflowRevisionSha256 !== expected.workflowRevisionSha256
        ) {
          budgetError(
            "CORRUPT",
            `Pipeline admission ${expected.admissionId} contradicts its reservation intent.`,
          );
        }
        recovered.push(structuredClone(existing));
        continue;
      }
      atomicWritePipelineAdmission(paths, expected);
      recovered.push(structuredClone(expected));
    }
    return recovered;
  });
}

export function listPipelineAdmissions(projectId: string): PipelineAdmissionRecordV1[] {
  const paths = resolvePaths(projectId);
  const directory = pipelineAdmissionsDirectory(paths);
  if (!assertSafeDirectoryChain(paths, directory, false)) return [];
  const records: PipelineAdmissionRecordV1[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = /^(kadypipe_[a-f0-9]{32})\.json$/.exec(entry.name);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) {
      budgetError("CORRUPT", `Unexpected or unsafe pipeline admission entry: ${entry.name}`);
    }
    const record = readPipelineAdmissionRecord(paths, match[1]);
    if (!record) budgetError("CORRUPT", `Pipeline admission ${match[1]} disappeared during listing.`);
    records.push(record);
  }
  return records.sort((left, right) => left.createdAt - right.createdAt ||
    left.admissionId.localeCompare(right.admissionId));
}

/**
 * Atomically reserve a legacy pipeline's complete NodeSpec budget envelope.
 * Nodes classified as non-cap-counted by the central billing policy retain
 * token ceilings and audit metadata but do not consume the project's USD cap.
 * One reservation prevents partial per-node
 * admission if the aggregate cannot fit.
 */
export async function reservePipelineNodeBudgets(input: {
  projectId: string;
  admissionId: string;
  workflowNodeCount: number;
  hooks: PipelineNodeBudgetHook[];
  leaseDurationMs?: number;
  durableIntent?: {
    workflowName: string;
    requestSha256: string;
    workflowRevisionSha256: string;
  };
}): Promise<PipelineBudgetAdmission> {
  if (input.hooks.length === 0) {
    budgetError("INVALID_ARGUMENT", "An executable pipeline must have at least one resolved budget hook.");
  }
  if (!Number.isSafeInteger(input.workflowNodeCount) || input.workflowNodeCount < 1) {
    budgetError("INVALID_ARGUMENT", "Pipeline workflow node count must be a positive integer.");
  }
  const admissionId = pipelineAdmissionId(input.admissionId);
  const seen = new Set<string>();
  let maxTokens = 0;
  let maxCostUsd = 0;
  let modelCallCount = 0;
  for (const hook of input.hooks) {
    if (!hook.nodeId || seen.has(hook.nodeId)) {
      budgetError("INVALID_ARGUMENT", "Pipeline NodeSpec budget hooks require unique node ids.");
    }
    seen.add(hook.nodeId);
    modelCallCount = safeModelCallCount(
      modelCallCount + safeModelCallCount(
        hook.modelCallCount ?? 1,
        `Node ${hook.nodeId} modelCallCount`,
      ),
      "pipeline aggregate modelCallCount",
    );
    maxTokens = safeTokenCount(maxTokens + safeTokenCount(
      hook.maxTokens,
      `Node ${hook.nodeId} budget.maxTokens`,
    ), "pipeline aggregate maxTokens");
    const nodeCost = safeMoney(hook.maxCostUsd, `Node ${hook.nodeId} budget.maxCostUsd`);
    const capCounted = billingCountsTowardBudget(hook.billing);
    if (capCounted && nodeCost <= 0) {
      budgetError(
        "INVALID_ARGUMENT",
        `Cap-counted pipeline node ${hook.nodeId} requires a positive maxCostUsd envelope.`,
      );
    }
    maxCostUsd = safeMoney(
      maxCostUsd + (capCounted ? nodeCost : 0),
      "pipeline aggregate maxCostUsd",
    );
  }
  if (maxTokens < 1) {
    budgetError("INVALID_ARGUMENT", "Pipeline NodeSpec budgets must admit at least one token.");
  }
  const identity = admissionId.slice("kadypipe_".length);
  const runId = `pipeline:${identity}`;
  const pipelineAdmissionIntent = input.durableIntent === undefined
    ? undefined
    : {
        admissionId,
        workflowName: input.durableIntent.workflowName,
        engineAdmissionKey: pipelineEngineAdmissionKey(input.projectId, admissionId),
        correlationLabel: pipelineAdmissionCorrelationLabel(
          pipelineEngineAdmissionKey(input.projectId, admissionId),
        ),
        projectLabel: pipelineAdmissionProjectLabel(input.projectId),
        requestSha256: input.durableIntent.requestSha256,
        workflowRevisionSha256: input.durableIntent.workflowRevisionSha256,
        workflowNodeCount: input.workflowNodeCount,
        nodeIds: input.hooks.map((hook) => hook.nodeId),
        capCountedNodeIds: input.hooks
          .filter((hook) => billingCountsTowardBudget(hook.billing))
          .map((hook) => hook.nodeId),
        ownerInstanceId: PIPELINE_ADMISSION_OWNER_INSTANCE_ID,
      } satisfies PipelineReservationIntentV1;
  const handle = await reserveWorkflowBudget({
    projectId: input.projectId,
    reservationId: workflowBudgetReservationId("pipeline", identity),
    runId,
    runMaxCostUsd: maxCostUsd,
    runMaxTokens: maxTokens,
    runMaxModelCalls: modelCallCount,
    modelCallCount,
    maxCostUsd,
    maxTokens,
    ...(pipelineAdmissionIntent ? { pipelineAdmissionIntent } : {}),
    ...(input.leaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: input.leaseDurationMs }),
  });
  return {
    admissionId,
    runId,
    workflowNodeCount: input.workflowNodeCount,
    hooks: structuredClone(input.hooks),
    handle,
  };
}

export function reconcileStaleWorkflowBudgetReservations(
  projectId: string,
): Promise<WorkflowBudgetReservationV1[]> {
  return workflowBudgetStore.reconcileStale(projectId);
}
