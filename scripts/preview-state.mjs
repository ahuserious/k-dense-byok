import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const PREVIEW_LIFECYCLE_LOCK_VERSION = 4;
export const PREVIEW_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const PREVIEW_LOCK_POLL_INTERVAL_MS = 25;
const PREVIEW_RECOVERY_GUARD_VERSION = 1;

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fileDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function readFileSnapshot(file) {
  const stat = fs.statSync(file);
  const raw = fs.readFileSync(file);
  return {
    stat,
    raw,
    digest: fileDigest(raw),
    identity: `${stat.dev}:${stat.ino}`,
  };
}

function sameSnapshot(left, right) {
  return left.identity === right.identity && left.digest === right.digest;
}

function publishCompleteFile(file, value, mode = 0o600) {
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
    fs.linkSync(temporaryFile, file);
    fs.unlinkSync(temporaryFile);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
  return readFileSnapshot(file);
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

function parseLockOwner(snapshot) {
  try {
    const owner = JSON.parse(snapshot.raw.toString("utf8"));
    if (
      owner?.version !== PREVIEW_LIFECYCLE_LOCK_VERSION ||
      typeof owner.operation !== "string" ||
      typeof owner.generation !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      !validIdentity(owner.identity)
    ) return null;
    return owner;
  } catch {
    return null;
  }
}

function parseRecoveryGuardOwner(snapshot) {
  try {
    const owner = JSON.parse(snapshot.raw.toString("utf8"));
    if (
      owner?.version !== PREVIEW_RECOVERY_GUARD_VERSION ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      !validIdentity(owner.identity) ||
      typeof owner.createdAt !== "string"
    ) return null;
    return owner;
  } catch {
    return null;
  }
}

function lifecycleOwnerDescription(owner) {
  return `${owner.operation} PID ${owner.pid}`;
}

function identityDisposition(ownerIdentity, currentIdentity) {
  if (currentIdentity === null) return "stale";
  if (!validIdentity(ownerIdentity) || !validIdentity(currentIdentity)) return "live";
  if (ownerIdentity.method !== currentIdentity.method) return "live";
  return ownerIdentity.value === currentIdentity.value ? "live" : "stale";
}

function assertStaleGenerationMatches(owner, generationFiles) {
  if (!owner) return;
  let matchingArtifacts = 0;
  const unreadableArtifacts = [];
  for (const generationFile of generationFiles) {
    let raw;
    try {
      raw = fs.readFileSync(generationFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    let generation;
    try {
      generation = JSON.parse(raw)?.generation;
    } catch {
      unreadableArtifacts.push(generationFile);
      continue;
    }
    if (typeof generation !== "string" || !generation) {
      unreadableArtifacts.push(generationFile);
      continue;
    }
    if (generation !== owner.generation) {
      throw new Error(
        `Preview lifecycle refuses stale-lock recovery because ${generationFile} ` +
          `belongs to generation ${generation}, not ${owner.generation}.`,
      );
    }
    matchingArtifacts += 1;
  }
  if (unreadableArtifacts.length > 0 && matchingArtifacts === 0) {
    throw new Error(
      `Preview lifecycle refuses stale-lock recovery because it cannot verify generation in ` +
        `${unreadableArtifacts.join(", ")}.`,
    );
  }
}

function lockTimeoutError(lockFile, holder) {
  const holderText = holder
    ? ` PID ${holder.pid} (${holder.identity.method}:${holder.identity.value})`
    : " with an unrecognized owner";
  return new Error(
    `Timed out after ${PREVIEW_LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for preview lifecycle recovery guard${holderText} at ${lockFile}.`,
  );
}

function acquirePreviewRecoveryGuard(
  lockFile,
  {
    pid,
    identity,
    resolvePidStartIdentity,
    now,
    pauseSync,
    deadline,
  },
) {
  const guardFile = `${lockFile}.recovery`;
  const guardOwner = {
    version: PREVIEW_RECOVERY_GUARD_VERSION,
    pid,
    identity,
    createdAt: new Date(now()).toISOString(),
  };
  const serializedGuardOwner = `${JSON.stringify(guardOwner, null, 2)}\n`;
  let ownedSnapshot;

  while (now() <= deadline) {
    try {
      ownedSnapshot = publishCompleteFile(guardFile, serializedGuardOwner);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let observedSnapshot;
    try {
      observedSnapshot = readFileSnapshot(guardFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const observedOwner = parseRecoveryGuardOwner(observedSnapshot);
    if (!observedOwner) {
      throw new Error(
        `Preview lifecycle recovery guard is unrecognized and cannot be reclaimed automatically: ${guardFile}.`,
      );
    }
    const currentIdentity = resolvePidStartIdentity(observedOwner.pid);
    if (identityDisposition(observedOwner.identity, currentIdentity) === "live") {
      if (now() >= deadline) throw lockTimeoutError(guardFile, observedOwner);
      pauseSync(PREVIEW_LOCK_POLL_INTERVAL_MS);
      continue;
    }

    // A hard-link claim keeps the observed inode alive and lets contenders use
    // link count as an atomic election. Only the sole claimant may unlink the
    // canonical stale guard and publish its replacement.
    const claimFile = `${guardFile}.claim.${pid}.${randomUUID()}`;
    try {
      fs.linkSync(guardFile, claimFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    try {
      const claimSnapshot = readFileSnapshot(claimFile);
      if (!sameSnapshot(observedSnapshot, claimSnapshot)) continue;
      let canonicalSnapshot;
      try {
        canonicalSnapshot = readFileSnapshot(guardFile);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!sameSnapshot(observedSnapshot, canonicalSnapshot)) continue;
      if (fs.statSync(claimFile).nlink !== 2) {
        pauseSync(PREVIEW_LOCK_POLL_INTERVAL_MS);
        continue;
      }
      fs.unlinkSync(guardFile);
      fsyncDirectory(path.dirname(guardFile));
      try {
        ownedSnapshot = publishCompleteFile(guardFile, serializedGuardOwner);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (ownedSnapshot) break;
    } finally {
      fs.rmSync(claimFile, { force: true });
    }
  }
  if (!ownedSnapshot) throw lockTimeoutError(guardFile, null);

  let released = false;
  return {
    release() {
      if (released) return;
      const currentSnapshot = readFileSnapshot(guardFile);
      if (!sameSnapshot(ownedSnapshot, currentSnapshot)) {
        throw new Error(`Preview lifecycle recovery guard ownership changed: ${guardFile}.`);
      }
      fs.unlinkSync(guardFile);
      fsyncDirectory(path.dirname(guardFile));
      released = true;
    },
  };
}

export function acquirePreviewLifecycleLock(
  lockFile,
  {
    operation,
    generation,
    pid = process.pid,
    identity,
    resolvePidStartIdentity = previewPidStartIdentity,
    generationFiles = [],
    log = console.log,
    now = Date.now,
    pauseSync = sleepSync,
  } = {},
) {
  if (!operation || !generation) {
    throw new Error("Preview lifecycle lock requires an operation and generation.");
  }
  const ownerIdentity = identity ?? resolvePidStartIdentity(pid);
  if (!validIdentity(ownerIdentity)) {
    throw new Error(`Preview lifecycle cannot acquire a lock without PID identity for ${pid}.`);
  }
  const owner = {
    version: PREVIEW_LIFECYCLE_LOCK_VERSION,
    operation,
    generation,
    pid,
    identity: ownerIdentity,
    createdAt: new Date(now()).toISOString(),
  };
  const serializedOwner = `${JSON.stringify(owner, null, 2)}\n`;

  const deadline = now() + PREVIEW_LOCK_ACQUIRE_TIMEOUT_MS;
  let ownedSnapshot;
  while (!ownedSnapshot && now() <= deadline) {
    const guard = acquirePreviewRecoveryGuard(lockFile, {
      pid,
      identity: ownerIdentity,
      resolvePidStartIdentity,
      now,
      pauseSync,
      deadline,
    });
    try {
      let observedSnapshot;
      try {
        observedSnapshot = readFileSnapshot(lockFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!observedSnapshot) {
        ownedSnapshot = publishCompleteFile(lockFile, serializedOwner);
        continue;
      }
      const staleOwner = parseLockOwner(observedSnapshot);
      if (!staleOwner) {
        throw new Error(
          `Preview lifecycle lock is legacy, malformed, or uses an unknown identity method and is busy: ${lockFile}. ` +
            "Run node scripts/preview-down.mjs --recover-lock for explicit proof-based recovery.",
        );
      }
      const currentIdentity = resolvePidStartIdentity(staleOwner.pid);
      if (identityDisposition(staleOwner.identity, currentIdentity) === "live") {
        const suffix = staleOwner.operation === "preview-up" ? " is still starting" : " is running";
        throw new Error(
          `Preview lifecycle is busy: ${lifecycleOwnerDescription(staleOwner)}${suffix} and holds ${lockFile}.`,
        );
      }
      assertStaleGenerationMatches(staleOwner, generationFiles);
      const currentSnapshot = readFileSnapshot(lockFile);
      if (!sameSnapshot(observedSnapshot, currentSnapshot)) continue;
      fs.unlinkSync(lockFile);
      fsyncDirectory(path.dirname(lockFile));
      ownedSnapshot = publishCompleteFile(lockFile, serializedOwner);
      log(
        `Recovered stale lifecycle lock (pid ${staleOwner.pid}, started ${staleOwner.identity.method}:${staleOwner.identity.value}).`,
      );
    } finally {
      guard.release();
    }
  }
  if (!ownedSnapshot) throw lockTimeoutError(lockFile, null);

  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      const deadline = now() + PREVIEW_LOCK_ACQUIRE_TIMEOUT_MS;
      const guard = acquirePreviewRecoveryGuard(lockFile, {
        pid,
        identity: ownerIdentity,
        resolvePidStartIdentity,
        now,
        pauseSync,
        deadline,
      });
      try {
        const currentSnapshot = readFileSnapshot(lockFile);
        if (!sameSnapshot(ownedSnapshot, currentSnapshot)) {
          throw new Error(`Preview lifecycle lock ownership changed before release: ${lockFile}.`);
        }
        fs.unlinkSync(lockFile);
        fsyncDirectory(path.dirname(lockFile));
        released = true;
      } finally {
        guard.release();
      }
    },
  };
}

export function recoverUnrecognizedPreviewLifecycleLock(
  lockFile,
  {
    verifySafeRecovery,
    pid = process.pid,
    identity,
    resolvePidStartIdentity = previewPidStartIdentity,
    log = console.log,
    now = Date.now,
    pauseSync = sleepSync,
  } = {},
) {
  if (typeof verifySafeRecovery !== "function") {
    throw new Error("Explicit preview lock recovery requires a safety proof callback.");
  }
  const ownerIdentity = identity ?? resolvePidStartIdentity(pid);
  if (!validIdentity(ownerIdentity)) {
    throw new Error(`Preview lock recovery cannot verify PID identity for ${pid}.`);
  }
  const guard = acquirePreviewRecoveryGuard(lockFile, {
    pid,
    identity: ownerIdentity,
    resolvePidStartIdentity,
    now,
    pauseSync,
    deadline: now() + PREVIEW_LOCK_ACQUIRE_TIMEOUT_MS,
  });
  try {
    let observedSnapshot;
    try {
      observedSnapshot = readFileSnapshot(lockFile);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (parseLockOwner(observedSnapshot)) {
      throw new Error(
        `Preview lifecycle lock is a current-version record; use normal preview-down recovery: ${lockFile}.`,
      );
    }
    verifySafeRecovery({
      lockFile,
      identity: observedSnapshot.identity,
      digest: observedSnapshot.digest,
    });
    const currentSnapshot = readFileSnapshot(lockFile);
    if (!sameSnapshot(observedSnapshot, currentSnapshot)) {
      throw new Error(`Preview lifecycle lock changed during explicit recovery: ${lockFile}.`);
    }
    fs.unlinkSync(lockFile);
    fsyncDirectory(path.dirname(lockFile));
    log(`Recovered legacy or malformed preview lifecycle lock: ${lockFile}.`);
    return true;
  } finally {
    guard.release();
  }
}

export function publishPreviewStartGate(gateFile, generation) {
  if (typeof generation !== "string" || !generation) {
    throw new Error("Preview start gate requires a generation.");
  }
  publishCompleteFile(gateFile, `${generation}\n`);
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
