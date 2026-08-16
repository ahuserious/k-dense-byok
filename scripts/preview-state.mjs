import fs from "node:fs";

function lifecycleOwnerDescription(lockFile) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return `${owner.operation ?? "unknown operation"} PID ${owner.pid ?? "unknown"}`;
  } catch {
    return "an unreadable existing owner";
  }
}

export function acquirePreviewLifecycleLock(
  lockFile,
  { operation, generation, pid = process.pid } = {},
) {
  if (!operation || !generation) {
    throw new Error("Preview lifecycle lock requires an operation and generation.");
  }

  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Preview lifecycle is busy: ${lifecycleOwnerDescription(lockFile)} holds ${lockFile}.`,
      );
    }
    throw error;
  }

  const owner = {
    version: 1,
    operation,
    generation,
    pid,
    acquiredAt: new Date().toISOString(),
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
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (
        current.generation !== generation ||
        current.operation !== operation ||
        current.pid !== pid
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
