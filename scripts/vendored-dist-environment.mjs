import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const sensitiveEnvironmentNamePattern =
  /(?:^|_)(?:API_KEY|AUTH[^_]*|CREDENTIALS?|DATABASE_URL|KEY|MYSQL_PWD|PASSWORD|PAT|PGPASSWORD|SECRET|TOKEN)(?:_|$)/i;
const previewBuildEnvironmentNames = ["HOME", "PATH", "NODE_ENV", "PORT", "TMPDIR", "LANG", "CI"];
const usableStaleStatuses = new Set([
  "stale-inputs",
  "stale-git-head",
  "stale-build-env",
  "stale-dependencies",
]);

export function scrubSensitiveEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !sensitiveEnvironmentNamePattern.test(name) && !name.startsWith("GIT_CONFIG_"),
    ),
  );
}

export function previewVendoredDistEnvironment(
  stateRoot,
  shimDirectory,
  enginePort,
  ambientEnvironment = process.env,
) {
  const environment = {
    HOME: path.join(stateRoot, "home"),
    PATH: `${shimDirectory}${path.delimiter}${ambientEnvironment.PATH ?? ""}`,
    NODE_ENV: ambientEnvironment.NODE_ENV ?? "production",
    PORT: String(enginePort),
    TMPDIR: path.join(stateRoot, "tmp"),
  };
  for (const name of ["LANG", "CI"]) {
    if (ambientEnvironment[name] !== undefined) environment[name] = ambientEnvironment[name];
  }
  return environment;
}

export function strictPreviewVendoredDistEnvironment(environment) {
  return Object.fromEntries(
    previewBuildEnvironmentNames
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, String(environment[name])]),
  );
}

export function previewVendoredDistFingerprintEnvironment(
  launcherEnvironment,
  enginePort,
) {
  return strictPreviewVendoredDistEnvironment({
    ...launcherEnvironment,
    NODE_ENV: launcherEnvironment.NODE_ENV ?? "production",
    PORT: String(enginePort),
  });
}

export function workflowEngineConsumerEnvironment(
  environment,
  enginePort,
) {
  const port = String(enginePort);
  const localOrigin = `http://127.0.0.1:${port}`;
  const managedValues = {
    KADY_PIPELINE_ENGINE_PORT: port,
    KADY_ARCHON_PORT: port,
    PIPELINE_ENGINE_BASE_URL: localOrigin,
    NEXT_PUBLIC_PIPELINE_ENGINE_URL: localOrigin,
  };
  const expectedOrigins = {
    PIPELINE_ENGINE_BASE_URL: localOrigin,
    NEXT_PUBLIC_PIPELINE_ENGINE_URL: localOrigin,
    ARCHON_BASE_URL: localOrigin,
    NEXT_PUBLIC_ARCHON_URL: localOrigin,
  };
  const conflicts = Object.entries(expectedOrigins).filter(
    ([name, value]) => environment[name] !== undefined && String(environment[name]) !== value,
  );
  if (conflicts.length > 0) {
    const names = conflicts.map(([name]) => name).join(", ");
    throw new Error(
      `managed workflow engine on ${localOrigin} conflicts with explicit ${names}; ` +
        "remove the conflicting value (an --external-engine mode is not implemented)",
    );
  }
  return {
    ...environment,
    ...managedValues,
    KADY_PIPELINE_ENGINE_DISABLED: "0",
  };
}

export function resolveWorkflowEnginePort(environment, cliPort = null) {
  const value = cliPort ?? environment.KADY_PIPELINE_ENGINE_PORT ?? environment.KADY_ARCHON_PORT ?? 3091;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`workflow engine port must be an integer from 1 through 65535; received ${JSON.stringify(value)}`);
  }
  return port;
}

export function workflowEnginePrerequisiteStatus({ sourcesPresent, bunPath }) {
  if (!sourcesPresent) return { available: false, reason: "missing-sources" };
  if (!bunPath) return { available: false, reason: "missing-bun" };
  return { available: true, reason: "ready" };
}

export async function waitForOwnedWorkflowEngine({
  childPid,
  childExited,
  listenersOn,
  isOwnedByChild,
  probeHealth,
  wait,
  timeoutMs = 30_000,
  pollMs = 200,
  now = Date.now,
  signal,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) return { status: "aborted" };
    if (childExited()) return { status: "child-exited" };
    const listenerPids = listenersOn();
    const foreignPid = listenerPids.find((pid) => !isOwnedByChild(pid, childPid));
    if (foreignPid !== undefined) return { status: "foreign-listener", foreignPid };
    if (listenerPids.length > 0 && await probeHealth()) {
      if (signal?.aborted) return { status: "aborted" };
      const verifiedPids = listenersOn();
      const takeoverPid = verifiedPids.find((pid) => !isOwnedByChild(pid, childPid));
      if (takeoverPid !== undefined) return { status: "foreign-listener", foreignPid: takeoverPid };
      if (!childExited() && verifiedPids.length > 0) {
        return { status: "ready", listenerPids: verifiedPids };
      }
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  if (signal?.aborted) return { status: "aborted" };
  return { status: childExited() ? "child-exited" : "timeout" };
}

export async function terminateOwnedProcessTree({
  treeGone,
  terminate,
  forceTerminate,
  wait,
  description,
  gracefulWaitMs = 2_000,
  forcedWaitMs = 5_000,
  pollMs = 50,
  now = Date.now,
}) {
  const waitUntilGone = async (timeoutMs) => {
    const deadline = now() + timeoutMs;
    while (!treeGone() && now() < deadline) {
      await wait(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    return treeGone();
  };

  if (treeGone()) return;
  terminate();
  if (await waitUntilGone(gracefulWaitMs)) return;
  forceTerminate();
  if (await waitUntilGone(forcedWaitMs)) return;
  throw new Error(`could not verify disappearance of ${description}`);
}

export function workflowEngineRuntimeOwnership({
  listenerPids,
  childPid = null,
  ownerPids = [],
  isOwnedByChild,
  isOwnedByCheckout,
}) {
  const foreignPid = listenerPids.find((pid) => !isOwnedByCheckout(pid));
  const owned = childPid === null
    ? listenerPids.some((pid) => ownerPids.includes(pid) && isOwnedByCheckout(pid))
    : listenerPids.some((pid) => isOwnedByChild(pid, childPid));
  return owned && foreignPid === undefined
    ? { status: "owned" }
    : { status: foreignPid === undefined ? "missing" : "foreign", foreignPid };
}

export function prepareLauncherDependencies({
  environment,
  missingPreviewDependencies = [],
  install,
}) {
  if (environment.KADY_PREVIEW === "1") {
    if (missingPreviewDependencies.length > 0) {
      throw new Error(
        `Preview requires dependencies installed before launch; missing ${missingPreviewDependencies.join(", ")}.`,
      );
    }
    return "reuse-preview";
  }
  install();
  return "installed";
}

export function missingPreviewLauncherDependencies(repositoryRoot) {
  const requirements = [
    "server/node_modules/tsx/dist/cli.mjs",
    "web/node_modules/next/dist/bin/next",
  ];
  if (fs.existsSync(path.join(repositoryRoot, "web", "tsconfig.json"))) {
    requirements.push(
      "web/node_modules/typescript/lib/typescript.js",
      "web/node_modules/@types/react/index.d.ts",
      "web/node_modules/@types/node/index.d.ts",
    );
  }
  return requirements.filter((relativePath) => !fs.existsSync(path.join(repositoryRoot, relativePath)));
}

function linuxProcStartValue(pid, readFileSync) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const closeParenthesis = stat.lastIndexOf(")");
  if (closeParenthesis < 0) return null;
  const fieldsAfterCommand = stat.slice(closeParenthesis + 1).trim().split(/\s+/);
  const value = fieldsAfterCommand[19]; // field 22; this slice starts at field 3.
  return /^\d+$/.test(value ?? "") ? value : null;
}

function hostBootIdentity(platform, readFileSync, spawnProcess) {
  if (platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return bootId || null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const result = spawnProcess("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
    });
    const seconds = /\bsec\s*=\s*(\d+)/.exec(result.stdout ?? "")?.[1];
    if (result.status === 0 && seconds) return `darwin-boot-seconds:${seconds}`;
    return null;
  }
  if (platform === "win32") {
    const result = spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"],
      { encoding: "utf-8", windowsHide: true },
    );
    const value = result.stdout?.trim();
    return result.status === 0 && value ? `windows-boot:${value}` : null;
  }
  return null;
}

export function captureProcessIdentity(
  pid,
  {
    platform = process.platform,
    readFileSync = fs.readFileSync,
    spawnProcess = spawnSync,
    hostname = os.hostname,
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const host = hostname();
  const boot = hostBootIdentity(platform, readFileSync, spawnProcess);
  if (!host || !boot) return null;
  if (platform === "linux") {
    try {
      const value = linuxProcStartValue(pid, readFileSync);
      return value ? { method: "proc-stat", value, host, boot } : null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const result = spawnProcess("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
    });
    const value = result.stdout?.trim();
    return result.status === 0 && value ? { method: "ps-lstart-utc", value, host, boot } : null;
  }
  if (platform === "win32") {
    const result = spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate.ToUniversalTime().ToString('o')`],
      { encoding: "utf-8", windowsHide: true },
    );
    const value = result.stdout?.trim();
    return result.status === 0 && value
      ? { method: "windows-creation-utc", value, host, boot }
      : null;
  }
  return null;
}

export function processLiveness(pid, killProcess = process.kill.bind(process)) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unknown";
  try {
    killProcess(pid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
}

function validProcessIdentity(identity) {
  return identity && typeof identity === "object" &&
    typeof identity.method === "string" && identity.method &&
    typeof identity.value === "string" && identity.value &&
    typeof identity.host === "string" && identity.host &&
    typeof identity.boot === "string" && identity.boot;
}

export function recordedProcessState(
  pid,
  identity,
  {
    getLiveness = processLiveness,
    captureIdentity = captureProcessIdentity,
  } = {},
) {
  const liveness = getLiveness(pid);
  if (liveness === "dead") return "gone";
  if (liveness !== "alive" || !validProcessIdentity(identity)) return "unverifiable";
  const current = captureIdentity(pid);
  if (!validProcessIdentity(current)) return "unverifiable";
  if (current.host !== identity.host || current.boot !== identity.boot) return "unverifiable";
  if (current.method !== identity.method) return "unverifiable";
  return current.value === identity.value ? "same" : "gone";
}

export function latchOwnedProcessGroupRetirement(record, childExitObserved, groupLiveness) {
  if (record.retired) return true;
  if (childExitObserved && groupLiveness === "dead") record.retired = true;
  return record.retired;
}

export function vendoredDistBuildLockPath(repositoryRoot) {
  const identity = fs.realpathSync(path.resolve(repositoryRoot));
  // Every preview has a different TMPDIR, so the rendezvous must live under
  // the one ignored workspace all builders mutate. Dist promotion never
  // replaces node_modules, and the dependency sentinel detects its deletion.
  return path.join(
    identity,
    "server",
    "vendor",
    "pipeline-engine",
    "node_modules",
    ".vendored-dist-lock",
    "build.lock",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readLockSnapshot(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    const content = fs.readFileSync(lockPath);
    const record = JSON.parse(content.toString("utf-8"));
    if (!record || typeof record.token !== "string") return null;
    return { record, dev: stat.dev, ino: stat.ino, digest: sha256(content) };
  } catch {
    return null;
  }
}

function readBuildLock(lockPath) {
  return readLockSnapshot(lockPath)?.record ?? null;
}

function buildLockOwnerStatus(
  lock,
  {
    getLiveness = processLiveness,
    captureIdentity = captureProcessIdentity,
  } = {},
) {
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1 || !validProcessIdentity(lock.identity)) {
    return { active: true, recoverable: false, reason: "unverifiable-owner" };
  }
  const processes = [{ pid: lock.pid, identity: lock.identity, role: "wrapper" }];
  if (!Array.isArray(lock.workers)) {
    return { active: true, recoverable: false, reason: "unverifiable-workers" };
  }
  for (const worker of lock.workers) {
    if (!Number.isSafeInteger(worker?.pid) || worker.pid < 1 ||
        !validProcessIdentity(worker.identity) ||
        !["install", "build"].includes(worker.phase) || typeof worker.startedAt !== "string") {
      return { active: true, recoverable: false, reason: "unverifiable-worker" };
    }
    processes.push(worker);
  }
  const states = processes.map((entry) => ({
    ...entry,
    state: recordedProcessState(entry.pid, entry.identity, { getLiveness, captureIdentity }),
  }));
  const blocking = states.find((entry) => entry.state !== "gone");
  return blocking
    ? { active: true, recoverable: false, reason: blocking.state, blocking }
    : { active: false, recoverable: true, reason: "all-recorded-processes-gone" };
}

function snapshotMatches(lockPath, expected) {
  const current = readLockSnapshot(lockPath);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino &&
    current.digest === expected.digest && current.record.token === expected.record.token;
}

function writeExclusiveRecord(lockPath, record, lockFileSystem = fs) {
  const descriptor = lockFileSystem.openSync(lockPath, "wx", 0o600);
  try {
    lockFileSystem.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    if (typeof lockFileSystem.fsyncSync === "function") lockFileSystem.fsyncSync(descriptor);
    lockFileSystem.closeSync(descriptor);
  } catch (error) {
    try { lockFileSystem.closeSync(descriptor); } catch { /* original error wins */ }
    lockFileSystem.rmSync(lockPath, { force: true });
    throw error;
  }
}

function writeOwnedRecord(lockPath, record, token) {
  if (readBuildLock(lockPath)?.token !== token) {
    throw new Error(`vendored dist build lock ownership was lost: ${lockPath}`);
  }
  const temporaryPath = `${lockPath}.${token}.update`;
  const descriptor = fs.openSync(temporaryPath, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (readBuildLock(lockPath)?.token !== token) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`vendored dist build lock ownership was lost: ${lockPath}`);
  }
  fs.renameSync(temporaryPath, lockPath);
}

function ownerRecord(token, identity) {
  const now = new Date().toISOString();
  return { schema: 2, token, pid: process.pid, identity, heartbeat: now, workers: [] };
}

async function acquireRecoveryGuard(lockPath, dependencies) {
  const guardPath = `${lockPath}.recovery`;
  const token = randomUUID();
  const identity = dependencies.captureIdentity(process.pid);
  if (!validProcessIdentity(identity)) throw new Error("could not capture recovery-guard process identity");
  const record = ownerRecord(token, identity);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeExclusiveRecord(guardPath, record);
      return {
        path: guardPath,
        release() {
          if (readBuildLock(guardPath)?.token === token) fs.rmSync(guardPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const snapshot = readLockSnapshot(guardPath);
    if (!snapshot) return null;
    const status = buildLockOwnerStatus(snapshot.record, dependencies);
    if (!status.recoverable) return null;
    // A hard-link claim pins the validated inode. Removing the public name can
    // then race only with a successor's O_EXCL create; this contender never
    // removes that successor and simply retries its own O_EXCL acquisition.
    const claimPath = `${guardPath}.${token}.claim`;
    try {
      fs.linkSync(guardPath, claimPath);
      const claim = readLockSnapshot(claimPath);
      if (!claim || claim.dev !== snapshot.dev || claim.ino !== snapshot.ino ||
          claim.digest !== snapshot.digest || !snapshotMatches(guardPath, snapshot)) {
        return null;
      }
      fs.rmSync(guardPath);
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(error?.code)) throw error;
      return null;
    } finally {
      fs.rmSync(claimPath, { force: true });
    }
  }
  return null;
}

export function vendoredDistBuildLockStatus(repositoryRoot) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  const lock = readBuildLock(lockPath);
  if (!lock) return { active: false, lockPath, lock: null };
  if (!fs.existsSync(lockPath)) {
    return { active: false, lockPath, lock: null };
  }
  return { ...buildLockOwnerStatus(lock), lockPath, lock };
}

export async function acquireVendoredDistBuildLock(
  repositoryRoot,
  {
    waitMs = 120_000,
    pollMs = 200,
    lockFileSystem = fs,
    captureIdentity = captureProcessIdentity,
    getLiveness = processLiveness,
    logRecovery = console.warn,
    afterStaleLockValidated = async () => {},
  } = {},
) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const identity = captureIdentity(process.pid);
  if (!validProcessIdentity(identity)) throw new Error(`could not determine identity for build-lock PID ${process.pid}`);
  const dependencies = { captureIdentity, getLiveness };
  const deadline = Date.now() + waitMs;
  let recoveryGuard = null;
  const timeoutError = () => {
    const owner = readBuildLock(lockPath);
    const ownerPid = owner?.pid ?? "unknown";
    const ownerIdentity = validProcessIdentity(owner?.identity) ? owner.identity : "unknown";
    const ownerMetadata = owner
      ? JSON.stringify({
          pid: ownerPid,
          identity: ownerIdentity,
          token: owner.token,
          heartbeat: owner.heartbeat ?? owner.heartbeatAt ?? null,
          workers: owner.workers ?? "unverifiable",
        })
      : "unreadable-or-malformed";
    return new Error(
      `timed out waiting for vendored dist build lock held by pid ${ownerPid}, ` +
        `identity ${JSON.stringify(ownerIdentity)}: ${lockPath}; owner=${ownerMetadata}; ` +
        "safe recovery command: node scripts/vendored-dist-build.mjs --recover-lock",
    );
  };
  try {
    while (true) {
    if (Date.now() >= deadline) {
      throw timeoutError();
    }
    const lock = ownerRecord(token, identity);
    try {
      writeExclusiveRecord(lockPath, lock, lockFileSystem);
      recoveryGuard?.release();
      recoveryGuard = null;
      const heartbeat = setInterval(() => {
        const current = readBuildLock(lockPath);
        if (current?.token !== token) return;
        lock.heartbeat = new Date().toISOString();
        try { writeOwnedRecord(lockPath, lock, token); } catch { /* ownership checks remain authoritative */ }
      }, 1000);
      heartbeat.unref();
      return {
        lockPath,
        token,
        publishWorker(worker) {
          if (!Number.isSafeInteger(worker?.pid) || !validProcessIdentity(worker.identity) ||
              !["install", "build"].includes(worker.phase)) {
            throw new Error("cannot publish an unverifiable vendored-dist worker");
          }
          lock.workers = [...lock.workers.filter((entry) => entry.pid !== worker.pid), worker];
          writeOwnedRecord(lockPath, lock, token);
        },
        clearWorker(pid) {
          lock.workers = lock.workers.filter((entry) => entry.pid !== pid);
          writeOwnedRecord(lockPath, lock, token);
        },
        assertOwned(operation) {
          if (readBuildLock(lockPath)?.token !== token) {
            throw new Error(`vendored dist build lock ownership was lost before ${operation}: ${lockPath}`);
          }
        },
        release() {
          clearInterval(heartbeat);
          if (readBuildLock(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    recoveryGuard = await acquireRecoveryGuard(lockPath, dependencies);
    if (recoveryGuard) {
      const snapshot = readLockSnapshot(lockPath);
      if (!snapshot) continue;
      const ownerStatus = buildLockOwnerStatus(snapshot.record, dependencies);
      if (ownerStatus.recoverable) {
        await afterStaleLockValidated({ lockPath, record: snapshot.record });
        if (!snapshotMatches(lockPath, snapshot)) {
          recoveryGuard.release();
          recoveryGuard = null;
          continue;
        }
        fs.rmSync(lockPath, { force: true });
        logRecovery(
          `recovered stale vendored-dist build lock (pid ${snapshot.record.pid}, ` +
            `identity ${JSON.stringify(snapshot.record.identity)})`,
        );
        continue;
      }
      recoveryGuard.release();
      recoveryGuard = null;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
  }
  } finally {
    recoveryGuard?.release();
  }
}

export async function recoverVendoredDistBuildLock(
  repositoryRoot,
  { captureIdentity = captureProcessIdentity, getLiveness = processLiveness } = {},
) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const dependencies = { captureIdentity, getLiveness };
  const guard = await acquireRecoveryGuard(lockPath, dependencies);
  if (!guard) throw new Error(`vendored-dist recovery guard is held at ${lockPath}.recovery`);
  try {
    const snapshot = readLockSnapshot(lockPath);
    if (!snapshot) return { recovered: false, lockPath, record: null };
    const status = buildLockOwnerStatus(snapshot.record, dependencies);
    if (!status.recoverable) {
      throw new Error(`refusing lock recovery (${status.reason}): ${JSON.stringify(snapshot.record)}`);
    }
    if (!snapshotMatches(lockPath, snapshot)) {
      throw new Error("refusing lock recovery because the lock changed during revalidation");
    }
    fs.rmSync(lockPath, { force: true });
    return { recovered: true, lockPath, record: snapshot.record };
  } finally {
    guard.release();
  }
}

export function classifyVendoredDistAfterBuildFailure(checkResult) {
  // These statuses are emitted only after the checker has verified every
  // recorded output and index.html asset reference. All other failures mean
  // there is no bundle the launcher can safely serve.
  return usableStaleStatuses.has(checkResult?.status) ? "serve-stale" : "skip-engine";
}

export function classifyWorkflowEngineListener({
  listenerPids,
  isOwnedByCheckout,
  healthOk,
  distStatus,
}) {
  if (listenerPids.length === 0) return { action: "start", pidsToStop: [] };
  const foreignPid = listenerPids.find((pid) => !isOwnedByCheckout(pid));
  if (foreignPid !== undefined) {
    return { action: "skip-foreign", foreignPid, pidsToStop: [] };
  }
  if (healthOk && distStatus?.ok) {
    return { action: "reuse-owned-fresh", pidsToStop: [] };
  }
  return { action: "restart-owned", pidsToStop: [...listenerPids] };
}

export function classifyWorkflowEngineBuildOutcome(buildExitCode, checkResult) {
  if (buildExitCode === 0) return "start";
  return classifyVendoredDistAfterBuildFailure(checkResult) === "serve-stale"
    ? "warn-continue"
    : "skip-engine";
}
