import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const UNREADABLE_LOCK_MINIMUM_AGE_MS = 500;
export const UNREADABLE_LOCK_STABILITY_DELAY_MS = 250;

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
      owner?.version !== 3 ||
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

function stableUnreadableSnapshot(lockFile, firstSnapshot, now, pauseSync) {
  const remainingAge = Math.max(
    0,
    UNREADABLE_LOCK_MINIMUM_AGE_MS - (now() - firstSnapshot.stat.mtimeMs),
  );
  pauseSync(remainingAge + UNREADABLE_LOCK_STABILITY_DELAY_MS);
  let secondSnapshot;
  try {
    secondSnapshot = readFileSnapshot(lockFile);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return sameSnapshot(firstSnapshot, secondSnapshot) ? secondSnapshot : null;
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
    version: 3,
    operation,
    generation,
    pid,
    identity: ownerIdentity,
    createdAt: new Date(now()).toISOString(),
  };
  const serializedOwner = `${JSON.stringify(owner, null, 2)}\n`;

  let ownedSnapshot;
  for (;;) {
    try {
      ownedSnapshot = publishCompleteFile(lockFile, serializedOwner);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let staleSnapshot;
    try {
      staleSnapshot = readFileSnapshot(lockFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const staleOwner = parseLockOwner(staleSnapshot);
    if (staleOwner) {
      const currentIdentity = resolvePidStartIdentity(staleOwner.pid);
      if (identityDisposition(staleOwner.identity, currentIdentity) === "live") {
        const suffix = staleOwner.operation === "preview-up" ? " is still starting" : " is running";
        throw new Error(
          `Preview lifecycle is busy: ${lifecycleOwnerDescription(staleOwner)}${suffix} and holds ${lockFile}.`,
        );
      }
      assertStaleGenerationMatches(staleOwner, generationFiles);
    } else {
      staleSnapshot = stableUnreadableSnapshot(lockFile, staleSnapshot, now, pauseSync);
      if (!staleSnapshot) continue;
    }

    const takeoverFile = `${lockFile}.stale.${pid}.${randomUUID()}`;
    try {
      fs.renameSync(lockFile, takeoverFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const takeoverSnapshot = readFileSnapshot(takeoverFile);
    if (!sameSnapshot(staleSnapshot, takeoverSnapshot)) {
      try {
        fs.linkSync(takeoverFile, lockFile);
      } catch {}
      fs.rmSync(takeoverFile, { force: true });
      continue;
    }
    try {
      ownedSnapshot = publishCompleteFile(lockFile, serializedOwner);
    } catch (error) {
      fs.rmSync(takeoverFile, { force: true });
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    fs.rmSync(takeoverFile, { force: true });
    fsyncDirectory(path.dirname(lockFile));
    log(
      staleOwner
        ? `Recovered stale lifecycle lock (pid ${staleOwner.pid}, started ${staleOwner.identity.method}:${staleOwner.identity.value}).`
        : `Recovered unreadable lifecycle lock older than ${UNREADABLE_LOCK_MINIMUM_AGE_MS}ms.`,
    );
    break;
  }

  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      const releaseFile = `${lockFile}.release.${pid}.${randomUUID()}`;
      try {
        fs.renameSync(lockFile, releaseFile);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`Preview lifecycle lock disappeared before release: ${lockFile}.`);
        }
        throw error;
      }
      const releasedSnapshot = readFileSnapshot(releaseFile);
      if (!sameSnapshot(ownedSnapshot, releasedSnapshot)) {
        try {
          fs.linkSync(releaseFile, lockFile);
        } catch {}
        throw new Error(`Preview lifecycle lock ownership changed before release: ${lockFile}.`);
      }
      fs.rmSync(releaseFile, { force: true });
      fsyncDirectory(path.dirname(lockFile));
      released = true;
    },
  };
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
