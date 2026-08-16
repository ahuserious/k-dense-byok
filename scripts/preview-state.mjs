import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function readLockOwner(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    const owner = JSON.parse(raw);
    if (
      ![1, 2].includes(owner?.version) ||
      typeof owner.operation !== "string" ||
      typeof owner.generation !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      (owner.version === 2 &&
        (typeof owner.pidStartIdentity !== "string" || !owner.pidStartIdentity))
    ) {
      throw new Error("invalid lifecycle owner");
    }
    return { owner, raw };
  } catch (error) {
    throw new Error(
      `Preview lifecycle lock ${lockFile} has an unreadable owner; ` +
        "inspect and remove it only after proving no preview lifecycle command is running.",
      { cause: error },
    );
  }
}

function lifecycleOwnerDescription(owner) {
  return `${owner.operation} PID ${owner.pid}`;
}

export function previewPidStartIdentity(
  pid,
  {
    signalProcess = process.kill,
    runCommand = spawnSync,
  } = {},
) {
  try {
    signalProcess(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return null;
    throw error;
  }

  const result = runCommand("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
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
      `Could not verify start identity for live preview lifecycle PID ${pid}: ` +
        `${result.stderr?.trim() || `ps exit ${result.status ?? "unknown"}`}.`,
    );
  }
  return `ps-lstart:${started}`;
}

function assertStaleGenerationMatches(owner, generationFiles) {
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

export function acquirePreviewLifecycleLock(
  lockFile,
  {
    operation,
    generation,
    pid = process.pid,
    pidStartIdentity,
    resolvePidStartIdentity = previewPidStartIdentity,
    generationFiles = [],
    log = console.log,
  } = {},
) {
  if (!operation || !generation) {
    throw new Error("Preview lifecycle lock requires an operation and generation.");
  }

  const ownerStartIdentity = pidStartIdentity ?? resolvePidStartIdentity(pid);
  if (!ownerStartIdentity) {
    throw new Error(`Preview lifecycle cannot acquire a lock for non-running PID ${pid}.`);
  }

  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLockOwner(lockFile);
      const currentStartIdentity = resolvePidStartIdentity(existing.owner.pid);
      if (
        currentStartIdentity &&
        (!existing.owner.pidStartIdentity ||
          currentStartIdentity === existing.owner.pidStartIdentity)
      ) {
        throw new Error(
          `Preview lifecycle is busy: ${lifecycleOwnerDescription(existing.owner)} holds ${lockFile}.`,
        );
      }
      assertStaleGenerationMatches(existing.owner, generationFiles);
      let currentRaw;
      try {
        currentRaw = fs.readFileSync(lockFile, "utf8");
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (currentRaw !== existing.raw) continue;
      fs.rmSync(lockFile);
      log(
        `Recovered stale lifecycle lock (pid ${existing.owner.pid}, ` +
          `started ${existing.owner.pidStartIdentity ?? "unknown legacy identity"}).`,
      );
    }
  }

  const owner = {
    version: 2,
    operation,
    generation,
    pid,
    pidStartIdentity: ownerStartIdentity,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(lockFile, { force: true });
    throw error;
  }

  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      const current = readLockOwner(lockFile).owner;
      if (
        current.generation !== generation ||
        current.operation !== operation ||
        current.pid !== pid ||
        current.pidStartIdentity !== ownerStartIdentity
      ) {
        throw new Error(
          `Preview lifecycle lock ownership changed before release: ${lockFile}.`,
        );
      }
      fs.closeSync(descriptor);
      fs.rmSync(lockFile, { force: true });
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
    const directoryDescriptor = fs.openSync(stateDirectory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
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
  return {
    state: {
      version: 1,
      generation: projectionMarker.generation,
      repositoryRoot: projectionMarker.repositoryRoot,
      stateRoot: projectionMarker.stateRoot,
      launchRoot: projectionMarker.launchRoot,
      rootPid: projectionMarker.rootPid,
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
