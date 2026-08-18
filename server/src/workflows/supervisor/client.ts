import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import type {
  DagFusionDelegationIdentity,
  DagFusionDelegationReceipt,
  DagFusionDelegationUsageSettlement,
  OwnedDelegationRequest,
} from "../../../pi-packages/dag-fusion-drive/index.ts";
import {
  assertWorkflowHarnessAdapterBound,
  prepareWorkflowDelegationProject,
} from "../../agent/workflow-delegation-session.ts";
import { resolvePaths, type ProjectPaths } from "../../projects.ts";
import type {
  HostedOpenRouterFusionRequest,
  HostedOpenRouterFusionResult,
} from "../hosted-fusion.ts";
import type {
  SupervisedWorkflowBudgetDescriptorV1,
} from "../supervised-budget.ts";
import type {
  KadyHostedFusionTransportOptions,
  KadyNodeExecutorDependencies,
  KadySupervisedDelegateOptions,
} from "../kady-node-executor.ts";
import {
  MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES,
  WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
  encodeWorkflowSupervisorRequestLine,
  parseWorkflowSupervisorResponseLine,
  type SerializedHostedOpenRouterFusionRequest,
  WORKFLOW_SUPERVISOR_SAFE_ERRORS,
  type WorkflowSupervisorErrorCode,
  type WorkflowSupervisorQuiesceProjectResult,
  type WorkflowSupervisorQuiesceReason,
  type WorkflowSupervisorRequest,
  type WorkflowSupervisorResponse,
  type WorkflowSupervisorSnapshot,
  type WorkflowSupervisorSuccessResponse,
} from "./protocol.ts";
import {
  assertPrivateWorkflowSupervisorSocketDirectory,
  assertPrivateWorkflowSupervisorStateDirectory,
  readWorkflowSupervisorRuntimeState,
  workflowSupervisorProcessMayBeAlive,
  workflowSupervisorRepositoryDigest,
  workflowSupervisorRuntimePaths,
  type WorkflowSupervisorRuntimePaths,
  type WorkflowSupervisorRuntimeStateV1,
} from "./runtime.ts";
import type {
  WorkflowSupervisorCredentialKey,
} from "./credential-contract.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;
const CHILD_TERMINATE_TIMEOUT_MS = 3_000;
const CHILD_KILL_TIMEOUT_MS = 3_000;
const STARTUP_POLL_INTERVAL_MS = 50;
const CANCEL_SETTLEMENT_TIMEOUT_MS = 30_000;
const MAX_LAUNCH_LOCK_BYTES = 4 * 1024;
const LAUNCH_LOCK_VERSION = 1 as const;

export type WorkflowSupervisorClientErrorCode =
  | "ABORTED"
  | "NOT_ATTACHED"
  | "PROTOCOL_ERROR"
  | "RECONCILIATION_FAILED"
  | "STARTUP_AMBIGUOUS"
  | "STARTUP_FAILED"
  | "TRANSPORT_ERROR";

export class WorkflowSupervisorClientError extends Error {
  constructor(
    readonly code: WorkflowSupervisorClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowSupervisorClientError";
  }
}

export class WorkflowSupervisorRemoteError extends Error {
  constructor(
    readonly code: WorkflowSupervisorErrorCode,
    readonly retryable: boolean,
    readonly settlement?: DagFusionDelegationUsageSettlement,
  ) {
    super(WORKFLOW_SUPERVISOR_SAFE_ERRORS[code].message);
    this.name = "WorkflowSupervisorRemoteError";
  }
}

/** Exact process ownership retained until startup either attaches or cleans up. */
export interface SpawnedWorkflowSupervisor {
  pid: number;
  token: string;
  /** Resolve only after the exact spawned ChildProcess has emitted `exit`. */
  terminate(): Promise<void>;
}

export interface WorkflowSupervisorClientDependencies {
  readRuntimeState(
    paths: WorkflowSupervisorRuntimePaths,
  ): WorkflowSupervisorRuntimeStateV1 | undefined;
  processMayBeAlive(pid: number): boolean;
  spawnSupervisor(
    paths: WorkflowSupervisorRuntimePaths,
  ): Promise<SpawnedWorkflowSupervisor>;
  connect(socketPath: string): net.Socket;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  randomEpoch(): number;
}

export interface EnsureWorkflowSupervisorOptions {
  onOwnership?(pid: number): void;
  paths?: WorkflowSupervisorRuntimePaths;
  startupTimeoutMs?: number;
  connectTimeoutMs?: number;
  pingTimeoutMs?: number;
  closeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  cancelSettlementTimeoutMs?: number;
  dependencies?: Partial<WorkflowSupervisorClientDependencies>;
}

interface ExchangeOptions {
  keepOpen?: boolean;
  signal?: AbortSignal;
  connectTimeoutMs: number;
  responseTimeoutMs?: number;
  /** Cancel out of band on abort instead of dropping the operation socket. */
  cancelOnAbort?: {
    cancel(): Promise<void>;
    timeoutMs: number;
  };
}

interface ExchangeResult {
  response: WorkflowSupervisorResponse;
  socket: net.Socket;
}

interface LaunchLockRecordV1 {
  version: typeof LAUNCH_LOCK_VERSION;
  pid: number;
  startedAt: number;
  nonce: string;
}

interface HeldLaunchLock {
  fd: number;
  stat: fs.Stats;
}

interface RuntimeArtifactIdentities {
  stateFile: fs.Stats;
  socket?: fs.Stats;
}

interface FreshWorkflowSupervisorRuntime {
  runtimeState: WorkflowSupervisorRuntimeStateV1;
  child: SpawnedWorkflowSupervisor;
}

function clientError(
  code: WorkflowSupervisorClientErrorCode,
  message: string,
  cause?: unknown,
): WorkflowSupervisorClientError {
  return new WorkflowSupervisorClientError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 300_000) {
    throw clientError("STARTUP_FAILED", `${name} must be a positive bounded integer.`);
  }
  return resolved;
}

function randomPositiveSafeEpoch(): number {
  // randomInt's range is limited to 2^48. Zero is excluded so the result also
  // satisfies the protocol's positive-safe-integer epoch contract.
  return crypto.randomInt(1, 2 ** 48);
}

function defaultSleep(milliseconds: number): Promise<void> {
  // Startup runs before Fastify owns a listening handle. Keep this timer
  // referenced so the backend cannot exit while awaiting supervisor state.
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function noFollowFlag(): number {
  return (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
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

function ensurePrivateStateDirectory(paths: WorkflowSupervisorRuntimePaths): void {
  try {
    assertPrivateWorkflowSupervisorStateDirectory(paths, { create: true });
    assertPrivateWorkflowSupervisorSocketDirectory(paths, { create: true });
  } catch (error) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor state directory is not private and owned.",
      error,
    );
  }
}

function openPrivateAppendLog(filename: string): number {
  const fd = fs.openSync(
    filename,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      noFollowFlag(),
    0o600,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("Supervisor log target is not a regular file.");
    }
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

async function defaultSpawnSupervisor(
  paths: WorkflowSupervisorRuntimePaths,
): Promise<SpawnedWorkflowSupervisor> {
  ensurePrivateStateDirectory(paths);
  const serverRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const tsxPackage = path.join(serverRoot, "node_modules", "tsx", "package.json");
  const supervisorEntrypoint = path.join(import.meta.dirname, "entry.ts");
  for (const filename of [tsxPackage, supervisorEntrypoint]) {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) {
      throw clientError("STARTUP_FAILED", "Workflow supervisor runtime entrypoint is unavailable.");
    }
  }

  const stdoutFd = openPrivateAppendLog(paths.stdoutLog);
  let stderrFd: number | undefined;
  let ownedChild: SpawnedWorkflowSupervisor | undefined;
  try {
    stderrFd = openPrivateAppendLog(paths.stderrLog);
    const token = crypto.randomBytes(32).toString("hex");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", supervisorEntrypoint],
      {
        cwd: serverRoot,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: {
          ...process.env,
          KADY_WORKFLOW_SUPERVISOR_DIR: paths.stateDir,
          KADY_WORKFLOW_SUPERVISOR_SOCKET: paths.socketPath,
          KADY_WORKFLOW_SUPERVISOR_TOKEN: token,
        },
      },
    );
    let childExited = child.exitCode !== null || child.signalCode !== null;
    const exited = childExited
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          child.once("exit", () => {
            childExited = true;
            resolve();
          });
        });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) < 1) {
      throw new Error("Detached workflow supervisor did not report a process id.");
    }
    const pid = child.pid!;
    // Avoid uncaught post-spawn ChildProcess errors. Termination proof comes
    // from the exact handle's exit event, never from a reusable numeric pid.
    child.on("error", () => {});
    ownedChild = ownedSpawnedWorkflowSupervisor(
      child,
      pid,
      token,
      exited,
      () => childExited,
    );
    child.unref();
    return ownedChild;
  } catch (error) {
    if (ownedChild) {
      try {
        await ownedChild.terminate();
      } catch (terminationError) {
        throw clientError(
          "STARTUP_AMBIGUOUS",
          "The failed workflow supervisor launch could not prove exact child termination.",
          new AggregateError([error, terminationError]),
        );
      }
    }
    throw clientError(
      "STARTUP_FAILED",
      "The detached workflow supervisor process could not be launched.",
      error,
    );
  } finally {
    fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
  }
}

function waitForOwnedChildExit(
  exited: Promise<void>,
  hasExited: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(hasExited());
    }, timeoutMs);
    void exited.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function ownedSpawnedWorkflowSupervisor(
  child: ChildProcess,
  pid: number,
  token: string,
  exited: Promise<void>,
  hasExited: () => boolean,
): SpawnedWorkflowSupervisor {
  let terminatePromise: Promise<void> | undefined;
  return {
    pid,
    token,
    terminate() {
      if (terminatePromise) return terminatePromise;
      terminatePromise = (async () => {
        if (hasExited()) return;
        try {
          child.kill("SIGTERM");
        } catch {
          // Exit-event proof below remains authoritative.
        }
        if (await waitForOwnedChildExit(exited, hasExited, CHILD_TERMINATE_TIMEOUT_MS)) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // Exit-event proof below remains authoritative.
        }
        if (await waitForOwnedChildExit(exited, hasExited, CHILD_KILL_TIMEOUT_MS)) return;
        throw new Error("Exact detached workflow supervisor child did not exit after termination.");
      })();
      return terminatePromise;
    },
  };
}

const defaultDependencies: WorkflowSupervisorClientDependencies = {
  readRuntimeState: readWorkflowSupervisorRuntimeState,
  processMayBeAlive: workflowSupervisorProcessMayBeAlive,
  spawnSupervisor: defaultSpawnSupervisor,
  connect: (socketPath) => net.createConnection(socketPath),
  now: Date.now,
  sleep: defaultSleep,
  randomEpoch: randomPositiveSafeEpoch,
};

function effectiveDependencies(
  overrides: Partial<WorkflowSupervisorClientDependencies> | undefined,
): WorkflowSupervisorClientDependencies {
  return { ...defaultDependencies, ...overrides };
}

function timerAfter(
  milliseconds: number,
  callback: () => void,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return timer;
}

function exchange(
  dependencies: WorkflowSupervisorClientDependencies,
  socketPath: string,
  request: WorkflowSupervisorRequest,
  options: ExchangeOptions,
): Promise<ExchangeResult> {
  if (options.signal?.aborted) {
    return Promise.reject(clientError("ABORTED", "Workflow supervisor request was aborted."));
  }

  let socket: net.Socket;
  try {
    socket = dependencies.connect(socketPath);
  } catch (error) {
    return Promise.reject(
      clientError("TRANSPORT_ERROR", "Workflow supervisor socket could not be opened.", error),
    );
  }
  // A control lease may fail after its initial response. Retain a harmless
  // listener so a later socket error can never become an uncaught exception.
  socket.on("error", () => {});

  return new Promise<ExchangeResult>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let buffer = Buffer.alloc(0);
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    const connectTimer = timerAfter(options.connectTimeoutMs, () => {
      finishError(
        clientError("TRANSPORT_ERROR", "Workflow supervisor socket connection timed out."),
      );
    });

    const cleanup = () => {
      clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const finishSuccess = (response: WorkflowSupervisorResponse) => {
      if (settled) return;
      if (response.messageId !== request.messageId) {
        finishError(
          clientError(
            "PROTOCOL_ERROR",
            "Workflow supervisor response correlation did not match the request.",
          ),
        );
        return;
      }
      settled = true;
      cleanup();
      if (options.keepOpen) {
        socket.on("data", () => {
          socket.destroy(
            clientError(
              "PROTOCOL_ERROR",
              "Workflow supervisor control lease emitted an unexpected second frame.",
            ),
          );
        });
      } else {
        socket.end();
      }
      resolve({ response, socket });
    };
    const onConnect = () => {
      connected = true;
      clearTimeout(connectTimer);
      if (options.responseTimeoutMs !== undefined) {
        responseTimer = timerAfter(options.responseTimeoutMs, () => {
          finishError(
            clientError("TRANSPORT_ERROR", "Workflow supervisor response timed out."),
          );
        });
      }
      let encoded: string;
      try {
        encoded = encodeWorkflowSupervisorRequestLine(request);
      } catch (error) {
        finishError(
          clientError("PROTOCOL_ERROR", "Workflow supervisor request was invalid.", error),
        );
        return;
      }
      socket.write(encoded, (error) => {
        if (error) {
          finishError(
            clientError("TRANSPORT_ERROR", "Workflow supervisor request could not be sent.", error),
          );
        }
      });
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_WORKFLOW_SUPERVISOR_FRAME_BYTES) {
        finishError(
          clientError("PROTOCOL_ERROR", "Workflow supervisor response exceeded its byte limit."),
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.byteLength - 1) {
        finishError(
          clientError("PROTOCOL_ERROR", "Workflow supervisor sent more than one response frame."),
        );
        return;
      }
      try {
        finishSuccess(parseWorkflowSupervisorResponseLine(buffer));
      } catch (error) {
        finishError(
          clientError("PROTOCOL_ERROR", "Workflow supervisor response was invalid.", error),
        );
      }
    };
    const onEnd = () => {
      finishError(
        clientError("TRANSPORT_ERROR", "Workflow supervisor closed before responding."),
      );
    };
    const onClose = () => {
      finishError(
        clientError("TRANSPORT_ERROR", "Workflow supervisor connection closed unexpectedly."),
      );
    };
    const onError = (error: Error) => {
      finishError(
        clientError(
          "TRANSPORT_ERROR",
          connected
            ? "Workflow supervisor connection failed during the request."
            : "Workflow supervisor socket connection failed.",
          error,
        ),
      );
    };
    const onAbort = () => {
      // Destroying this socket also cancels the attempt, but it discards the
      // terminal settlement the supervisor is about to send. When the caller
      // supplies an out-of-band cancel, ask for cancellation there and keep
      // reading here; only a silent supervisor falls back to the hard drop.
      if (!options.cancelOnAbort || !connected) {
        finishError(clientError("ABORTED", "Workflow supervisor request was aborted."));
        return;
      }
      const { cancel, timeoutMs } = options.cancelOnAbort;
      if (responseTimer) clearTimeout(responseTimer);
      responseTimer = timerAfter(timeoutMs, () => {
        finishError(clientError("ABORTED", "Workflow supervisor request was aborted."));
      });
      void cancel().catch(() => {
        // A cancel that cannot be delivered leaves the bounded timer above as
        // the only guarantee; it still ends in the fail-closed hard drop.
      });
    };

    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isLaunchLockRecord(value: unknown): value is LaunchLockRecordV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 4 &&
    (value as Record<string, unknown>).version === LAUNCH_LOCK_VERSION &&
    Number.isSafeInteger((value as Record<string, unknown>).pid) &&
    ((value as Record<string, unknown>).pid as number) >= 1 &&
    Number.isSafeInteger((value as Record<string, unknown>).startedAt) &&
    ((value as Record<string, unknown>).startedAt as number) >= 0 &&
    typeof (value as Record<string, unknown>).nonce === "string" &&
    /^[a-f0-9]{32}$/.test((value as Record<string, unknown>).nonce as string)
  );
}

function readLaunchLock(paths: WorkflowSupervisorRuntimePaths): LaunchLockRecordV1 {
  const fd = fs.openSync(paths.launchLock, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 2 || before.size > MAX_LAUNCH_LOCK_BYTES) {
      throw new Error("Workflow supervisor launch lock is not a bounded regular file.");
    }
    const value = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    if (!isLaunchLockRecord(value)) {
      throw new Error("Workflow supervisor launch lock is malformed.");
    }
    const after = fs.fstatSync(fd);
    if (
      !after.isFile() ||
      before.size !== after.size ||
      !((before.dev === 0 && before.ino === 0) ||
        (before.dev === after.dev && before.ino === after.ino))
    ) {
      throw new Error("Workflow supervisor launch lock changed while it was read.");
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

function acquireLaunchLock(
  paths: WorkflowSupervisorRuntimePaths,
  now: number,
): HeldLaunchLock | undefined {
  const record: LaunchLockRecordV1 = {
    version: LAUNCH_LOCK_VERSION,
    pid: process.pid,
    startedAt: now,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  let fd: number;
  try {
    fd = fs.openSync(
      paths.launchLock,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    fsyncDirectory(paths.stateDir);
    return { fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(paths.launchLock, { force: true });
    throw error;
  }
}

function sameFileIdentity(expected: fs.Stats, current: fs.Stats): boolean {
  return (expected.dev === 0 && expected.ino === 0) ||
    (current.dev === expected.dev && current.ino === expected.ino);
}

function removeFileIfSame(filename: string, expected: fs.Stats): boolean {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !sameFileIdentity(expected, current)
  ) {
    return false;
  }
  fs.unlinkSync(filename);
  return true;
}

function releaseLaunchLock(
  paths: WorkflowSupervisorRuntimePaths,
  held: HeldLaunchLock,
): void {
  try {
    removeFileIfSame(paths.launchLock, held.stat);
    fsyncDirectory(paths.stateDir);
  } finally {
    fs.closeSync(held.fd);
  }
}

function removeDeadLaunchLock(
  paths: WorkflowSupervisorRuntimePaths,
  expected: LaunchLockRecordV1,
  dependencies: WorkflowSupervisorClientDependencies,
): void {
  if (dependencies.processMayBeAlive(expected.pid)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor launch ownership became live while it was inspected.",
    );
  }
  const stat = fs.lstatSync(paths.launchLock);
  const reread = readLaunchLock(paths);
  if (!isDeepStrictEqual(reread, expected) || dependencies.processMayBeAlive(expected.pid)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor launch ownership changed while it was inspected.",
    );
  }
  if (!removeFileIfSame(paths.launchLock, stat)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor launch lock changed before stale cleanup.",
    );
  }
  fsyncDirectory(paths.stateDir);
}

function assertRuntimeCompatibility(
  state: WorkflowSupervisorRuntimeStateV1,
  paths: WorkflowSupervisorRuntimePaths,
): void {
  if (
    state.protocolVersion !== WORKFLOW_SUPERVISOR_PROTOCOL_VERSION ||
    state.repositoryDigest !== workflowSupervisorRepositoryDigest() ||
    state.socketPath !== paths.socketPath
  ) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor runtime state belongs to an incompatible process.",
    );
  }
}

function deadSocketIdentity(
  paths: WorkflowSupervisorRuntimePaths,
): fs.Stats | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const stat = fs.lstatSync(paths.socketPath);
    if (!stat.isSocket()) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor socket path is occupied by a non-socket entry.",
      );
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function removeDeadRuntimeState(
  state: WorkflowSupervisorRuntimeStateV1,
  paths: WorkflowSupervisorRuntimePaths,
  dependencies: WorkflowSupervisorClientDependencies,
): void {
  if (dependencies.processMayBeAlive(state.pid)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor process became live while stale state was inspected.",
    );
  }
  const expectedSocket = state.socketPath === paths.socketPath
    ? deadSocketIdentity(paths)
    : undefined;
  const stat = fs.lstatSync(paths.stateFile);
  const reread = dependencies.readRuntimeState(paths);
  if (
    !reread ||
    !isDeepStrictEqual(reread, state) ||
    dependencies.processMayBeAlive(state.pid)
  ) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor runtime state changed before stale cleanup.",
    );
  }
  if (!removeFileIfSame(paths.stateFile, stat)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor runtime state changed before it could be removed.",
    );
  }
  if (state.socketPath === paths.socketPath && process.platform !== "win32") {
    if (expectedSocket) {
      if (!removeFileIfSame(paths.socketPath, expectedSocket)) {
        throw clientError(
          "STARTUP_AMBIGUOUS",
          "Workflow supervisor socket identity changed before stale cleanup.",
        );
      }
    } else if (deadSocketIdentity(paths)) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor socket appeared during stale cleanup.",
      );
    }
  }
  fsyncDirectory(paths.stateDir);
}

function assertSocketPathAvailable(paths: WorkflowSupervisorRuntimePaths): void {
  if (process.platform === "win32") return;
  try {
    fs.lstatSync(paths.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw clientError(
    "STARTUP_AMBIGUOUS",
    "Workflow supervisor socket exists without attributable runtime state.",
  );
}

function captureRuntimeArtifactIdentities(
  expected: WorkflowSupervisorRuntimeStateV1,
  paths: WorkflowSupervisorRuntimePaths,
  dependencies: WorkflowSupervisorClientDependencies,
): RuntimeArtifactIdentities {
  const current = dependencies.readRuntimeState(paths);
  if (!current || !isDeepStrictEqual(current, expected)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor runtime state changed before attachment.",
    );
  }
  let stateFile: fs.Stats;
  try {
    stateFile = fs.lstatSync(paths.stateFile);
  } catch (error) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor runtime state disappeared before attachment.",
      error,
    );
  }
  if (!stateFile.isFile() || stateFile.isSymbolicLink()) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor runtime state changed type before attachment.",
    );
  }

  let socket: fs.Stats | undefined;
  if (process.platform !== "win32") {
    try {
      socket = fs.lstatSync(paths.socketPath);
    } catch (error) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor socket disappeared before attachment.",
        error,
      );
    }
    if (!socket.isSocket()) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor socket changed type before attachment.",
      );
    }
  }
  return { stateFile, ...(socket ? { socket } : {}) };
}

function commonRequest(
  state: WorkflowSupervisorRuntimeStateV1,
  messageId: string,
): Pick<WorkflowSupervisorRequest, "version" | "messageId" | "token"> {
  return {
    version: WORKFLOW_SUPERVISOR_PROTOCOL_VERSION,
    messageId,
    token: state.token,
  };
}

function mintMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

function successFor<Op extends WorkflowSupervisorSuccessResponse["op"]>(
  response: WorkflowSupervisorResponse,
  op: Op,
): Extract<WorkflowSupervisorSuccessResponse, { op: Op }> {
  if (!response.ok) {
    throw new WorkflowSupervisorRemoteError(
      response.error.code,
      response.error.retryable,
      response.settlement,
    );
  }
  if (response.op !== op) {
    throw clientError(
      "PROTOCOL_ERROR",
      "Workflow supervisor response operation did not match the request.",
    );
  }
  return response as Extract<WorkflowSupervisorSuccessResponse, { op: Op }>;
}

async function pingRuntime(
  state: WorkflowSupervisorRuntimeStateV1,
  dependencies: WorkflowSupervisorClientDependencies,
  connectTimeoutMs: number,
  pingTimeoutMs: number,
): Promise<void> {
  const messageId = mintMessageId();
  const { response } = await exchange(
    dependencies,
    state.socketPath,
    { ...commonRequest(state, messageId), op: "ping" },
    { connectTimeoutMs, responseTimeoutMs: pingTimeoutMs },
  );
  const success = successFor(response, "ping");
  if (success.result.pid !== state.pid || success.result.state === "shutting-down") {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Workflow supervisor ping did not match the advertised live runtime.",
    );
  }
}

async function inspectExistingRuntime(
  state: WorkflowSupervisorRuntimeStateV1,
  paths: WorkflowSupervisorRuntimePaths,
  dependencies: WorkflowSupervisorClientDependencies,
  connectTimeoutMs: number,
  pingTimeoutMs: number,
): Promise<WorkflowSupervisorRuntimeStateV1 | undefined> {
  let compatibilityError: unknown;
  try {
    assertRuntimeCompatibility(state, paths);
    await pingRuntime(state, dependencies, connectTimeoutMs, pingTimeoutMs);
    return state;
  } catch (error) {
    compatibilityError = error;
  }

  if (dependencies.processMayBeAlive(state.pid)) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "A workflow supervisor process is still live but could not be authenticated.",
      compatibilityError,
    );
  }
  removeDeadRuntimeState(state, paths, dependencies);
  return undefined;
}

async function acquireStartupLock(
  paths: WorkflowSupervisorRuntimePaths,
  dependencies: WorkflowSupervisorClientDependencies,
  startupTimeoutMs: number,
): Promise<HeldLaunchLock> {
  ensurePrivateStateDirectory(paths);
  const deadline = dependencies.now() + startupTimeoutMs;

  for (;;) {
    const held = acquireLaunchLock(paths, dependencies.now());
    if (held) return held;
    let owner: LaunchLockRecordV1;
    try {
      owner = readLaunchLock(paths);
    } catch (error) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor launch lock could not be authenticated.",
        error,
      );
    }
    if (!dependencies.processMayBeAlive(owner.pid)) {
      removeDeadLaunchLock(paths, owner, dependencies);
      continue;
    }
    if (dependencies.now() >= deadline) {
      throw clientError(
        "STARTUP_FAILED",
        "Timed out waiting for another workflow supervisor launch.",
      );
    }
    await dependencies.sleep(STARTUP_POLL_INTERVAL_MS);
  }
}

async function waitForRuntimeDisappearance(
  expected: WorkflowSupervisorRuntimeStateV1,
  identities: RuntimeArtifactIdentities,
  paths: WorkflowSupervisorRuntimePaths,
  dependencies: WorkflowSupervisorClientDependencies,
  timeoutMs: number,
): Promise<void> {
  const deadline = dependencies.now() + timeoutMs;
  for (;;) {
    let current: WorkflowSupervisorRuntimeStateV1 | undefined;
    try {
      current = dependencies.readRuntimeState(paths);
    } catch (error) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor runtime state became unauthentic during shutdown.",
        error,
      );
    }
    if (current && !isDeepStrictEqual(current, expected)) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor runtime state was replaced during shutdown.",
      );
    }
    let stateFileExists = false;
    try {
      const stateFile = fs.lstatSync(paths.stateFile);
      if (!stateFile.isFile() || !sameFileIdentity(identities.stateFile, stateFile)) {
        throw clientError(
          "STARTUP_AMBIGUOUS",
          "Workflow supervisor runtime state identity changed during shutdown.",
        );
      }
      stateFileExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let socketExists = false;
    if (process.platform !== "win32") {
      try {
        const socketStat = fs.lstatSync(paths.socketPath);
        if (
          !socketStat.isSocket() ||
          !identities.socket ||
          !sameFileIdentity(identities.socket, socketStat)
        ) {
          throw clientError(
            "STARTUP_AMBIGUOUS",
            "Workflow supervisor socket identity changed during shutdown.",
          );
        }
        socketExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!current && !stateFileExists && !socketExists) return;
    if (dependencies.now() >= deadline) {
      throw clientError(
        "STARTUP_FAILED",
        "Workflow supervisor did not remove its exact runtime state and socket before timeout.",
      );
    }
    await dependencies.sleep(STARTUP_POLL_INTERVAL_MS);
  }
}

function optionalArtifactStat(
  filename: string,
  expectedKind: "file" | "socket",
): fs.Stats | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const matches = expectedKind === "file" ? stat.isFile() : stat.isSocket();
  if (!matches || stat.isSymbolicLink()) {
    throw new Error(`Workflow supervisor ${expectedKind} artifact changed type.`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`Workflow supervisor ${expectedKind} artifact changed ownership.`);
  }
  return stat;
}

function removeFailedFreshRuntimeArtifacts(paths: WorkflowSupervisorRuntimePaths): void {
  const stateFile = optionalArtifactStat(paths.stateFile, "file");
  const socket = process.platform === "win32"
    ? undefined
    : optionalArtifactStat(paths.socketPath, "socket");
  if (stateFile && !removeFileIfSame(paths.stateFile, stateFile)) {
    throw new Error("Workflow supervisor state identity changed during failed-start cleanup.");
  }
  if (socket && !removeFileIfSame(paths.socketPath, socket)) {
    throw new Error("Workflow supervisor socket identity changed during failed-start cleanup.");
  }
  if (fs.existsSync(paths.stateFile)) {
    throw new Error("Workflow supervisor state remained after failed-start cleanup.");
  }
  if (process.platform !== "win32" && fs.existsSync(paths.socketPath)) {
    throw new Error("Workflow supervisor socket remained after failed-start cleanup.");
  }
  fsyncDirectory(paths.stateDir);
}

async function failFreshRuntimeStartup(
  child: SpawnedWorkflowSupervisor,
  paths: WorkflowSupervisorRuntimePaths,
  startupError: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  let exactChildExited = false;
  try {
    await child.terminate();
    exactChildExited = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  // Never unlink attribution for a child that may still be live. Runtime
  // artifacts are removed only after exact ChildProcess exit is proven.
  if (exactChildExited) {
    try {
      removeFailedFreshRuntimeArtifacts(paths);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw clientError(
      "STARTUP_AMBIGUOUS",
      "Fresh workflow supervisor startup failed without provable child and artifact cleanup.",
      new AggregateError([startupError, ...cleanupErrors]),
    );
  }
  if (startupError instanceof WorkflowSupervisorClientError) throw startupError;
  throw clientError(
    "STARTUP_FAILED",
    "Fresh workflow supervisor failed before it became ready.",
    startupError,
  );
}

async function launchFreshRuntime(
  paths: WorkflowSupervisorRuntimePaths,
  dependencies: WorkflowSupervisorClientDependencies,
  startupTimeoutMs: number,
  connectTimeoutMs: number,
  pingTimeoutMs: number,
  onOwnership?: (pid: number) => void,
): Promise<FreshWorkflowSupervisorRuntime> {
  assertSocketPathAvailable(paths);
  const child = await dependencies.spawnSupervisor(paths);
  try {
    if (
      !Number.isSafeInteger(child.pid) ||
      child.pid < 1 ||
      !/^[a-f0-9]{64}$/.test(child.token) ||
      typeof child.terminate !== "function"
    ) {
      throw clientError(
        "STARTUP_FAILED",
        "Detached workflow supervisor returned invalid process ownership.",
      );
    }
    onOwnership?.(child.pid);
    const deadline = dependencies.now() + startupTimeoutMs;
    for (;;) {
      const launchedState = dependencies.readRuntimeState(paths);
      if (launchedState) {
        if (launchedState.pid !== child.pid || launchedState.token !== child.token) {
          throw clientError(
            "STARTUP_AMBIGUOUS",
            "Published workflow supervisor state did not belong to the launched process.",
          );
        }
        const ready = await inspectExistingRuntime(
          launchedState,
          paths,
          dependencies,
          connectTimeoutMs,
          pingTimeoutMs,
        );
        if (ready) return { runtimeState: ready, child };
      }
      if (!dependencies.processMayBeAlive(child.pid)) {
        throw clientError(
          "STARTUP_FAILED",
          "Detached workflow supervisor exited before publishing ready state.",
        );
      }
      if (dependencies.now() >= deadline) {
        throw clientError(
          "STARTUP_FAILED",
          "Timed out waiting for the detached workflow supervisor to become ready.",
        );
      }
      await dependencies.sleep(STARTUP_POLL_INTERVAL_MS);
    }
  } catch (error) {
    return await failFreshRuntimeStartup(child, paths, error);
  }
}

function sameIdentity(
  left: DagFusionDelegationIdentity,
  right: DagFusionDelegationIdentity,
): boolean {
  return left.requestId === right.requestId &&
    left.ownerRunId === right.ownerRunId &&
    left.nodeId === right.nodeId;
}

function expectedIdentity(request: OwnedDelegationRequest): DagFusionDelegationIdentity {
  return {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
  };
}

function assertBudgetIdentity(
  descriptor: SupervisedWorkflowBudgetDescriptorV1,
  identity: DagFusionDelegationIdentity,
): void {
  if (
    descriptor.runId !== identity.ownerRunId ||
    `${descriptor.executionId}:${descriptor.slotId}` !== identity.nodeId
  ) {
    throw clientError(
      "PROTOCOL_ERROR",
      "Workflow budget descriptor identity did not match the supervised operation.",
    );
  }
}

async function reconcileExactSettlement(
  expected: DagFusionDelegationIdentity,
  settlement: DagFusionDelegationUsageSettlement,
  reconcileUsage: (
    settlement: DagFusionDelegationUsageSettlement,
  ) => void | Promise<void>,
): Promise<void> {
  if (!sameIdentity(expected, settlement.identity)) {
    throw clientError(
      "PROTOCOL_ERROR",
      "Workflow supervisor settlement identity did not match the operation.",
    );
  }
  try {
    await reconcileUsage(structuredClone(settlement));
  } catch (error) {
    throw clientError(
      "RECONCILIATION_FAILED",
      "Workflow supervisor terminal usage could not be reconciled.",
      error,
    );
  }
}

function assertCanonicalProjectPaths(projectId: string, paths: ProjectPaths): ProjectPaths {
  const canonical = resolvePaths(projectId);
  if (!isDeepStrictEqual(paths, canonical)) {
    throw clientError(
      "PROTOCOL_ERROR",
      "Workflow supervisor project paths were not the canonical project paths.",
    );
  }
  return canonical;
}

export class WorkflowSupervisorClient {
  readonly pid: number;
  readonly epoch: number;



  private controlSocket: net.Socket | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly runtimeState: WorkflowSupervisorRuntimeStateV1,
    private readonly runtimeArtifactIdentities: RuntimeArtifactIdentities,
    private readonly paths: WorkflowSupervisorRuntimePaths,
    private readonly dependencies: WorkflowSupervisorClientDependencies,
    private readonly connectTimeoutMs: number,
    private readonly closeTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    /**
     * How long an aborted provider operation keeps its transport open waiting
     * for the supervisor's terminal settlement before falling back to dropping
     * the socket. The supervisor's cancellation path already bounds itself;
     * this only has to outlast one acknowledgement round trip.
     */
    private readonly cancelSettlementTimeoutMs: number,
    epoch: number,
  ) {
    this.pid = runtimeState.pid;
    this.epoch = epoch;
  }

  static async attach(input: {
    runtimeState: WorkflowSupervisorRuntimeStateV1;
    paths: WorkflowSupervisorRuntimePaths;
    dependencies: WorkflowSupervisorClientDependencies;
    connectTimeoutMs: number;
    closeTimeoutMs: number;
    shutdownTimeoutMs: number;
    cancelSettlementTimeoutMs: number;
  }): Promise<WorkflowSupervisorClient> {
    const epoch = input.dependencies.randomEpoch();
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw clientError("STARTUP_FAILED", "Workflow supervisor epoch source was invalid.");
    }
    const runtimeArtifactIdentities = captureRuntimeArtifactIdentities(
      input.runtimeState,
      input.paths,
      input.dependencies,
    );
    const client = new WorkflowSupervisorClient(
      input.runtimeState,
      runtimeArtifactIdentities,
      input.paths,
      input.dependencies,
      input.connectTimeoutMs,
      input.closeTimeoutMs,
      input.shutdownTimeoutMs,
      input.cancelSettlementTimeoutMs,
      epoch,
    );
    const messageId = mintMessageId();
    const { response, socket } = await exchange(
      input.dependencies,
      input.runtimeState.socketPath,
      {
        ...commonRequest(input.runtimeState, messageId),
        op: "attach",
        epoch,
      },
      // Attach may be waiting for a former backend's exact owned attempts to
      // quiesce. Timing it out could leave a completed attach without a lease.
      { keepOpen: true, connectTimeoutMs: input.connectTimeoutMs },
    );
    let success: Extract<WorkflowSupervisorSuccessResponse, { op: "attach" }>;
    try {
      success = successFor(response, "attach");
    } catch (error) {
      socket.destroy();
      throw error;
    }
    if (!success.result.attached || success.result.epoch !== epoch) {
      socket.destroy();
      throw clientError(
        "PROTOCOL_ERROR",
        "Workflow supervisor attach acknowledgement did not match its epoch.",
      );
    }
    client.controlSocket = socket;
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (client.controlSocket === socket) client.controlSocket = undefined;
    });
    if (socket.destroyed) {
      client.controlSocket = undefined;
      throw clientError(
        "TRANSPORT_ERROR",
        "Workflow supervisor control lease closed during attachment.",
      );
    }
    return client;
  }

  private assertAttached(): void {
    if (
      this.closing ||
      !this.controlSocket ||
      this.controlSocket.destroyed ||
      this.controlSocket.writableEnded
    ) {
      throw clientError(
        "NOT_ATTACHED",
        "Workflow supervisor client has no live control lease.",
      );
    }
  }

  private async request(
    request: WorkflowSupervisorRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowSupervisorResponse> {
    this.assertAttached();
    const { response } = await exchange(
      this.dependencies,
      this.runtimeState.socketPath,
      request,
      { connectTimeoutMs: this.connectTimeoutMs, signal },
    );
    return response;
  }

  /**
   * Provider operations keep their transport open across a caller abort so the
   * supervisor's terminal settlement still arrives. The cancel travels on its
   * own short-lived connection because the operation socket is one-shot.
   */
  private async operationRequest(
    request: WorkflowSupervisorRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowSupervisorResponse> {
    this.assertAttached();
    const { response } = await exchange(
      this.dependencies,
      this.runtimeState.socketPath,
      request,
      {
        connectTimeoutMs: this.connectTimeoutMs,
        signal,
        cancelOnAbort: {
          timeoutMs: this.cancelSettlementTimeoutMs,
          cancel: async () => {
            await exchange(
              this.dependencies,
              this.runtimeState.socketPath,
              {
                ...this.attachedCommon(mintMessageId()),
                op: "cancel",
                targetMessageId: request.messageId,
              },
              { connectTimeoutMs: this.connectTimeoutMs },
            );
          },
        },
      },
    );
    return response;
  }

  private attachedCommon(messageId: string) {
    return {
      ...commonRequest(this.runtimeState, messageId),
      epoch: this.epoch,
    };
  }

  async delegate(
    projectId: string,
    request: OwnedDelegationRequest,
    options: KadySupervisedDelegateOptions,
  ): Promise<DagFusionDelegationReceipt> {
    const canonicalPaths = resolvePaths(projectId);
    if (request.cwd !== canonicalPaths.sandbox) {
      throw clientError(
        "PROTOCOL_ERROR",
        "Workflow delegation cwd did not match the canonical project sandbox.",
      );
    }
    if (options.supervisedBudget === undefined) {
      throw clientError(
        "PROTOCOL_ERROR",
        "Supervised workflow delegation requires a durable budget descriptor.",
      );
    }
    const identity = expectedIdentity(request);
    assertBudgetIdentity(options.supervisedBudget, identity);
    const messageId = mintMessageId();
    const response = await this.operationRequest(
      {
        ...this.attachedCommon(messageId),
        op: "delegate",
        projectId,
        request: structuredClone(request),
        limits: structuredClone(options.limits),
        budget: structuredClone(options.supervisedBudget),
      },
      options.signal,
    );
    if (!response.ok) {
      if (response.settlement) {
        await reconcileExactSettlement(identity, response.settlement, options.reconcileUsage);
      }
      throw new WorkflowSupervisorRemoteError(
        response.error.code,
        response.error.retryable,
        response.settlement,
      );
    }
    const success = successFor(response, "delegate");
    if (
      !sameIdentity(identity, success.result.receipt.identity) ||
      !sameIdentity(identity, success.result.settlement.identity)
    ) {
      throw clientError(
        "PROTOCOL_ERROR",
        "Workflow supervisor delegation result identity did not match the request.",
      );
    }
    await reconcileExactSettlement(
      identity,
      success.result.settlement,
      options.reconcileUsage,
    );
    return success.result.receipt;
  }

  async runHostedFusion(
    request: HostedOpenRouterFusionRequest,
    transport?: KadyHostedFusionTransportOptions,
  ): Promise<HostedOpenRouterFusionResult> {
    assertCanonicalProjectPaths(request.projectId, request.paths);
    if (transport?.supervisedBudget === undefined) {
      throw clientError(
        "PROTOCOL_ERROR",
        "Supervised hosted Fusion requires a durable budget descriptor.",
      );
    }
    // Hosted Fusion has no child process to carry a node-control envelope, so
    // the bindings must ride the request. Matching the in-process wrapper
    // `runS4HostedFusionWithNodeControl`, their absence fails the attempt
    // closed rather than letting the router run on provider defaults.
    if (transport.nodeControl === undefined) {
      throw clientError(
        "PROTOCOL_ERROR",
        "Supervised hosted Fusion received no trusted S4 provider-request controls.",
      );
    }
    assertBudgetIdentity(transport.supervisedBudget, request.identity);
    const {
      paths: _paths,
      signal,
      reconcileUsage,
      ...serialized
    } = request;
    const stableRequest: SerializedHostedOpenRouterFusionRequest = {
      ...structuredClone(serialized),
      nodeControl: structuredClone(transport.nodeControl),
    };
    const messageId = mintMessageId();
    const response = await this.operationRequest(
      {
        ...this.attachedCommon(messageId),
        op: "hosted-fusion",
        projectId: request.projectId,
        request: stableRequest,
        budget: structuredClone(transport.supervisedBudget),
      },
      signal,
    );
    if (!response.ok) {
      if (response.settlement) {
        await reconcileExactSettlement(
          request.identity,
          response.settlement,
          reconcileUsage,
        );
      }
      throw new WorkflowSupervisorRemoteError(
        response.error.code,
        response.error.retryable,
        response.settlement,
      );
    }
    const success = successFor(response, "hosted-fusion");
    await reconcileExactSettlement(
      request.identity,
      success.result.settlement,
      reconcileUsage,
    );
    return success.result.result;
  }

  async quiesceProject(
    projectId: string,
    reason: WorkflowSupervisorQuiesceReason = "caller-request",
  ): Promise<WorkflowSupervisorQuiesceProjectResult> {
    const messageId = mintMessageId();
    const response = await this.request({
      ...this.attachedCommon(messageId),
      op: "quiesce-project",
      projectId,
      reason,
    });
    return successFor(response, "quiesce-project").result;
  }

  async reloadCredentials(
    keys: readonly WorkflowSupervisorCredentialKey[],
  ): Promise<WorkflowSupervisorCredentialKey[]> {
    const messageId = mintMessageId();
    const response = await this.request({
      ...this.attachedCommon(messageId),
      op: "reload-credentials",
      keys: [...keys],
    });
    return [...successFor(response, "reload-credentials").result.keys];
  }

  async snapshot(projectId?: string): Promise<WorkflowSupervisorSnapshot> {
    const messageId = mintMessageId();
    const response = await this.request({
      ...this.attachedCommon(messageId),
      op: "snapshot",
      ...(projectId === undefined ? {} : { projectId }),
    });
    return successFor(response, "snapshot").result.snapshot;
  }

  /** Explicitly terminate the supervisor after all owned work is quiescent. */
  async shutdown(
    reason: "backend-shutdown" | "supervisor-restart" = "backend-shutdown",
  ): Promise<void> {
    const messageId = mintMessageId();
    const response = await this.request({
      ...this.attachedCommon(messageId),
      op: "shutdown",
      reason,
    });
    successFor(response, "shutdown");
    await this.close();
    await waitForRuntimeDisappearance(
      this.runtimeState,
      this.runtimeArtifactIdentities,
      this.paths,
      this.dependencies,
      this.shutdownTimeoutMs,
    );
  }

  /** Release only this backend's control lease; the supervisor keeps running. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const socket = this.controlSocket;
    this.controlSocket = undefined;
    this.closePromise = (async () => {
      if (!socket || socket.destroyed) return;
      await new Promise<void>((resolve) => {
        let finished = false;
        const timer = timerAfter(this.closeTimeoutMs, () => {
          if (finished) return;
          finished = true;
          socket.destroy();
          resolve();
        });
        socket.once("close", () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve();
        });
        socket.end();
      });
    })();
    return this.closePromise;
  }

  /** Trusted dependency overrides consumed by the production DAG executor. */
  nodeExecutorDependencies(): Pick<
    KadyNodeExecutorDependencies,
    "getDelegationSession" | "runHostedFusion"
  > {
    return {
      getDelegationSession: async (projectId, paths, harness) => {
        // The supervised transport owns the only trusted adapter there is (a
        // Pi session in the supervisor process), so the harness decision has
        // to happen here. The executor awaits this seam before it reserves any
        // budget, which is why an unavailable or unbound harness is refused
        // with the dispatch diagnostic instead of quietly buying a Pi child.
        assertWorkflowHarnessAdapterBound(harness);
        const canonical = assertCanonicalProjectPaths(projectId, paths);
        prepareWorkflowDelegationProject(projectId, canonical);
        return {
          host: {
            delegate: (request, options) =>
              this.delegate(projectId, request, options),
          },
        };
      },
      runHostedFusion: (request, transport) =>
        this.runHostedFusion(request, transport),
    };
  }
}

export async function ensureWorkflowSupervisor(
  options: EnsureWorkflowSupervisorOptions = {},
): Promise<WorkflowSupervisorClient> {
  const paths = options.paths ?? workflowSupervisorRuntimePaths();
  const dependencies = effectiveDependencies(options.dependencies);
  const startupTimeoutMs = positiveBoundedInteger(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    "Workflow supervisor startup timeout",
  );
  const connectTimeoutMs = positiveBoundedInteger(
    options.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    "Workflow supervisor connect timeout",
  );
  const pingTimeoutMs = positiveBoundedInteger(
    options.pingTimeoutMs,
    DEFAULT_PING_TIMEOUT_MS,
    "Workflow supervisor ping timeout",
  );
  const closeTimeoutMs = positiveBoundedInteger(
    options.closeTimeoutMs,
    DEFAULT_CLOSE_TIMEOUT_MS,
    "Workflow supervisor close timeout",
  );
  const cancelSettlementTimeoutMs = positiveBoundedInteger(
    options.cancelSettlementTimeoutMs,
    CANCEL_SETTLEMENT_TIMEOUT_MS,
    "Workflow supervisor cancel settlement timeout",
  );
  const shutdownTimeoutMs = positiveBoundedInteger(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "Workflow supervisor shutdown timeout",
  );
  const launchLock = await acquireStartupLock(
    paths,
    dependencies,
    startupTimeoutMs,
  );
  try {
    const inheritedState = dependencies.readRuntimeState(paths);
    if (inheritedState) {
      const readyInheritedState = await inspectExistingRuntime(
        inheritedState,
        paths,
        dependencies,
        connectTimeoutMs,
        pingTimeoutMs,
      );
      if (readyInheritedState) {
        options.onOwnership?.(readyInheritedState.pid);
        const drainClient = await WorkflowSupervisorClient.attach({
          runtimeState: readyInheritedState,
          paths,
          dependencies,
          connectTimeoutMs,
          closeTimeoutMs,
          shutdownTimeoutMs,
          cancelSettlementTimeoutMs,
        });
        try {
          // A supervisor inherited across backend lifetimes is drain-only. Its
          // in-memory credentials and provider configuration may be stale, so
          // no new workflow operation is ever admitted through it.
          await drainClient.shutdown("supervisor-restart");
        } catch (error) {
          await drainClient.close();
          throw error;
        }
      }
    }

    if (dependencies.readRuntimeState(paths)) {
      throw clientError(
        "STARTUP_AMBIGUOUS",
        "Workflow supervisor runtime state appeared before the fresh launch.",
      );
    }
    const freshRuntime = await launchFreshRuntime(
      paths,
      dependencies,
      startupTimeoutMs,
      connectTimeoutMs,
      pingTimeoutMs,
      options.onOwnership,
    );
    try {
      return await WorkflowSupervisorClient.attach({
        runtimeState: freshRuntime.runtimeState,
        paths,
        dependencies,
        connectTimeoutMs,
        closeTimeoutMs,
        shutdownTimeoutMs,
        cancelSettlementTimeoutMs,
      });
    } catch (error) {
      return await failFreshRuntimeStartup(freshRuntime.child, paths, error);
    }
  } finally {
    releaseLaunchLock(paths, launchLock);
  }
}
