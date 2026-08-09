import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  WatcherOperationPhase,
  WatcherOperationRecord,
  WatcherOperationStore,
  WatcherOperationTransaction,
} from "./compaction-watcher.ts";

const STATE_SEGMENTS = [".kady", "workflows", "context-watcher"] as const;
const OPERATION_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;
const LOCK_LEASE_MS = 60 * 60 * 1_000;
const PROCESS_START_IDENTITY = `${Date.now()}-${randomBytes(24).toString("hex")}`;
const PHASES = new Set<WatcherOperationPhase>([
  "repairing",
  "repair-failed",
  "redeployed",
  "restart-failed",
  "completed",
]);

export type CompactionWatcherOperationStoreErrorCode =
  | "INVALID_ROOT"
  | "INVALID_KEY"
  | "LOCKED"
  | "CORRUPT"
  | "CAS_MISMATCH"
  | "UNSAFE_PATH";

export class CompactionWatcherOperationStoreError extends Error {
  constructor(
    readonly code: CompactionWatcherOperationStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompactionWatcherOperationStoreError";
  }
}

function fail(
  code: CompactionWatcherOperationStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new CompactionWatcherOperationStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function noFollowFlag(): number {
  const flag = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;
  return typeof flag === "number" ? flag : 0;
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Some supported Windows filesystems cannot fsync a directory.
  }
}

function ensureStateDirectory(sandboxRoot: string): string {
  if (!sandboxRoot || sandboxRoot.includes("\0")) {
    return fail("INVALID_ROOT", "Compaction watcher sandbox root is invalid.");
  }
  const requestedRoot = path.resolve(sandboxRoot);
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(requestedRoot);
  } catch (error) {
    return fail("INVALID_ROOT", "Compaction watcher sandbox root is missing.", error);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return fail("INVALID_ROOT", "Compaction watcher sandbox root must be a real directory.");
  }
  const realRoot = fs.realpathSync(requestedRoot);
  let current = realRoot;
  for (const segment of STATE_SEGMENTS) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return fail("UNSAFE_PATH", "Compaction watcher state directory is unavailable.", error);
      }
    }
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return fail("UNSAFE_PATH", "Compaction watcher state traverses an unsafe path.");
    }
    const realCurrent = fs.realpathSync(current);
    if (!realCurrent.startsWith(`${realRoot}${path.sep}`)) {
      return fail("UNSAFE_PATH", "Compaction watcher state escapes the sandbox.");
    }
  }
  return current;
}

function assertOperationKey(operationKey: string): void {
  if (!OPERATION_KEY_PATTERN.test(operationKey)) {
    fail("INVALID_KEY", "Compaction watcher operation key is invalid.");
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordOperationKey(
  runId: string,
  nodeId: string | undefined,
  auditIdentity: string,
): string {
  return createHash("sha256")
    .update(runId, "utf8")
    .update("\0")
    .update(nodeId ?? "", "utf8")
    .update("\0")
    .update(auditIdentity, "utf8")
    .digest("hex");
}

function validRecovery(value: unknown, runId: string): boolean {
  return plainRecord(value) &&
    Object.keys(value).every((key) => [
      "runId",
      "checkpointId",
      "restartToken",
      "verified",
      "sideEffectSafety",
    ].includes(key)) &&
    value.runId === runId &&
    typeof value.checkpointId === "string" && value.checkpointId.length > 0 &&
    typeof value.restartToken === "string" && value.restartToken.length > 0 &&
    value.verified === true &&
    ["no-side-effects", "idempotent", "compensated"].includes(
      value.sideEffectSafety as string,
    );
}

function parseRecord(value: unknown, operationKey: string): WatcherOperationRecord {
  if (
    !plainRecord(value) ||
    value.version !== 1 ||
    value.operationKey !== operationKey ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.runId !== "string" || value.runId.length === 0 ||
    (value.nodeId !== undefined && typeof value.nodeId !== "string") ||
    typeof value.auditIdentity !== "string" ||
    !OPERATION_KEY_PATTERN.test(value.auditIdentity) ||
    (typeof value.runId === "string" && typeof value.auditIdentity === "string" &&
      recordOperationKey(
        value.runId,
        typeof value.nodeId === "string" ? value.nodeId : undefined,
        value.auditIdentity,
      ) !== operationKey) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase as WatcherOperationPhase) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0 ||
    (value.workflowRevision !== undefined && (
      !Number.isSafeInteger(value.workflowRevision) ||
      (value.workflowRevision as number) < 1
    )) ||
    (value.recovery !== undefined && !validRecovery(value.recovery, value.runId)) ||
    (value.detail !== undefined && typeof value.detail !== "string") ||
    (["redeployed", "restart-failed", "completed"].includes(value.phase) && (
      value.workflowRevision === undefined || value.recovery === undefined
    ))
  ) {
    return fail("CORRUPT", "Compaction watcher operation state is malformed.");
  }
  return structuredClone(value) as unknown as WatcherOperationRecord;
}

function readRecord(stateFile: string, operationKey: string): WatcherOperationRecord | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(stateFile, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail("UNSAFE_PATH", "Compaction watcher state could not be opened safely.", error);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_STATE_BYTES) {
      return fail("CORRUPT", "Compaction watcher state file is unsafe or oversized.");
    }
    const serialized = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      Buffer.byteLength(serialized, "utf8") !== before.size
    ) {
      return fail("UNSAFE_PATH", "Compaction watcher state changed while being read.");
    }
    try {
      return parseRecord(JSON.parse(serialized), operationKey);
    } catch (error) {
      if (error instanceof CompactionWatcherOperationStoreError) throw error;
      return fail("CORRUPT", "Compaction watcher state is not valid JSON.", error);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeRecord(stateDirectory: string, stateFile: string, record: WatcherOperationRecord): void {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    fail("CORRUPT", "Compaction watcher state exceeds its hard size bound.");
  }
  const temporary = path.join(
    stateDirectory,
    `.${record.operationKey}.${process.pid}.${record.sequence}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, stateFile);
    fsyncDirectory(stateDirectory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ProcessIdentityRecord {
  version: 1;
  pid: number;
  processStartIdentity: string;
}

interface LockOwnerRecord extends ProcessIdentityRecord {
  ownerNonce: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

interface ObservedLock {
  owner?: LockOwnerRecord;
  legacyPid?: number;
  dev: number;
  ino: number;
  mtimeMs: number;
}

interface AcquiredLock {
  descriptor: number;
  owner: LockOwnerRecord;
}

function processIdentityFile(stateDirectory: string, pid: number): string {
  return path.join(stateDirectory, `.process-${pid}.json`);
}

function publishProcessIdentity(stateDirectory: string): void {
  const identity: ProcessIdentityRecord = {
    version: 1,
    pid: process.pid,
    processStartIdentity: PROCESS_START_IDENTITY,
  };
  const target = processIdentityFile(stateDirectory, process.pid);
  const temporary = path.join(
    stateDirectory,
    `.process-${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(identity)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    fsyncDirectory(stateDirectory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function parseProcessIdentity(value: unknown): ProcessIdentityRecord | undefined {
  if (
    !plainRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.processStartIdentity !== "string" ||
    value.processStartIdentity.length < 16
  ) return undefined;
  return value as unknown as ProcessIdentityRecord;
}

function parseLockOwner(value: unknown): LockOwnerRecord | undefined {
  const identity = parseProcessIdentity(value);
  if (
    !identity ||
    !plainRecord(value) ||
    typeof value.ownerNonce !== "string" ||
    value.ownerNonce.length < 16 ||
    !Number.isSafeInteger(value.acquiredAt) ||
    (value.acquiredAt as number) < 0 ||
    !Number.isSafeInteger(value.leaseExpiresAt) ||
    (value.leaseExpiresAt as number) <= (value.acquiredAt as number)
  ) return undefined;
  return value as unknown as LockOwnerRecord;
}

function readSmallFile(file: string): { serialized: string; stats: fs.Stats } | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail("UNSAFE_PATH", "Compaction watcher lock metadata is unsafe.", error);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_LOCK_BYTES) {
      return fail("UNSAFE_PATH", "Compaction watcher lock metadata is unsafe or oversized.");
    }
    const serialized = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      Buffer.byteLength(serialized, "utf8") !== before.size
    ) {
      return fail("UNSAFE_PATH", "Compaction watcher lock metadata changed while read.");
    }
    return { serialized, stats: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readObservedLock(lockFile: string): ObservedLock | undefined {
  const read = readSmallFile(lockFile);
  if (!read) return undefined;
  let owner: LockOwnerRecord | undefined;
  let legacyPid: number | undefined;
  try {
    owner = parseLockOwner(JSON.parse(read.serialized));
  } catch {
    const parsedPid = Number(read.serialized.trim());
    if (Number.isSafeInteger(parsedPid) && parsedPid > 0) legacyPid = parsedPid;
  }
  return {
    ...(owner ? { owner } : {}),
    ...(legacyPid ? { legacyPid } : {}),
    dev: read.stats.dev,
    ino: read.stats.ino,
    mtimeMs: read.stats.mtimeMs,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processIdentityMatches(stateDirectory: string, owner: LockOwnerRecord): boolean {
  const read = readSmallFile(processIdentityFile(stateDirectory, owner.pid));
  if (!read) return false;
  try {
    const identity = parseProcessIdentity(JSON.parse(read.serialized));
    return identity?.pid === owner.pid &&
      identity.processStartIdentity === owner.processStartIdentity;
  } catch {
    return false;
  }
}

function lockIsStale(stateDirectory: string, observed: ObservedLock): boolean {
  if (observed.owner) {
    if (Date.now() >= observed.owner.leaseExpiresAt) return true;
    return !processIsAlive(observed.owner.pid) ||
      !processIdentityMatches(stateDirectory, observed.owner);
  }
  if (observed.legacyPid && !processIsAlive(observed.legacyPid)) return true;
  return Date.now() >= observed.mtimeMs + LOCK_LEASE_MS;
}

function sameObservedLock(left: ObservedLock, right: ObservedLock): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.owner?.ownerNonce === right.owner?.ownerNonce &&
    left.owner?.processStartIdentity === right.owner?.processStartIdentity &&
    left.owner?.leaseExpiresAt === right.owner?.leaseExpiresAt &&
    left.legacyPid === right.legacyPid;
}

function tryReclaimStaleLock(stateDirectory: string, lockFile: string): boolean {
  const reclaimFile = `${lockFile}.reclaim`;
  const reclaimCandidate = createLockCandidate(stateDirectory);
  let reclaimLock: AcquiredLock | undefined;
  try {
    try {
      fs.linkSync(reclaimCandidate.temporary, reclaimFile);
      fs.unlinkSync(reclaimCandidate.temporary);
      reclaimLock = {
        descriptor: reclaimCandidate.descriptor,
        owner: reclaimCandidate.owner,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        fs.closeSync(reclaimCandidate.descriptor);
        fs.rmSync(reclaimCandidate.temporary, { force: true });
        const prior = readObservedLock(reclaimFile);
        if (!prior || !lockIsStale(stateDirectory, prior)) return false;
        const verifiedPrior = readObservedLock(reclaimFile);
        if (!verifiedPrior || !sameObservedLock(prior, verifiedPrior)) return false;
        try {
          fs.unlinkSync(reclaimFile);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        return false;
      }
      fs.closeSync(reclaimCandidate.descriptor);
      fs.rmSync(reclaimCandidate.temporary, { force: true });
      return fail("UNSAFE_PATH", "Compaction watcher reclaim lock is unsafe.", error);
    }
    const observed = readObservedLock(lockFile);
    if (!observed || !lockIsStale(stateDirectory, observed)) return false;
    const verified = readObservedLock(lockFile);
    if (!verified || !sameObservedLock(observed, verified)) return false;
    fs.unlinkSync(lockFile);
    fsyncDirectory(stateDirectory);
    return true;
  } finally {
    if (reclaimLock) releaseLock(reclaimFile, reclaimLock);
  }
}

function createLockCandidate(stateDirectory: string): {
  descriptor: number;
  temporary: string;
  owner: LockOwnerRecord;
} {
  const acquiredAt = Date.now();
  const owner: LockOwnerRecord = {
    version: 1,
    pid: process.pid,
    ownerNonce: randomBytes(24).toString("hex"),
    processStartIdentity: PROCESS_START_IDENTITY,
    acquiredAt,
    leaseExpiresAt: acquiredAt + LOCK_LEASE_MS,
  };
  const temporary = path.join(
    stateDirectory,
    `.lock-${process.pid}-${owner.ownerNonce}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
    0o600,
  );
  fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
  fs.fsyncSync(descriptor);
  return { descriptor, temporary, owner };
}

async function acquireLock(stateDirectory: string, lockFile: string): Promise<AcquiredLock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const candidate = createLockCandidate(stateDirectory);
  while (true) {
    try {
      fs.linkSync(candidate.temporary, lockFile);
      fs.unlinkSync(candidate.temporary);
      fsyncDirectory(stateDirectory);
      return { descriptor: candidate.descriptor, owner: candidate.owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        fs.closeSync(candidate.descriptor);
        fs.rmSync(candidate.temporary, { force: true });
        return fail("UNSAFE_PATH", "Compaction watcher operation lock is unsafe.", error);
      }
      tryReclaimStaleLock(stateDirectory, lockFile);
      if (Date.now() >= deadline) {
        fs.closeSync(candidate.descriptor);
        fs.rmSync(candidate.temporary, { force: true });
        return fail("LOCKED", "Compaction watcher operation is still active.");
      }
      await delay(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockFile: string, lock: AcquiredLock): void {
  try {
    const opened = fs.fstatSync(lock.descriptor);
    const current = fs.lstatSync(lockFile);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      fail("UNSAFE_PATH", "Compaction watcher operation lock changed identity.");
    }
    const observed = readObservedLock(lockFile);
    if (observed?.owner?.ownerNonce !== lock.owner.ownerNonce) {
      fail("UNSAFE_PATH", "Compaction watcher operation lock changed owner.");
    }
    fs.unlinkSync(lockFile);
    fsyncDirectory(path.dirname(lockFile));
  } finally {
    fs.closeSync(lock.descriptor);
  }
}

/** Durable filesystem CAS store. One exact operation key is serialized at a time. */
export class FileCompactionWatcherOperationStore implements WatcherOperationStore {
  readonly #stateDirectory: string;

  constructor(sandboxRoot: string) {
    this.#stateDirectory = ensureStateDirectory(sandboxRoot);
    publishProcessIdentity(this.#stateDirectory);
  }

  async runExclusive<T>(
    operationKey: string,
    operation: (transaction: WatcherOperationTransaction) => Promise<T>,
  ): Promise<T> {
    assertOperationKey(operationKey);
    const stateFile = path.join(this.#stateDirectory, `${operationKey}.json`);
    const lockFile = path.join(this.#stateDirectory, `.${operationKey}.lock`);
    const lock = await acquireLock(this.#stateDirectory, lockFile);
    try {
      const stateDirectory = this.#stateDirectory;
      let current = readRecord(stateFile, operationKey);
      const transaction: WatcherOperationTransaction = {
        get current(): WatcherOperationRecord | undefined {
          return current ? structuredClone(current) : undefined;
        },
        compareAndSwap(expectedPhase, next): WatcherOperationRecord {
          if (current?.phase !== expectedPhase) {
            return fail(
              "CAS_MISMATCH",
              `Compaction watcher expected phase ${String(expectedPhase)}, observed ${String(current?.phase)}.`,
            );
          }
          const record: WatcherOperationRecord = {
            version: 1,
            operationKey,
            sequence: (current?.sequence ?? 0) + 1,
            ...structuredClone(next),
            updatedAt: Date.now(),
          };
          writeRecord(stateDirectory, stateFile, record);
          current = record;
          return structuredClone(record);
        },
      };
      return await operation(transaction);
    } finally {
      releaseLock(lockFile, lock);
    }
  }
}
