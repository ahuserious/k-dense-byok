import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

export const DAG_FUSION_COMPACTION_AUDIT_VERSION = 1 as const;
export const DAG_FUSION_COMPACTION_AUDIT_MAX_BYTES = 64 * 1024;
export const DAG_FUSION_COMPACTION_AUDIT_MAX_ATTEMPTS = 32;

const MAX_RUN_ID_BYTES = 1_024;
const MAX_ENTRY_ID_BYTES = 1_024;
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_CUSTOM_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_MESSAGE_COUNT = 50_000;
const MAX_BRANCH_ENTRY_COUNT = 100_000;
const MAX_FILE_OPERATION_COUNT = 50_000;
const MAX_TOKEN_COUNT = 1_000_000_000;
const AUDIT_DIRECTORY_SEGMENTS = [".kady", "workflows", "compaction-audit"] as const;
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);

export type DagFusionCompactionAuditPhase = "pre" | "post";
export type DagFusionCompactionAuditFailureCode =
  | "PRE_INVALID_SHAPE"
  | "PRE_LIMIT_EXCEEDED"
  | "PRE_OVERLAPPED"
  | "POST_INVALID_SHAPE"
  | "POST_LIMIT_EXCEEDED"
  | "POST_MISMATCH"
  | "POST_MISSING"
  | "POST_WITHOUT_PRE";

export type DagFusionCompactionAuditReadErrorCode =
  | "AUDIT_INVALID_RUN_ID"
  | "AUDIT_MISSING"
  | "AUDIT_PATH_UNSAFE"
  | "AUDIT_TOO_LARGE"
  | "AUDIT_MALFORMED";

export class DagFusionCompactionAuditReadError extends Error {
  constructor(
    message: string,
    readonly code: DagFusionCompactionAuditReadErrorCode,
    readonly phase: DagFusionCompactionAuditPhase = "pre",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DagFusionCompactionAuditReadError";
  }
}

interface TextFingerprint {
  sha256: string;
  utf8Bytes: number;
}

interface PreMetadata {
  firstKeptEntryId: TextFingerprint;
  messagesToSummarizeCount: number;
  turnPrefixMessagesCount: number;
  branchEntryCount: number;
  tokensBefore: number;
  isSplitTurn: boolean;
  previousSummary?: TextFingerprint;
  customInstructions?: TextFingerprint;
  fileOps: {
    readCount: number;
    writtenCount: number;
    editedCount: number;
  };
  settings: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}

interface PostMetadata {
  firstKeptEntryId: TextFingerprint;
  summary: TextFingerprint;
  tokensBefore: number;
  fromExtension: boolean;
}

interface AuditHeaderRecord {
  version: typeof DAG_FUSION_COMPACTION_AUDIT_VERSION;
  sequence: 0;
  kind: "header";
  runId: TextFingerprint;
}

interface AuditPhaseRecord {
  version: typeof DAG_FUSION_COMPACTION_AUDIT_VERSION;
  sequence: number;
  kind: DagFusionCompactionAuditPhase;
  attempt: number;
  passed: boolean;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  metadata?: PreMetadata | PostMetadata;
  errorCode?: DagFusionCompactionAuditFailureCode;
}

type AuditRecord = AuditHeaderRecord | AuditPhaseRecord;

export interface TrustedDagFusionCompactionCheck {
  attempt: number;
  phase: DagFusionCompactionAuditPhase;
  passed: boolean;
  errorCode?: DagFusionCompactionAuditFailureCode;
}

export interface TrustedDagFusionCompactionAudit {
  occurred: boolean;
  checks: TrustedDagFusionCompactionCheck[];
}

interface PendingPreAudit {
  attempt: number;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  metadata: PreMetadata;
}

interface AuditController {
  before(event: SessionBeforeCompactEvent): { cancel: true } | undefined;
  after(event: SessionCompactEvent): void;
}

export interface InstallDagFusionCompactionAuditOptions {
  env?: NodeJS.ProcessEnv;
  sandboxRoot?: string;
}

function readError(
  message: string,
  code: DagFusionCompactionAuditReadErrorCode,
  phase: DagFusionCompactionAuditPhase = "pre",
  cause?: unknown,
): never {
  throw new DagFusionCompactionAuditReadError(
    message,
    code,
    phase,
    cause === undefined ? undefined : { cause },
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function safeInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fingerprint(value: string): TextFingerprint {
  return {
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    utf8Bytes: utf8Bytes(value),
  };
}

function boundedFingerprint(
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): TextFingerprint | undefined {
  if (typeof value !== "string") return undefined;
  const byteLength = utf8Bytes(value);
  if ((!allowEmpty && byteLength === 0) || byteLength > maximumBytes) return undefined;
  return fingerprint(value);
}

function validReason(value: unknown): value is "manual" | "threshold" | "overflow" {
  return typeof value === "string" && COMPACTION_REASONS.has(value);
}

function normalizeSandboxRoot(value: string): string {
  if (!value || value.includes("\0")) {
    return readError("The compaction-audit sandbox root is invalid.", "AUDIT_PATH_UNSAFE");
  }
  const resolved = path.resolve(value);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    return readError(
      "The compaction-audit sandbox root does not exist.",
      "AUDIT_PATH_UNSAFE",
      "pre",
      error,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return readError(
      "The compaction-audit sandbox root must be a real directory.",
      "AUDIT_PATH_UNSAFE",
    );
  }
  return resolved;
}

function ensureSafeAuditDirectory(sandboxRoot: string, create: boolean): string {
  const root = normalizeSandboxRoot(sandboxRoot);
  let current = root;
  for (const segment of AUDIT_DIRECTORY_SEGMENTS) {
    current = path.join(current, segment);
    if (create) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return readError(
            "The compaction-audit directory could not be created safely.",
            "AUDIT_PATH_UNSAFE",
            "pre",
            error,
          );
        }
      }
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "AUDIT_MISSING"
        : "AUDIT_PATH_UNSAFE";
      return readError(
        "The compaction-audit directory is unavailable.",
        code,
        "pre",
        error,
      );
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return readError(
        "A compaction-audit path component is not a real directory.",
        "AUDIT_PATH_UNSAFE",
      );
    }
  }

  const realRoot = fs.realpathSync(root);
  const realCurrent = fs.realpathSync(current);
  const relative = path.relative(realRoot, realCurrent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return readError(
      "The compaction-audit directory escapes the project sandbox.",
      "AUDIT_PATH_UNSAFE",
    );
  }
  return current;
}

function validateRunId(runId: string): TextFingerprint {
  const value = boundedFingerprint(runId, MAX_RUN_ID_BYTES);
  if (!value) {
    return readError(
      "PI_SUBAGENT_RUN_ID must be a non-empty bounded string.",
      "AUDIT_INVALID_RUN_ID",
    );
  }
  return value;
}

export function dagFusionCompactionAuditPath(sandboxRoot: string, runId: string): string {
  const runIdFingerprint = validateRunId(runId);
  return path.join(
    path.resolve(sandboxRoot),
    ...AUDIT_DIRECTORY_SEGMENTS,
    `${runIdFingerprint.sha256}.jsonl`,
  );
}

function noFollowFlag(): number {
  const value = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;
  return typeof value === "number" ? value : 0;
}

function assertSafeOpenedFile(stats: fs.Stats, phase: DagFusionCompactionAuditPhase): void {
  const permissionsArePrivate = process.platform === "win32" || (stats.mode & 0o077) === 0;
  if (
    !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 ||
    !permissionsArePrivate
  ) {
    readError(
      "The compaction-audit sidecar is not a private single-link regular file.",
      "AUDIT_PATH_UNSAFE",
      phase,
    );
  }
}

function serializedRecord(record: AuditRecord): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (encoded.byteLength > 8 * 1024) {
    return readError("A compaction-audit record is unexpectedly large.", "AUDIT_TOO_LARGE");
  }
  return encoded;
}

function createAuditSidecar(sandboxRoot: string, runId: string): string {
  const runIdFingerprint = validateRunId(runId);
  const directory = ensureSafeAuditDirectory(sandboxRoot, true);
  const auditPath = path.join(directory, `${runIdFingerprint.sha256}.jsonl`);
  const header = serializedRecord({
    version: DAG_FUSION_COMPACTION_AUDIT_VERSION,
    sequence: 0,
    kind: "header",
    runId: runIdFingerprint,
  });
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      auditPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    assertSafeOpenedFile(fs.fstatSync(descriptor), "pre");
    if (fs.writeSync(descriptor, header) !== header.byteLength) {
      readError("The compaction-audit header was only partly written.", "AUDIT_MALFORMED");
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof DagFusionCompactionAuditReadError) throw error;
    readError(
      "The compaction-audit sidecar could not be initialized exclusively.",
      "AUDIT_PATH_UNSAFE",
      "pre",
      error,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return auditPath;
}

function appendAuditRecord(auditPath: string, record: AuditPhaseRecord): void {
  const encoded = serializedRecord(record);
  let descriptor: number | undefined;
  try {
    const pathStats = fs.lstatSync(auditPath);
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) {
      readError(
        "The compaction-audit sidecar path changed identity.",
        "AUDIT_PATH_UNSAFE",
        record.kind,
      );
    }
    descriptor = fs.openSync(
      auditPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor);
    assertSafeOpenedFile(opened, record.kind);
    if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino) {
      readError(
        "The compaction-audit sidecar changed during open.",
        "AUDIT_PATH_UNSAFE",
        record.kind,
      );
    }
    if (opened.size + encoded.byteLength > DAG_FUSION_COMPACTION_AUDIT_MAX_BYTES) {
      readError(
        "The compaction-audit sidecar reached its hard size bound.",
        "AUDIT_TOO_LARGE",
        record.kind,
      );
    }
    if (fs.writeSync(descriptor, encoded) !== encoded.byteLength) {
      readError(
        "A compaction-audit record was only partly written.",
        "AUDIT_MALFORMED",
        record.kind,
      );
    }
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function preMetadata(
  event: SessionBeforeCompactEvent,
): { ok: true; value: PreMetadata } | { ok: false; code: DagFusionCompactionAuditFailureCode } {
  if (
    !event || !isPlainRecord(event.preparation) ||
    !Array.isArray(event.preparation.messagesToSummarize) ||
    !Array.isArray(event.preparation.turnPrefixMessages) ||
    !Array.isArray(event.branchEntries) ||
    typeof event.preparation.isSplitTurn !== "boolean" ||
    !validReason(event.reason) || typeof event.willRetry !== "boolean" ||
    !isPlainRecord(event.preparation.fileOps) ||
    !(event.preparation.fileOps.read instanceof Set) ||
    !(event.preparation.fileOps.written instanceof Set) ||
    !(event.preparation.fileOps.edited instanceof Set) ||
    !isPlainRecord(event.preparation.settings) ||
    typeof event.preparation.settings.enabled !== "boolean"
  ) {
    return { ok: false, code: "PRE_INVALID_SHAPE" };
  }
  const firstKeptEntryId = boundedFingerprint(
    event.preparation.firstKeptEntryId,
    MAX_ENTRY_ID_BYTES,
  );
  const previousSummary = event.preparation.previousSummary === undefined
    ? undefined
    : boundedFingerprint(event.preparation.previousSummary, MAX_SUMMARY_BYTES, true);
  const customInstructions = event.customInstructions === undefined
    ? undefined
    : boundedFingerprint(event.customInstructions, MAX_CUSTOM_INSTRUCTIONS_BYTES, true);
  if (
    !firstKeptEntryId ||
    (event.preparation.previousSummary !== undefined && !previousSummary) ||
    (event.customInstructions !== undefined && !customInstructions) ||
    event.preparation.messagesToSummarize.length > MAX_MESSAGE_COUNT ||
    event.preparation.turnPrefixMessages.length > MAX_MESSAGE_COUNT ||
    event.branchEntries.length > MAX_BRANCH_ENTRY_COUNT ||
    event.preparation.fileOps.read.size > MAX_FILE_OPERATION_COUNT ||
    event.preparation.fileOps.written.size > MAX_FILE_OPERATION_COUNT ||
    event.preparation.fileOps.edited.size > MAX_FILE_OPERATION_COUNT ||
    !safeInteger(event.preparation.tokensBefore, MAX_TOKEN_COUNT) ||
    !safeInteger(event.preparation.settings.reserveTokens, MAX_TOKEN_COUNT) ||
    !safeInteger(event.preparation.settings.keepRecentTokens, MAX_TOKEN_COUNT)
  ) {
    return { ok: false, code: "PRE_LIMIT_EXCEEDED" };
  }
  return {
    ok: true,
    value: {
      firstKeptEntryId,
      messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
      turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
      branchEntryCount: event.branchEntries.length,
      tokensBefore: event.preparation.tokensBefore,
      isSplitTurn: event.preparation.isSplitTurn,
      ...(previousSummary ? { previousSummary } : {}),
      ...(customInstructions ? { customInstructions } : {}),
      fileOps: {
        readCount: event.preparation.fileOps.read.size,
        writtenCount: event.preparation.fileOps.written.size,
        editedCount: event.preparation.fileOps.edited.size,
      },
      settings: {
        enabled: event.preparation.settings.enabled,
        reserveTokens: event.preparation.settings.reserveTokens,
        keepRecentTokens: event.preparation.settings.keepRecentTokens,
      },
    },
  };
}

function postMetadata(
  event: SessionCompactEvent,
): { ok: true; value: PostMetadata } | { ok: false; code: DagFusionCompactionAuditFailureCode } {
  if (
    !event || !isPlainRecord(event.compactionEntry) ||
    !validReason(event.reason) || typeof event.willRetry !== "boolean" ||
    typeof event.fromExtension !== "boolean"
  ) {
    return { ok: false, code: "POST_INVALID_SHAPE" };
  }
  const firstKeptEntryId = boundedFingerprint(
    event.compactionEntry.firstKeptEntryId,
    MAX_ENTRY_ID_BYTES,
  );
  const summary = boundedFingerprint(event.compactionEntry.summary, MAX_SUMMARY_BYTES);
  if (
    !firstKeptEntryId || !summary ||
    !safeInteger(event.compactionEntry.tokensBefore, MAX_TOKEN_COUNT)
  ) {
    return { ok: false, code: "POST_LIMIT_EXCEEDED" };
  }
  return {
    ok: true,
    value: {
      firstKeptEntryId,
      summary,
      tokensBefore: event.compactionEntry.tokensBefore,
      fromExtension: event.fromExtension,
    },
  };
}

function sameFingerprint(left: TextFingerprint, right: TextFingerprint): boolean {
  return left.sha256 === right.sha256 && left.utf8Bytes === right.utf8Bytes;
}

function createAuditController(auditPath: string): AuditController {
  let sequence = 0;
  let nextAttempt = 1;
  let pending: PendingPreAudit | undefined;

  return {
    before(event) {
      const attempt = nextAttempt++;
      const sequenceNumber = ++sequence;
      if (attempt > DAG_FUSION_COMPACTION_AUDIT_MAX_ATTEMPTS) {
        appendAuditRecord(auditPath, {
          version: DAG_FUSION_COMPACTION_AUDIT_VERSION,
          sequence: sequenceNumber,
          kind: "pre",
          attempt,
          passed: false,
          reason: validReason(event.reason) ? event.reason : "manual",
          willRetry: event.willRetry === true,
          errorCode: "PRE_LIMIT_EXCEEDED",
        });
        return { cancel: true };
      }
      if (pending) {
        appendAuditRecord(auditPath, {
          version: DAG_FUSION_COMPACTION_AUDIT_VERSION,
          sequence: sequenceNumber,
          kind: "pre",
          attempt,
          passed: false,
          reason: validReason(event.reason) ? event.reason : "manual",
          willRetry: event.willRetry === true,
          errorCode: "PRE_OVERLAPPED",
        });
        return { cancel: true };
      }
      const metadata = preMetadata(event);
      if (!metadata.ok) {
        appendAuditRecord(auditPath, {
          version: DAG_FUSION_COMPACTION_AUDIT_VERSION,
          sequence: sequenceNumber,
          kind: "pre",
          attempt,
          passed: false,
          reason: validReason(event.reason) ? event.reason : "manual",
          willRetry: event.willRetry === true,
          errorCode: metadata.code,
        });
        return { cancel: true };
      }
      pending = {
        attempt,
        reason: event.reason,
        willRetry: event.willRetry,
        metadata: metadata.value,
      };
      appendAuditRecord(auditPath, {
        version: DAG_FUSION_COMPACTION_AUDIT_VERSION,
        sequence: sequenceNumber,
        kind: "pre",
        attempt,
        passed: true,
        reason: event.reason,
        willRetry: event.willRetry,
        metadata: metadata.value,
      });
      return undefined;
    },
    after(event) {
      const active = pending;
      const metadata = postMetadata(event);
      let errorCode: DagFusionCompactionAuditFailureCode | undefined;
      if (!active) {
        errorCode = "POST_WITHOUT_PRE";
      } else if (!metadata.ok) {
        errorCode = metadata.code;
      } else if (
        event.reason !== active.reason ||
        event.willRetry !== active.willRetry ||
        metadata.value.tokensBefore !== active.metadata.tokensBefore ||
        !sameFingerprint(
          metadata.value.firstKeptEntryId,
          active.metadata.firstKeptEntryId,
        )
      ) {
        errorCode = "POST_MISMATCH";
      }
      const attempt = active?.attempt ?? nextAttempt++;
      appendAuditRecord(auditPath, {
        version: DAG_FUSION_COMPACTION_AUDIT_VERSION,
        sequence: ++sequence,
        kind: "post",
        attempt,
        passed: errorCode === undefined,
        reason: validReason(event.reason) ? event.reason : "manual",
        willRetry: event.willRetry === true,
        ...(metadata.ok ? { metadata: metadata.value } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
      pending = undefined;
    },
  };
}

/** Register bounded compaction hooks only in an owned pi-subagents child. */
export function installDagFusionCompactionAudit(
  pi: Pick<ExtensionAPI, "on">,
  options: InstallDagFusionCompactionAuditOptions = {},
): boolean {
  const env = options.env ?? process.env;
  if (env.PI_SUBAGENT_CHILD !== "1") return false;
  const runId = env.PI_SUBAGENT_RUN_ID;
  if (typeof runId !== "string") {
    return readError(
      "A pi-subagents child cannot enable compaction auditing without PI_SUBAGENT_RUN_ID.",
      "AUDIT_INVALID_RUN_ID",
    );
  }
  const auditPath = createAuditSidecar(options.sandboxRoot ?? process.cwd(), runId);
  const controller = createAuditController(auditPath);
  pi.on("session_before_compact", (event) => controller.before(event));
  pi.on("session_compact", (event) => controller.after(event));
  return true;
}

function validFingerprint(value: unknown): value is TextFingerprint {
  return isPlainRecord(value) && hasOnlyKeys(value, ["sha256", "utf8Bytes"]) &&
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) &&
    safeInteger(value.utf8Bytes, MAX_SUMMARY_BYTES);
}

function validPreMetadata(value: unknown): value is PreMetadata {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "firstKeptEntryId", "messagesToSummarizeCount", "turnPrefixMessagesCount",
    "branchEntryCount", "tokensBefore", "isSplitTurn", "previousSummary",
    "customInstructions", "fileOps", "settings",
  ])) return false;
  if (
    !validFingerprint(value.firstKeptEntryId) ||
    value.firstKeptEntryId.utf8Bytes > MAX_ENTRY_ID_BYTES ||
    !safeInteger(value.messagesToSummarizeCount, MAX_MESSAGE_COUNT) ||
    !safeInteger(value.turnPrefixMessagesCount, MAX_MESSAGE_COUNT) ||
    !safeInteger(value.branchEntryCount, MAX_BRANCH_ENTRY_COUNT) ||
    !safeInteger(value.tokensBefore, MAX_TOKEN_COUNT) ||
    typeof value.isSplitTurn !== "boolean" ||
    (value.previousSummary !== undefined && (
      !validFingerprint(value.previousSummary) ||
      value.previousSummary.utf8Bytes > MAX_SUMMARY_BYTES
    )) ||
    (value.customInstructions !== undefined && (
      !validFingerprint(value.customInstructions) ||
      value.customInstructions.utf8Bytes > MAX_CUSTOM_INSTRUCTIONS_BYTES
    )) ||
    !isPlainRecord(value.fileOps) ||
    !hasOnlyKeys(value.fileOps, ["readCount", "writtenCount", "editedCount"]) ||
    !safeInteger(value.fileOps.readCount, MAX_FILE_OPERATION_COUNT) ||
    !safeInteger(value.fileOps.writtenCount, MAX_FILE_OPERATION_COUNT) ||
    !safeInteger(value.fileOps.editedCount, MAX_FILE_OPERATION_COUNT) ||
    !isPlainRecord(value.settings) ||
    !hasOnlyKeys(value.settings, ["enabled", "reserveTokens", "keepRecentTokens"]) ||
    typeof value.settings.enabled !== "boolean" ||
    !safeInteger(value.settings.reserveTokens, MAX_TOKEN_COUNT) ||
    !safeInteger(value.settings.keepRecentTokens, MAX_TOKEN_COUNT)
  ) return false;
  return true;
}

function validPostMetadata(value: unknown): value is PostMetadata {
  return isPlainRecord(value) && hasOnlyKeys(value, [
    "firstKeptEntryId", "summary", "tokensBefore", "fromExtension",
  ]) && validFingerprint(value.firstKeptEntryId) &&
    value.firstKeptEntryId.utf8Bytes <= MAX_ENTRY_ID_BYTES &&
    validFingerprint(value.summary) && value.summary.utf8Bytes <= MAX_SUMMARY_BYTES &&
    safeInteger(value.tokensBefore, MAX_TOKEN_COUNT) &&
    typeof value.fromExtension === "boolean";
}

function parseAuditRecords(serialized: string, expectedRunId: TextFingerprint): AuditRecord[] {
  if (!serialized.endsWith("\n")) {
    return readError("The compaction-audit sidecar has a torn tail.", "AUDIT_MALFORMED");
  }
  const lines = serialized.slice(0, -1).split("\n");
  if (
    lines.length < 1 ||
    lines.length > 2 + DAG_FUSION_COMPACTION_AUDIT_MAX_ATTEMPTS * 2
  ) {
    return readError("The compaction-audit record count is invalid.", "AUDIT_MALFORMED");
  }
  const records: AuditRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (utf8Bytes(line) > 8 * 1024) {
      return readError("A compaction-audit record exceeds its bound.", "AUDIT_TOO_LARGE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return readError("The compaction-audit sidecar is not valid JSONL.", "AUDIT_MALFORMED", "pre", error);
    }
    if (!isPlainRecord(parsed) || parsed.version !== DAG_FUSION_COMPACTION_AUDIT_VERSION) {
      return readError("The compaction-audit record version is invalid.", "AUDIT_MALFORMED");
    }
    if (index === 0) {
      if (
        !hasOnlyKeys(parsed, ["version", "sequence", "kind", "runId"]) ||
        parsed.sequence !== 0 || parsed.kind !== "header" ||
        !validFingerprint(parsed.runId) || !sameFingerprint(parsed.runId, expectedRunId)
      ) {
        return readError("The compaction-audit header is invalid.", "AUDIT_MALFORMED");
      }
      records.push(parsed as unknown as AuditHeaderRecord);
      continue;
    }
    if (
      !hasOnlyKeys(parsed, [
        "version", "sequence", "kind", "attempt", "passed", "reason",
        "willRetry", "metadata", "errorCode",
      ]) ||
      parsed.sequence !== index ||
      (parsed.kind !== "pre" && parsed.kind !== "post") ||
      !safeInteger(parsed.attempt, DAG_FUSION_COMPACTION_AUDIT_MAX_ATTEMPTS + 1) ||
      parsed.attempt < 1 || typeof parsed.passed !== "boolean" ||
      !validReason(parsed.reason) || typeof parsed.willRetry !== "boolean" ||
      (parsed.passed
        ? parsed.errorCode !== undefined
        : typeof parsed.errorCode !== "string") ||
      (parsed.kind === "pre"
        ? (parsed.metadata !== undefined && !validPreMetadata(parsed.metadata))
        : (parsed.metadata !== undefined && !validPostMetadata(parsed.metadata)))
    ) {
      return readError(
        "A compaction-audit phase record is invalid.",
        "AUDIT_MALFORMED",
        parsed.kind === "post" ? "post" : "pre",
      );
    }
    const allowedErrors: readonly DagFusionCompactionAuditFailureCode[] = parsed.kind === "pre"
      ? ["PRE_INVALID_SHAPE", "PRE_LIMIT_EXCEEDED", "PRE_OVERLAPPED"]
      : ["POST_INVALID_SHAPE", "POST_LIMIT_EXCEEDED", "POST_MISMATCH", "POST_WITHOUT_PRE"];
    if (parsed.errorCode !== undefined && !allowedErrors.includes(
      parsed.errorCode as DagFusionCompactionAuditFailureCode,
    )) {
      return readError(
        "A compaction-audit failure code is invalid.",
        "AUDIT_MALFORMED",
        parsed.kind,
      );
    }
    if (parsed.passed && parsed.metadata === undefined) {
      return readError(
        "A successful compaction-audit record has no metadata.",
        "AUDIT_MALFORMED",
        parsed.kind,
      );
    }
    records.push(parsed as unknown as AuditPhaseRecord);
  }
  return records;
}

function readAuditFile(sandboxRoot: string, runId: string): AuditRecord[] {
  const expectedRunId = validateRunId(runId);
  const directory = ensureSafeAuditDirectory(sandboxRoot, false);
  const auditPath = path.join(directory, `${expectedRunId.sha256}.jsonl`);
  let descriptor: number | undefined;
  try {
    let pathStats: fs.Stats;
    try {
      pathStats = fs.lstatSync(auditPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "AUDIT_MISSING"
        : "AUDIT_PATH_UNSAFE";
      return readError("The child compaction-audit sidecar is missing.", code, "pre", error);
    }
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) {
      return readError(
        "The child compaction-audit sidecar path is unsafe.",
        "AUDIT_PATH_UNSAFE",
      );
    }
    descriptor = fs.openSync(auditPath, fs.constants.O_RDONLY | noFollowFlag());
    const opened = fs.fstatSync(descriptor);
    assertSafeOpenedFile(opened, "pre");
    if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino) {
      return readError(
        "The child compaction-audit sidecar changed during open.",
        "AUDIT_PATH_UNSAFE",
      );
    }
    if (opened.size < 1 || opened.size > DAG_FUSION_COMPACTION_AUDIT_MAX_BYTES) {
      return readError(
        "The child compaction-audit sidecar violates its size bound.",
        "AUDIT_TOO_LARGE",
      );
    }
    const serialized = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || utf8Bytes(serialized) !== opened.size
    ) {
      return readError(
        "The child compaction-audit sidecar changed while being read.",
        "AUDIT_PATH_UNSAFE",
      );
    }
    return parseAuditRecords(serialized, expectedRunId);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Read and independently validate a child sidecar from Kady's trusted process.
 * A valid header with no phase records means no compaction occurred.
 */
export function readTrustedDagFusionCompactionAudit(
  sandboxRoot: string,
  runId: string,
): TrustedDagFusionCompactionAudit {
  const records = readAuditFile(sandboxRoot, runId);
  const checks: TrustedDagFusionCompactionCheck[] = [];
  let pending: AuditPhaseRecord | undefined;
  for (const record of records.slice(1) as AuditPhaseRecord[]) {
    if (record.kind === "pre") {
      if (pending) {
        return readError(
          "A compaction pre-check started before the prior attempt completed.",
          "AUDIT_MALFORMED",
          "pre",
        );
      }
      checks.push({
        attempt: record.attempt,
        phase: "pre",
        passed: record.passed,
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      });
      if (record.passed) pending = record;
      continue;
    }

    const allowedWithoutPre = !record.passed && record.errorCode === "POST_WITHOUT_PRE";
    if (!pending && !allowedWithoutPre) {
      return readError(
        "A compaction post-check has no matching successful pre-check.",
        "AUDIT_MALFORMED",
        "post",
      );
    }
    if (pending && record.attempt !== pending.attempt) {
      return readError(
        "A compaction post-check has the wrong attempt identity.",
        "AUDIT_MALFORMED",
        "post",
      );
    }
    if (record.passed) {
      const pre = pending!.metadata as PreMetadata;
      const post = record.metadata as PostMetadata;
      if (
        record.reason !== pending!.reason ||
        record.willRetry !== pending!.willRetry ||
        post.tokensBefore !== pre.tokensBefore ||
        !sameFingerprint(post.firstKeptEntryId, pre.firstKeptEntryId)
      ) {
        return readError(
          "A successful compaction post-check contradicts its pre-check.",
          "AUDIT_MALFORMED",
          "post",
        );
      }
    }
    checks.push({
      attempt: record.attempt,
      phase: "post",
      passed: record.passed,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    });
    pending = undefined;
  }
  if (pending) {
    checks.push({
      attempt: pending.attempt,
      phase: "post",
      passed: false,
      errorCode: "POST_MISSING",
    });
  }
  return { occurred: records.length > 1, checks };
}
