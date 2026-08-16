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
  if (!fs.existsSync(lockPath)) {
    return { active: false, lockPath, lock: null };
  }
  const startIdentityMatches = currentStart === null
    ? processAlive(lock.pid) && String(lock.processStart).startsWith("node-start-seconds:")
    : currentStart === lock.processStart;
  // An exact PID/start-identity match is authoritative even if the owner was
  // paused long enough to miss heartbeats. Reclaiming it would create two
  // writers when that process resumes.
  const active = startIdentityMatches;
  return { active, lockPath, lock };
}

export async function acquireVendoredDistBuildLock(
  repositoryRoot,
  { waitMs = 120_000, pollMs = 200, lockFileSystem = fs } = {},
) {
  const lockPath = vendoredDistBuildLockPath(repositoryRoot);
  const token = randomUUID();
  const processStart = processStartIdentity(process.pid);
  if (!processStart) throw new Error(`could not determine start time for build-lock PID ${process.pid}`);
  const deadline = Date.now() + waitMs;
  const timeoutError = () => {
    const owner = readBuildLock(lockPath);
    const ownerMetadata = owner
      ? JSON.stringify({
          pid: owner.pid ?? null,
          processStart: owner.processStart ?? null,
          token: owner.token,
          createdAt: owner.createdAt ?? null,
        })
      : "unreadable-or-malformed";
    return new Error(`timed out waiting for vendored dist build lock: ${lockPath}; owner=${ownerMetadata}`);
  };
  while (true) {
    if (Date.now() >= deadline) {
      throw timeoutError();
    }
    const lock = {
      schema: 1,
      token,
      pid: process.pid,
      processStart,
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    try {
      const descriptor = lockFileSystem.openSync(lockPath, "wx", 0o600);
      try {
        lockFileSystem.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`);
        lockFileSystem.closeSync(descriptor);
      } catch (error) {
        try {
          lockFileSystem.closeSync(descriptor);
        } catch {
          // The original write/close failure is the useful error.
        }
        lockFileSystem.rmSync(lockPath, { force: true });
        throw error;
      }
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
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
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
