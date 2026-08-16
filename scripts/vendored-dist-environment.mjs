import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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

export function sameProcessIdentity(left, right) {
  return validProcessIdentity(left) && validProcessIdentity(right) &&
    left.method === right.method && left.value === right.value &&
    left.host === right.host && left.boot === right.boot;
}

export function recordSupervisorOwnership(records, pid, identity) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !validProcessIdentity(identity)) {
    return "unverifiable";
  }
  const previous = records.get(pid);
  if (!previous) {
    records.set(pid, { pid, identity, retired: false });
    return "recorded";
  }
  if (sameProcessIdentity(previous.identity, identity)) return "unchanged";
  // A later cached snapshot can name a PID that the OS has already reused.
  // Retain the new observation for diagnostics, but never infer ownership of
  // that different process from the reused numeric PID.
  previous.retired = true;
  records.set(pid, { pid, identity, retired: true, supersededIdentity: previous.identity });
  return "identity-changed-retired";
}

export function recordedProcessState(
  pid,
  identity,
  {
    getLiveness = processLiveness,
    captureIdentity = captureProcessIdentity,
  } = {},
) {
  if (!validProcessIdentity(identity)) return "unverifiable";
  const localScope = captureIdentity(process.pid);
  if (!validProcessIdentity(localScope)) return "unverifiable";
  if (localScope.host !== identity.host) return "unverifiable";
  if (localScope.boot !== identity.boot) return "gone";
  const liveness = getLiveness(pid);
  if (liveness === "dead") return "gone";
  if (liveness !== "alive") return "unverifiable";
  const current = captureIdentity(pid);
  if (!validProcessIdentity(current)) return "unverifiable";
  if (current.host !== identity.host) return "unverifiable";
  if (current.boot !== identity.boot) return "gone";
  if (current.method !== identity.method) return "unverifiable";
  return current.value === identity.value ? "same" : "gone";
}

export function latchOwnedProcessGroupRetirement(record, childExitObserved, groupLiveness) {
  if (record.retired) return true;
  if (childExitObserved && groupLiveness === "dead") record.retired = true;
  return record.retired;
}

export async function forceOwnedSupervisorProcessGroup(
  owner,
  {
    isWindows = process.platform === "win32",
    recordedState = (pid, identity) => recordedProcessState(pid, identity),
    groupLiveness = () => "unknown",
    pidLiveness = processLiveness,
    signalGroup = (pid) => process.kill(-pid, "SIGKILL"),
    signalPid = (pid) => process.kill(pid, "SIGKILL"),
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    timeoutMs = 5_000,
  } = {},
) {
  if (owner.retired) return { ok: true, status: "retired" };

  const retireIfGroupDead = (statusWhenDead) => {
    if (isWindows) {
      owner.retired = true;
      return { ok: true, status: statusWhenDead };
    }
    const currentGroupLiveness = groupLiveness(owner.pid);
    if (currentGroupLiveness === "dead") {
      owner.retired = true;
      return { ok: true, status: statusWhenDead };
    }
    if (currentGroupLiveness === "unknown") {
      return { ok: false, status: "unverifiable" };
    }
    return null;
  };

  const initialState = recordedState(owner.pid, owner.identity);
  if (initialState === "gone") {
    const retired = retireIfGroupDead("gone");
    if (retired) return retired;
  } else if (initialState !== "same") {
    return { ok: false, status: "unverifiable" };
  }

  if (!isWindows) {
    try {
      signalGroup(owner.pid);
    } catch (error) {
      if (error?.code !== "ESRCH") return { ok: false, status: "signal-failed", error };
      const fallbackState = recordedState(owner.pid, owner.identity);
      if (fallbackState === "gone" || initialState === "gone") {
        const retired = retireIfGroupDead("gone");
        if (retired) return retired;
      } else if (fallbackState !== "same") {
        return { ok: false, status: "unverifiable" };
      } else {
        try {
          signalPid(owner.pid);
        } catch (fallbackError) {
          if (fallbackError?.code !== "ESRCH") {
            return { ok: false, status: "signal-failed", error: fallbackError };
          }
        }
      }
    }
  } else {
    try {
      signalPid(owner.pid);
    } catch (error) {
      if (error?.code !== "ESRCH") return { ok: false, status: "signal-failed", error };
    }
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const currentGroupLiveness = isWindows ? pidLiveness(owner.pid) : groupLiveness(owner.pid);
    if (currentGroupLiveness === "dead") {
      owner.retired = true;
      return { ok: true, status: "killed" };
    }
    if (currentGroupLiveness === "unknown") {
      return { ok: false, status: "disappearance-unverifiable" };
    }
    if (pidLiveness(owner.pid) === "alive" && recordedState(owner.pid, owner.identity) === "gone") {
      owner.retired = true;
      return { ok: true, status: "pid-reused" };
    }
    await wait(50);
  }
  return { ok: false, status: "timeout" };
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
    "build.lock.d",
  );
}

export function vendoredDistBuildLockOwnerPath(lockDirectory) {
  return path.join(lockDirectory, "owner.json");
}

function vendoredPipelineEngineRoot(repositoryRoot) {
  return path.join(
    fs.realpathSync(path.resolve(repositoryRoot)),
    "server",
    "vendor",
    "pipeline-engine",
  );
}

function validWorkerRecord(worker) {
  return Number.isSafeInteger(worker?.pid) && worker.pid >= 1 &&
    validProcessIdentity(worker.identity) &&
    ["install", "build"].includes(worker.phase) &&
    typeof worker.startedAt === "string" && worker.startedAt;
}

function validOwnerRecord(record) {
  return record && typeof record === "object" &&
    record.version === 1 &&
    Number.isSafeInteger(record.pid) && record.pid >= 1 &&
    validProcessIdentity(record.identity) &&
    typeof record.phase === "string" && record.phase &&
    Array.isArray(record.workers) && record.workers.every(validWorkerRecord) &&
    typeof record.createdAt === "string" && record.createdAt &&
    typeof record.heartbeatAt === "string" && record.heartbeatAt;
}

function inspectLockDirectory(lockDirectory) {
  try {
    const directoryStat = fs.lstatSync(lockDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return { kind: "unreadable", record: null };
    }
  } catch (error) {
    return error?.code === "ENOENT"
      ? { kind: "absent", record: null }
      : { kind: "unreadable", record: null };
  }
  try {
    const ownerPath = vendoredDistBuildLockOwnerPath(lockDirectory);
    const ownerStat = fs.lstatSync(ownerPath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
      return { kind: "unreadable", record: null };
    }
    const record = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));
    if (!validOwnerRecord(record)) return { kind: "unreadable", record: null };
    return { kind: "valid", record };
  } catch {
    return { kind: "unreadable", record: null };
  }
}

function readOwnerRecord(lockDirectory) {
  const inspection = inspectLockDirectory(lockDirectory);
  return inspection.kind === "valid" ? inspection.record : null;
}

function sameLockOwner(record, pid, identity) {
  return validOwnerRecord(record) && record.pid === pid && sameProcessIdentity(record.identity, identity);
}

function createOwnerRecord(identity, phase = "holding") {
  const now = new Date().toISOString();
  return {
    version: 1,
    pid: process.pid,
    identity,
    phase,
    workers: [],
    createdAt: now,
    heartbeatAt: now,
  };
}

function writeOwnerRecord(lockDirectory, record, lockFileSystem = fs) {
  const ownerPath = vendoredDistBuildLockOwnerPath(lockDirectory);
  const temporaryPath = path.join(lockDirectory, `.owner.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = lockFileSystem.openSync(temporaryPath, "wx", 0o600);
  try {
    lockFileSystem.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    if (typeof lockFileSystem.fsyncSync === "function") lockFileSystem.fsyncSync(descriptor);
    lockFileSystem.closeSync(descriptor);
    lockFileSystem.renameSync(temporaryPath, ownerPath);
  } catch (error) {
    try { lockFileSystem.closeSync(descriptor); } catch { /* original error wins */ }
    try { lockFileSystem.rmSync(temporaryPath, { force: true }); } catch { /* original error wins */ }
    throw error;
  }
}

function writeOwnedOwnerRecord(lockDirectory, record, pid, identity, lockFileSystem = fs) {
  if (!sameLockOwner(readOwnerRecord(lockDirectory), pid, identity)) {
    throw new Error(`vendored dist build lock ownership was lost: ${lockDirectory}`);
  }
  writeOwnerRecord(lockDirectory, record, lockFileSystem);
  if (!sameLockOwner(readOwnerRecord(lockDirectory), pid, identity)) {
    throw new Error(`vendored dist build lock ownership was lost: ${lockDirectory}`);
  }
}

function abandonLockDirectory(lockDirectory) {
  try {
    for (const entry of fs.readdirSync(lockDirectory)) {
      fs.rmSync(path.join(lockDirectory, entry), { force: true });
    }
    fs.rmdirSync(lockDirectory);
  } catch {
    /* leftover directory remains busy */
  }
}

function releaseLockDirectory(lockDirectory, pid, identity) {
  if (!sameLockOwner(readOwnerRecord(lockDirectory), pid, identity)) return;
  try {
    fs.unlinkSync(vendoredDistBuildLockOwnerPath(lockDirectory));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  try {
    fs.rmdirSync(lockDirectory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

function ownerStatusDescription(inspection) {
  if (inspection.kind !== "valid") return "unreadable owner record";
  return JSON.stringify({
    pid: inspection.record.pid,
    identity: inspection.record.identity,
    phase: inspection.record.phase,
    heartbeatAt: inspection.record.heartbeatAt,
    workers: inspection.record.workers,
  });
}

function buildLockOwnerStatus(
  lock,
  {
    getLiveness = processLiveness,
    captureIdentity = captureProcessIdentity,
  } = {},
) {
  if (!validOwnerRecord(lock)) {
    return { active: true, recoverable: false, reason: "unreadable-owner" };
  }
  const processes = [{ pid: lock.pid, identity: lock.identity, role: "wrapper" }, ...lock.workers];
  const states = processes.map((entry) => ({
    ...entry,
    state: recordedProcessState(entry.pid, entry.identity, { getLiveness, captureIdentity }),
  }));
  const blocking = states.find((entry) => entry.state !== "gone");
  return blocking
    ? { active: true, recoverable: false, reason: blocking.state, blocking }
    : { active: false, recoverable: true, reason: "all-recorded-processes-gone" };
}

function processCommandName(pid, { platform = process.platform, readFileSync = fs.readFileSync, spawnProcess = spawnSync } = {}) {
  if (platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
    } catch {
      return null;
    }
  }
  const result = spawnProcess("ps", ["-p", String(pid), "-o", "comm="], {
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  const value = result.stdout?.trim();
  return result.status === 0 && value ? path.basename(value) : null;
}

function processWorkingDirectory(pid, { platform = process.platform, readLinkSync = fs.readlinkSync, spawnProcess = spawnSync } = {}) {
  if (platform === "linux") {
    try {
      return readLinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const result = spawnProcess("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf-8" });
    const line = (result.stdout ?? "").split("\n").find((entry) => entry.startsWith("n"));
    return line ? line.slice(1) : null;
  }
  return null;
}

function isNodeOrBunCommand(command) {
  if (!command) return false;
  const base = path.basename(command).toLowerCase();
  return base === "node" || base === "nodejs" || base === "bun" ||
    base === "node.exe" || base === "bun.exe";
}

export function findVendoredRootOccupants(
  vendoredRoot,
  {
    platform = process.platform,
    spawnProcess = spawnSync,
    selfPid = process.pid,
    readFileSync = fs.readFileSync,
    readLinkSync = fs.readlinkSync,
    readDirSync = fs.readdirSync,
  } = {},
) {
  const occupants = new Set();
  const consider = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid === selfPid) return;
    const command = processCommandName(pid, { platform, readFileSync, spawnProcess });
    if (isNodeOrBunCommand(command)) occupants.add(pid);
  };
  let argumentMatches;
  try {
    argumentMatches = spawnProcess("pgrep", ["-f", vendoredRoot], {
      encoding: "utf-8",
      timeout: 2_000,
    });
  } catch (error) {
    throw new Error(`could not verify node/bun occupants of ${vendoredRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const token of (argumentMatches.stdout ?? "").trim().split(/\s+/).filter(Boolean)) {
    consider(Number(token));
  }
  if (platform === "linux") {
    let procEntries = [];
    try {
      procEntries = readDirSync("/proc");
    } catch {
      procEntries = [];
    }
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === selfPid) continue;
      const cwd = processWorkingDirectory(pid, { platform, readLinkSync, spawnProcess });
      if (cwd === vendoredRoot || (cwd && cwd.startsWith(`${vendoredRoot}${path.sep}`))) {
        consider(pid);
      }
    }
  } else if (platform === "darwin") {
    let result;
    try {
      result = spawnProcess("lsof", ["-a", "-d", "cwd", "-c", "node", "-c", "bun", "-Fn"], {
        encoding: "utf-8",
        timeout: 2_000,
      });
    } catch (error) {
      throw new Error(`could not verify node/bun occupants of ${vendoredRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let currentPid = null;
    for (const line of (result.stdout ?? "").split("\n")) {
      if (line.startsWith("p")) {
        currentPid = Number(line.slice(1));
        continue;
      }
      if (!line.startsWith("n") || !Number.isSafeInteger(currentPid) || currentPid === selfPid) continue;
      const cwd = line.slice(1);
      if (cwd === vendoredRoot || cwd.startsWith(`${vendoredRoot}${path.sep}`)) {
        consider(currentPid);
      }
    }
  }
  return [...occupants];
}

export function vendoredDistBuildLockStatus(repositoryRoot) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  const inspection = inspectLockDirectory(lockPath);
  if (inspection.kind === "absent") return { active: false, lockPath, lock: null };
  if (inspection.kind !== "valid") {
    return { active: true, recoverable: false, reason: "unreadable-owner", lockPath, lock: null };
  }
  return { active: true, recoverable: false, reason: "busy", lockPath, lock: inspection.record };
}

export async function acquireVendoredDistBuildLock(
  repositoryRoot,
  {
    waitMs = 120_000,
    pollMs = 200,
    lockFileSystem = fs,
    captureIdentity = captureProcessIdentity,
  } = {},
) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const identity = captureIdentity(process.pid);
  if (!validProcessIdentity(identity)) throw new Error(`could not determine identity for build-lock PID ${process.pid}`);
  const deadline = Date.now() + waitMs;
  const timeoutError = () => {
    const inspection = inspectLockDirectory(lockPath);
    const ownerPid = inspection.record?.pid ?? "unknown";
    const ownerIdentity = validProcessIdentity(inspection.record?.identity) ? inspection.record.identity : "unknown";
    return new Error(
      `timed out waiting for vendored dist build lock held by pid ${ownerPid}, ` +
        `identity ${JSON.stringify(ownerIdentity)}: ${lockPath}; owner=${ownerStatusDescription(inspection)}; ` +
        "safe recovery command: node scripts/vendored-dist-build.mjs --recover-lock",
    );
  };
  while (true) {
    if (Date.now() >= deadline) throw timeoutError();
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timeoutError();
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
      continue;
    }
    const lock = createOwnerRecord(identity);
    try {
      writeOwnerRecord(lockPath, lock, lockFileSystem);
    } catch (error) {
      abandonLockDirectory(lockPath);
      throw error;
    }
    const heartbeat = setInterval(() => {
      if (!sameLockOwner(readOwnerRecord(lockPath), process.pid, identity)) return;
      lock.heartbeatAt = new Date().toISOString();
      try { writeOwnedOwnerRecord(lockPath, lock, process.pid, identity, lockFileSystem); } catch { /* ownership checks remain authoritative */ }
    }, 1000);
    heartbeat.unref();
    return {
      lockPath,
      token,
      publishWorker(worker) {
        if (!validWorkerRecord(worker)) {
          throw new Error("cannot publish an unverifiable vendored-dist worker");
        }
        lock.workers = [...lock.workers.filter((entry) => entry.pid !== worker.pid), worker];
        lock.phase = worker.phase;
        lock.heartbeatAt = new Date().toISOString();
        writeOwnedOwnerRecord(lockPath, lock, process.pid, identity, lockFileSystem);
      },
      clearWorker(pid) {
        lock.workers = lock.workers.filter((entry) => entry.pid !== pid);
        lock.phase = lock.workers.length === 0 ? "holding" : lock.workers[lock.workers.length - 1].phase;
        lock.heartbeatAt = new Date().toISOString();
        writeOwnedOwnerRecord(lockPath, lock, process.pid, identity, lockFileSystem);
      },
      assertOwned(operation) {
        if (!sameLockOwner(readOwnerRecord(lockPath), process.pid, identity)) {
          throw new Error(`vendored dist build lock ownership was lost before ${operation}: ${lockPath}`);
        }
      },
      release() {
        clearInterval(heartbeat);
        releaseLockDirectory(lockPath, process.pid, identity);
      },
    };
  }
}

export async function recoverVendoredDistBuildLock(
  repositoryRoot,
  {
    captureIdentity = captureProcessIdentity,
    getLiveness = processLiveness,
    platform = process.platform,
    force = false,
    spawnProcess = spawnSync,
    readFileSync = fs.readFileSync,
    readLinkSync = fs.readlinkSync,
    occupantsFor = findVendoredRootOccupants,
  } = {},
) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  if (platform === "win32") {
    throw new Error(
      "vendored-dist lock recovery is disabled on Windows; close every Kady and Bun process, " +
        "verify no build worker remains, then manually remove the build.lock.d directory",
    );
  }
  const inspection = inspectLockDirectory(lockPath);
  if (inspection.kind === "absent") return { recovered: false, lockPath, record: null };
  if (inspection.kind === "valid") {
    const status = buildLockOwnerStatus(inspection.record, { captureIdentity, getLiveness });
    if (!status.recoverable) {
      throw new Error(`refusing lock recovery (${status.reason}): ${JSON.stringify(inspection.record)}`);
    }
    fs.unlinkSync(vendoredDistBuildLockOwnerPath(lockPath));
    try {
      fs.rmdirSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
    }
    return { recovered: true, lockPath, record: inspection.record };
  }
  if (!force) {
    throw new Error(`refusing lock recovery because the owner record is unreadable: ${lockPath}`);
  }
  const vendoredRoot = vendoredPipelineEngineRoot(repositoryRoot);
  const occupants = occupantsFor(vendoredRoot, {
    platform,
    spawnProcess,
    readFileSync,
    readLinkSync,
  });
  if (occupants.length > 0) {
    throw new Error(
      `refusing forced lock recovery because node/bun still reference ${vendoredRoot}: ${occupants.join(", ")}`,
    );
  }
  fs.rmSync(lockPath, { recursive: true, force: true });
  return { recovered: true, lockPath, record: null, forced: true };
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
