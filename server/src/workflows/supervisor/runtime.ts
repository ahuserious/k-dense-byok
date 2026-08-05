import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_SUPERVISOR_RUNTIME_VERSION = 1 as const;
export const WORKFLOW_SUPERVISOR_STATE_FILE = "supervisor.json";
export const WORKFLOW_SUPERVISOR_MAX_STATE_BYTES = 16 * 1024;
/**
 * A bind path longer than `sockaddr_un.sun_path` is not representable at all,
 * so `listen` fails with EINVAL. macOS and the BSDs hold 104 bytes and carry
 * the length out of band; Linux holds 108 and needs the NUL terminator. Any
 * other platform gets the smaller budget minus a terminator.
 */
export const WORKFLOW_SUPERVISOR_MAX_SOCKET_PATH_BYTES = process.platform === "darwin"
  ? 104
  : process.platform === "linux"
  ? 107
  : 103;

export interface WorkflowSupervisorRuntimePaths {
  stateDir: string;
  stateFile: string;
  launchLock: string;
  socketPath: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface WorkflowSupervisorRuntimeStateV1 {
  version: typeof WORKFLOW_SUPERVISOR_RUNTIME_VERSION;
  protocolVersion: number;
  repositoryDigest: string;
  pid: number;
  token: string;
  socketPath: string;
  startedAt: number;
}

function repositoryRoot(): string {
  return fs.realpathSync(path.resolve(import.meta.dirname, "..", "..", "..", ".."));
}

function repositoryDigest(): string {
  return crypto.createHash("sha256").update(repositoryRoot()).digest("hex").slice(0, 24);
}

function absoluteOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function exceedsSocketPathBudget(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, "utf-8") > WORKFLOW_SUPERVISOR_MAX_SOCKET_PATH_BYTES;
}

/**
 * Short private directory for a socket that cannot be bound inside its own
 * state directory. Pi agent directories are routinely deeper than `sun_path`
 * allows, and the backend and its detached owner must still agree on one exact
 * path, so the name is derived from the exact state directory it serves.
 */
export function workflowSupervisorFallbackSocketDirectory(stateDir: string): string {
  const key = crypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `kady-wf-${key}`);
}

export function workflowSupervisorRuntimePaths(): WorkflowSupervisorRuntimePaths {
  const digest = repositoryDigest();
  const stateDir = absoluteOverride("KADY_WORKFLOW_SUPERVISOR_DIR") ??
    path.join(getAgentDir(), "workflow-supervisor", digest);
  const socketOverride = process.env.KADY_WORKFLOW_SUPERVISOR_SOCKET?.trim();
  let socketPath = socketOverride || (process.platform === "win32"
    ? `\\\\.\\pipe\\kady-workflow-supervisor-${digest}`
    : path.join(stateDir, "supervisor.sock"));
  if (process.platform !== "win32") {
    if (!path.isAbsolute(socketPath)) {
      throw new Error("KADY_WORKFLOW_SUPERVISOR_SOCKET must be absolute on this platform.");
    }
    if (!socketOverride && exceedsSocketPathBudget(socketPath)) {
      socketPath = path.join(
        workflowSupervisorFallbackSocketDirectory(stateDir),
        "supervisor.sock",
      );
    }
    // An operator-supplied override and an over-long temporary directory both
    // land here. Fail closed with the actionable knob instead of leaving the
    // detached supervisor to die on an opaque EINVAL from `listen`.
    if (exceedsSocketPathBudget(socketPath)) {
      throw new Error(
        "Workflow supervisor socket path exceeds this platform's limit of " +
          `${WORKFLOW_SUPERVISOR_MAX_SOCKET_PATH_BYTES} bytes; set ` +
          "KADY_WORKFLOW_SUPERVISOR_SOCKET to a shorter absolute path.",
      );
    }
  }
  return {
    stateDir,
    stateFile: path.join(stateDir, WORKFLOW_SUPERVISOR_STATE_FILE),
    launchLock: path.join(stateDir, "launch.lock"),
    socketPath,
    stdoutLog: path.join(stateDir, "supervisor.stdout.log"),
    stderrLog: path.join(stateDir, "supervisor.stderr.log"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRuntimeState(value: unknown): WorkflowSupervisorRuntimeStateV1 {
  if (
    !isRecord(value) ||
    value.version !== WORKFLOW_SUPERVISOR_RUNTIME_VERSION ||
    !Number.isSafeInteger(value.protocolVersion) || (value.protocolVersion as number) < 1 ||
    typeof value.repositoryDigest !== "string" || !/^[a-f0-9]{24}$/.test(value.repositoryDigest) ||
    !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 ||
    typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
    typeof value.socketPath !== "string" || value.socketPath.length < 1 || value.socketPath.length > 512 ||
    !Number.isSafeInteger(value.startedAt) || (value.startedAt as number) < 0
  ) {
    throw new Error("Workflow supervisor runtime state is malformed.");
  }
  return value as unknown as WorkflowSupervisorRuntimeStateV1;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (left.dev === 0 && left.ino === 0) ||
    (left.dev === right.dev && left.ino === right.ino);
}

function assertCurrentUserOwnership(stat: fs.Stats, description: string): void {
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`${description} is not owned by the current user.`);
  }
}

function assertPrivateMode(
  stat: fs.Stats,
  expectedMode: number,
  description: string,
): void {
  if (process.platform !== "win32" && (stat.mode & 0o777) !== expectedMode) {
    throw new Error(`${description} must have mode ${expectedMode.toString(8)}.`);
  }
}

/**
 * Validate the final directory component without repairing an existing
 * directory. Broadening ownership or permissions is an ambiguous local trust
 * boundary, so callers must fail closed instead of silently chmodding it.
 */
function assertPrivateDirectory(
  directory: string,
  description: string,
  create: boolean | undefined,
): fs.Stats | undefined {
  if (create) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} is not a real directory.`);
  }
  assertCurrentUserOwnership(stat, description);
  assertPrivateMode(stat, 0o700, description);
  return stat;
}

export function assertPrivateWorkflowSupervisorStateDirectory(
  paths: WorkflowSupervisorRuntimePaths,
  options: { create?: boolean } = {},
): fs.Stats | undefined {
  return assertPrivateDirectory(
    paths.stateDir,
    "Workflow supervisor state directory",
    options.create,
  );
}

/**
 * Prepare a socket directory that this runtime minted itself. A socket living
 * inside the state directory needs no extra work, and a caller-supplied
 * override keeps its own directory untouched: creating or judging a path the
 * operator chose is not this process's decision.
 */
export function assertPrivateWorkflowSupervisorSocketDirectory(
  paths: WorkflowSupervisorRuntimePaths,
  options: { create?: boolean } = {},
): void {
  if (process.platform === "win32") return;
  const socketDir = path.dirname(paths.socketPath);
  if (socketDir !== workflowSupervisorFallbackSocketDirectory(paths.stateDir)) return;
  assertPrivateDirectory(socketDir, "Workflow supervisor socket directory", options.create);
}

function assertPrivateRuntimeStateFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WORKFLOW_SUPERVISOR_MAX_STATE_BYTES) {
    throw new Error("Workflow supervisor runtime state is not a bounded regular file.");
  }
  assertCurrentUserOwnership(stat, "Workflow supervisor runtime state");
  assertPrivateMode(stat, 0o600, "Workflow supervisor runtime state");
}

export function readWorkflowSupervisorRuntimeState(
  paths: WorkflowSupervisorRuntimePaths = workflowSupervisorRuntimePaths(),
): WorkflowSupervisorRuntimeStateV1 | undefined {
  if (!assertPrivateWorkflowSupervisorStateDirectory(paths)) return undefined;
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(paths.stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertPrivateRuntimeStateFile(pathStat);
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(paths.stateFile, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    assertPrivateRuntimeStateFile(before);
    if (!sameFileIdentity(pathStat, before)) {
      throw new Error("Workflow supervisor runtime state changed before it was read.");
    }
    const value = parseRuntimeState(JSON.parse(fs.readFileSync(fd, "utf-8")));
    const after = fs.fstatSync(fd);
    if (
      !after.isFile() || after.isSymbolicLink() ||
      before.size !== after.size ||
      !sameFileIdentity(before, after)
    ) {
      throw new Error("Workflow supervisor runtime state changed while it was read.");
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

export function writeWorkflowSupervisorRuntimeState(
  state: WorkflowSupervisorRuntimeStateV1,
  paths: WorkflowSupervisorRuntimePaths = workflowSupervisorRuntimePaths(),
): void {
  parseRuntimeState(state);
  assertPrivateWorkflowSupervisorStateDirectory(paths, { create: true });
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf-8");
  if (bytes.byteLength > WORKFLOW_SUPERVISOR_MAX_STATE_BYTES) {
    throw new Error("Workflow supervisor runtime state exceeds its byte limit.");
  }
  const temporary = path.join(
    paths.stateDir,
    `.${WORKFLOW_SUPERVISOR_STATE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    assertPrivateRuntimeStateFile(fs.fstatSync(fd));
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const temporaryStat = fs.fstatSync(fd);
    assertPrivateRuntimeStateFile(temporaryStat);
    fs.closeSync(fd);
    fd = undefined;
    assertPrivateWorkflowSupervisorStateDirectory(paths);
    fs.renameSync(temporary, paths.stateFile);
    const publishedStat = fs.lstatSync(paths.stateFile);
    assertPrivateRuntimeStateFile(publishedStat);
    if (!sameFileIdentity(temporaryStat, publishedStat)) {
      throw new Error("Workflow supervisor runtime state changed while it was published.");
    }
    try {
      const directoryFd = fs.openSync(paths.stateDir, "r");
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Directory fsync is not available on every supported Windows filesystem.
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Remove a published state file only while both its contents and inode remain
 * the exact runtime identity owned by the caller.
 */
export function removeWorkflowSupervisorRuntimeStateIfOwned(
  paths: WorkflowSupervisorRuntimePaths,
  expected: WorkflowSupervisorRuntimeStateV1,
): boolean {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(paths.stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  assertPrivateRuntimeStateFile(before);

  let current: WorkflowSupervisorRuntimeStateV1 | undefined;
  try {
    current = readWorkflowSupervisorRuntimeState(paths);
  } catch {
    // A malformed or replaced state file is not attributable to this runtime.
    return false;
  }
  if (
    !current ||
    current.pid !== expected.pid ||
    current.token !== expected.token ||
    current.startedAt !== expected.startedAt ||
    current.socketPath !== expected.socketPath
  ) {
    return false;
  }

  let after: fs.Stats;
  try {
    after = fs.lstatSync(paths.stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!sameFileIdentity(before, after)) return false;

  // This final identity read intentionally sits immediately beside unlink.
  // Node has no portable unlink-by-file-descriptor primitive.
  const finalStat = fs.lstatSync(paths.stateFile);
  if (!sameFileIdentity(after, finalStat)) return false;
  fs.unlinkSync(paths.stateFile);
  return true;
}

export function workflowSupervisorRepositoryDigest(): string {
  return repositoryDigest();
}

export function workflowSupervisorProcessMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
