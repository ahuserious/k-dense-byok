import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PREVIEW_LIFECYCLE_LOCK_VERSION = 4;

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishAtomicFile(file, value, mode = 0o600, { replace = true } = {}) {
  const directory = path.dirname(file);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", mode);
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!replace && fs.existsSync(file)) {
      const error = new Error(`File already exists: ${file}`);
      error.code = "EEXIST";
      throw error;
    }
    fs.renameSync(temporaryFile, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

function parseProcStartTime(statText) {
  const closingParenthesis = statText.lastIndexOf(")");
  if (closingParenthesis === -1) return null;
  const fieldsFromState = statText.slice(closingParenthesis + 2).trim().split(/\s+/);
  return fieldsFromState[19] && /^\d+$/.test(fieldsFromState[19])
    ? fieldsFromState[19]
    : null;
}

export function previewPidStartIdentity(
  pid,
  {
    platform = process.platform,
    signalProcess = process.kill,
    readFile = fs.readFileSync,
    runCommand = spawnSync,
  } = {},
) {
  try {
    signalProcess(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return null;
    throw error;
  }

  if (platform === "linux") {
    try {
      const bootId = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const startTime = parseProcStartTime(
        String(readFile(`/proc/${pid}/stat`, "utf8")),
      );
      if (bootId && startTime) {
        return { method: "proc-stat", value: `${bootId}:${startTime}` };
      }
    } catch (error) {
      try {
        signalProcess(pid, 0);
      } catch (signalError) {
        if (signalError?.code === "ESRCH") return null;
        throw signalError;
      }
      throw new Error(
        `Could not verify proc-stat identity for live preview PID ${pid}: ${error.message}.`,
      );
    }
    throw new Error(`Could not parse proc-stat identity for live preview PID ${pid}.`);
  }

  const result = runCommand("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  const started = result.stdout?.trim();
  if (result.status !== 0 || !started) {
    try {
      signalProcess(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return null;
      throw error;
    }
    throw new Error(
      `Could not verify ps-lstart-utc identity for live preview PID ${pid}: ` +
        `${result.stderr?.trim() || `ps exit ${result.status ?? "unknown"}`}.`,
    );
  }
  return { method: "ps-lstart-utc", value: started };
}

function validIdentity(identity) {
  return identity &&
    ["proc-stat", "ps-lstart-utc", "test"].includes(identity.method) &&
    typeof identity.value === "string" &&
    identity.value.length > 0;
}

function previewHostBootIdentity(
  {
    platform = process.platform,
    hostname = os.hostname,
    readFile = fs.readFileSync,
    runCommand = spawnSync,
  } = {},
) {
  const host = hostname();
  let boot;
  if (platform === "linux") {
    boot = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } else {
    const result = runCommand("ps", ["-p", "1", "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
    });
    boot = result.status === 0 ? result.stdout?.trim() : "";
  }
  if (!host || !boot) {
    throw new Error("Preview lifecycle cannot determine the current host and boot identity.");
  }
  return { host, boot };
}

function parseLockOwner(raw) {
  try {
    const owner = JSON.parse(raw);
    if (
      !Number.isSafeInteger(owner?.version) ||
      owner.version < 2 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1
    ) return null;
    const identity = owner.version === 2 && typeof owner.pidStartIdentity === "string"
      ? { method: "legacy-pid-start", value: owner.pidStartIdentity }
      : owner.identity;
    if (
      typeof identity?.method !== "string" ||
      !identity.method ||
      typeof identity?.value !== "string" ||
      !identity.value
    ) return null;
    return { ...owner, identity };
  } catch {
    return null;
  }
}

function readLockOwner(lockDirectory, legacyLockFiles = []) {
  let lockStat;
  if (lockDirectory) {
    try {
      lockStat = fs.lstatSync(lockDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (lockStat) {
    const ownerFile = path.join(lockDirectory, "owner.json");
    let raw = null;
    try {
      raw = fs.readFileSync(ownerFile, "utf8");
    } catch {}
    return {
      kind: "directory",
      target: lockDirectory,
      ownerFile,
      owner: raw === null ? null : parseLockOwner(raw),
    };
  }
  for (const legacyLockFile of legacyLockFiles) {
    try {
      const raw = fs.readFileSync(legacyLockFile, "utf8");
      return {
        kind: "legacy-file",
        target: legacyLockFile,
        ownerFile: legacyLockFile,
        owner: parseLockOwner(raw),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return {
          kind: "legacy-file",
          target: legacyLockFile,
          ownerFile: legacyLockFile,
          owner: null,
        };
      }
    }
  }
  return null;
}

function lifecycleOwnerDescription(owner) {
  return `${owner.operation || "preview lifecycle"} PID ${owner.pid}`;
}

export function acquirePreviewLifecycleLock(
  lockDirectory,
  {
    operation,
    generation,
    pid = process.pid,
    identity,
    resolvePidStartIdentity = previewPidStartIdentity,
    hostBootIdentity,
    legacyLockFiles = [],
    now = Date.now,
  } = {},
) {
  if (!operation || !generation) {
    throw new Error("Preview lifecycle lock requires an operation and generation.");
  }
  const ownerIdentity = identity ?? resolvePidStartIdentity(pid);
  if (!validIdentity(ownerIdentity)) {
    throw new Error(`Preview lifecycle cannot acquire a lock without PID identity for ${pid}.`);
  }
  const { host, boot } = hostBootIdentity ?? previewHostBootIdentity();
  const owner = {
    version: PREVIEW_LIFECYCLE_LOCK_VERSION,
    operation,
    generation,
    pid,
    identity: { ...ownerIdentity, host, boot },
    createdAt: new Date(now()).toISOString(),
  };
  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
    fsyncDirectory(path.dirname(lockDirectory));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readLockOwner(lockDirectory, legacyLockFiles);
    throw new Error(
      existing?.owner
        ? `Preview lifecycle BUSY: ${lifecycleOwnerDescription(existing.owner)} holds ${lockDirectory}.`
        : `Preview lifecycle BUSY: unreadable owner record at ${lockDirectory}.`,
    );
  }
  const legacyLock = readLockOwner(null, legacyLockFiles);
  if (legacyLock) {
    fs.rmdirSync(lockDirectory);
    fsyncDirectory(path.dirname(lockDirectory));
    throw new Error(
      legacyLock.owner
        ? `Preview lifecycle BUSY: ${lifecycleOwnerDescription(legacyLock.owner)} holds ${legacyLock.target}.`
        : `Preview lifecycle BUSY: unreadable owner record at ${legacyLock.target}.`,
    );
  }
  const ownerFile = path.join(lockDirectory, "owner.json");
  try {
    publishAtomicFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`);
  } catch (error) {
    fs.rmSync(lockDirectory, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lockDirectory);
      fsyncDirectory(path.dirname(lockDirectory));
      released = true;
    },
  };
}

export function recoverPreviewLifecycleLock(
  lockDirectory,
  {
    legacyLockFiles = [],
    force = false,
    verifyForcedRecovery,
    resolvePidStartIdentity = previewPidStartIdentity,
    currentHostBootIdentity,
    log = console.log,
  } = {},
) {
  const existing = readLockOwner(lockDirectory, legacyLockFiles);
  if (!existing) return false;
  if (existing.owner) {
    const currentHostBoot = currentHostBootIdentity ?? previewHostBootIdentity();
    const ownerHost = existing.owner.identity.host;
    const ownerBoot = existing.owner.identity.boot;
    if (!ownerHost || !ownerBoot ||
        ownerHost !== currentHostBoot.host || ownerBoot !== currentHostBoot.boot) {
      throw new Error(
        `Preview lock recovery cannot verify owner liveness for PID ${existing.owner.pid}: host or boot identity differs or is missing.`,
      );
    }
    if (resolvePidStartIdentity(existing.owner.pid) !== null) {
      throw new Error(
        `Preview lock recovery refuses live owner PID ${existing.owner.pid} from ${existing.ownerFile}.`,
      );
    }
  } else {
    if (!force) {
      throw new Error(
        `Preview lock owner record is missing or unreadable at ${existing.ownerFile}; rerun with --recover-lock --force only after operator confirmation.`,
      );
    }
    if (typeof verifyForcedRecovery !== "function") {
      throw new Error("Forced preview lock recovery requires port and process safety proofs.");
    }
    verifyForcedRecovery();
  }
  if (existing.kind === "directory") fs.rmSync(existing.target, { recursive: true, force: true });
  else fs.unlinkSync(existing.target);
  fsyncDirectory(path.dirname(existing.target));
  log(`Recovered preview lifecycle lock: ${existing.target}.`);
  return true;
}

export function publishPreviewStartGate(gateFile, generation) {
  if (typeof generation !== "string" || !generation) {
    throw new Error("Preview start gate requires a generation.");
  }
  publishAtomicFile(gateFile, `${generation}\n`, 0o600, { replace: false });
}

export function publishPreviewStateFile(stateFile, state) {
  const stateDirectory = path.dirname(stateFile);
  const temporaryStateFile = path.join(
    stateDirectory,
    `.${path.basename(stateFile)}.${process.pid}.${state.generation}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryStateFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryStateFile, stateFile);
    fsyncDirectory(stateDirectory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryStateFile, { force: true });
    throw error;
  }
}

export function readPreviewStateCandidate(stateFile) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    return { status: "valid", state: JSON.parse(raw) };
  } catch {
    return { status: "malformed" };
  }
}

export function previewTeardownRecord(stateFile, projectionMarker) {
  const candidate = readPreviewStateCandidate(stateFile);
  if (candidate.status === "valid") {
    return { state: candidate.state, recoveredFromMarker: false, stateStatus: "valid" };
  }
  if (!projectionMarker) {
    throw new Error(
      `No usable preview state found at ${stateFile} and no owned projection marker exists.`,
    );
  }
  if (!projectionMarker.rootProcess) {
    throw new Error(
      `Preview projection generation ${projectionMarker.generation} has no generation-bound launcher process; refusing recovery.`,
    );
  }
  return {
    state: {
      version: 2,
      generation: projectionMarker.generation,
      repositoryRoot: projectionMarker.repositoryRoot,
      stateRoot: projectionMarker.stateRoot,
      launchRoot: projectionMarker.launchRoot,
      rootProcess: projectionMarker.rootProcess,
      serviceStatePath: projectionMarker.serviceStatePath,
      ports: projectionMarker.ports,
    },
    recoveredFromMarker: true,
    stateStatus: candidate.status,
  };
}

export async function removePreviewStateFile(
  stateFile,
  timeoutMs = 5_000,
  {
    fileExists = fs.existsSync,
    removeFile = (filePath) => fs.rmSync(filePath, { force: true }),
    now = Date.now,
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pollIntervalMs = 25,
  } = {},
) {
  removeFile(stateFile);
  const deadline = now() + timeoutMs;
  while (fileExists(stateFile) && now() < deadline) {
    await pause(pollIntervalMs);
  }
  return !fileExists(stateFile);
}
