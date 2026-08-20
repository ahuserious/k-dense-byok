import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import {
  validateScientificWorkflowTemplatePreconditions,
  type ScientificWorkflowPreconditionIssue,
} from "../../../web/src/data/dag-workflow-templates/types.ts";
import { isValidSessionId } from "../agent/notebook-store.ts";
import {
  ProjectLifecycleLockError,
  withProjectLifecycleLock,
  type ProjectLifecycleLockOptions,
} from "../project-lifecycle-lock.ts";
import { resolvePaths, type ProjectPaths } from "../projects.ts";
import { apiRelative, isWithin } from "../sandbox-fs.ts";
import {
  MAX_WORKFLOW_DOCUMENT_BYTES,
  ModelRequestSchema,
  type WorkflowGraphDocument,
} from "./schema.ts";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_STORAGE_VERSION,
  isTerminalWorkflowRunStatus,
  isWorkflowModelCallSlotId,
  isWorkflowRunEventType,
  reduceWorkflowRun,
  type WorkflowModelResolutionReceipt,
  type WorkflowRunDiagnostic,
  type WorkflowRunEventData,
  type WorkflowRunEventInput,
  type WorkflowRunEventV1,
  type WorkflowRunManifestV1,
  type WorkflowRunState,
} from "./run-state.ts";
import { validateStoredWorkflowGraphDocument } from "./harness-stored-validation.ts";
import { validateWorkflowGraphDocument } from "./validate.ts";
import {
  expandWorkflowRefs,
  WorkflowRefExpansionError,
} from "./kinds/workflow-ref-expand.ts";

export const WORKFLOW_DEFINITION_STORAGE_VERSION = 1 as const;
export const MAX_WORKFLOW_DEFINITIONS_PER_PROJECT = 256;
export const MAX_STORED_WORKFLOW_DEFINITION_BYTES = MAX_WORKFLOW_DOCUMENT_BYTES + 128 * 1024;
export const MAX_WORKFLOW_RUN_MANIFEST_BYTES = MAX_WORKFLOW_DOCUMENT_BYTES + 512 * 1024;
export const MAX_WORKFLOW_RUN_INPUT_BYTES = 256 * 1024;
export const MAX_WORKFLOW_EVENT_BYTES = 64 * 1024;
export const MAX_WORKFLOW_EVENT_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_WORKFLOW_EVENT_PAGE_SIZE = 500;
export const DEFAULT_WORKFLOW_EVENT_PAGE_SIZE = 200;
export const MAX_WORKFLOW_RUN_LIST_SIZE = 200;
export const MAX_WORKFLOW_RUNS_PER_PROJECT = 4_096;
export const MAX_WORKFLOW_RUN_STORAGE_BYTES_PER_PROJECT = 4 * 1024 * 1024 * 1024;
export const MAX_WORKFLOW_RUN_SUMMARY_BYTES = 4 * 1024 * 1024;
export const MAX_WORKFLOW_RUN_LEASE_BYTES = 4 * 1024;
export const MAX_WORKFLOW_RUN_CANCELLATION_BYTES = 4 * 1024;
export const DEFAULT_WORKFLOW_RUN_LEASE_MS = 30_000;
export const MIN_WORKFLOW_RUN_LEASE_MS = 1_000;
export const MAX_WORKFLOW_RUN_LEASE_MS = 5 * 60_000;

const WORKFLOW_RUN_SUMMARY_STORAGE_VERSION = 1 as const;
const WORKFLOW_RUN_LEASE_STORAGE_VERSION = 1 as const;
const WORKFLOW_RUN_CANCELLATION_STORAGE_VERSION = 1 as const;
const WORKFLOW_MUTATION_LOCK_STALE_MS = 2 * 60_000;
const WORKFLOW_DEFINITION_LOCK_WAIT_MS = 5_000;
const MAX_WORKFLOW_MUTATION_LOCK_BYTES = 4 * 1024;

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WORKFLOW_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const WORKFLOW_RUN_ID_RE = /^wrun_[a-f0-9]{32}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type WorkflowStoreErrorCode =
  | "INVALID_ID"
  | "INVALID_DEFINITION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_LARGE"
  | "LIMIT_REACHED"
  | "CANCEL_REQUESTED"
  | "PRECONDITION_FAILED"
  | "CORRUPT"
  | "UNSUPPORTED_VERSION";

export class WorkflowStoreError extends Error {
  code: WorkflowStoreErrorCode;

  constructor(code: WorkflowStoreErrorCode, message: string) {
    super(message);
    this.name = "WorkflowStoreError";
    this.code = code;
  }
}

/**
 * Every definition intent/revision conflict. `currentRevision` is the revision
 * observed by the same read that decided the conflict, inside the definition
 * mutation lock, or `null` when no record existed at that instant. Callers must
 * use it instead of rereading: a reread can race a later writer and would emit
 * an ETag that never described the compared state.
 */
export class WorkflowDefinitionConflictError extends WorkflowStoreError {
  readonly currentRevision: number | null;

  constructor(message: string, currentRevision: number | null) {
    super("CONFLICT", message);
    this.name = "WorkflowDefinitionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class WorkflowPreconditionError extends WorkflowStoreError {
  readonly issues: ScientificWorkflowPreconditionIssue[];

  constructor(issues: ScientificWorkflowPreconditionIssue[]) {
    super(
      "PRECONDITION_FAILED",
      `Workflow preconditions failed (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
    );
    this.name = "WorkflowPreconditionError";
    this.issues = structuredClone(issues);
  }
}

export interface StoredWorkflowDefinitionV1 {
  storageVersion: typeof WORKFLOW_DEFINITION_STORAGE_VERSION;
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  graphSha256: string;
  graph: WorkflowGraphDocument;
}

/**
 * A definition precondition supplied by a caller: `Number.isSafeInteger(value)
 * && value >= 0`. Persisted definition revisions are separately positive
 * integers, so `0` is a legal update precondition that can only reach the
 * missing-record conflict path; it never means "create".
 */
export type WorkflowExpectedRevision = number;

export type SaveWorkflowDefinitionIntent =
  | { kind: "create" }
  | { kind: "update"; expectedRevision: WorkflowExpectedRevision }
  | { kind: "upsert"; expectedRevision?: WorkflowExpectedRevision };

export type SaveWorkflowDefinitionOutcome = "created" | "unchanged" | "updated";

export interface SaveWorkflowDefinitionResult {
  outcome: SaveWorkflowDefinitionOutcome;
  definition: StoredWorkflowDefinitionV1;
}

/**
 * Temporary trusted compatibility facade options. An omitted `intent` maps to
 * `upsert`, never `create`, so repeated in-process setup helpers keep working.
 * The HTTP route may not use this facade; it calls the outcome core with an
 * explicit `create` or `update` intent.
 */
export interface SaveWorkflowDefinitionOptions {
  intent?: "upsert";
  /** Compared against `current?.revision ?? 0` before any hash equality check. */
  expectedRevision?: WorkflowExpectedRevision;
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowStoreError(
      "INVALID_DEFINITION",
      `expectedRevision must be a non-negative safe integer; received ${String(value)}.`,
    );
  }
}

export interface CreateWorkflowRunInput {
  workflowId: string;
  requestId: string;
  expectedWorkflowRevision?: number;
  sessionId?: string;
  requestedBy: "user" | "agent" | "api";
  input?: {
    goal?: string;
    variables?: Record<string, unknown>;
    files?: Record<string, string[]>;
  };
}

export interface WorkflowRunFiles {
  dir: string;
  manifest: string;
  events: string;
  summary: string;
  lease: string;
  cancellation: string;
  mutationLock: string;
}

export interface WorkflowRunRecord {
  manifest: WorkflowRunManifestV1;
  state: WorkflowRunState;
}

export interface WorkflowRunEventPage {
  events: WorkflowRunEventV1[];
  lastSeq: number;
  hasMore: boolean;
  diagnostics: WorkflowRunDiagnostic[];
}

export interface WorkflowRecoveryResult {
  interrupted: string[];
  active: string[];
  errors: Array<{ runId: string; message: string }>;
}

export interface WorkflowRunLeaseClaim {
  runId: string;
  ownerToken: string;
  fence: number;
  expiresAt: number;
}

export interface WorkflowRunCancellationIntentV1 {
  storageVersion: typeof WORKFLOW_RUN_CANCELLATION_STORAGE_VERSION;
  runId: string;
  requestedAt: number;
  code: "USER_CANCELLED";
  message: string;
}

interface StoredWorkflowRunLeaseV1 extends WorkflowRunLeaseClaim {
  storageVersion: typeof WORKFLOW_RUN_LEASE_STORAGE_VERSION;
  acquiredAt: number;
  renewedAt: number;
  releasedAt?: number;
}

export interface WorkflowStoreOptions {
  now?: () => number;
  randomOwnerToken?: () => string;
  defaultLeaseDurationMs?: number;
  projectLifecycleLock?: ProjectLifecycleLockOptions;
}

interface EventTailRepair {
  keepBytes: number;
  truncatedBytes: number;
  addMissingNewline: boolean;
}

interface LoadedEventLog {
  bytes: Buffer;
  events: WorkflowRunEventV1[];
  diagnostics: WorkflowRunDiagnostic[];
  repair?: EventTailRepair;
}

interface StoredWorkflowRunSummaryV1 {
  storageVersion: typeof WORKFLOW_RUN_SUMMARY_STORAGE_VERSION;
  runId: string;
  projectId: string;
  manifestSha256: string;
  eventLogBytes: number;
  eventLogMtimeMs: number;
  eventLogCtimeMs: number;
  stateSha256: string;
  state: WorkflowRunState;
}

interface ManagedFileMetadata {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StoredWorkflowMutationLockV1 {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

interface WorkflowMutationLockObservation {
  owner: StoredWorkflowMutationLockV1;
  stat: fs.Stats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyObjectKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowStoreError("CORRUPT", "Workflow state contains a non-finite number.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new WorkflowStoreError("CORRUPT", "Workflow state must contain only JSON values.");
  }
  if (ancestors.has(value)) {
    throw new WorkflowStoreError("CORRUPT", "Workflow state contains a circular reference.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowStoreError("CORRUPT", "Workflow state must contain plain JSON objects.");
    }
    // A null-prototype accumulator preserves keys such as __proto__ as data
    // instead of invoking Object.prototype setters and changing the digest.
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new WorkflowStoreError("CORRUPT", `Workflow field ${key} is undefined.`);
      }
      output[key] = canonicalize(item, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function serializedJson(value: unknown): string {
  canonicalize(value);
  return JSON.stringify(value, null, 2) + "\n";
}

function byteLength(value: string | Buffer): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf-8") : value.length;
}

function assertByteLimit(value: string | Buffer, maximum: number, label: string): void {
  if (byteLength(value) > maximum) {
    throw new WorkflowStoreError("TOO_LARGE", `${label} exceeds ${maximum} bytes.`);
  }
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new WorkflowStoreError("INVALID_ID", `Invalid project id: ${projectId}`);
  }
}

function assertWorkflowId(workflowId: string): void {
  if (!WORKFLOW_ID_RE.test(workflowId)) {
    throw new WorkflowStoreError("INVALID_ID", `Invalid workflow id: ${workflowId}`);
  }
}

function assertWorkflowRunId(runId: string): void {
  if (!WORKFLOW_RUN_ID_RE.test(runId)) {
    throw new WorkflowStoreError("INVALID_ID", `Invalid workflow run id: ${runId}`);
  }
}

function assertRequestId(requestId: string): void {
  if (
    typeof requestId !== "string" ||
    Buffer.byteLength(requestId, "utf-8") < 1 ||
    Buffer.byteLength(requestId, "utf-8") > 256 ||
    /[\u0000-\u001f\u007f]/.test(requestId)
  ) {
    throw new WorkflowStoreError(
      "INVALID_ID",
      "Workflow request id must be 1-256 bytes and contain no control characters.",
    );
  }
}

function deepestExistingAncestor(target: string, stop: string): string | null {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    if (current === stop) return null;
    const parent = path.dirname(current);
    if (parent === current || !isWithin(stop, parent)) return null;
    current = parent;
  }
}

/** Keep app-owned workflow state inside the real project sandbox, including through symlinks. */
function assertManagedTarget(paths: ProjectPaths, target: string): void {
  const sandbox = path.resolve(paths.sandbox);
  const kadyDir = path.resolve(paths.kadyDir);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(kadyDir, resolvedTarget)) {
    throw new WorkflowStoreError("INVALID_ID", "Workflow path escaped the project state directory.");
  }
  if (!fs.existsSync(sandbox) || !fs.existsSync(kadyDir)) return;

  const realSandbox = fs.realpathSync(sandbox);
  const realKadyDir = fs.realpathSync(kadyDir);
  if (!isWithin(realSandbox, realKadyDir)) {
    throw new WorkflowStoreError("INVALID_ID", "Project workflow state resolves outside its sandbox.");
  }
  const existing = deepestExistingAncestor(resolvedTarget, kadyDir);
  if (existing && !isWithin(realKadyDir, fs.realpathSync(existing))) {
    throw new WorkflowStoreError("INVALID_ID", "Workflow path traverses a symlink outside project state.");
  }
}

function projectPaths(projectId: string): ProjectPaths {
  assertProjectId(projectId);
  return resolvePaths(projectId);
}

function validateRunFileSelections(
  projectId: string,
  selections: Record<string, string[]> | undefined,
): {
  files: Record<string, string[]>;
  issues: ScientificWorkflowPreconditionIssue[];
} {
  const sandbox = path.resolve(projectPaths(projectId).sandbox);
  const realSandbox = fs.realpathSync(sandbox);
  const claimedPaths = new Set<string>();
  const files: Record<string, string[]> = {};
  const issues: ScientificWorkflowPreconditionIssue[] = [];

  for (const [key, selectedPaths] of Object.entries(selections ?? {})) {
    const validPaths: string[] = [];
    for (const selectedPath of selectedPaths) {
      const absolutePath = path.resolve(sandbox, selectedPath);
      let valid = !path.isAbsolute(selectedPath) && isWithin(sandbox, absolutePath);
      try {
        const stat = fs.lstatSync(absolutePath);
        valid = valid && stat.isFile() && !stat.isSymbolicLink();
        const realPath = fs.realpathSync(absolutePath);
        valid = valid && isWithin(realSandbox, realPath);
        fs.accessSync(realPath, fs.constants.R_OK);
      } catch {
        valid = false;
      }
      const canonicalPath = valid ? apiRelative(sandbox, absolutePath) : selectedPath;
      if (!valid) {
        issues.push({
          kind: "file",
          key,
          message: `Selected file for ${key} is not a readable regular sandbox file: ${selectedPath}.`,
        });
        continue;
      }
      if (claimedPaths.has(canonicalPath)) {
        issues.push({
          kind: "file",
          key,
          message: `Selected file ${canonicalPath} is already bound to another required input.`,
        });
        continue;
      }
      claimedPaths.add(canonicalPath);
      validPaths.push(canonicalPath);
    }
    files[key] = validPaths;
  }
  return { files, issues };
}

function ensureManagedDirectory(paths: ProjectPaths, directory: string): void {
  assertManagedTarget(paths, directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertManagedTarget(paths, directory);
  assertNoSymlinkComponents(paths, directory, true);
}

function definitionPath(projectId: string, workflowId: string): string {
  assertWorkflowId(workflowId);
  const paths = projectPaths(projectId);
  const file = path.join(paths.workflowDefinitionsDir, `${workflowId}.json`);
  assertManagedTarget(paths, file);
  return file;
}

export function workflowRunFiles(projectId: string, runId: string): WorkflowRunFiles {
  assertWorkflowRunId(runId);
  const paths = projectPaths(projectId);
  const dir = path.join(paths.workflowRunsDir, runId);
  assertManagedTarget(paths, dir);
  return {
    dir,
    manifest: path.join(dir, "run.json"),
    events: path.join(dir, "events.jsonl"),
    summary: path.join(dir, "summary.json"),
    lease: path.join(dir, "lease.json"),
    cancellation: path.join(dir, "cancel.json"),
    mutationLock: path.join(dir, ".mutation.lock"),
  };
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on some supported Windows filesystems.
  }
}

function assertNoSymlinkComponents(
  paths: ProjectPaths,
  target: string,
  includeTarget: boolean,
): void {
  const kadyDir = path.resolve(paths.kadyDir);
  const resolvedTarget = path.resolve(target);
  const targetToCheck = includeTarget ? resolvedTarget : path.dirname(resolvedTarget);
  if (!isWithin(kadyDir, targetToCheck)) {
    throw new WorkflowStoreError("INVALID_ID", "Workflow path escaped the project state directory.");
  }
  const relative = apiRelative(kadyDir, targetToCheck);
  if (relative === "" && !includeTarget) return;
  let current = kadyDir;
  const components = relative === "" ? [] : relative.split("/");
  const pathsToCheck = [kadyDir, ...components.map((component) => {
    current = path.join(current, component);
    return current;
  })];
  for (const candidate of pathsToCheck) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new WorkflowStoreError(
        "CORRUPT",
        `Managed workflow path contains a symbolic link: ${path.basename(candidate)}.`,
      );
    }
  }
}

function sameFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  // dev/ino are stable on Unix. Windows may report zero for both, where the
  // no-follow open plus regular-file checks remain the available guarantee.
  return (before.dev === 0 && before.ino === 0) ||
    (before.dev === after.dev && before.ino === after.ino);
}

function openManagedRegularFile(
  paths: ProjectPaths,
  file: string,
  flags: number,
  label: string,
): { fd: number; stat: fs.Stats } | null {
  assertManagedTarget(paths, file);
  assertNoSymlinkComponents(paths, file, true);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new WorkflowStoreError("CORRUPT", `${label} is not a regular managed file.`);
  }
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(file, flags | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new WorkflowStoreError("CORRUPT", `${label} cannot be opened through a symbolic link.`);
    }
    throw error;
  }
  try {
    const after = fs.fstatSync(fd);
    assertManagedTarget(paths, file);
    assertNoSymlinkComponents(paths, file, true);
    if (!after.isFile() || !sameFileIdentity(before, after)) {
      throw new WorkflowStoreError("CORRUPT", `${label} changed while it was being opened.`);
    }
    return { fd, stat: after };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function existingManagedFileSize(
  paths: ProjectPaths,
  file: string,
  label: string,
): number | null {
  const opened = openManagedRegularFile(paths, file, fs.constants.O_RDONLY, label);
  if (!opened) return null;
  try {
    return opened.stat.size;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function existingManagedFileMetadata(
  paths: ProjectPaths,
  file: string,
  label: string,
): ManagedFileMetadata | null {
  const opened = openManagedRegularFile(paths, file, fs.constants.O_RDONLY, label);
  if (!opened) return null;
  try {
    return {
      size: opened.stat.size,
      mtimeMs: opened.stat.mtimeMs,
      ctimeMs: opened.stat.ctimeMs,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function atomicWriteBytes(
  paths: ProjectPaths,
  file: string,
  bytes: Buffer,
  maximum: number,
): void {
  assertByteLimit(bytes, maximum, path.basename(file));
  const directory = path.dirname(file);
  ensureManagedDirectory(paths, directory);
  assertNoSymlinkComponents(paths, file, true);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertManagedTarget(paths, file);
    assertNoSymlinkComponents(paths, file, true);
    fs.renameSync(temporary, file);
    assertManagedTarget(paths, file);
    assertNoSymlinkComponents(paths, file, true);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function atomicWriteJson(
  paths: ProjectPaths,
  file: string,
  value: unknown,
  maximum: number,
): void {
  atomicWriteBytes(paths, file, Buffer.from(serializedJson(value), "utf-8"), maximum);
}

function appendDurableLine(
  paths: ProjectPaths,
  file: string,
  line: string,
  maximum: number,
  label: string,
): ManagedFileMetadata {
  const opened = openManagedRegularFile(
    paths,
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND,
    label,
  );
  if (!opened) throw new WorkflowStoreError("CORRUPT", `${label} is missing.`);
  const encodedBytes = Buffer.byteLength(line, "utf-8");
  if (opened.stat.size + encodedBytes > maximum) {
    fs.closeSync(opened.fd);
    throw new WorkflowStoreError("LIMIT_REACHED", `${label} exceeds ${maximum} bytes.`);
  }
  try {
    fs.writeFileSync(opened.fd, line, "utf-8");
    fs.fsyncSync(opened.fd);
    const after = fs.fstatSync(opened.fd);
    if (
      !after.isFile() ||
      !sameFileIdentity(opened.stat, after) ||
      after.size !== opened.stat.size + encodedBytes
    ) {
      throw new WorkflowStoreError("CORRUPT", `${label} changed during append.`);
    }
    return {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function readBoundedFile(
  paths: ProjectPaths,
  file: string,
  maximum: number,
  label: string,
): Buffer | null {
  const opened = openManagedRegularFile(paths, file, fs.constants.O_RDONLY, label);
  if (!opened) return null;
  if (opened.stat.size > maximum) {
    fs.closeSync(opened.fd);
    throw new WorkflowStoreError("TOO_LARGE", `${label} exceeds ${maximum} bytes.`);
  }
  try {
    return fs.readFileSync(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function parseWorkflowMutationLock(
  bytes: Buffer,
  label: string,
): StoredWorkflowMutationLockV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch {
    throw new WorkflowStoreError("CORRUPT", `${label} is malformed JSON.`);
  }
  if (
    !isRecord(value) ||
    !hasOnlyObjectKeys(value, ["version", "token", "pid", "hostname", "createdAt"]) ||
    value.version !== 1 ||
    typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
    !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 ||
    typeof value.hostname !== "string" || value.hostname.length < 1 || value.hostname.length > 255 ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
  ) {
    throw new WorkflowStoreError("CORRUPT", `${label} has invalid ownership metadata.`);
  }
  return value as unknown as StoredWorkflowMutationLockV1;
}

function readWorkflowMutationLock(
  paths: ProjectPaths,
  lockFile: string,
  label: string,
): WorkflowMutationLockObservation | null {
  const opened = openManagedRegularFile(paths, lockFile, fs.constants.O_RDONLY, label);
  if (!opened) return null;
  if (opened.stat.size > MAX_WORKFLOW_MUTATION_LOCK_BYTES) {
    fs.closeSync(opened.fd);
    throw new WorkflowStoreError("CORRUPT", `${label} exceeds ${MAX_WORKFLOW_MUTATION_LOCK_BYTES} bytes.`);
  }
  try {
    return {
      owner: parseWorkflowMutationLock(fs.readFileSync(opened.fd), label),
      stat: opened.stat,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function sameWorkflowMutationLock(
  left: WorkflowMutationLockObservation,
  right: WorkflowMutationLockObservation,
): boolean {
  return left.owner.token === right.owner.token &&
    left.owner.pid === right.owner.pid &&
    left.owner.hostname === right.owner.hostname &&
    left.owner.createdAt === right.owner.createdAt &&
    sameFileIdentity(left.stat, right.stat);
}

function workflowMutationLockOwnerMayBeAlive(owner: StoredWorkflowMutationLockV1): boolean {
  // A lock on shared storage from another host is never stolen automatically;
  // this process cannot establish the remote owner's liveness safely.
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createWorkflowMutationLock(
  paths: ProjectPaths,
  lockFile: string,
  label: string,
): { fd: number; observation: WorkflowMutationLockObservation } | null {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const owner: StoredWorkflowMutationLockV1 = {
    version: 1,
    token: crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      lockFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf-8");
    fs.fsyncSync(fd);
    return { fd, observation: { owner, stat: fs.fstatSync(fd) } };
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lockFile, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

function releaseWorkflowMutationLock(
  paths: ProjectPaths,
  lockFile: string,
  label: string,
  acquired: { fd: number; observation: WorkflowMutationLockObservation },
): void {
  fs.closeSync(acquired.fd);
  const current = readWorkflowMutationLock(paths, lockFile, label);
  if (!current || !sameWorkflowMutationLock(current, acquired.observation)) {
    throw new WorkflowStoreError("CORRUPT", `${label} changed owner before release.`);
  }
  fs.unlinkSync(lockFile);
  fsyncDirectory(path.dirname(lockFile));
}

function recoverUnprotectedWorkflowMutationLock(
  paths: ProjectPaths,
  lockFile: string,
  label: string,
  observed: WorkflowMutationLockObservation,
): boolean {
  if (
    Date.now() - observed.owner.createdAt <= WORKFLOW_MUTATION_LOCK_STALE_MS ||
    workflowMutationLockOwnerMayBeAlive(observed.owner)
  ) return false;
  const confirmed = readWorkflowMutationLock(paths, lockFile, label);
  if (
    !confirmed ||
    !sameWorkflowMutationLock(confirmed, observed) ||
    Date.now() - confirmed.owner.createdAt <= WORKFLOW_MUTATION_LOCK_STALE_MS ||
    workflowMutationLockOwnerMayBeAlive(confirmed.owner)
  ) return false;
  try {
    fs.unlinkSync(lockFile);
    fsyncDirectory(path.dirname(lockFile));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function recoverWorkflowMutationLock(
  paths: ProjectPaths,
  lockFile: string,
  label: string,
  observed: WorkflowMutationLockObservation,
): boolean {
  if (
    Date.now() - observed.owner.createdAt <= WORKFLOW_MUTATION_LOCK_STALE_MS ||
    workflowMutationLockOwnerMayBeAlive(observed.owner)
  ) return false;
  const recoveryFile = `${lockFile}.recovery`;
  const recoveryLabel = `${label} recovery lock`;
  let recovery = createWorkflowMutationLock(paths, recoveryFile, recoveryLabel);
  if (!recovery) {
    const oldRecovery = readWorkflowMutationLock(paths, recoveryFile, recoveryLabel);
    if (!oldRecovery || !recoverUnprotectedWorkflowMutationLock(
      paths,
      recoveryFile,
      recoveryLabel,
      oldRecovery,
    )) return false;
    recovery = createWorkflowMutationLock(paths, recoveryFile, recoveryLabel);
  }
  if (!recovery) return false;

  try {
    const confirmed = readWorkflowMutationLock(paths, lockFile, label);
    if (
      !confirmed ||
      !sameWorkflowMutationLock(confirmed, observed) ||
      Date.now() - confirmed.owner.createdAt <= WORKFLOW_MUTATION_LOCK_STALE_MS ||
      workflowMutationLockOwnerMayBeAlive(confirmed.owner)
    ) return false;
    fs.unlinkSync(lockFile);
    fsyncDirectory(path.dirname(lockFile));
    return true;
  } finally {
    releaseWorkflowMutationLock(paths, recoveryFile, recoveryLabel, recovery);
  }
}

const workflowMutationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function withWorkflowMutationLock<T>(
  paths: ProjectPaths,
  lockFile: string,
  label: string,
  waitMs: number,
  callback: () => T,
): T {
  assertManagedTarget(paths, lockFile);
  assertNoSymlinkComponents(paths, lockFile, true);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const acquired = createWorkflowMutationLock(paths, lockFile, label);
    if (acquired) {
      try {
        return callback();
      } finally {
        releaseWorkflowMutationLock(paths, lockFile, label, acquired);
      }
    }

    const observed = readWorkflowMutationLock(paths, lockFile, label);
    if (!observed) continue;
    if (recoverWorkflowMutationLock(paths, lockFile, label, observed)) continue;
    if (Date.now() >= deadline) {
      throw new WorkflowStoreError("CONFLICT", `${label} is owned by another live process.`);
    }
    Atomics.wait(workflowMutationWaitBuffer, 0, 0, Math.min(10, deadline - Date.now()));
  }
}

function withRunMutationLock<T>(
  paths: ProjectPaths,
  runId: string,
  callback: () => T,
): T {
  return withWorkflowMutationLock(
    paths,
    workflowRunFiles(paths.id, runId).mutationLock,
    `Workflow run ${runId} mutation lock`,
    0,
    callback,
  );
}

function withDefinitionMutationLock<T>(
  paths: ProjectPaths,
  workflowId: string,
  callback: () => T,
): T {
  return withWorkflowMutationLock(
    paths,
    path.join(paths.workflowDefinitionsDir, `.${workflowId}.mutation.lock`),
    `Workflow definition ${workflowId} mutation lock`,
    WORKFLOW_DEFINITION_LOCK_WAIT_MS,
    callback,
  );
}

function parseStoredRunLease(
  runId: string,
  bytes: Buffer,
): StoredWorkflowRunLeaseV1 {
  const value = parseJsonObject(bytes, `Workflow run ${runId} lease`);
  if (
    !hasOnlyObjectKeys(value, [
      "storageVersion",
      "runId",
      "ownerToken",
      "fence",
      "acquiredAt",
      "renewedAt",
      "expiresAt",
      "releasedAt",
    ]) ||
    value.storageVersion !== WORKFLOW_RUN_LEASE_STORAGE_VERSION ||
    value.runId !== runId ||
    typeof value.ownerToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.ownerToken) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !Number.isSafeInteger(value.acquiredAt) ||
    (value.acquiredAt as number) < 0 ||
    !Number.isSafeInteger(value.renewedAt) ||
    (value.renewedAt as number) < (value.acquiredAt as number) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) < (value.renewedAt as number) ||
    (value.releasedAt !== undefined && (
      !Number.isSafeInteger(value.releasedAt) ||
      (value.releasedAt as number) < (value.acquiredAt as number)
    ))
  ) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has an invalid lease.`);
  }
  return value as unknown as StoredWorkflowRunLeaseV1;
}

function readStoredRunLease(
  projectId: string,
  runId: string,
): StoredWorkflowRunLeaseV1 | null {
  const paths = projectPaths(projectId);
  const bytes = readBoundedFile(
    paths,
    workflowRunFiles(projectId, runId).lease,
    MAX_WORKFLOW_RUN_LEASE_BYTES,
    `Workflow run ${runId} lease`,
  );
  return bytes ? parseStoredRunLease(runId, bytes) : null;
}

function isLiveRunLease(lease: StoredWorkflowRunLeaseV1 | null, now: number): boolean {
  return Boolean(lease && lease.releasedAt === undefined && lease.expiresAt > now);
}

function writeStoredRunLease(
  projectId: string,
  lease: StoredWorkflowRunLeaseV1,
): void {
  const paths = projectPaths(projectId);
  const file = workflowRunFiles(projectId, lease.runId).lease;
  const bytes = Buffer.from(serializedJson(lease), "utf-8");
  assertByteLimit(bytes, MAX_WORKFLOW_RUN_LEASE_BYTES, "Workflow run lease");
  const oldBytes = existingManagedFileSize(
    paths,
    file,
    `Workflow run ${lease.runId} lease`,
  ) ?? 0;
  assertProjectRunCapacity(projectId, Math.max(0, bytes.length - oldBytes));
  atomicWriteBytes(paths, file, bytes, MAX_WORKFLOW_RUN_LEASE_BYTES);
}

function parseStoredRunCancellation(
  runId: string,
  bytes: Buffer,
): WorkflowRunCancellationIntentV1 {
  const value = parseJsonObject(bytes, `Workflow run ${runId} cancellation request`);
  if (
    !hasOnlyObjectKeys(value, [
      "storageVersion",
      "runId",
      "requestedAt",
      "code",
      "message",
    ]) ||
    value.storageVersion !== WORKFLOW_RUN_CANCELLATION_STORAGE_VERSION ||
    value.runId !== runId ||
    !Number.isSafeInteger(value.requestedAt) ||
    (value.requestedAt as number) < 0 ||
    value.code !== "USER_CANCELLED" ||
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    Buffer.byteLength(value.message, "utf-8") > 2_048
  ) {
    throw new WorkflowStoreError(
      "CORRUPT",
      `Workflow run ${runId} has an invalid cancellation request.`,
    );
  }
  return value as unknown as WorkflowRunCancellationIntentV1;
}

function readStoredRunCancellation(
  projectId: string,
  runId: string,
): WorkflowRunCancellationIntentV1 | null {
  const paths = projectPaths(projectId);
  const bytes = readBoundedFile(
    paths,
    workflowRunFiles(projectId, runId).cancellation,
    MAX_WORKFLOW_RUN_CANCELLATION_BYTES,
    `Workflow run ${runId} cancellation request`,
  );
  return bytes ? parseStoredRunCancellation(runId, bytes) : null;
}

function writeStoredRunCancellation(
  projectId: string,
  intent: WorkflowRunCancellationIntentV1,
): void {
  const paths = projectPaths(projectId);
  const file = workflowRunFiles(projectId, intent.runId).cancellation;
  const bytes = Buffer.from(serializedJson(intent), "utf-8");
  assertByteLimit(
    bytes,
    MAX_WORKFLOW_RUN_CANCELLATION_BYTES,
    "Workflow run cancellation request",
  );
  const oldBytes = existingManagedFileSize(
    paths,
    file,
    `Workflow run ${intent.runId} cancellation request`,
  ) ?? 0;
  assertProjectRunCapacity(projectId, Math.max(0, bytes.length - oldBytes));
  atomicWriteBytes(paths, file, bytes, MAX_WORKFLOW_RUN_CANCELLATION_BYTES);
}

function assertLeaseDuration(durationMs: number): void {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < MIN_WORKFLOW_RUN_LEASE_MS ||
    durationMs > MAX_WORKFLOW_RUN_LEASE_MS
  ) {
    throw new WorkflowStoreError(
      "CONFLICT",
      `Workflow lease duration must be ${MIN_WORKFLOW_RUN_LEASE_MS}-${MAX_WORKFLOW_RUN_LEASE_MS} ms.`,
    );
  }
}

function leaseTimestamp(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WorkflowStoreError("CORRUPT", "Workflow lease clock returned an invalid timestamp.");
  }
  return now;
}

function leaseExpiry(now: number, durationMs: number): number {
  const expiresAt = leaseTimestamp(now) + durationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new WorkflowStoreError("LIMIT_REACHED", "Workflow lease timestamp exceeds the safe range.");
  }
  return expiresAt;
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString("utf-8")) as unknown;
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new WorkflowStoreError("CORRUPT", `${label} is malformed JSON.`);
  }
}

function parseStoredDefinition(
  projectId: string,
  workflowId: string,
  bytes: Buffer,
): StoredWorkflowDefinitionV1 {
  const value = parseJsonObject(bytes, `Workflow definition ${workflowId}`);
  if (value.storageVersion !== WORKFLOW_DEFINITION_STORAGE_VERSION) {
    throw new WorkflowStoreError(
      "UNSUPPORTED_VERSION",
      `Workflow definition ${workflowId} uses unsupported storage version ${String(value.storageVersion)}.`,
    );
  }
  if (
    value.id !== workflowId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    typeof value.graphSha256 !== "string" ||
    !SHA256_RE.test(value.graphSha256)
  ) {
    throw new WorkflowStoreError("CORRUPT", `Workflow definition ${workflowId} has invalid metadata.`);
  }
  const validation = validateStoredWorkflowGraphDocument(value.graph);
  if (!validation.ok || validation.document.id !== workflowId) {
    throw new WorkflowStoreError("CORRUPT", `Workflow definition ${workflowId} contains an invalid graph.`);
  }
  const graphSha256 = sha256(validation.document);
  if (graphSha256 !== value.graphSha256) {
    throw new WorkflowStoreError("CORRUPT", `Workflow definition ${workflowId} failed its content digest.`);
  }
  void projectId;
  return {
    storageVersion: WORKFLOW_DEFINITION_STORAGE_VERSION,
    id: workflowId,
    revision: value.revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    graphSha256,
    graph: validation.document,
  };
}

function readDefinitionFile(
  projectId: string,
  workflowId: string,
): StoredWorkflowDefinitionV1 | null {
  const paths = projectPaths(projectId);
  const bytes = readBoundedFile(
    paths,
    definitionPath(projectId, workflowId),
    MAX_STORED_WORKFLOW_DEFINITION_BYTES,
    `Workflow definition ${workflowId}`,
  );
  return bytes ? parseStoredDefinition(projectId, workflowId, bytes) : null;
}

function definitionIds(projectId: string): string[] {
  const paths = projectPaths(projectId);
  assertManagedTarget(paths, paths.workflowDefinitionsDir);
  assertNoSymlinkComponents(paths, paths.workflowDefinitionsDir, true);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.workflowDefinitionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".json") && entry.isSymbolicLink()) {
      throw new WorkflowStoreError(
        "CORRUPT",
        `Workflow definition ${entry.name} is a symbolic link.`,
      );
    }
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => WORKFLOW_ID_RE.test(id))
    .sort();
}

function requestIntent(input: CreateWorkflowRunInput): Record<string, unknown> {
  return {
    workflowId: input.workflowId,
    requestId: input.requestId,
    requestedBy: input.requestedBy,
    ...(input.expectedWorkflowRevision !== undefined
      ? { expectedWorkflowRevision: input.expectedWorkflowRevision }
      : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    input: input.input ?? {},
  };
}

function runIdForRequest(projectId: string, requestId: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(requestId)
    .digest("hex")
    .slice(0, 32);
  return `wrun_${digest}`;
}

function validateCreateRunInput(input: CreateWorkflowRunInput): void {
  assertWorkflowId(input.workflowId);
  assertRequestId(input.requestId);
  if (!(["user", "agent", "api"] as const).includes(input.requestedBy)) {
    throw new WorkflowStoreError("CORRUPT", "Workflow run requestedBy is invalid.");
  }
  if (input.sessionId && !isValidSessionId(input.sessionId)) {
    throw new WorkflowStoreError("INVALID_ID", `Invalid session id: ${input.sessionId}`);
  }
  if (
    input.expectedWorkflowRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedWorkflowRevision) || input.expectedWorkflowRevision < 1)
  ) {
    throw new WorkflowStoreError("CONFLICT", "Expected workflow revision must be a positive integer.");
  }
  if (input.input !== undefined && !isRecord(input.input)) {
    throw new WorkflowStoreError("CORRUPT", "Workflow run input must be an object.");
  }
  if (input.input && !hasOnlyObjectKeys(input.input, ["goal", "variables", "files"])) {
    throw new WorkflowStoreError("CORRUPT", "Workflow run input has unsupported fields.");
  }
  if (input.input?.goal !== undefined && (
    typeof input.input.goal !== "string" || input.input.goal.length > 32_768
  )) {
    throw new WorkflowStoreError("TOO_LARGE", "Workflow run goal exceeds 32768 characters.");
  }
  if (input.input?.variables !== undefined && !isRecord(input.input.variables)) {
    throw new WorkflowStoreError("CORRUPT", "Workflow run variables must be an object.");
  }
  if (input.input?.files !== undefined) {
    if (!isRecord(input.input.files)) {
      throw new WorkflowStoreError("CORRUPT", "Workflow run files must be keyed by required input.");
    }
    for (const [key, selectedPaths] of Object.entries(input.input.files)) {
      if (!key || !Array.isArray(selectedPaths) || selectedPaths.length > 100) {
        throw new WorkflowStoreError("CORRUPT", "Workflow run file selections are invalid.");
      }
      if (selectedPaths.some((selectedPath) =>
        typeof selectedPath !== "string" || !selectedPath || selectedPath.length > 1_024
      )) {
        throw new WorkflowStoreError("CORRUPT", "Workflow run file paths are invalid.");
      }
    }
  }
  assertByteLimit(
    canonicalJson(input.input ?? {}),
    MAX_WORKFLOW_RUN_INPUT_BYTES,
    "Workflow run input",
  );
  canonicalJson(requestIntent(input));
}

function parseRunManifest(
  projectId: string,
  runId: string,
  bytes: Buffer,
): WorkflowRunManifestV1 {
  const value = parseJsonObject(bytes, `Workflow run ${runId}`);
  if (value.storageVersion !== WORKFLOW_RUN_STORAGE_VERSION) {
    throw new WorkflowStoreError(
      "UNSUPPORTED_VERSION",
      `Workflow run ${runId} uses unsupported storage version ${String(value.storageVersion)}.`,
    );
  }
  if (
    value.id !== runId ||
    value.projectId !== projectId ||
    typeof value.workflowId !== "string" ||
    !WORKFLOW_ID_RE.test(value.workflowId) ||
    !Number.isSafeInteger(value.workflowRevision) ||
    (value.workflowRevision as number) < 1 ||
    typeof value.graphSha256 !== "string" ||
    !SHA256_RE.test(value.graphSha256) ||
    typeof value.requestId !== "string" ||
    Buffer.byteLength(value.requestId, "utf-8") < 1 ||
    Buffer.byteLength(value.requestId, "utf-8") > 256 ||
    /[\u0000-\u001f\u007f]/.test(value.requestId) ||
    typeof value.requestSha256 !== "string" ||
    !SHA256_RE.test(value.requestSha256) ||
    (value.expectedWorkflowRevision !== undefined && (
      !Number.isSafeInteger(value.expectedWorkflowRevision) ||
      (value.expectedWorkflowRevision as number) < 1
    )) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !(["user", "agent", "api"] as unknown[]).includes(value.requestedBy) ||
    !isRecord(value.input)
  ) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has invalid metadata.`);
  }
  if (runIdForRequest(projectId, value.requestId as string) !== runId) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} does not match its request id.`);
  }
  const storedInput = value.input as Record<string, unknown>;
  if (
    !hasOnlyObjectKeys(storedInput, ["goal", "variables", "files"]) ||
    (storedInput.goal !== undefined && (
      typeof storedInput.goal !== "string" || storedInput.goal.length > 32_768
    )) ||
    (storedInput.variables !== undefined && !isRecord(storedInput.variables)) ||
    (storedInput.files !== undefined && (
      !isRecord(storedInput.files) ||
      Object.values(storedInput.files).some((selectedPaths) =>
        !Array.isArray(selectedPaths) || selectedPaths.some((selectedPath) => typeof selectedPath !== "string")
      )
    ))
  ) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has invalid input.`);
  }
  if (value.sessionId !== undefined && (
    typeof value.sessionId !== "string" || !isValidSessionId(value.sessionId)
  )) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has an invalid session id.`);
  }
  const validation = validateStoredWorkflowGraphDocument(value.graph);
  if (!validation.ok || validation.document.id !== value.workflowId) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} contains an invalid graph snapshot.`);
  }
  const graphSha256 = sha256(validation.document);
  if (graphSha256 !== value.graphSha256) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} failed its graph digest.`);
  }
  if (canonicalJson(value.effectiveLimits) !== canonicalJson(validation.document.limits)) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has inconsistent effective limits.`);
  }
  if (
    value.expectedWorkflowRevision !== undefined &&
    value.expectedWorkflowRevision !== value.workflowRevision
  ) {
    throw new WorkflowStoreError(
      "CORRUPT",
      `Workflow run ${runId} expected a different revision than its graph snapshot.`,
    );
  }
  const persistedIntent: CreateWorkflowRunInput = {
    workflowId: value.workflowId,
    requestId: value.requestId,
    requestedBy: value.requestedBy as WorkflowRunManifestV1["requestedBy"],
    ...(value.expectedWorkflowRevision !== undefined
      ? { expectedWorkflowRevision: value.expectedWorkflowRevision as number }
      : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    input: value.input as WorkflowRunManifestV1["input"],
  };
  const requestSha256 = sha256(requestIntent(persistedIntent));
  if (requestSha256 !== value.requestSha256) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} failed its request-intent digest.`);
  }
  return {
    storageVersion: WORKFLOW_RUN_STORAGE_VERSION,
    id: runId,
    projectId,
    workflowId: value.workflowId,
    workflowRevision: value.workflowRevision as number,
    graphSha256,
    requestId: value.requestId,
    requestSha256,
    ...(value.expectedWorkflowRevision !== undefined
      ? { expectedWorkflowRevision: value.expectedWorkflowRevision as number }
      : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    createdAt: value.createdAt,
    requestedBy: value.requestedBy as WorkflowRunManifestV1["requestedBy"],
    input: value.input as WorkflowRunManifestV1["input"],
    effectiveLimits: validation.document.limits,
    graph: validation.document,
  };
}

function readRunManifestFile(projectId: string, runId: string): WorkflowRunManifestV1 | null {
  const paths = projectPaths(projectId);
  const files = workflowRunFiles(projectId, runId);
  const bytes = readBoundedFile(
    paths,
    files.manifest,
    MAX_WORKFLOW_RUN_MANIFEST_BYTES,
    `Workflow run ${runId}`,
  );
  return bytes ? parseRunManifest(projectId, runId, bytes) : null;
}

function runIds(projectId: string): string[] {
  const paths = projectPaths(projectId);
  assertManagedTarget(paths, paths.workflowRunsDir);
  assertNoSymlinkComponents(paths, paths.workflowRunsDir, true);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.workflowRunsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    if (WORKFLOW_RUN_ID_RE.test(entry.name) && entry.isSymbolicLink()) {
      throw new WorkflowStoreError("CORRUPT", `Workflow run ${entry.name} is a symbolic link.`);
    }
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && WORKFLOW_RUN_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (ids.length > MAX_WORKFLOW_RUNS_PER_PROJECT) {
    throw new WorkflowStoreError(
      "LIMIT_REACHED",
      `Project has ${ids.length} workflow runs; maximum is ${MAX_WORKFLOW_RUNS_PER_PROJECT}.`,
    );
  }
  return ids;
}

function validateReceipt(value: unknown): value is WorkflowModelResolutionReceipt {
  if (!isRecord(value) || !Value.Check(ModelRequestSchema, value.request)) return false;
  if (!isRecord(value.resolved) || !isRecord(value.resolved.auth)) return false;
  const runtime = value.resolved.runtime;
  const reasoning = value.resolved.reasoning;
  return (
    typeof value.resolved.provider === "string" &&
    value.resolved.provider.length > 0 && value.resolved.provider.length <= 64 &&
    typeof value.resolved.model === "string" &&
    value.resolved.model.length > 0 && value.resolved.model.length <= 256 &&
    typeof value.resolved.auth.kind === "string" &&
    value.resolved.auth.kind.length > 0 && value.resolved.auth.kind.length <= 64 &&
    (value.resolved.auth.profile === undefined || (
      typeof value.resolved.auth.profile === "string" &&
      value.resolved.auth.profile.length > 0 &&
      value.resolved.auth.profile.length <= 128
    )) &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(reasoning)) &&
    ["pi", "openrouter-fusion", "kady-fusion", "local", "custom"].includes(String(runtime)) &&
    typeof value.fallbackUsed === "boolean" &&
    (value.resolutionReason === undefined || (
      typeof value.resolutionReason === "string" && value.resolutionReason.length <= 1_024
    ))
  );
}

function validateEventData(type: string, data: unknown): data is WorkflowRunEventData | undefined {
  if (data === undefined) return type !== "model_call_declared" && type !== "model_resolved";
  if (!isRecord(data)) return false;
  canonicalJson(data);
  if (type === "model_call_declared") {
    const slot = data.modelCallSlot;
    return isRecord(slot) &&
      isWorkflowModelCallSlotId(slot.id) &&
      Value.Check(ModelRequestSchema, slot.request);
  }
  if (type === "model_resolved") {
    return isWorkflowModelCallSlotId(data.modelCallSlotId) && validateReceipt(data.receipt);
  }
  return true;
}

function validateStoredEvent(
  value: unknown,
  runId: string,
  line: number,
): { event?: WorkflowRunEventV1; diagnostic?: WorkflowRunDiagnostic } {
  if (!isRecord(value)) {
    return { diagnostic: { code: "invalid-event", message: "Event row is not an object.", fatal: true, line } };
  }
  if (value.schemaVersion !== WORKFLOW_RUN_EVENT_SCHEMA_VERSION) {
    return {
      diagnostic: {
        code: "unsupported-event-version",
        message: `Event row uses unsupported schema version ${String(value.schemaVersion)}.`,
        fatal: true,
        line,
      },
    };
  }
  if (
    value.runId !== runId ||
    typeof value.eventId !== "string" ||
    !EVENT_ID_RE.test(value.eventId) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    !isWorkflowRunEventType(value.type) ||
    !validateEventData(String(value.type), value.data)
  ) {
    return {
      diagnostic: {
        code: "invalid-event",
        message: "Event row has invalid envelope or payload fields.",
        fatal: true,
        line,
      },
    };
  }
  for (const key of ["executionId", "parentExecutionId", "branchId"] as const) {
    if (value[key] !== undefined && (
      typeof value[key] !== "string" || !EXECUTION_ID_RE.test(value[key] as string)
    )) {
      return {
        diagnostic: {
          code: "invalid-event",
          message: `Event row has an invalid ${key}.`,
          fatal: true,
          line,
        },
      };
    }
  }
  if (value.nodeId !== undefined && (
    typeof value.nodeId !== "string" || !WORKFLOW_ID_RE.test(value.nodeId)
  )) {
    return { diagnostic: { code: "invalid-event", message: "Event row has an invalid nodeId.", fatal: true, line } };
  }
  if (value.attempt !== undefined && (
    !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
  )) {
    return { diagnostic: { code: "invalid-event", message: "Event row has an invalid attempt.", fatal: true, line } };
  }
  if (
    ["model_call_declared", "model_resolved", "node_started", "node_succeeded", "node_failed", "node_skipped"].includes(
      value.type as string,
    ) && (!value.executionId || !value.nodeId)
  ) {
    return {
      diagnostic: {
        code: "invalid-event",
        message: `${String(value.type)} requires executionId and nodeId.`,
        fatal: true,
        line,
      },
    };
  }
  return { event: value as unknown as WorkflowRunEventV1 };
}

function loadEventLog(projectId: string, runId: string): LoadedEventLog {
  const paths = projectPaths(projectId);
  const file = workflowRunFiles(projectId, runId).events;
  const bytes = readBoundedFile(
    paths,
    file,
    MAX_WORKFLOW_EVENT_LOG_BYTES,
    `Workflow run ${runId} event log`,
  );
  if (!bytes) {
    return {
      bytes: Buffer.alloc(0),
      events: [],
      diagnostics: [{ code: "missing-event-log", message: "Run event log is missing.", fatal: true }],
    };
  }

  const raw = bytes.toString("utf-8");
  const hasFinalNewline = bytes.length === 0 || bytes.at(-1) === 0x0a;
  const lines = raw.split("\n");
  if (hasFinalNewline) lines.pop();
  const events: WorkflowRunEventV1[] = [];
  const diagnostics: WorkflowRunDiagnostic[] = [];
  let repair: EventTailRepair | undefined;
  let expectedSeq = 1;
  const seenEventIds = new Set<string>();

  for (const [index, lineText] of lines.entries()) {
    const lineNumber = index + 1;
    if (!lineText.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      const isLastUnterminatedLine = !hasFinalNewline && index === lines.length - 1;
      if (isLastUnterminatedLine) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        repair = {
          keepBytes: lastNewline < 0 ? 0 : lastNewline + 1,
          truncatedBytes: bytes.length - (lastNewline < 0 ? 0 : lastNewline + 1),
          addMissingNewline: false,
        };
        diagnostics.push({
          code: "torn-event-tail",
          message: `Event log ends with ${repair.truncatedBytes} incomplete bytes.`,
          fatal: true,
          line: lineNumber,
        });
      } else {
        diagnostics.push({
          code: "malformed-event-row",
          message: "A complete event-log row is malformed JSON.",
          fatal: true,
          line: lineNumber,
        });
      }
      continue;
    }
    const validated = validateStoredEvent(parsed, runId, lineNumber);
    if (validated.diagnostic) {
      diagnostics.push(validated.diagnostic);
      continue;
    }
    const event = validated.event!;
    if (event.seq !== expectedSeq) {
      diagnostics.push({
        code: "event-sequence",
        message: `Expected event sequence ${expectedSeq}, received ${event.seq}.`,
        fatal: true,
        line: lineNumber,
      });
      continue;
    }
    if (seenEventIds.has(event.eventId)) {
      diagnostics.push({
        code: "duplicate-event-id",
        message: `Event id ${event.eventId} occurs more than once.`,
        fatal: true,
        line: lineNumber,
      });
      continue;
    }
    seenEventIds.add(event.eventId);
    events.push(event);
    expectedSeq++;
  }

  if (!hasFinalNewline && !repair && bytes.length > 0) {
    repair = { keepBytes: bytes.length, truncatedBytes: 0, addMissingNewline: true };
    diagnostics.push({
      code: "missing-final-newline",
      message: "Event log has a complete final row without its newline terminator.",
      fatal: false,
      line: lines.length,
    });
  }
  if (events.length === 0) {
    diagnostics.push({
      code: "missing-initial-event",
      message: "Run event log contains no valid events.",
      fatal: true,
    });
  }
  return { bytes, events, diagnostics, ...(repair ? { repair } : {}) };
}

function eventIntent(event: WorkflowRunEventInput | WorkflowRunEventV1): Record<string, unknown> {
  return {
    eventId: event.eventId,
    type: event.type,
    ...(event.executionId ? { executionId: event.executionId } : {}),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.parentExecutionId ? { parentExecutionId: event.parentExecutionId } : {}),
    ...(event.branchId ? { branchId: event.branchId } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
  };
}

function validateEventInput(input: WorkflowRunEventInput): void {
  const inputType: unknown = (input as unknown as Record<string, unknown>).type;
  if (
    !EVENT_ID_RE.test(input.eventId) ||
    !isWorkflowRunEventType(inputType) ||
    inputType === "store_repaired"
  ) {
    throw new WorkflowStoreError("CORRUPT", "Workflow event id or type is invalid.");
  }
  const candidate = {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    runId: "wrun_00000000000000000000000000000000",
    seq: 1,
    ts: 1,
    ...input,
  };
  const validation = validateStoredEvent(candidate, candidate.runId, 1);
  if (validation.diagnostic) {
    throw new WorkflowStoreError("CORRUPT", validation.diagnostic.message);
  }
  const encoded = JSON.stringify(candidate) + "\n";
  assertByteLimit(encoded, MAX_WORKFLOW_EVENT_BYTES, "Workflow event");
}

function repairEventLog(
  projectId: string,
  runId: string,
  loaded: LoadedEventLog,
): WorkflowRunEventV1 {
  const repair = loaded.repair!;
  const retained = loaded.bytes.subarray(0, repair.keepBytes);
  const separator = repair.addMissingNewline && retained.length > 0 ? Buffer.from("\n") : Buffer.alloc(0);
  const repairIdentity = crypto
    .createHash("sha256")
    .update(runId)
    .update(loaded.bytes)
    .digest("hex")
    .slice(0, 32);
  const event: WorkflowRunEventV1 = {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    runId,
    eventId: `repair_${repairIdentity}`,
    seq: loaded.events.length + 1,
    ts: Date.now(),
    type: "store_repaired",
    data: {
      message: repair.truncatedBytes > 0
        ? `Removed ${repair.truncatedBytes} bytes from a torn event-log tail.`
        : "Restored the missing final event-log newline.",
      truncatedBytes: repair.truncatedBytes,
    },
  };
  const encodedEvent = Buffer.from(JSON.stringify(event) + "\n", "utf-8");
  assertByteLimit(encodedEvent, MAX_WORKFLOW_EVENT_BYTES, "Workflow repair event");
  const replacement = Buffer.concat([retained, separator, encodedEvent]);
  const paths = projectPaths(projectId);
  atomicWriteBytes(
    paths,
    workflowRunFiles(projectId, runId).events,
    replacement,
    MAX_WORKFLOW_EVENT_LOG_BYTES,
  );
  return event;
}

function isTerminalEvent(type: WorkflowRunEventInput["type"]): boolean {
  return type === "run_succeeded" || type === "run_failed" || type === "run_cancelled";
}

function workflowRunStorageBytes(projectId: string, ids = runIds(projectId)): number {
  const paths = projectPaths(projectId);
  let total = 0;
  for (const runId of ids) {
    const files = workflowRunFiles(projectId, runId);
    for (const [file, label] of [
      [files.manifest, `Workflow run ${runId}`],
      [files.events, `Workflow run ${runId} event log`],
      [files.summary, `Workflow run ${runId} summary`],
      [files.lease, `Workflow run ${runId} lease`],
      [files.cancellation, `Workflow run ${runId} cancellation request`],
    ] as const) {
      const size = existingManagedFileSize(paths, file, label);
      if (size !== null) total += size;
      if (!Number.isSafeInteger(total)) {
        throw new WorkflowStoreError("TOO_LARGE", "Workflow run storage size is not representable.");
      }
    }
  }
  return total;
}

function assertProjectRunCapacity(
  projectId: string,
  additionalBytes: number,
  options: { creatingRun?: boolean } = {},
): void {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
    throw new WorkflowStoreError("CORRUPT", "Workflow run storage growth is invalid.");
  }
  const ids = runIds(projectId);
  if (options.creatingRun && ids.length >= MAX_WORKFLOW_RUNS_PER_PROJECT) {
    throw new WorkflowStoreError(
      "LIMIT_REACHED",
      `A project may store at most ${MAX_WORKFLOW_RUNS_PER_PROJECT} workflow runs. Archive or remove runs explicitly before creating another.`,
    );
  }
  const currentBytes = workflowRunStorageBytes(projectId, ids);
  if (currentBytes + additionalBytes > MAX_WORKFLOW_RUN_STORAGE_BYTES_PER_PROJECT) {
    throw new WorkflowStoreError(
      "LIMIT_REACHED",
      `Workflow runs would exceed the ${MAX_WORKFLOW_RUN_STORAGE_BYTES_PER_PROJECT}-byte project limit. No audit history was deleted.`,
    );
  }
}

function storedRunSummary(
  manifest: WorkflowRunManifestV1,
  state: WorkflowRunState,
  eventLog: ManagedFileMetadata,
): StoredWorkflowRunSummaryV1 {
  const clonedState = structuredClone(state);
  return {
    storageVersion: WORKFLOW_RUN_SUMMARY_STORAGE_VERSION,
    runId: manifest.id,
    projectId: manifest.projectId,
    manifestSha256: sha256(manifest),
    eventLogBytes: eventLog.size,
    eventLogMtimeMs: eventLog.mtimeMs,
    eventLogCtimeMs: eventLog.ctimeMs,
    stateSha256: sha256(clonedState),
    state: clonedState,
  };
}

function serializedRunSummary(
  manifest: WorkflowRunManifestV1,
  state: WorkflowRunState,
  eventLog: ManagedFileMetadata,
): Buffer {
  const bytes = Buffer.from(
    serializedJson(storedRunSummary(manifest, state, eventLog)),
    "utf-8",
  );
  assertByteLimit(bytes, MAX_WORKFLOW_RUN_SUMMARY_BYTES, "Workflow run summary");
  return bytes;
}

function isRunStateSummaryShape(value: unknown, runId: string): value is WorkflowRunState {
  if (!isRecord(value)) return false;
  return value.runId === runId &&
    [
      "queued",
      "running",
      "waiting",
      "blocked",
      "paused",
      "interrupted",
      "succeeded",
      "failed",
      "cancelled",
    ].includes(String(value.status)) &&
    Number.isSafeInteger(value.lastSeq) && (value.lastSeq as number) >= 0 &&
    isRecord(value.executions) &&
    typeof value.recoverable === "boolean" &&
    Array.isArray(value.diagnostics);
}

function readRunSummary(
  projectId: string,
  manifest: WorkflowRunManifestV1,
  eventLog: ManagedFileMetadata,
): WorkflowRunState | null {
  const paths = projectPaths(projectId);
  const bytes = readBoundedFile(
    paths,
    workflowRunFiles(projectId, manifest.id).summary,
    MAX_WORKFLOW_RUN_SUMMARY_BYTES,
    `Workflow run ${manifest.id} summary`,
  );
  if (!bytes) return null;
  let value: Record<string, unknown>;
  try {
    value = parseJsonObject(bytes, `Workflow run ${manifest.id} summary`);
  } catch (error) {
    if (error instanceof WorkflowStoreError) return null;
    throw error;
  }
  if (
    value.storageVersion !== WORKFLOW_RUN_SUMMARY_STORAGE_VERSION ||
    value.runId !== manifest.id ||
    value.projectId !== projectId ||
    value.manifestSha256 !== sha256(manifest) ||
    value.eventLogBytes !== eventLog.size ||
    value.eventLogMtimeMs !== eventLog.mtimeMs ||
    value.eventLogCtimeMs !== eventLog.ctimeMs ||
    typeof value.stateSha256 !== "string" ||
    !SHA256_RE.test(value.stateSha256) ||
    !isRunStateSummaryShape(value.state, manifest.id)
  ) {
    return null;
  }
  try {
    if (sha256(value.state) !== value.stateSha256) return null;
  } catch {
    return null;
  }
  return structuredClone(value.state);
}

function writeRunSummaryBytes(
  projectId: string,
  runId: string,
  bytes: Buffer,
): void {
  atomicWriteBytes(
    projectPaths(projectId),
    workflowRunFiles(projectId, runId).summary,
    bytes,
    MAX_WORKFLOW_RUN_SUMMARY_BYTES,
  );
}

function readRunForListing(
  projectId: string,
  runId: string,
): WorkflowRunRecord | null {
  const manifest = readRunManifestFile(projectId, runId);
  if (!manifest) return null;
  const paths = projectPaths(projectId);
  const eventLog = existingManagedFileMetadata(
    paths,
    workflowRunFiles(projectId, runId).events,
    `Workflow run ${runId} event log`,
  );
  if (eventLog === null) {
    throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} event log is missing.`);
  }
  const summaryState = readRunSummary(projectId, manifest, eventLog);
  if (summaryState) return { manifest, state: summaryState };

  const loaded = loadEventLog(projectId, runId);
  const state = reduceWorkflowRun(manifest, loaded.events, loaded.diagnostics);
  const summaryBytes = serializedRunSummary(manifest, state, eventLog);
  const existingSummaryBytes = existingManagedFileSize(
    paths,
    workflowRunFiles(projectId, runId).summary,
    `Workflow run ${runId} summary`,
  ) ?? 0;
  try {
    assertProjectRunCapacity(projectId, Math.max(0, summaryBytes.length - existingSummaryBytes));
    writeRunSummaryBytes(projectId, runId, summaryBytes);
  } catch (error) {
    // The summary is a rebuildable cache. Capacity refusal must not hide the
    // authoritative audit log from the listing operation.
    if (!(error instanceof WorkflowStoreError) || error.code !== "LIMIT_REACHED") throw error;
  }
  return { manifest, state };
}

export class WorkflowStore {
  private readonly now: () => number;
  private readonly randomOwnerToken: () => string;
  private readonly defaultLeaseDurationMs: number;
  private readonly projectLifecycleLock: ProjectLifecycleLockOptions;

  constructor(options: WorkflowStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomOwnerToken = options.randomOwnerToken ?? (() => crypto.randomBytes(32).toString("hex"));
    this.defaultLeaseDurationMs = options.defaultLeaseDurationMs ?? DEFAULT_WORKFLOW_RUN_LEASE_MS;
    this.projectLifecycleLock = { ...options.projectLifecycleLock };
    assertLeaseDuration(this.defaultLeaseDurationMs);
  }

  acquireRunLease(
    projectId: string,
    runId: string,
    durationMs = this.defaultLeaseDurationMs,
  ): WorkflowRunLeaseClaim {
    assertLeaseDuration(durationMs);
    if (!readRunManifestFile(projectId, runId)) {
      throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
    }
    const paths = projectPaths(projectId);
    return withRunMutationLock(paths, runId, () => {
      if (!readRunManifestFile(projectId, runId)) {
        throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
      }
      const now = leaseTimestamp(this.now());
      const previous = readStoredRunLease(projectId, runId);
      if (isLiveRunLease(previous, now)) {
        throw new WorkflowStoreError("CONFLICT", `Workflow run ${runId} already has a live owner lease.`);
      }
      const ownerToken = this.randomOwnerToken();
      if (!/^[a-f0-9]{64}$/.test(ownerToken)) {
        throw new WorkflowStoreError("CORRUPT", "Workflow lease owner-token generator returned invalid data.");
      }
      const fence = (previous?.fence ?? 0) + 1;
      if (!Number.isSafeInteger(fence)) {
        throw new WorkflowStoreError("LIMIT_REACHED", `Workflow run ${runId} exhausted its lease fence.`);
      }
      const lease: StoredWorkflowRunLeaseV1 = {
        storageVersion: WORKFLOW_RUN_LEASE_STORAGE_VERSION,
        runId,
        ownerToken,
        fence,
        acquiredAt: now,
        renewedAt: now,
        expiresAt: leaseExpiry(now, durationMs),
      };
      writeStoredRunLease(projectId, lease);
      return { runId, ownerToken, fence, expiresAt: lease.expiresAt };
    });
  }

  renewRunLease(
    projectId: string,
    claim: WorkflowRunLeaseClaim,
    durationMs = this.defaultLeaseDurationMs,
  ): WorkflowRunLeaseClaim {
    assertWorkflowRunId(claim.runId);
    assertLeaseDuration(durationMs);
    const paths = projectPaths(projectId);
    return withRunMutationLock(paths, claim.runId, () => {
      const now = leaseTimestamp(this.now());
      const current = readStoredRunLease(projectId, claim.runId);
      if (
        !current ||
        current.ownerToken !== claim.ownerToken ||
        current.fence !== claim.fence ||
        !isLiveRunLease(current, now)
      ) {
        throw new WorkflowStoreError("CONFLICT", `Workflow run ${claim.runId} lease is stale or fenced out.`);
      }
      const renewedAt = Math.max(current.renewedAt, now);
      const renewed: StoredWorkflowRunLeaseV1 = {
        ...current,
        renewedAt,
        expiresAt: leaseExpiry(renewedAt, durationMs),
      };
      writeStoredRunLease(projectId, renewed);
      return {
        runId: renewed.runId,
        ownerToken: renewed.ownerToken,
        fence: renewed.fence,
        expiresAt: renewed.expiresAt,
      };
    });
  }

  releaseRunLease(projectId: string, claim: WorkflowRunLeaseClaim): void {
    assertWorkflowRunId(claim.runId);
    const paths = projectPaths(projectId);
    withRunMutationLock(paths, claim.runId, () => {
      const current = readStoredRunLease(projectId, claim.runId);
      if (
        !current ||
        current.ownerToken !== claim.ownerToken ||
        current.fence !== claim.fence
      ) {
        throw new WorkflowStoreError("CONFLICT", `Workflow run ${claim.runId} lease is fenced out.`);
      }
      if (current.releasedAt !== undefined) return;
      const now = leaseTimestamp(this.now());
      const releasedAt = Math.max(current.acquiredAt, now);
      const renewedAt = Math.max(current.renewedAt, releasedAt);
      writeStoredRunLease(projectId, {
        ...current,
        renewedAt,
        expiresAt: renewedAt,
        releasedAt,
      });
    });
  }

  hasLiveRunLease(projectId: string, runId: string): boolean {
    assertWorkflowRunId(runId);
    return isLiveRunLease(readStoredRunLease(projectId, runId), leaseTimestamp(this.now()));
  }

  readRunCancellationIntent(
    projectId: string,
    runId: string,
  ): WorkflowRunCancellationIntentV1 | null {
    assertWorkflowRunId(runId);
    if (!readRunManifestFile(projectId, runId)) {
      throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
    }
    const intent = readStoredRunCancellation(projectId, runId);
    return intent ? structuredClone(intent) : null;
  }

  /**
   * Persist one idempotent user-cancellation intent under the run mutation
   * lock. If nobody owns the run, make the terminal transition immediately;
   * otherwise the fenced owner is forced to observe the intent before its
   * next durable append.
   */
  requestRunCancellation(projectId: string, runId: string): WorkflowRunRecord {
    assertWorkflowRunId(runId);
    const paths = projectPaths(projectId);
    return withRunMutationLock(paths, runId, () => {
      const manifest = readRunManifestFile(projectId, runId);
      if (!manifest) {
        throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
      }
      const loaded = loadEventLog(projectId, runId);
      const state = reduceWorkflowRun(manifest, loaded.events, loaded.diagnostics);
      const run = { manifest, state };
      if (state.status === "cancelled") return run;
      if (isTerminalWorkflowRunStatus(state.status) || state.status === "interrupted") {
        throw new WorkflowStoreError(
          "CONFLICT",
          `Workflow run ${runId} cannot be cancelled from ${state.status}.`,
        );
      }

      let intent = readStoredRunCancellation(projectId, runId);
      if (!intent) {
        const requestedAt = leaseTimestamp(this.now());
        intent = {
          storageVersion: WORKFLOW_RUN_CANCELLATION_STORAGE_VERSION,
          runId,
          requestedAt,
          code: "USER_CANCELLED",
          message: "Workflow execution was cancelled by the user.",
        };
        writeStoredRunCancellation(projectId, intent);
      }

      const lease = readStoredRunLease(projectId, runId);
      if (!isLiveRunLease(lease, leaseTimestamp(this.now()))) {
        this.appendRunEventLocked(
          projectId,
          runId,
          {
            eventId: `cancel_${crypto.createHash("sha256").update(`${runId}:user-cancel`).digest("hex").slice(0, 32)}`,
            type: "run_cancelled",
            data: {
              error: {
                code: intent.code,
                message: intent.message,
                retryable: false,
              },
            },
          },
          state.lastSeq,
        );
        const cancelled = this.readRun(projectId, runId);
        if (!cancelled) {
          throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} disappeared after cancellation.`);
        }
        return cancelled;
      }
      return run;
    });
  }

  private assertAppendLease(
    projectId: string,
    runId: string,
    claim: WorkflowRunLeaseClaim | undefined,
    eventType: WorkflowRunEventInput["type"],
  ): void {
    const now = leaseTimestamp(this.now());
    const current = readStoredRunLease(projectId, runId);
    if (claim) {
      if (
        claim.runId !== runId ||
        !current ||
        current.ownerToken !== claim.ownerToken ||
        current.fence !== claim.fence ||
        !isLiveRunLease(current, now)
      ) {
        throw new WorkflowStoreError("CONFLICT", `Workflow run ${runId} append was fenced by another owner.`);
      }
      if (
        eventType !== "run_cancelled" &&
        readStoredRunCancellation(projectId, runId)
      ) {
        throw new WorkflowStoreError(
          "CANCEL_REQUESTED",
          `Workflow run ${runId} has a durable user cancellation request.`,
        );
      }
      return;
    }
    if (isLiveRunLease(current, now)) {
      throw new WorkflowStoreError("CONFLICT", `Workflow run ${runId} has a live owner lease.`);
    }
  }

  /**
   * Temporary trusted compatibility facade over {@link saveDefinitionWithIntent}.
   * An omitted intent means `upsert`, never `create`. Returns the definition so
   * existing in-process callers keep their `StoredWorkflowDefinitionV1` shape.
   */
  saveDefinition(
    projectId: string,
    workflowId: string,
    value: unknown,
    options: SaveWorkflowDefinitionOptions = {},
  ): StoredWorkflowDefinitionV1 {
    const intent: SaveWorkflowDefinitionIntent = options.expectedRevision === undefined
      ? { kind: "upsert" }
      : { kind: "upsert", expectedRevision: options.expectedRevision };
    return this.saveDefinitionWithIntent(projectId, workflowId, value, intent).definition;
  }

  saveDefinitionWithIntent(
    projectId: string,
    workflowId: string,
    value: unknown,
    intent: SaveWorkflowDefinitionIntent,
  ): SaveWorkflowDefinitionResult {
    assertWorkflowId(workflowId);
    const validation = validateWorkflowGraphDocument(value);
    if (!validation.ok || validation.document.id !== workflowId) {
      const detail = validation.ok
        ? "The graph id does not match the requested workflow id."
        : validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      throw new WorkflowStoreError("INVALID_DEFINITION", detail);
    }
    if (intent.kind !== "create" && intent.expectedRevision !== undefined) {
      assertExpectedRevision(intent.expectedRevision);
    }
    const graph = validation.document;
    const graphSha256 = sha256(graph);
    const paths = projectPaths(projectId);
    ensureManagedDirectory(paths, paths.workflowDefinitionsDir);
    return withDefinitionMutationLock(paths, workflowId, () => {
      // The read, intent evaluation, and replacement are one cross-process CAS
      // critical section. Validation and hashing above are pure and deliberately
      // stay outside the lock.
      const current = readDefinitionFile(projectId, workflowId);
      const currentRevision = current?.revision ?? null;

      // The discriminated intent is evaluated against this locked read BEFORE
      // any hash equality check. An identical body must never smuggle a caller
      // past a failed precondition.
      if (intent.kind === "create") {
        if (current) {
          throw new WorkflowDefinitionConflictError(
            `Workflow ${workflowId} already exists at revision ${current.revision}; create requires absence.`,
            current.revision,
          );
        }
      } else if (intent.kind === "update") {
        if (!current) {
          throw new WorkflowDefinitionConflictError(
            `Workflow ${workflowId} does not exist at revision ${intent.expectedRevision}.`,
            null,
          );
        }
        if (current.revision !== intent.expectedRevision) {
          throw new WorkflowDefinitionConflictError(
            `Workflow ${workflowId} is revision ${current.revision}; expected ${intent.expectedRevision}.`,
            current.revision,
          );
        }
      } else if (intent.expectedRevision !== undefined) {
        if (intent.expectedRevision !== (current?.revision ?? 0)) {
          throw new WorkflowDefinitionConflictError(
            `Workflow ${workflowId} is revision ${String(currentRevision)}; expected ${intent.expectedRevision}.`,
            currentRevision,
          );
        }
      } else if (current && current.graphSha256 !== graphSha256) {
        // Trusted upsert without a precondition may repeat an identical setup
        // save, but it may not overwrite a changed record.
        throw new WorkflowDefinitionConflictError(
          `Workflow ${workflowId} is revision ${current.revision}; a changed upsert requires an expected revision.`,
          current.revision,
        );
      }

      if (current && current.graphSha256 === graphSha256) {
        return { outcome: "unchanged" as const, definition: current };
      }

      if (!current && definitionIds(projectId).length >= MAX_WORKFLOW_DEFINITIONS_PER_PROJECT) {
        throw new WorkflowStoreError(
          "LIMIT_REACHED",
          `A project may store at most ${MAX_WORKFLOW_DEFINITIONS_PER_PROJECT} workflows.`,
        );
      }
      const now = Date.now();
      const stored: StoredWorkflowDefinitionV1 = {
        storageVersion: WORKFLOW_DEFINITION_STORAGE_VERSION,
        id: workflowId,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        graphSha256,
        graph,
      };
      atomicWriteJson(
        paths,
        definitionPath(projectId, workflowId),
        stored,
        MAX_STORED_WORKFLOW_DEFINITION_BYTES,
      );
      return { outcome: current ? ("updated" as const) : ("created" as const), definition: stored };
    });
  }

  readDefinition(projectId: string, workflowId: string): StoredWorkflowDefinitionV1 | null {
    return readDefinitionFile(projectId, workflowId);
  }

  listDefinitions(projectId: string): StoredWorkflowDefinitionV1[] {
    return definitionIds(projectId)
      .flatMap((workflowId) => {
        const definition = readDefinitionFile(projectId, workflowId);
        return definition ? [definition] : [];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  createRun(projectId: string, input: CreateWorkflowRunInput): WorkflowRunManifestV1 {
    assertProjectId(projectId);
    validateCreateRunInput(input);
    try {
      return withProjectLifecycleLock(
        projectId,
        () => this.createRunWithLifecycleLock(projectId, input),
        this.projectLifecycleLock,
      );
    } catch (error) {
      if (!(error instanceof ProjectLifecycleLockError)) throw error;
      const code: WorkflowStoreErrorCode = error.code === "INVALID_ID"
        ? "INVALID_ID"
        : error.code === "CONFLICT"
          ? "CONFLICT"
          : "CORRUPT";
      throw new WorkflowStoreError(code, error.message);
    }
  }

  private createRunWithLifecycleLock(
    projectId: string,
    input: CreateWorkflowRunInput,
  ): WorkflowRunManifestV1 {
    const requestSha256 = sha256(requestIntent(input));
    const runId = runIdForRequest(projectId, input.requestId);
    const existing = readRunManifestFile(projectId, runId);
    if (existing) {
      if (existing.requestSha256 === requestSha256) return existing;
      throw new WorkflowStoreError(
        "CONFLICT",
        `Request id ${input.requestId} was already used for different workflow-run input.`,
      );
    }

    const definition = readDefinitionFile(projectId, input.workflowId);
    if (!definition) {
      throw new WorkflowStoreError("NOT_FOUND", `Workflow ${input.workflowId} does not exist.`);
    }
    if (
      input.expectedWorkflowRevision !== undefined &&
      input.expectedWorkflowRevision !== definition.revision
    ) {
      throw new WorkflowStoreError(
        "CONFLICT",
        `Workflow ${input.workflowId} is revision ${definition.revision}; expected ${input.expectedWorkflowRevision}.`,
      );
    }

    const selectedFiles = validateRunFileSelections(projectId, input.input?.files);
    if (selectedFiles.issues.length > 0) {
      throw new WorkflowPreconditionError(selectedFiles.issues);
    }
    if (definition.graph.preconditions) {
      const issues = validateScientificWorkflowTemplatePreconditions(
        definition.graph.preconditions,
        {
          goal: input.input?.goal,
          variables: input.input?.variables,
          files: selectedFiles.files,
          capabilities: ["prompt-analysis", "read-uploaded-files"],
        },
      );
      if (issues.length > 0) throw new WorkflowPreconditionError(issues);
    }

    let expandedGraph = definition.graph;
    try {
      expandedGraph = expandWorkflowRefs(definition.graph, (workflowId) => {
        const referenced = readDefinitionFile(projectId, workflowId);
        if (!referenced) return null;
        return {
          id: referenced.id,
          revision: referenced.revision,
          graphSha256: referenced.graphSha256,
          graph: referenced.graph,
        };
      });
    } catch (error) {
      if (error instanceof WorkflowRefExpansionError) {
        throw new WorkflowStoreError(
          error.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_DEFINITION",
          error.message,
        );
      }
      throw error;
    }
    const expandedValidation = validateWorkflowGraphDocument(expandedGraph);
    if (!expandedValidation.ok) {
      throw new WorkflowStoreError(
        "INVALID_DEFINITION",
        expandedValidation.issues.map((issue) => issue.message).join("; "),
      );
    }

    const createdAt = Date.now();
    const manifest: WorkflowRunManifestV1 = {
      storageVersion: WORKFLOW_RUN_STORAGE_VERSION,
      id: runId,
      projectId,
      workflowId: definition.id,
      workflowRevision: definition.revision,
      graphSha256: definition.graphSha256,
      requestId: input.requestId,
      requestSha256,
      ...(input.expectedWorkflowRevision !== undefined
        ? { expectedWorkflowRevision: input.expectedWorkflowRevision }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAt,
      requestedBy: input.requestedBy,
      input: structuredClone(input.input ?? {}),
      effectiveLimits: structuredClone(expandedValidation.document.limits),
      graph: structuredClone(expandedValidation.document),
    };
    const manifestBytes = Buffer.from(serializedJson(manifest), "utf-8");
    assertByteLimit(manifestBytes, MAX_WORKFLOW_RUN_MANIFEST_BYTES, "Workflow run manifest");
    const initialEvent: WorkflowRunEventV1 = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      runId,
      eventId: `queued_${requestSha256.slice(0, 32)}`,
      seq: 1,
      ts: createdAt,
      type: "run_queued",
      data: { workflowRevision: definition.revision },
    };
    const eventBytes = Buffer.from(JSON.stringify(initialEvent) + "\n", "utf-8");
    const initialState = reduceWorkflowRun(manifest, [initialEvent]);
    if (initialState.diagnostics.some((diagnostic) => diagnostic.fatal)) {
      throw new WorkflowStoreError("CORRUPT", "New workflow run failed its initial event contract.");
    }
    const paths = projectPaths(projectId);
    ensureManagedDirectory(paths, paths.workflowRunsDir);
    const finalFiles = workflowRunFiles(projectId, runId);
    const stagingDirectory = path.join(
      paths.workflowRunsDir,
      `.creating-${runId}-${process.pid}-${crypto.randomUUID()}`,
    );
    assertManagedTarget(paths, stagingDirectory);
    try {
      fs.mkdirSync(stagingDirectory, { mode: 0o700 });
      atomicWriteBytes(
        paths,
        path.join(stagingDirectory, "run.json"),
        manifestBytes,
        MAX_WORKFLOW_RUN_MANIFEST_BYTES,
      );
      atomicWriteBytes(
        paths,
        path.join(stagingDirectory, "events.jsonl"),
        eventBytes,
        MAX_WORKFLOW_EVENT_LOG_BYTES,
      );
      const eventMetadata = existingManagedFileMetadata(
        paths,
        path.join(stagingDirectory, "events.jsonl"),
        `Workflow run ${runId} event log`,
      );
      if (!eventMetadata) {
        throw new WorkflowStoreError("CORRUPT", "New workflow event log is unreadable.");
      }
      const summaryBytes = serializedRunSummary(manifest, initialState, eventMetadata);
      assertProjectRunCapacity(
        projectId,
        manifestBytes.length + eventBytes.length + summaryBytes.length,
        { creatingRun: true },
      );
      atomicWriteBytes(
        paths,
        path.join(stagingDirectory, "summary.json"),
        summaryBytes,
        MAX_WORKFLOW_RUN_SUMMARY_BYTES,
      );
      fsyncDirectory(stagingDirectory);
      fs.renameSync(stagingDirectory, finalFiles.dir);
      fsyncDirectory(paths.workflowRunsDir);
    } catch (error) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      const raced = readRunManifestFile(projectId, runId);
      if (raced?.requestSha256 === requestSha256) return raced;
      throw error;
    }
    return manifest;
  }

  readRun(projectId: string, runId: string): WorkflowRunRecord | null {
    const manifest = readRunManifestFile(projectId, runId);
    if (!manifest) return null;
    const loaded = loadEventLog(projectId, runId);
    return {
      manifest,
      state: reduceWorkflowRun(manifest, loaded.events, loaded.diagnostics),
    };
  }

  listRuns(projectId: string, limit = 100): WorkflowRunRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKFLOW_RUN_LIST_SIZE) {
      throw new WorkflowStoreError(
        "LIMIT_REACHED",
        `Workflow run list limit must be 1-${MAX_WORKFLOW_RUN_LIST_SIZE}.`,
      );
    }
    return runIds(projectId)
      .flatMap((runId) => {
        const run = readRunForListing(projectId, runId);
        return run ? [run] : [];
      })
      .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt || a.manifest.id.localeCompare(b.manifest.id))
      .slice(0, limit);
  }

  /** Durable queued work in oldest-first order for controller recovery. */
  listQueuedRuns(projectId: string): WorkflowRunRecord[] {
    return runIds(projectId)
      .flatMap((runId) => {
        const run = readRunForListing(projectId, runId);
        return run?.state.status === "queued" ? [run] : [];
      })
      .sort((a, b) =>
        a.manifest.createdAt - b.manifest.createdAt ||
        a.manifest.id.localeCompare(b.manifest.id)
      );
  }

  /** Non-terminal runs which may accept a durable cancellation request. */
  listCancellableRuns(projectId: string): WorkflowRunRecord[] {
    return runIds(projectId)
      .flatMap((runId) => {
        const run = readRunForListing(projectId, runId);
        return run && ["queued", "running", "waiting", "blocked", "paused"].includes(
            run.state.status,
          )
          ? [run]
          : [];
      })
      .sort((a, b) =>
        a.manifest.createdAt - b.manifest.createdAt ||
        a.manifest.id.localeCompare(b.manifest.id)
      );
  }

  readRunEvents(
    projectId: string,
    runId: string,
    options: { after?: number; limit?: number } = {},
  ): WorkflowRunEventPage {
    if (!readRunManifestFile(projectId, runId)) {
      throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
    }
    const after = options.after ?? 0;
    const limit = options.limit ?? DEFAULT_WORKFLOW_EVENT_PAGE_SIZE;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new WorkflowStoreError("CONFLICT", "Event cursor must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKFLOW_EVENT_PAGE_SIZE) {
      throw new WorkflowStoreError(
        "LIMIT_REACHED",
        `Event page limit must be 1-${MAX_WORKFLOW_EVENT_PAGE_SIZE}.`,
      );
    }
    const loaded = loadEventLog(projectId, runId);
    const remaining = loaded.events.filter((event) => event.seq > after);
    return {
      events: remaining.slice(0, limit),
      lastSeq: loaded.events.at(-1)?.seq ?? 0,
      hasMore: remaining.length > limit,
      diagnostics: loaded.diagnostics,
    };
  }

  appendRunEvent(
    projectId: string,
    runId: string,
    input: WorkflowRunEventInput,
    expectedSeq: number,
    lease?: WorkflowRunLeaseClaim,
  ): WorkflowRunEventV1 {
    if (!readRunManifestFile(projectId, runId)) {
      throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
    }
    const paths = projectPaths(projectId);
    return withRunMutationLock(paths, runId, () => {
      this.assertAppendLease(projectId, runId, lease, input.type);
      return this.appendRunEventLocked(projectId, runId, input, expectedSeq);
    });
  }

  private appendRunEventLocked(
    projectId: string,
    runId: string,
    input: WorkflowRunEventInput,
    expectedSeq: number,
  ): WorkflowRunEventV1 {
    const manifest = readRunManifestFile(projectId, runId);
    if (!manifest) {
      throw new WorkflowStoreError("NOT_FOUND", `No such workflow run: ${runId}`);
    }
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
      throw new WorkflowStoreError("CONFLICT", "Expected event sequence must be non-negative.");
    }
    validateEventInput(input);
    if (input.nodeId && !manifest.graph.nodes.some((node) => node.id === input.nodeId)) {
      throw new WorkflowStoreError(
        "CONFLICT",
        `Node ${input.nodeId} is not present in workflow run ${runId}.`,
      );
    }
    let loaded = loadEventLog(projectId, runId);
    const fatalDiagnostics = loaded.diagnostics.filter(
      (diagnostic) => diagnostic.fatal && diagnostic.code !== "torn-event-tail",
    );
    if (fatalDiagnostics.length > 0) {
      throw new WorkflowStoreError(
        fatalDiagnostics.some((diagnostic) => diagnostic.code === "unsupported-event-version")
          ? "UNSUPPORTED_VERSION"
          : "CORRUPT",
        fatalDiagnostics.map((diagnostic) => diagnostic.message).join("; "),
      );
    }
    const existing = loaded.events.find((event) => event.eventId === input.eventId);
    if (existing) {
      if (canonicalJson(eventIntent(existing)) !== canonicalJson(eventIntent(input))) {
        throw new WorkflowStoreError("CONFLICT", `Event id ${input.eventId} has different persisted content.`);
      }
      if (loaded.repair) {
        repairEventLog(projectId, runId, loaded);
        loaded = loadEventLog(projectId, runId);
      }
      const persistedState = reduceWorkflowRun(manifest, loaded.events, loaded.diagnostics);
      if (persistedState.diagnostics.some((diagnostic) => diagnostic.fatal)) {
        throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has an invalid event history.`);
      }
      const paths = projectPaths(projectId);
      const eventMetadata = existingManagedFileMetadata(
        paths,
        workflowRunFiles(projectId, runId).events,
        `Workflow run ${runId} event log`,
      );
      if (!eventMetadata || eventMetadata.size !== loaded.bytes.length) {
        throw new WorkflowStoreError(
          "CONFLICT",
          `Workflow run ${runId} event log changed while rebuilding its summary.`,
        );
      }
      const summaryBytes = serializedRunSummary(manifest, persistedState, eventMetadata);
      const oldSummaryBytes = existingManagedFileSize(
        paths,
        workflowRunFiles(projectId, runId).summary,
        `Workflow run ${runId} summary`,
      ) ?? 0;
      assertProjectRunCapacity(projectId, Math.max(0, summaryBytes.length - oldSummaryBytes));
      writeRunSummaryBytes(projectId, runId, summaryBytes);
      return existing;
    }
    const currentSeq = loaded.events.at(-1)?.seq ?? 0;
    if (expectedSeq !== currentSeq) {
      throw new WorkflowStoreError(
        "CONFLICT",
        `Workflow run ${runId} is at event ${currentSeq}; expected ${expectedSeq}.`,
      );
    }
    if (loaded.repair) {
      repairEventLog(projectId, runId, loaded);
      loaded = loadEventLog(projectId, runId);
    }
    const currentState = reduceWorkflowRun(manifest, loaded.events, loaded.diagnostics);
    if (currentState.diagnostics.some((diagnostic) => diagnostic.fatal)) {
      throw new WorkflowStoreError("CORRUPT", `Workflow run ${runId} has an invalid event history.`);
    }
    if (isTerminalWorkflowRunStatus(currentState.status)) {
      throw new WorkflowStoreError(
        "CONFLICT",
        `Workflow run ${runId} already reached terminal state ${currentState.status}.`,
      );
    }

    const event: WorkflowRunEventV1 = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      runId,
      seq: (loaded.events.at(-1)?.seq ?? 0) + 1,
      ts: Date.now(),
      ...structuredClone(input),
    };
    const encoded = JSON.stringify(event) + "\n";
    assertByteLimit(encoded, MAX_WORKFLOW_EVENT_BYTES, "Workflow event");
    const nextState = reduceWorkflowRun(
      manifest,
      [...loaded.events, event],
      loaded.diagnostics,
    );
    const candidateFatalDiagnostics = nextState.diagnostics.filter(
      (diagnostic) => diagnostic.fatal,
    );
    if (candidateFatalDiagnostics.length > 0) {
      throw new WorkflowStoreError(
        "CONFLICT",
        `Workflow event ${input.eventId} violates run history: ${candidateFatalDiagnostics
          .map((diagnostic) => diagnostic.message)
          .join("; ")}`,
      );
    }
    const paths = projectPaths(projectId);
    const eventFile = workflowRunFiles(projectId, runId).events;
    const currentEventMetadata = existingManagedFileMetadata(
      paths,
      eventFile,
      `Workflow run ${runId} event log`,
    );
    if (currentEventMetadata === null || currentEventMetadata.size !== loaded.bytes.length) {
      throw new WorkflowStoreError(
        "CONFLICT",
        `Workflow run ${runId} event log changed during append.`,
      );
    }
    const encodedBytes = Buffer.byteLength(encoded, "utf-8");
    const maximumBeforeAppend = isTerminalEvent(input.type)
      ? MAX_WORKFLOW_EVENT_LOG_BYTES
      : MAX_WORKFLOW_EVENT_LOG_BYTES - MAX_WORKFLOW_EVENT_BYTES;
    if (currentEventMetadata.size + encodedBytes > maximumBeforeAppend) {
      throw new WorkflowStoreError(
        "LIMIT_REACHED",
        `Workflow event log is full; append a terminal event before ${MAX_WORKFLOW_EVENT_LOG_BYTES} bytes.`,
      );
    }
    const oldSummaryBytes = existingManagedFileSize(
      paths,
      workflowRunFiles(projectId, runId).summary,
      `Workflow run ${runId} summary`,
    ) ?? 0;
    // The post-fsync mtime/ctime are only known after append. Reserve the
    // summary's full bounded size before mutating the authoritative log; this
    // can reject within 4 MiB of the 4 GiB project cap, but never leaves a
    // successful append whose required cache growth was not admitted.
    assertProjectRunCapacity(
      projectId,
      encodedBytes + Math.max(0, MAX_WORKFLOW_RUN_SUMMARY_BYTES - oldSummaryBytes),
    );
    const nextEventMetadata = appendDurableLine(
      paths,
      eventFile,
      encoded,
      maximumBeforeAppend,
      `Workflow run ${runId} event log`,
    );
    const summaryBytes = serializedRunSummary(manifest, nextState, nextEventMetadata);
    writeRunSummaryBytes(projectId, runId, summaryBytes);
    return event;
  }

  reconcileInterruptedRuns(projectId: string): WorkflowRecoveryResult {
    const result: WorkflowRecoveryResult = { interrupted: [], active: [], errors: [] };
    for (const runId of runIds(projectId)) {
      try {
        const run = this.readRun(projectId, runId);
        if (!run) continue;
        const unrecoverableDiagnostics = run.state.diagnostics.filter(
          (diagnostic) => diagnostic.fatal && diagnostic.code !== "torn-event-tail",
        );
        if (unrecoverableDiagnostics.length > 0) {
          result.errors.push({
            runId,
            message: unrecoverableDiagnostics
              .map((diagnostic) => diagnostic.message)
              .join("; "),
          });
          continue;
        }
        const hasRunningExecution = Object.values(run.state.executions).some(
          (execution) => execution.status === "running",
        );
        if (
          !["running", "waiting", "blocked", "paused"].includes(run.state.status) &&
          !hasRunningExecution
        ) continue;
        if (this.hasLiveRunLease(projectId, runId)) {
          result.active.push(runId);
          continue;
        }
        // This recovers only durable graph state. Public Delegation V2 exposes
        // no durable child PID/reattachment handle, so a crash-era Pi leaf is
        // not proven quiescent here. Shipping resumable Pi leaves across this
        // boundary remains the documented P0 release gate.
        this.appendRunEvent(
          projectId,
          runId,
          {
            eventId: `restart_${crypto.createHash("sha256").update(`${runId}:${run.state.lastSeq}`).digest("hex").slice(0, 32)}`,
            type: "run_interrupted",
            data: {
              previousStatus: run.state.status,
              error: {
                code: "SERVER_RESTART",
                message: "Workflow execution was interrupted by a server restart.",
                retryable: true,
              },
            },
          },
          run.state.lastSeq,
        );
        result.interrupted.push(runId);
      } catch (error) {
        result.errors.push({ runId, message: (error as Error).message });
      }
    }
    return result;
  }
}

export const workflowStore = new WorkflowStore();
