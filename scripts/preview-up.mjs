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
  createLaunchOverlay,
  preparePreviewEngineHome,
  preparePreviewWebRoot,
  previewEngineHome,
  previewEnvironment,
  previewPrebuildEnvironment,
  readPreviewWebProjectionMarker,
  removePreviewWebRoot,
  updatePreviewWebProjectionMarker,
} from "./preview-environment.mjs";
import { previewVendoredDistEnvironment } from "./vendored-dist-environment.mjs";
import { vendoredDistBuildEnvironment } from "./vendored-dist-check.mjs";
import {
  processGroupId,
  assertPreviewServiceListenersOwned,
  quiescePreviewGeneration,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";
import {
  assertPreviewReadinessProcessesLive,
  readPreviewServiceStateSnapshot,
  waitForPreviewReadiness,
} from "./preview-readiness.mjs";
import {
  acquirePreviewLifecycleLock,
  previewPidStartIdentity,
  publishPreviewStartGate,
  publishPreviewStateFile,
  readPreviewStateCandidate,
} from "./preview-state.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const previewDirectory = path.join(repositoryRoot, "deploy", "preview");
const vendoredDistManifestFile = path.join(
  repositoryRoot,
  "server",
  "vendor",
  "pipeline-engine",
  "packages",
  "web",
  "dist",
  ".vendored-dist-manifest.json",
);
const stateFile = path.join(previewDirectory, ".state.json");
const lifecycleLockDirectory = path.join(previewDirectory, ".lifecycle.lock.d");
const legacyLifecycleLockFile = path.join(previewDirectory, ".lifecycle.lock");

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

// The preview always checks the bundle with NODE_ENV=production and
// PORT=<engine port>, and the manifest's buildEnv is compared for strict
// equality. A bundle built outside the preview (`npm run build:vendored-dist`
// writes buildEnv {NODE_ENV: null, PORT: null}) can therefore never satisfy
// --no-build-dist. Name both fingerprints and the remedy instead of letting
// the check report a bare "build environment mismatch"; never accept the
// mismatch.
function assertSkipBuildManifestFingerprint(environment) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(vendoredDistManifestFile, "utf-8"));
  } catch {
    // A missing or unreadable manifest is the check's own fail-closed report.
    return;
  }
  const previewBuildEnvironment = vendoredDistBuildEnvironment(environment);
  if (JSON.stringify(manifest?.buildEnv) === JSON.stringify(previewBuildEnvironment)) return;
  throw new Error(
    "--no-build-dist cannot verify this vendored dist: the manifest was built under " +
      `buildEnv ${JSON.stringify(manifest?.buildEnv ?? null)}, but the preview checks it under ` +
      `buildEnv ${JSON.stringify(previewBuildEnvironment)}. ` +
      "Rerun preview-up without --no-build-dist so the bundle is rebuilt under the preview build environment.",
  );
}

function prepareVendoredDist({ skipBuild, environment }) {
  const scriptName = skipBuild ? "vendored-dist-check.mjs" : "vendored-dist-build.mjs";
  const arguments_ = [path.join(scriptDirectory, scriptName)];
  if (!skipBuild) arguments_.push("--if-stale");

  if (skipBuild) {
    console.log("Vendored dist build disabled; verifying the existing bundle.");
    assertSkipBuildManifestFingerprint(environment);
  } else {
    console.log("Preparing the vendored Pipeline Engine web bundle.");
  }
  assertPreviewAutomaticEnvironmentFilesAbsent(repositoryRoot);
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`Could not run ${scriptName}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `Vendored Pipeline Engine web dist preparation failed (exit ${result.status ?? "unknown"}). ` +
        "Run `node scripts/vendored-dist-build.mjs --force` or omit --no-build-dist.",
    );
  }
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
  await quiescePreviewGeneration(
    repositoryRoot,
    state,
    {
      readServiceSnapshot: () => readPreviewServiceStateSnapshot(
        state.serviceStatePath,
        state.generation,
      ),
    },
  );
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
  lifecycleLock = acquirePreviewLifecycleLock(lifecycleLockDirectory, {
    operation: "preview-up",
    generation: previewGeneration,
    legacyLockFiles: [legacyLifecycleLockFile],
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
let projectionPrepared = false;
let statePublished = false;
let preserveFailedLaunchArtifacts = false;
function releaseLifecycleLock() {
  if (!lifecycleLock) return;
  const heldLock = lifecycleLock;
  lifecycleLock = null;
  heldLock.release();
}
process.once("exit", () => {
  if (projectionPrepared && !statePublished && !preserveFailedLaunchArtifacts) {
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

// process.env is replaced by the preview allowlist below, so the ports and the
// deprecated-variable warning are resolved from this pristine copy further down.
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
// prepareVendoredDist() runs further down, once the launch overlay exists: the
// prebuild must use previewVendoredDistEnvironment(), whose PATH (shim first)
// and TMPDIR are exactly what the launcher fingerprints when it re-checks the
// bundle, and a failed build must be cleaned up by the launch failure path.

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
  repositoryRoot,
  stateRoot,
  realNpm,
  realGit,
);
preparePreviewWebRoot(repositoryRoot, launchRoot, previewGeneration, { stateRoot, ports });
projectionPrepared = true;
const environment = previewEnvironment(
  stateRoot,
  launchRoot,
  shimDirectory,
  ports,
  ambientEnvironment,
  previewGeneration,
);
// Same allowlisted ambient values the launcher will see, so the prebuilt
// manifest's build-env fingerprint matches the launcher's re-check exactly.
const vendoredDistEnvironment = previewPrebuildEnvironment(
  previewVendoredDistEnvironment(
    stateRoot,
    shimDirectory,
    ports.engine,
    allowlistedPreviewEnvironment(ambientEnvironment),
  ),
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
  prepareVendoredDist({
    skipBuild: process.argv.includes("--no-build-dist"),
    environment: vendoredDistEnvironment,
  });
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
  publishPreviewStartGate(gateFile, previewGeneration);

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
      // Liveness is asserted only for the launcher's own processes: the root
      // launcher and the three roles it spawns directly. The recorded
      // workflow-supervisor is spawned by the backend, so the launcher never
      // records its exit and a supervisor death would otherwise hold readiness
      // until the service timeouts expire. It stays in the teardown set.
      assertPreviewReadinessProcessesLive(
        repositoryRoot,
        lifecycleState,
        serviceStates,
      );
      assertPreviewServiceListenersOwned(
        ports,
        serviceStates,
        previewGeneration,
      );
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
  } else if (rootProcess?.pid) {
    try {
      process.kill(-rootProcess.pid, "SIGKILL");
    } catch (caught) {
      cleanupError = caught;
    }
  }
  preserveFailedLaunchArtifacts = cleanupError !== null;
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
