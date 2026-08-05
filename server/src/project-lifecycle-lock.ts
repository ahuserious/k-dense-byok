/**
 * Cross-process exclusion for project lifecycle transitions.
 *
 * Locks live under `PROJECTS_ROOT/.locks`, outside the project directory that
 * deletion removes. A DAG run creator and the final delete recheck therefore
 * cannot pass one another between "no active run" and recursive deletion.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECTS_ROOT } from "./config.ts";

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PROJECT_IDS = new Set(["new", "index", "archive", "..", "."]);
const MAX_LOCK_BYTES = 4_096;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type ProjectLifecycleLockErrorCode =
  | "INVALID_ID"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "CORRUPT";

export class ProjectLifecycleLockError extends Error {
  constructor(
    readonly code: ProjectLifecycleLockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectLifecycleLockError";
  }
}

export interface ProjectLifecycleLockOptions {
  waitMs?: number;
  staleMs?: number;
}

interface StoredProjectLifecycleLockV1 {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

interface ProjectLifecycleLockObservation {
  owner: StoredProjectLifecycleLockV1;
  stat: fs.Stats;
}

function lockError(code: ProjectLifecycleLockErrorCode, message: string): never {
  throw new ProjectLifecycleLockError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId) || RESERVED_PROJECT_IDS.has(projectId)) {
    lockError("INVALID_ID", `Invalid project id: ${projectId}`);
  }
}

function assertOptions(options: ProjectLifecycleLockOptions): Required<ProjectLifecycleLockOptions> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    lockError("INVALID_ARGUMENT", "Project lifecycle lock waitMs must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(staleMs) || staleMs < 1_000) {
    lockError("INVALID_ARGUMENT", "Project lifecycle lock staleMs must be at least 1000ms.");
  }
  return { waitMs, staleMs };
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

function isWithin(root: string, target: string): boolean {
  if (process.platform === "win32") {
    root = root.toLowerCase();
    target = target.toLowerCase();
  }
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function ensureOwnedDirectory(directory: string, realProjectsRoot: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    lockError("CORRUPT", `Project lifecycle lock path is not an owned directory: ${directory}`);
  }
  const realDirectory = fs.realpathSync(directory);
  if (!isWithin(realProjectsRoot, realDirectory)) {
    lockError("CORRUPT", "Project lifecycle lock directory escaped the projects root.");
  }
}

function lifecycleLockDirectory(): string {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  const rootStat = fs.statSync(PROJECTS_ROOT);
  if (!rootStat.isDirectory()) {
    lockError("CORRUPT", "The configured projects root is not a directory.");
  }
  const realProjectsRoot = fs.realpathSync(PROJECTS_ROOT);
  const locksDirectory = path.join(PROJECTS_ROOT, ".locks");
  ensureOwnedDirectory(locksDirectory, realProjectsRoot);
  const lifecycleDirectory = path.join(locksDirectory, "project-lifecycle");
  ensureOwnedDirectory(lifecycleDirectory, realProjectsRoot);
  return lifecycleDirectory;
}

function sameFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return (before.dev === 0 && before.ino === 0) ||
    (before.dev === after.dev && before.ino === after.ino);
}

function parseLock(bytes: Buffer, label: string): StoredProjectLifecycleLockV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch {
    lockError("CORRUPT", `${label} is malformed JSON.`);
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "token", "pid", "hostname", "createdAt"]) ||
    value.version !== 1 ||
    typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
    !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 ||
    typeof value.hostname !== "string" || value.hostname.length < 1 || value.hostname.length > 255 ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
  ) {
    lockError("CORRUPT", `${label} has invalid ownership metadata.`);
  }
  return value as unknown as StoredProjectLifecycleLockV1;
}

function readLock(lockFile: string, label: string): ProjectLifecycleLockObservation | null {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(lockFile, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) lockError("CORRUPT", `${label} is not a regular file.`);
    if (before.size > MAX_LOCK_BYTES) {
      lockError("CORRUPT", `${label} exceeds ${MAX_LOCK_BYTES} bytes.`);
    }
    const owner = parseLock(fs.readFileSync(fd), label);
    const after = fs.fstatSync(fd);
    if (!after.isFile() || !sameFileIdentity(before, after) || before.size !== after.size) {
      lockError("CORRUPT", `${label} changed while it was read.`);
    }
    return { owner, stat: after };
  } finally {
    fs.closeSync(fd);
  }
}

function sameLock(
  left: ProjectLifecycleLockObservation,
  right: ProjectLifecycleLockObservation,
): boolean {
  return left.owner.token === right.owner.token &&
    left.owner.pid === right.owner.pid &&
    left.owner.hostname === right.owner.hostname &&
    left.owner.createdAt === right.owner.createdAt &&
    sameFileIdentity(left.stat, right.stat);
}

function lockOwnerMayBeAlive(owner: StoredProjectLifecycleLockV1): boolean {
  // Shared storage may be mounted on several hosts. Remote locks are never
  // stolen because this process cannot prove the remote owner's death.
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createLock(
  lockFile: string,
  label: string,
): ProjectLifecycleLockObservation | null {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const owner: StoredProjectLifecycleLockV1 = {
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
    const stat = fs.fstatSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(path.dirname(lockFile));
    return { owner, stat };
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lockFile, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

function releaseLock(
  lockFile: string,
  label: string,
  acquired: ProjectLifecycleLockObservation,
): void {
  const current = readLock(lockFile, label);
  if (!current || !sameLock(current, acquired)) {
    lockError("CORRUPT", `${label} changed owner before release.`);
  }
  fs.unlinkSync(lockFile);
  fsyncDirectory(path.dirname(lockFile));
}

function recoverUnprotectedLock(
  lockFile: string,
  label: string,
  observed: ProjectLifecycleLockObservation,
  staleMs: number,
): boolean {
  if (
    Date.now() - observed.owner.createdAt <= staleMs ||
    lockOwnerMayBeAlive(observed.owner)
  ) return false;
  const confirmed = readLock(lockFile, label);
  if (
    !confirmed ||
    !sameLock(confirmed, observed) ||
    Date.now() - confirmed.owner.createdAt <= staleMs ||
    lockOwnerMayBeAlive(confirmed.owner)
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

function acquireRecoveryLock(
  recoveryFile: string,
  label: string,
  staleMs: number,
): ProjectLifecycleLockObservation | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acquired = createLock(recoveryFile, label);
    if (acquired) return acquired;
    const observed = readLock(recoveryFile, label);
    if (!observed || !recoverUnprotectedLock(recoveryFile, label, observed, staleMs)) {
      return null;
    }
  }
  return null;
}

function recoverDeadLock(
  lockFile: string,
  label: string,
  observed: ProjectLifecycleLockObservation,
  staleMs: number,
): boolean {
  if (
    Date.now() - observed.owner.createdAt <= staleMs ||
    lockOwnerMayBeAlive(observed.owner)
  ) return false;
  const recoveryFile = `${lockFile}.recovery`;
  const recoveryLabel = `${label} recovery lock`;
  const recovery = acquireRecoveryLock(recoveryFile, recoveryLabel, staleMs);
  if (!recovery) return false;
  try {
    const confirmed = readLock(lockFile, label);
    if (
      !confirmed ||
      !sameLock(confirmed, observed) ||
      Date.now() - confirmed.owner.createdAt <= staleMs ||
      lockOwnerMayBeAlive(confirmed.owner)
    ) return false;
    fs.unlinkSync(lockFile);
    fsyncDirectory(path.dirname(lockFile));
    return true;
  } finally {
    releaseLock(recoveryFile, recoveryLabel, recovery);
  }
}

/**
 * Run one synchronous project lifecycle transition under a cross-process lock.
 * The callback must not return a promise or re-enter this lock.
 */
export function withProjectLifecycleLock<T>(
  projectId: string,
  criticalSection: () => T,
  options: ProjectLifecycleLockOptions = {},
): T {
  assertProjectId(projectId);
  const { waitMs, staleMs } = assertOptions(options);
  const lockDirectory = lifecycleLockDirectory();
  const lockFile = path.join(lockDirectory, `${projectId}.lock`);
  const label = `Project ${projectId} lifecycle lock`;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const acquired = createLock(lockFile, label);
    if (acquired) {
      try {
        const result = criticalSection();
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          lockError("INVALID_ARGUMENT", "Project lifecycle critical sections must be synchronous.");
        }
        return result;
      } finally {
        releaseLock(lockFile, label, acquired);
      }
    }

    const observed = readLock(lockFile, label);
    if (!observed) continue;
    if (recoverDeadLock(lockFile, label, observed, staleMs)) continue;
    if (Date.now() >= deadline) {
      lockError("CONFLICT", `Timed out waiting for project ${projectId}'s lifecycle lock.`);
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, Math.min(10, deadline - Date.now()));
  }
}
