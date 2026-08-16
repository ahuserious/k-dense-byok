#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewEnvironment } from "./preview-environment.mjs";
import { scrubSensitiveEnvironment } from "./vendored-dist-environment.mjs";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";
import {
  collectPreviewListenerGroups,
  stopProcessGroups,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";
import { waitForPreviewReadiness } from "./preview-readiness.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const previewDirectory = path.join(repositoryRoot, "deploy", "preview");
const stateFile = path.join(previewDirectory, ".state.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  return value;
}

function portOption(name, fallback) {
  const value = Number(optionValue(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    fail(`${name} must be an integer from 1024 through 65535.`);
  }
  return value;
}

function commandPath(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf-8",
  });
  if (result.status !== 0 || !result.stdout.trim()) fail(`${command} is required.`);
  return result.stdout.trim();
}

function writeExecutable(targetPath, content) {
  fs.writeFileSync(targetPath, content, { mode: 0o700 });
}

function prepareVendoredDist({ skipBuild, enginePort }) {
  const scriptName = skipBuild ? "vendored-dist-check.mjs" : "vendored-dist-build.mjs";
  const arguments_ = [path.join(scriptDirectory, scriptName)];
  if (!skipBuild) arguments_.push("--if-stale");

  if (skipBuild) {
    console.log("Vendored dist build disabled; verifying the existing bundle.");
  } else {
    console.log("Preparing the vendored Pipeline Engine web bundle.");
  }
  const buildEnvironment = scrubSensitiveEnvironment({
    ...process.env,
    PORT: String(enginePort),
  });
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    env: buildEnvironment,
    stdio: "inherit",
  });
  if (result.error) fail(`Could not run ${scriptName}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `Vendored Pipeline Engine web dist preparation failed (exit ${result.status ?? "unknown"}). ` +
        "Run `node scripts/vendored-dist-build.mjs --force` or omit --no-build-dist.",
    );
  }
}

function createLaunchOverlay(stateRoot, realNpm, realGit) {
  const launchRoot = path.join(stateRoot, "launch");
  const isolatedHome = path.join(stateRoot, "home");
  // start.mjs prepends ~/.local/bin after its dependency checks. Put the
  // shims there so that normalization cannot expose the host npm/git again.
  const shimDirectory = path.join(isolatedHome, ".local", "bin");
  fs.mkdirSync(launchRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
  const launcherSource = fs.readFileSync(path.join(repositoryRoot, "start.mjs"), "utf-8");
  fs.writeFileSync(
    path.join(launchRoot, "start.mjs"),
    instrumentPreviewLauncher(launcherSource),
    { mode: 0o700 },
  );
  fs.copyFileSync(path.join(repositoryRoot, "env-file.mjs"), path.join(launchRoot, "env-file.mjs"));
  fs.writeFileSync(path.join(launchRoot, ".env"), "# Intentionally blank preview environment.\n", {
    mode: 0o600,
  });
  fs.symlinkSync(path.join(repositoryRoot, "server"), path.join(launchRoot, "server"), "dir");
  fs.symlinkSync(path.join(repositoryRoot, "web"), path.join(launchRoot, "web"), "dir");

  writeExecutable(
    path.join(shimDirectory, "npm"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "view") process.exit(1);
const result = spawnSync(${JSON.stringify(realNpm)}, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
  );
  writeExecutable(
    path.join(shimDirectory, "git"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("push")) {
  console.error("[kady-preview] blocked destructive git command: push");
  process.exit(125);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
  );
  return { launchRoot, shimDirectory };
}

function runPushBlockProbe(realGit, environment) {
  const remoteUrl = "https://preview.invalid/kady-preview-blocked.git";
  const probe = spawnSync(
    realGit,
    ["push", remoteUrl, "HEAD:refs/heads/preview-probe"],
    { cwd: repositoryRoot, env: environment, encoding: "utf-8" },
  );
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  console.log("Push-block probe (expected failure):");
  if (output) console.log(output);
  if (probe.status === 0 || !/transport ['\"]https['\"] not allowed/i.test(output)) {
    throw new Error(
      `Push-block probe did not fail through GIT_ALLOW_PROTOCOL=file (exit ${probe.status}).`,
    );
  }
  console.log(`Push-block probe: BLOCKED (exit ${probe.status})`);
}

function processGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForOwnedTree(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupAlive(processGroupId);
}

async function stopFailedLaunch(rootPid, ports) {
  if (processGroupAlive(rootPid)) {
    process.kill(-rootPid, "SIGTERM");
    if (!(await waitForOwnedTree(rootPid, 30_000))) {
      process.kill(-rootPid, "SIGTERM");
      await waitForOwnedTree(rootPid, 10_000);
    }
  }

  const listenerGroups = collectPreviewListenerGroups(repositoryRoot, ports);
  const survivors = await stopProcessGroups(listenerGroups);
  if (survivors.length > 0) {
    throw new Error(
      `Preview listener process groups survived failed-launch cleanup: ${survivors.map(({ groupId }) => groupId).join(", ")}`,
    );
  }
  const occupied = await waitForPreviewPortsFree(ports, 15_000);
  if (occupied.length > 0) {
    throw new Error(
      `Preview ports did not become free after failed-launch cleanup: ${formatOccupiedPorts(occupied)}`,
    );
  }
}

function formatOccupiedPorts(occupied) {
  return occupied
    .map(({ role, port, listeners }) => `${role} :${port} (${listeners.join(", ")})`)
    .join("; ");
}

if (process.platform === "win32") {
  fail("The preview lifecycle currently requires POSIX process-group semantics.");
}
if (fs.existsSync(stateFile)) {
  fail(`Preview state already exists at ${stateFile}; run scripts/preview-down.mjs first.`);
}

const ports = {
  backend: portOption("--backend-port", Number(process.env.KADY_PORT || 18000)),
  frontend: portOption("--frontend-port", Number(process.env.KADY_FRONTEND_PORT || 13000)),
  engine: portOption(
    "--engine-port",
    Number(
      process.env.KADY_PIPELINE_ENGINE_PORT ||
        process.env.KADY_ARCHON_PORT ||
        13091,
    ),
  ),
};
if (!process.env.KADY_PIPELINE_ENGINE_PORT && process.env.KADY_ARCHON_PORT) {
  console.warn(
    "[deprecated] KADY_ARCHON_PORT is deprecated; use KADY_PIPELINE_ENGINE_PORT instead.",
  );
}
if (new Set(Object.values(ports)).size !== 3) fail("Preview ports must be distinct.");

prepareVendoredDist({
  skipBuild: process.argv.includes("--no-build-dist"),
  enginePort: ports.engine,
});

const initiallyOccupied = await waitForPreviewPortsFree(ports, 15_000);
if (initiallyOccupied.length > 0) {
  fail(
    `Preview ports are still occupied after the startup free-port barrier: ${formatOccupiedPorts(initiallyOccupied)}`,
  );
}

const requestedStateRoot = optionValue("--state-root", "");
let stateRoot = requestedStateRoot
  ? path.resolve(requestedStateRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-"));
if (requestedStateRoot) {
  const allowedTemporaryRoots = [os.tmpdir(), "/tmp"].map((candidate) =>
    fs.realpathSync(candidate),
  );
  const parentDirectory = fs.realpathSync(path.dirname(stateRoot));
  if (
    !path.basename(stateRoot).startsWith("kady-preview-") ||
    !allowedTemporaryRoots.some((temporaryRoot) => parentDirectory === temporaryRoot)
  ) {
    fail("--state-root must be a new kady-preview-* directory directly under a temp root.");
  }
  fs.mkdirSync(stateRoot, { recursive: false, mode: 0o700 });
}
stateRoot = fs.realpathSync(stateRoot);

const realNpm = commandPath("npm");
const realGit = commandPath("git");
const { launchRoot, shimDirectory } = createLaunchOverlay(stateRoot, realNpm, realGit);
const environment = previewEnvironment(stateRoot, launchRoot, shimDirectory, ports);
const logPath = path.join(stateRoot, "preview.log");
const serviceStatePath = environment.KADY_PREVIEW_SERVICE_STATE_FILE;
fs.writeFileSync(serviceStatePath, `${JSON.stringify({ version: 1, services: {} }, null, 2)}\n`, {
  mode: 0o600,
});

let rootProcess;
try {
  runPushBlockProbe(realGit, environment);
  const logDescriptor = fs.openSync(logPath, "a", 0o600);
  rootProcess = spawn(process.execPath, [path.join(launchRoot, "start.mjs"), "--no-browser"], {
    cwd: launchRoot,
    detached: true,
    env: environment,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  fs.closeSync(logDescriptor);
  if (!Number.isSafeInteger(rootProcess.pid) || rootProcess.pid < 1) {
    throw new Error("Preview launcher did not report a valid root PID.");
  }

  const state = {
    version: 1,
    repositoryRoot,
    stateRoot,
    launchRoot,
    projectsRoot: environment.KADY_PROJECTS_ROOT,
    piAgentDirectory: environment.PI_CODING_AGENT_DIR,
    workflowSupervisorDirectory: environment.KADY_WORKFLOW_SUPERVISOR_DIR,
    serviceStatePath,
    rootPid: rootProcess.pid,
    ports,
    logPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  await waitForPreviewReadiness({
    launcherProcess: rootProcess,
    serviceStatePath,
    logPath,
    services: [
      {
        role: "backend",
        label: "backend",
        url: `http://127.0.0.1:${ports.backend}/health`,
        timeoutMs: 180_000,
      },
      {
        role: "frontend",
        label: "web",
        url: `http://127.0.0.1:${ports.frontend}/`,
        timeoutMs: 180_000,
      },
      {
        role: "pipeline-engine",
        label: "workflow engine",
        url: `http://127.0.0.1:${ports.engine}/api/health`,
        timeoutMs: 120_000,
      },
    ],
  });

  rootProcess.unref();
  console.log("Preview ready:");
  console.log(`  Web:     http://127.0.0.1:${ports.frontend}`);
  console.log(`  Backend: http://127.0.0.1:${ports.backend}`);
  console.log(`  Engine:  http://127.0.0.1:${ports.engine}`);
  console.log(`  Root PID: ${rootProcess.pid}`);
  console.log(`  State:    ${stateRoot}`);
  console.log(`  Log:      ${logPath}`);
} catch (error) {
  let cleanupError = null;
  if (rootProcess?.pid) {
    try {
      await stopFailedLaunch(rootProcess.pid, ports);
    } catch (caught) {
      cleanupError = caught;
    }
  }
  console.error(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
  if (cleanupError) {
    console.error(
      `Preview cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  console.error(`Preview log: ${logPath}`);
  if (fs.existsSync(stateFile)) {
    console.error("Preview state was preserved; run scripts/preview-down.mjs to verify cleanup.");
  }
  process.exit(1);
}
