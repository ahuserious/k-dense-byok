#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function createLaunchOverlay(stateRoot, realNpm, realGit) {
  const launchRoot = path.join(stateRoot, "launch");
  const shimDirectory = path.join(launchRoot, "bin");
  fs.mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(repositoryRoot, "start.mjs"), path.join(launchRoot, "start.mjs"));
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

function previewEnvironment(stateRoot, launchRoot, shimDirectory, ports) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete environment[name];
  }

  const piAgentDirectory = path.join(stateRoot, "pi-agent");
  return {
    ...environment,
    PATH: `${shimDirectory}${path.delimiter}${environment.PATH ?? ""}`,
    KADY_PREVIEW: "1",
    KADY_PORT: String(ports.backend),
    KADY_FRONTEND_PORT: String(ports.frontend),
    KADY_PIPELINE_ENGINE_PORT: String(ports.engine),
    KADY_PROJECTS_ROOT: path.join(stateRoot, "projects"),
    KADY_PI_AGENT_DIR: piAgentDirectory,
    PI_CODING_AGENT_DIR: piAgentDirectory,
    KADY_SKILLS_CACHE_DIR: path.join(stateRoot, "skills-cache"),
    KADY_SKILLS_REPO: "kady-preview-nonexistent/none",
    KADY_WORKFLOW_SUPERVISOR_DIR: path.join(stateRoot, "workflow-supervisor"),
    KADY_WORKFLOW_SUPERVISOR_SOCKET: path.join(stateRoot, "wf.sock"),
    TELEGRAM_BOT_TOKEN: "",
    OPENAI_COMPATIBLE_BASE_URL: "",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    KADY_PREVIEW_LAUNCH_ROOT: launchRoot,
  };
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

async function stopFailedLaunch(rootPid) {
  if (!processGroupAlive(rootPid)) return;
  process.kill(-rootPid, "SIGTERM");
  if (await waitForOwnedTree(rootPid, 30_000)) return;
  process.kill(-rootPid, "SIGTERM");
  await waitForOwnedTree(rootPid, 10_000);
}

async function waitForHealth(url, label, rootProcess, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (rootProcess.exitCode !== null || rootProcess.signalCode !== null) {
      throw new Error(`${label} did not start because the preview launcher exited.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} health timed out: ${lastError}`);
}

if (process.platform === "win32") {
  fail("The preview lifecycle currently requires POSIX process-group and pgrep semantics.");
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
    rootPid: rootProcess.pid,
    ports,
    logPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  await waitForHealth(`http://127.0.0.1:${ports.backend}/health`, "backend", rootProcess, 180_000);
  await waitForHealth(`http://127.0.0.1:${ports.frontend}/`, "web", rootProcess, 180_000);
  await waitForHealth(
    `http://127.0.0.1:${ports.engine}/api/health`,
    "workflow engine",
    rootProcess,
    120_000,
  );

  rootProcess.unref();
  console.log("Preview ready:");
  console.log(`  Web:     http://127.0.0.1:${ports.frontend}`);
  console.log(`  Backend: http://127.0.0.1:${ports.backend}`);
  console.log(`  Engine:  http://127.0.0.1:${ports.engine}`);
  console.log(`  Root PID: ${rootProcess.pid}`);
  console.log(`  State:    ${stateRoot}`);
  console.log(`  Log:      ${logPath}`);
} catch (error) {
  if (rootProcess?.pid) await stopFailedLaunch(rootProcess.pid);
  console.error(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Preview log: ${logPath}`);
  if (fs.existsSync(stateFile)) {
    console.error("Preview state was preserved; run scripts/preview-down.mjs to verify cleanup.");
  }
  process.exit(1);
}
