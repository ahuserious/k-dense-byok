/**
 * Durable, content-free ownership journal for external workflow operations.
 * Prompts, results, credentials, and error text are deliberately not accepted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const WORKFLOW_SUPERVISOR_JOURNAL_VERSION = 1 as const;
export const MAX_WORKFLOW_SUPERVISOR_RECORD_BYTES = 16 * 1_024;
export const DEFAULT_MAX_WORKFLOW_SUPERVISOR_RECORDS = 100_000;

const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVATION_ID_RE = /^wbres_[a-f0-9]{32}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^[A-Z][A-Z0-9_:-]{0,63}$/;
const MAX_IDENTITY_BYTES = 256;

const OPERATION_KINDS = ["pi-subagent", "hosted-fusion"] as const;
const STATES = ["prepared", "running", "terminal", "quarantined"] as const;
const SETTLEMENT_STATUSES = ["completed", "failed", "aborted", "timed-out", "stale"] as const;
const TERMINAL_OUTCOMES = ["completed", "failed", "aborted", "timed-out", "unstarted"] as const;

export type WorkflowSupervisorOperationKind = typeof OPERATION_KINDS[number];
export type WorkflowSupervisorOperationState = typeof STATES[number];
export type WorkflowSupervisorSettlementStatus = typeof SETTLEMENT_STATUSES[number];
export type WorkflowSupervisorTerminalOutcome = typeof TERMINAL_OUTCOMES[number];

export type WorkflowSupervisorJournalErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_LARGE"
  | "CORRUPT"
  | "UNSUPPORTED_VERSION";

export class WorkflowSupervisorJournalError extends Error {
  constructor(
    readonly code: WorkflowSupervisorJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowSupervisorJournalError";
  }
}

export interface PrepareWorkflowSupervisorOperationInput {
  operationId: string;
  requestDigest: string;
  kind: WorkflowSupervisorOperationKind;
  projectId: string;
  backendEpoch: string;
  ownerRunId: string;
  nodeId: string;
  executionId?: string;
  slotId?: string;
  reservationId?: string;
}

export interface MarkWorkflowSupervisorRunningInput {
  ownerId: string;
  pid?: number;
  processInstanceId?: string;
}

export interface RecordWorkflowSupervisorSettlementInput {
  settlementId: string;
  status: WorkflowSupervisorSettlementStatus;
  usageComplete: boolean;
}

/**
 * Accounting-only projection of one settlement, sufficient to reapply it to the
 * durable budget store without redispatching provider work. Token counts and a
 * normalized cost are not prompts, results, credentials, or error text, so this
 * stays inside the journal's content-free contract.
 */
export interface WorkflowSupervisorPendingSettlementBudgetV1 {
  status: string;
  reason?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };
}

export interface PrepareWorkflowSupervisorSettlementInput
  extends RecordWorkflowSupervisorSettlementInput {
  budget: WorkflowSupervisorPendingSettlementBudgetV1;
}

export interface WorkflowSupervisorPendingSettlementV1
  extends PrepareWorkflowSupervisorSettlementInput {
  preparedAt: number;
}

export interface MarkWorkflowSupervisorTerminalInput {
  outcome: WorkflowSupervisorTerminalOutcome;
  code: string;
  proofSha256?: string;
}

export interface QuarantineWorkflowSupervisorOperationInput {
  reasonCode: string;
  proofSha256?: string;
}

export interface WorkflowSupervisorRunningV1 extends MarkWorkflowSupervisorRunningInput {
  startedAt: number;
}

export interface WorkflowSupervisorSettlementV1 extends RecordWorkflowSupervisorSettlementInput {
  settledAt: number;
}

export interface WorkflowSupervisorTerminalV1 extends MarkWorkflowSupervisorTerminalInput {
  terminalAt: number;
}

export interface WorkflowSupervisorQuarantineV1 extends QuarantineWorkflowSupervisorOperationInput {
  quarantinedAt: number;
}

export interface WorkflowSupervisorRecordV1 extends PrepareWorkflowSupervisorOperationInput {
  version: typeof WORKFLOW_SUPERVISOR_JOURNAL_VERSION;
  state: WorkflowSupervisorOperationState;
  preparedAt: number;
  updatedAt: number;
  running?: WorkflowSupervisorRunningV1;
  pendingSettlement?: WorkflowSupervisorPendingSettlementV1;
  settlement?: WorkflowSupervisorSettlementV1;
  terminal?: WorkflowSupervisorTerminalV1;
  quarantine?: WorkflowSupervisorQuarantineV1;
}

export interface WorkflowSupervisorStartupRecovery {
  terminalUnstarted: string[];
  quarantined: string[];
  /** Prepared-but-unapplied settlements the caller must still reapply. */
  settlementPending: string[];
}

export interface WorkflowSupervisorJournalOptions {
  stateDirectory: string;
  now?: () => number;
  maximumRecords?: number;
}

const PREPARE_KEYS = [
  "operationId", "requestDigest", "kind", "projectId", "backendEpoch",
  "ownerRunId", "nodeId", "executionId", "slotId", "reservationId",
] as const;
const RECORD_KEYS = [
  "version", ...PREPARE_KEYS, "state", "preparedAt", "updatedAt",
  "running", "pendingSettlement", "settlement", "terminal", "quarantine",
] as const;

function fail(code: WorkflowSupervisorJournalErrorCode, message: string): never {
  throw new WorkflowSupervisorJournalError(code, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    fail(code, `${label} contains unsupported fields.`);
  }
}

function identity(
  value: unknown,
  label: string,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTITY_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) fail(code, `${label} must be a bounded printable identity.`);
}

function digest(
  value: unknown,
  label: string,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(code, `${label} must be a lowercase SHA-256 digest.`);
  }
}

function machineCode(
  value: unknown,
  label: string,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !CODE_RE.test(value)) {
    fail(code, `${label} must be a bounded machine-readable code.`);
  }
}

function timestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("CORRUPT", `${label} must be a non-negative safe integer.`);
  }
}

function operationId(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
    fail(code, `Invalid workflow supervisor operation id: ${String(value)}`);
  }
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(code, `Invalid ${label}: ${String(value)}`);
  }
}

function validatePrepare(
  input: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts input is PrepareWorkflowSupervisorOperationInput {
  strictKeys(input, PREPARE_KEYS, "Workflow supervisor prepare input", code);
  operationId(input.operationId, code);
  digest(input.requestDigest, "requestDigest", code);
  oneOf(input.kind, OPERATION_KINDS, "workflow supervisor operation kind", code);
  if (typeof input.projectId !== "string" || !PROJECT_ID_RE.test(input.projectId)) {
    fail(code, `Invalid workflow supervisor project id: ${String(input.projectId)}`);
  }
  identity(input.backendEpoch, "backendEpoch", code);
  identity(input.ownerRunId, "ownerRunId", code);
  identity(input.nodeId, "nodeId", code);
  if (input.executionId !== undefined) identity(input.executionId, "executionId", code);
  if (input.slotId !== undefined) identity(input.slotId, "slotId", code);
  if (
    input.reservationId !== undefined &&
    (typeof input.reservationId !== "string" || !RESERVATION_ID_RE.test(input.reservationId))
  ) fail(code, "Invalid workflow supervisor reservation id.");
}

function validateRunning(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is WorkflowSupervisorRunningV1 {
  strictKeys(value, ["ownerId", "pid", "processInstanceId", "startedAt"], "Running receipt", code);
  identity(value.ownerId, "ownerId", code);
  if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1)) {
    fail(code, "pid must be a positive safe integer.");
  }
  if (value.processInstanceId !== undefined) identity(value.processInstanceId, "processInstanceId", code);
  timestamp(value.startedAt, "running.startedAt");
}

function validateSettlement(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is WorkflowSupervisorSettlementV1 {
  strictKeys(value, ["settlementId", "status", "usageComplete", "settledAt"], "Settlement receipt", code);
  digest(value.settlementId, "settlementId", code);
  oneOf(value.status, SETTLEMENT_STATUSES, "workflow supervisor settlement status", code);
  if (typeof value.usageComplete !== "boolean") fail(code, "usageComplete must be boolean.");
  if (value.status === "completed" && !value.usageComplete) {
    fail(code, "A completed settlement must include complete usage.");
  }
  timestamp(value.settledAt, "settlement.settledAt");
}

function validateTerminal(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is WorkflowSupervisorTerminalV1 {
  strictKeys(value, ["outcome", "code", "proofSha256", "terminalAt"], "Terminal receipt", code);
  oneOf(value.outcome, TERMINAL_OUTCOMES, "workflow supervisor terminal outcome", code);
  machineCode(value.code, "terminal code", code);
  if (value.proofSha256 !== undefined) digest(value.proofSha256, "terminal proofSha256", code);
  timestamp(value.terminalAt, "terminal.terminalAt");
}

function validatePendingSettlementBudget(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is WorkflowSupervisorPendingSettlementBudgetV1 {
  strictKeys(value, ["status", "reason", "usage"], "Pending settlement budget", code);
  for (const [label, field] of [["status", value.status], ["reason", value.reason]] as const) {
    if (label === "reason" && field === undefined) continue;
    if (typeof field !== "string" || field.length < 1 || field.length > 128) {
      fail(code, `Pending settlement budget ${label} must be a bounded string.`);
    }
  }
  if (value.usage === undefined) return;
  strictKeys(
    value.usage,
    ["input", "output", "cacheRead", "cacheWrite", "total", "cost"],
    "Pending settlement usage",
    code,
  );
  for (const label of ["input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const) {
    const amount = (value.usage as Record<string, unknown>)[label];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      fail(code, `Pending settlement usage ${label} must be a non-negative finite number.`);
    }
  }
}

function validatePendingSettlement(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is WorkflowSupervisorPendingSettlementV1 {
  strictKeys(
    value,
    ["settlementId", "status", "usageComplete", "budget", "preparedAt"],
    "Pending settlement",
    code,
  );
  digest(value.settlementId, "settlementId", code);
  oneOf(value.status, SETTLEMENT_STATUSES, "workflow supervisor settlement status", code);
  if (typeof value.usageComplete !== "boolean") fail(code, "usageComplete must be boolean.");
  if (value.status === "completed" && !value.usageComplete) {
    fail(code, "A completed settlement must include complete usage.");
  }
  validatePendingSettlementBudget(value.budget, code);
  timestamp(value.preparedAt, "pendingSettlement.preparedAt");
}

function validateQuarantine(
  value: unknown,
  code: WorkflowSupervisorJournalErrorCode,
): asserts value is WorkflowSupervisorQuarantineV1 {
  strictKeys(value, ["reasonCode", "proofSha256", "quarantinedAt"], "Quarantine receipt", code);
  machineCode(value.reasonCode, "quarantine reasonCode", code);
  if (value.proofSha256 !== undefined) digest(value.proofSha256, "quarantine proofSha256", code);
  timestamp(value.quarantinedAt, "quarantine.quarantinedAt");
}

function validateStored(value: unknown, expectedOperationId: string): WorkflowSupervisorRecordV1 {
  strictKeys(value, RECORD_KEYS, "Workflow supervisor record", "CORRUPT");
  if (value.version !== WORKFLOW_SUPERVISOR_JOURNAL_VERSION) {
    fail("UNSUPPORTED_VERSION", `Unsupported workflow supervisor record version: ${String(value.version)}`);
  }
  const prepared = Object.fromEntries(PREPARE_KEYS.map((key) => [key, value[key]]));
  validatePrepare(prepared, "CORRUPT");
  if (prepared.operationId !== expectedOperationId) {
    fail("CORRUPT", "Workflow supervisor record id does not match its filename.");
  }
  oneOf(value.state, STATES, "workflow supervisor state", "CORRUPT");
  timestamp(value.preparedAt, "preparedAt");
  timestamp(value.updatedAt, "updatedAt");
  if (value.updatedAt < value.preparedAt) fail("CORRUPT", "updatedAt precedes preparedAt.");

  if (value.running !== undefined) validateRunning(value.running, "CORRUPT");
  if (value.pendingSettlement !== undefined) {
    validatePendingSettlement(value.pendingSettlement, "CORRUPT");
  }
  if (value.settlement !== undefined) validateSettlement(value.settlement, "CORRUPT");
  if (value.terminal !== undefined) validateTerminal(value.terminal, "CORRUPT");
  if (value.quarantine !== undefined) validateQuarantine(value.quarantine, "CORRUPT");
  if (value.settlement !== undefined && value.running === undefined) {
    fail("CORRUPT", "Settlement receipt exists without a running operation.");
  }
  if (value.pendingSettlement !== undefined && value.running === undefined) {
    fail("CORRUPT", "Pending settlement exists without a running operation.");
  }
  if (
    value.settlement !== undefined &&
    value.pendingSettlement !== undefined &&
    value.settlement.settlementId !== value.pendingSettlement.settlementId
  ) {
    fail("CORRUPT", "Settlement receipt does not match its prepared settlement.");
  }
  for (const [label, receiptAt] of [
    ["running.startedAt", value.running?.startedAt],
    ["pendingSettlement.preparedAt", value.pendingSettlement?.preparedAt],
    ["settlement.settledAt", value.settlement?.settledAt],
    ["terminal.terminalAt", value.terminal?.terminalAt],
    ["quarantine.quarantinedAt", value.quarantine?.quarantinedAt],
  ] as const) {
    if (receiptAt !== undefined && (receiptAt < value.preparedAt || receiptAt > value.updatedAt)) {
      fail("CORRUPT", `${label} lies outside the record lifecycle.`);
    }
  }

  if (value.state === "prepared" && (value.running || value.terminal || value.quarantine)) {
    fail("CORRUPT", "Prepared operation has execution receipts.");
  }
  if (value.state === "running" && (!value.running || value.terminal || value.quarantine)) {
    fail("CORRUPT", "Running operation has inconsistent receipts.");
  }
  if (value.state === "quarantined" && (!value.running || !value.quarantine || value.terminal)) {
    fail("CORRUPT", "Quarantined operation has inconsistent receipts.");
  }
  if (value.state === "terminal") {
    if (!value.terminal) fail("CORRUPT", "Terminal operation has no terminal receipt.");
    if (value.terminal.outcome === "unstarted" && value.running) {
      fail("CORRUPT", "Unstarted operation has a running receipt.");
    }
    if (value.terminal.outcome !== "unstarted" && !value.running) {
      fail("CORRUPT", "Started terminal operation has no running receipt.");
    }
    if (
      value.terminal.outcome === "completed" &&
      value.settlement?.status !== "completed"
    ) {
      fail("CORRUPT", "Completed operation has no completed usage settlement.");
    }
  }
  return value as unknown as WorkflowSupervisorRecordV1;
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    // Some supported Windows filesystems cannot fsync a directory handle.
    if (process.platform !== "win32") throw error;
  }
}

function sameFile(before: fs.Stats, after: fs.Stats): boolean {
  return (before.dev === 0 && before.ino === 0) ||
    (before.dev === after.dev && before.ino === after.ino);
}

function clone(record: WorkflowSupervisorRecordV1): WorkflowSupervisorRecordV1 {
  return structuredClone(record);
}

function sameFields(left: object, right: object, keys: readonly string[]): boolean {
  return keys.every((key) => Reflect.get(left, key) === Reflect.get(right, key));
}

export class WorkflowSupervisorJournal {
  readonly stateDirectory: string;
  private readonly now: () => number;
  private readonly maximumRecords: number;

  constructor(options: WorkflowSupervisorJournalOptions) {
    strictKeys(
      options,
      ["stateDirectory", "now", "maximumRecords"],
      "Workflow supervisor journal options",
      "INVALID_ARGUMENT",
    );
    if (typeof options.stateDirectory !== "string" || options.stateDirectory.trim() === "") {
      fail("INVALID_ARGUMENT", "stateDirectory must be non-empty.");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      fail("INVALID_ARGUMENT", "now must be a function.");
    }
    const maximumRecords = options.maximumRecords ?? DEFAULT_MAX_WORKFLOW_SUPERVISOR_RECORDS;
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
      fail("INVALID_ARGUMENT", "maximumRecords must be a positive safe integer.");
    }
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.now = options.now ?? Date.now;
    this.maximumRecords = maximumRecords;
    this.ensureDirectory();
  }

  private recordIds(): string[] {
    this.ensureDirectory();
    const ids = fs.readdirSync(this.stateDirectory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => {
        const id = entry.name.slice(0, -5);
        operationId(id, "CORRUPT");
        if (entry.isSymbolicLink() || !entry.isFile()) {
          fail("CORRUPT", `${entry.name} is not a regular record.`);
        }
        return id;
      });
    if (ids.length > this.maximumRecords) {
      fail(
        "TOO_LARGE",
        `Workflow supervisor journal exceeds its ${this.maximumRecords}-record capacity.`,
      );
    }
    return ids;
  }

  private ensureDirectory(): void {
    try {
      fs.mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      fail("CORRUPT", `Workflow supervisor state path is invalid: ${(error as Error).message}`);
    }
    const stat = fs.lstatSync(this.stateDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("CORRUPT", "Workflow supervisor state path must be a real directory.");
    }
    if (process.platform !== "win32") fs.chmodSync(this.stateDirectory, 0o700);
  }

  private recordFile(id: string): string {
    operationId(id, "INVALID_ARGUMENT");
    return path.join(this.stateDirectory, `${id}.json`);
  }

  private currentTime(previous?: number): number {
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0 || (previous !== undefined && current < previous)) {
      fail("CORRUPT", "Workflow supervisor clock is invalid or moved backwards.");
    }
    return current;
  }

  private bytes(record: WorkflowSupervisorRecordV1): Buffer {
    validateStored(record, record.operationId);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.length > MAX_WORKFLOW_SUPERVISOR_RECORD_BYTES) {
      fail("TOO_LARGE", `Workflow supervisor record exceeds ${MAX_WORKFLOW_SUPERVISOR_RECORD_BYTES} bytes.`);
    }
    return bytes;
  }

  private temporaryFile(id: string, bytes: Buffer): string {
    this.ensureDirectory();
    const temporary = path.join(this.stateDirectory, `.${id}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return temporary;
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private publish(record: WorkflowSupervisorRecordV1, createOnly: boolean): boolean {
    const file = this.recordFile(record.operationId);
    if (!createOnly && !this.read(record.operationId)) {
      fail("NOT_FOUND", `No such workflow supervisor operation: ${record.operationId}`);
    }
    const temporary = this.temporaryFile(record.operationId, this.bytes(record));
    try {
      if (createOnly) {
        try {
          // Publish complete, already-fsynced bytes without overwriting a rival prepare.
          fs.linkSync(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      } else {
        fs.renameSync(temporary, file);
      }
      fsyncDirectory(this.stateDirectory);
      return true;
    } finally {
      fs.rmSync(temporary, { force: true });
      fsyncDirectory(this.stateDirectory);
    }
  }

  private read(id: string): WorkflowSupervisorRecordV1 | null {
    const file = this.recordFile(id);
    this.ensureDirectory();
    let before: fs.Stats;
    try {
      before = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) fail("CORRUPT", `${id} is not a regular record.`);
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      fail("CORRUPT", `${id} is not a private record.`);
    }
    if (before.size < 1 || before.size > MAX_WORKFLOW_SUPERVISOR_RECORD_BYTES) {
      fail("TOO_LARGE", `${id} has an invalid record size.`);
    }
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (["ELOOP", "EMLINK"].includes(String((error as NodeJS.ErrnoException).code))) {
        fail("CORRUPT", `${id} is a symbolic link.`);
      }
      throw error;
    }
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !sameFile(before, opened)) fail("CORRUPT", `${id} changed while opening.`);
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      if (!sameFile(opened, after) || after.size !== opened.size || bytes.length !== opened.size) {
        fail("CORRUPT", `${id} changed while reading.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("CORRUPT", `${id} is not valid JSON.`);
      }
      return validateStored(parsed, id);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /** A prior publish may have installed the exact bytes and then surfaced a
   * directory-fsync failure. Replaying that transition may report success only
   * after the containing directory is durably synchronized. */
  private durableReplay(record: WorkflowSupervisorRecordV1): WorkflowSupervisorRecordV1 {
    fsyncDirectory(this.stateDirectory);
    return clone(record);
  }

  prepare(input: PrepareWorkflowSupervisorOperationInput): WorkflowSupervisorRecordV1 {
    validatePrepare(input, "INVALID_ARGUMENT");
    const existing = this.read(input.operationId);
    if (existing) {
      if (sameFields(existing, input, PREPARE_KEYS)) return this.durableReplay(existing);
      fail("CONFLICT", `Workflow supervisor operation ${input.operationId} was prepared differently.`);
    }
    if (this.recordIds().length >= this.maximumRecords) {
      fail(
        "TOO_LARGE",
        `Workflow supervisor journal reached its ${this.maximumRecords}-record capacity.`,
      );
    }
    const preparedAt = this.currentTime();
    const record: WorkflowSupervisorRecordV1 = {
      version: WORKFLOW_SUPERVISOR_JOURNAL_VERSION,
      ...input,
      state: "prepared",
      preparedAt,
      updatedAt: preparedAt,
    };
    if (this.publish(record, true)) return clone(record);
    const raced = this.read(input.operationId);
    if (raced && sameFields(raced, input, PREPARE_KEYS)) return this.durableReplay(raced);
    fail("CONFLICT", `Workflow supervisor operation ${input.operationId} was concurrently prepared differently.`);
  }

  markRunning(id: string, input: MarkWorkflowSupervisorRunningInput): WorkflowSupervisorRecordV1 {
    validateRunning({ ...input, startedAt: 0 }, "INVALID_ARGUMENT");
    const record = this.required(id);
    if (record.running) {
      if (sameFields(record.running, input, ["ownerId", "pid", "processInstanceId"])) {
        return this.durableReplay(record);
      }
      fail("CONFLICT", `${id} already has a different owner.`);
    }
    if (record.state !== "prepared") fail("CONFLICT", `${id} cannot start from ${record.state}.`);
    const updatedAt = this.currentTime(record.updatedAt);
    return this.replace({
      ...record,
      state: "running",
      updatedAt,
      running: { ...input, startedAt: updatedAt },
    });
  }

  /**
   * Write-ahead half of a settlement. The intent must be durable before it is
   * applied to the budget store: a failure between the two would otherwise
   * discard usage the provider really reported, and the record's terminal
   * transition would consume the operation identity with nothing to replay.
   */
  prepareSettlement(
    id: string,
    input: PrepareWorkflowSupervisorSettlementInput,
  ): WorkflowSupervisorRecordV1 {
    validatePendingSettlement({ ...input, preparedAt: 0 }, "INVALID_ARGUMENT");
    const record = this.required(id);
    if (record.pendingSettlement) {
      if (
        sameFields(record.pendingSettlement, input, ["settlementId", "status", "usageComplete"]) &&
        isDeepStrictEqual(record.pendingSettlement.budget, input.budget)
      ) {
        return this.durableReplay(record);
      }
      fail("CONFLICT", `${id} already prepared a different settlement.`);
    }
    if (record.state === "prepared" || record.state === "terminal" || !record.running) {
      fail("CONFLICT", `${id} cannot prepare settlement from ${record.state}.`);
    }
    const updatedAt = this.currentTime(record.updatedAt);
    return this.replace({
      ...record,
      updatedAt,
      pendingSettlement: { ...structuredClone(input), preparedAt: updatedAt },
    });
  }

  recordSettlement(id: string, input: RecordWorkflowSupervisorSettlementInput): WorkflowSupervisorRecordV1 {
    validateSettlement({ ...input, settledAt: 0 }, "INVALID_ARGUMENT");
    const record = this.required(id);
    if (record.settlement) {
      if (sameFields(record.settlement, input, ["settlementId", "status", "usageComplete"])) {
        return this.durableReplay(record);
      }
      fail("CONFLICT", `${id} already has a different settlement.`);
    }
    if (
      record.pendingSettlement &&
      !sameFields(record.pendingSettlement, input, ["settlementId", "status", "usageComplete"])
    ) {
      fail("CONFLICT", `${id} settled differently from its prepared settlement.`);
    }
    if (record.state === "prepared" || record.state === "terminal" || !record.running) {
      fail("CONFLICT", `${id} cannot record settlement from ${record.state}.`);
    }
    const updatedAt = this.currentTime(record.updatedAt);
    return this.replace({
      ...record,
      updatedAt,
      settlement: { ...input, settledAt: updatedAt },
    });
  }

  markTerminal(id: string, input: MarkWorkflowSupervisorTerminalInput): WorkflowSupervisorRecordV1 {
    validateTerminal({ ...input, terminalAt: 0 }, "INVALID_ARGUMENT");
    const record = this.required(id);
    if (record.terminal) {
      if (sameFields(record.terminal, input, ["outcome", "code", "proofSha256"])) {
        return this.durableReplay(record);
      }
      fail("CONFLICT", `${id} already has a different terminal receipt.`);
    }
    if (record.state === "prepared" && input.outcome !== "unstarted") {
      fail("CONFLICT", `Prepared operation ${id} can only become unstarted.`);
    }
    if (record.state !== "prepared" && input.outcome === "unstarted") {
      fail("CONFLICT", `Started operation ${id} cannot become unstarted.`);
    }
    if (input.outcome === "completed" && record.settlement?.status !== "completed") {
      fail("CONFLICT", `Completed operation ${id} requires a completed settlement.`);
    }
    const updatedAt = this.currentTime(record.updatedAt);
    return this.replace({
      ...record,
      state: "terminal",
      updatedAt,
      terminal: { ...input, terminalAt: updatedAt },
    });
  }

  quarantine(id: string, input: QuarantineWorkflowSupervisorOperationInput): WorkflowSupervisorRecordV1 {
    validateQuarantine({ ...input, quarantinedAt: 0 }, "INVALID_ARGUMENT");
    const record = this.required(id);
    if (record.quarantine) {
      if (sameFields(record.quarantine, input, ["reasonCode", "proofSha256"])) {
        return this.durableReplay(record);
      }
      fail("CONFLICT", `${id} already has a different quarantine receipt.`);
    }
    if (record.state !== "running") fail("CONFLICT", `${id} cannot be quarantined from ${record.state}.`);
    const updatedAt = this.currentTime(record.updatedAt);
    return this.replace({
      ...record,
      state: "quarantined",
      updatedAt,
      quarantine: { ...input, quarantinedAt: updatedAt },
    });
  }

  snapshot(id: string): WorkflowSupervisorRecordV1 | null {
    operationId(id, "INVALID_ARGUMENT");
    const record = this.read(id);
    return record ? clone(record) : null;
  }

  list(): WorkflowSupervisorRecordV1[] {
    const ids = this.recordIds()
      .sort((left, right) => left.localeCompare(right));
    return ids.map((id) => {
      const record = this.read(id);
      if (!record) fail("CORRUPT", `${id} vanished while listing.`);
      return clone(record);
    });
  }

  recoverStartup(): WorkflowSupervisorStartupRecovery {
    const recovery: WorkflowSupervisorStartupRecovery = {
      terminalUnstarted: [],
      quarantined: [],
      settlementPending: [],
    };
    for (const record of this.list()) {
      // Ownership stays uncertain across supervisor death, so a running record
      // still quarantines below. Its prepared-but-unapplied accounting is a
      // separate obligation the caller can still discharge exactly once.
      if (record.pendingSettlement && !record.settlement) {
        recovery.settlementPending.push(record.operationId);
      }
      if (record.state === "prepared") {
        this.markTerminal(record.operationId, {
          outcome: "unstarted",
          code: "STARTUP_RECOVERY_UNSTARTED",
        });
        recovery.terminalUnstarted.push(record.operationId);
      } else if (record.state === "running") {
        this.quarantine(record.operationId, {
          reasonCode: "STARTUP_RECOVERY_RUNNING_UNCERTAIN",
        });
        recovery.quarantined.push(record.operationId);
      }
    }
    return recovery;
  }

  private required(id: string): WorkflowSupervisorRecordV1 {
    operationId(id, "INVALID_ARGUMENT");
    const record = this.read(id);
    if (!record) fail("NOT_FOUND", `No such workflow supervisor operation: ${id}`);
    return record;
  }

  private replace(record: WorkflowSupervisorRecordV1): WorkflowSupervisorRecordV1 {
    this.publish(record, false);
    return clone(record);
  }
}
