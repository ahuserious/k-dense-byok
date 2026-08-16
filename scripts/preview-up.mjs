#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowlistedPreviewEnvironment,
  assertPreviewAutomaticEnvironmentFilesAbsent,
  instrumentPreviewEnvironment,
  preparePreviewEngineHome,
  preparePreviewWebRoot,
  previewEngineHome,
  previewEnvironment,
  previewPrebuildEnvironment,
  previewWebProjectionMarkerPath,
  readPreviewWebProjectionMarker,
  removePreviewWebRoot,
  updatePreviewWebProjectionMarker,
} from "./preview-environment.mjs";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";
import {
  assertNoForeignPreviewListeners,
  collectRecordedPreviewProcessGroups,
  processGroupId,
  stopProcessGroups,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";
import {
  readPreviewServiceStates,
  waitForPreviewReadiness,
} from "./preview-readiness.mjs";
import {
  acquirePreviewLifecycleLock,
  previewPidStartIdentity,
  publishPreviewStateFile,
  readPreviewStateCandidate,
} from "./preview-state.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const previewDirectory = path.join(repositoryRoot, "deploy", "preview");
const stateFile = path.join(previewDirectory, ".state.json");
const lifecycleLockFile = path.join(previewDirectory, ".lifecycle.lock");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function replaceProcessEnvironment(environment) {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, environment);
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

function prepareVendoredDist({ skipBuild, environment }) {
  const scriptName = skipBuild ? "vendored-dist-check.mjs" : "vendored-dist-build.mjs";
  const arguments_ = [path.join(scriptDirectory, scriptName)];
  if (!skipBuild) arguments_.push("--if-stale");

  if (skipBuild) {
    console.log("Vendored dist build disabled; verifying the existing bundle.");
  } else {
    console.log("Preparing the vendored Pipeline Engine web bundle.");
  }
  assertPreviewAutomaticEnvironmentFilesAbsent(repositoryRoot);
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    env: environment,
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

function createLaunchOverlay(stateRoot, realNpm, realGit, generation, ports) {
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
    instrumentPreviewEnvironment(instrumentPreviewLauncher(launcherSource)),
    { mode: 0o700 },
  );
  fs.copyFileSync(path.join(repositoryRoot, "env-file.mjs"), path.join(launchRoot, "env-file.mjs"));
  fs.writeFileSync(path.join(launchRoot, ".env"), "# Intentionally blank preview environment.\n", {
    mode: 0o600,
  });
  fs.symlinkSync(path.join(repositoryRoot, "server"), path.join(launchRoot, "server"), "dir");

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
  preparePreviewWebRoot(repositoryRoot, launchRoot, generation, { stateRoot, ports });
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

async function stopFailedLaunch(state) {
  const marker = readPreviewWebProjectionMarker(repositoryRoot);
  if (marker?.generation !== state.generation) {
    throw new Error("Preview failure cleanup refuses a different projection generation.");
  }
  const publishedState = readPreviewStateCandidate(stateFile);
  if (
    publishedState.status === "malformed" ||
    (publishedState.status === "valid" &&
      publishedState.state?.generation !== state.generation)
  ) {
    throw new Error("Preview failure cleanup refuses malformed or different lifecycle state.");
  }
  const serviceStates = readPreviewServiceStates(state.serviceStatePath, state.generation);
  let groups = collectRecordedPreviewProcessGroups(
    repositoryRoot,
    state,
    serviceStates,
  );
  const rootGroup = groups.find(({ record }) => record.pid === state.rootProcess.pid);
  if (rootGroup) await stopProcessGroups([rootGroup], 30_000);
  groups = collectRecordedPreviewProcessGroups(repositoryRoot, state, serviceStates);
  const survivors = await stopProcessGroups(groups);
  if (survivors.length > 0) {
    throw new Error(
      `Preview listener process groups survived failed-launch cleanup: ${survivors.map(({ groupId }) => groupId).join(", ")}`,
    );
  }
  assertNoForeignPreviewListeners(state.ports, groups);
  const occupied = await waitForPreviewPortsFree(state.ports, 15_000);
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
const previewGeneration = randomUUID();
let lifecycleLock;
try {
  lifecycleLock = acquirePreviewLifecycleLock(lifecycleLockFile, {
    operation: "preview-up",
    generation: previewGeneration,
    generationFiles: [stateFile, previewWebProjectionMarkerPath(repositoryRoot)],
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
let projectionPrepared = false;
let statePublished = false;
function releaseLifecycleLock() {
  if (!lifecycleLock) return;
  const heldLock = lifecycleLock;
  lifecycleLock = null;
  heldLock.release();
}
process.once("exit", () => {
  if (projectionPrepared && !statePublished) {
    try {
      removePreviewWebRoot(repositoryRoot, previewGeneration);
    } catch (error) {
      console.error(
        `Preview pre-publication projection cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    releaseLifecycleLock();
  } catch (error) {
    console.error(
      `Preview lifecycle lock release failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
if (fs.existsSync(stateFile)) {
  fail(`Preview state already exists at ${stateFile}; run scripts/preview-down.mjs first.`);
}

const ambientEnvironment = { ...process.env };
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
fs.mkdirSync(path.join(stateRoot, "home"), { recursive: true, mode: 0o700 });
preparePreviewEngineHome(stateRoot);

replaceProcessEnvironment(
  allowlistedPreviewEnvironment(ambientEnvironment, {
    HOME: path.join(stateRoot, "home"),
    ARCHON_HOME: previewEngineHome(stateRoot),
    KADY_PREVIEW: "1",
  }),
);
prepareVendoredDist({
  skipBuild: process.argv.includes("--no-build-dist"),
  environment: previewPrebuildEnvironment(process.env),
});

const ports = {
  backend: portOption("--backend-port", Number(ambientEnvironment.KADY_PORT || 18000)),
  frontend: portOption(
    "--frontend-port",
    Number(ambientEnvironment.KADY_FRONTEND_PORT || 13000),
  ),
  engine: portOption(
    "--engine-port",
    Number(
      ambientEnvironment.KADY_PIPELINE_ENGINE_PORT ||
        ambientEnvironment.KADY_ARCHON_PORT ||
        13091,
    ),
  ),
};
if (!ambientEnvironment.KADY_PIPELINE_ENGINE_PORT && ambientEnvironment.KADY_ARCHON_PORT) {
  console.warn(
    "[deprecated] KADY_ARCHON_PORT is deprecated; use KADY_PIPELINE_ENGINE_PORT instead.",
  );
}
if (new Set(Object.values(ports)).size !== 3) fail("Preview ports must be distinct.");

const initiallyOccupied = await waitForPreviewPortsFree(ports, 15_000);
if (initiallyOccupied.length > 0) {
  fail(
    `Preview ports are still occupied after the startup free-port barrier: ${formatOccupiedPorts(initiallyOccupied)}`,
  );
}

const realNpm = commandPath("npm");
const realGit = commandPath("git");
const { launchRoot, shimDirectory } = createLaunchOverlay(
  stateRoot,
  realNpm,
  realGit,
  previewGeneration,
  ports,
);
projectionPrepared = true;
const environment = previewEnvironment(
  stateRoot,
  launchRoot,
  shimDirectory,
  ports,
  ambientEnvironment,
  previewGeneration,
);
replaceProcessEnvironment(environment);
const logPath = path.join(stateRoot, "preview.log");
const serviceStatePath = environment.KADY_PREVIEW_SERVICE_STATE_FILE;
fs.writeFileSync(serviceStatePath, `${JSON.stringify({
  version: 2,
  generation: previewGeneration,
  services: {},
}, null, 2)}\n`, {
  mode: 0o600,
});

let rootProcess;
let lifecycleState;
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
  const rootIdentity = previewPidStartIdentity(rootProcess.pid);
  const rootProcessRecord = {
    pid: rootProcess.pid,
    pgid: processGroupId(rootProcess.pid),
    identity: rootIdentity,
    generation: previewGeneration,
  };
  lifecycleState = {
    version: 2,
    generation: previewGeneration,
    repositoryRoot,
    stateRoot,
    launchRoot,
    projectsRoot: environment.KADY_PROJECTS_ROOT,
    piAgentDirectory: environment.PI_CODING_AGENT_DIR,
    workflowSupervisorDirectory: environment.KADY_WORKFLOW_SUPERVISOR_DIR,
    serviceStatePath,
    rootProcess: rootProcessRecord,
    ports,
    logPath,
    startedAt: new Date().toISOString(),
  };
  updatePreviewWebProjectionMarker(repositoryRoot, previewGeneration, {
    rootProcess: rootProcessRecord,
    serviceStatePath,
  });
  publishPreviewStateFile(stateFile, lifecycleState);
  statePublished = true;
  const gateFile = environment.KADY_PREVIEW_START_GATE_FILE;
  const gateDescriptor = fs.openSync(gateFile, "wx", 0o600);
  fs.writeFileSync(gateDescriptor, `${previewGeneration}\n`);
  fs.fsyncSync(gateDescriptor);
  fs.closeSync(gateDescriptor);

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
        url: `http://127.0.0.1:${ports.frontend}/api/preview-health`,
        timeoutMs: 180_000,
        expectedGeneration: previewGeneration,
      },
      {
        role: "pipeline-engine",
        label: "workflow engine",
        url: `http://127.0.0.1:${ports.engine}/api/health`,
        timeoutMs: 120_000,
      },
    ],
    expectedGeneration: previewGeneration,
    validateReady: (serviceStates) => {
      for (const role of ["backend", "frontend", "pipeline-engine"]) {
        if (!serviceStates[role]) {
          throw new Error(`Preview readiness lacks generation-bound ${role} process state.`);
        }
      }
      const liveGroups = collectRecordedPreviewProcessGroups(
        repositoryRoot,
        lifecycleState,
        serviceStates,
      );
      const livePids = new Set(liveGroups.map(({ record }) => record.pid));
      for (const record of [lifecycleState.rootProcess, ...Object.values(serviceStates)]) {
        if (!livePids.has(record.pid)) {
          throw new Error(
            `Preview readiness process PID ${record.pid} is no longer live for generation ${previewGeneration}.`,
          );
        }
      }
    },
  });

  releaseLifecycleLock();
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
  if (lifecycleState) {
    try {
      await stopFailedLaunch(lifecycleState);
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
