import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const sensitiveEnvironmentNamePattern =
  /(?:^|_)(?:API_KEY|AUTH[^_]*|CREDENTIALS?|DATABASE_URL|KEY|MYSQL_PWD|PASSWORD|PAT|PGPASSWORD|SECRET|TOKEN)(?:_|$)/i;
const previewBuildEnvironmentNames = ["HOME", "PATH", "NODE_ENV", "PORT", "TMPDIR", "LANG", "CI"];
const buildLockHeartbeatTimeoutMs = 10 * 60 * 1000;
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

export function prepareLauncherDependencies({
  environment,
  serverDependenciesReady,
  webDependenciesReady,
  install,
}) {
  if (environment.KADY_PREVIEW === "1") {
    if (!serverDependenciesReady || !webDependenciesReady) {
      const missing = [
        !serverDependenciesReady ? "server/node_modules/tsx" : null,
        !webDependenciesReady ? "web/node_modules/next" : null,
      ].filter(Boolean);
      throw new Error(
        `Preview requires dependencies installed before launch; missing ${missing.join(" and ")}.`,
      );
    }
    return "reuse-preview";
  }
  install();
  return "installed";
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`],
      { encoding: "utf-8", windowsHide: true },
    );
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  if (pid === process.pid) {
    return `node-start-seconds:${Math.floor((Date.now() - process.uptime() * 1000) / 1000)}`;
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function vendoredDistBuildLockPath(repositoryRoot) {
  const identity = fs.realpathSync(path.resolve(repositoryRoot));
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), `kady-vendored-dist-${digest}.lock`);
}

function readBuildLock(lockPath) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    return lock && typeof lock.token === "string" ? lock : null;
  } catch {
    return null;
  }
}

export function vendoredDistBuildLockStatus(repositoryRoot) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  const lock = readBuildLock(lockPath);
  if (!lock) return { active: false, lockPath, lock: null };
  const currentStart = processStartIdentity(lock.pid);
  let heartbeatAgeMs = Number.POSITIVE_INFINITY;
  try {
    heartbeatAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return { active: false, lockPath, lock: null };
  }
  const startIdentityMatches = currentStart === null
    ? processAlive(lock.pid) && String(lock.processStart).startsWith("node-start-seconds:")
    : currentStart === lock.processStart;
  const active = startIdentityMatches && Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs <= buildLockHeartbeatTimeoutMs;
  return { active, lockPath, lock };
}

export async function acquireVendoredDistBuildLock(
  repositoryRoot,
  { waitMs = 120_000, pollMs = 200 } = {},
) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  const token = randomUUID();
  const processStart = processStartIdentity(process.pid);
  if (!processStart) throw new Error(`could not determine start time for build-lock PID ${process.pid}`);
  const deadline = Date.now() + waitMs;
  while (true) {
    const lock = {
      schema: 1,
      token,
      pid: process.pid,
      processStart,
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`);
      fs.closeSync(descriptor);
      const heartbeat = setInterval(() => {
        const current = readBuildLock(lockPath);
        if (current?.token !== token) return;
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
      }, 1000);
      heartbeat.unref();
      return {
        lockPath,
        token,
        release() {
          clearInterval(heartbeat);
          if (readBuildLock(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const status = vendoredDistBuildLockStatus(repositoryRoot);
    if (!status.active) {
      const observedToken = status.lock?.token ?? null;
      if (readBuildLock(lockPath)?.token === observedToken) {
        console.warn(`vendored-dist-build: WARNING reclaiming inactive build lock: ${lockPath}`);
        fs.rmSync(lockPath, { force: true });
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for active vendored dist build lock: ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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
