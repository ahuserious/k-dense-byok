#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const stateFile = path.join(repositoryRoot, "deploy", "preview", ".state.json");
const keepState = process.argv.includes("--keep-state");
const processPatterns = [
  "kady-workflow-supervisor",
  "tsx/dist/preflight.cjs",
  "vendor/pipeline-engine",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readState() {
  if (!fs.existsSync(stateFile)) fail(`No preview state found at ${stateFile}.`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const allowedTemporaryRoots = [os.tmpdir(), "/tmp"].map((candidate) =>
    fs.realpathSync(candidate),
  );
  if (
    state.version !== 1 ||
    state.repositoryRoot !== repositoryRoot ||
    !Number.isSafeInteger(state.rootPid) ||
    state.rootPid < 1 ||
    typeof state.stateRoot !== "string" ||
    typeof state.launchRoot !== "string" ||
    !path.resolve(state.launchRoot).startsWith(`${path.resolve(state.stateRoot)}${path.sep}`)
  ) {
    fail("Preview state failed ownership validation; refusing teardown.");
  }
  const resolvedStateRoot = fs.realpathSync(state.stateRoot);
  if (
    !path.basename(resolvedStateRoot).startsWith("kady-preview-") ||
    !allowedTemporaryRoots.includes(path.dirname(resolvedStateRoot))
  ) {
    fail("Preview state root is not an owned temporary directory; refusing teardown.");
  }
  return state;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
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

function processWorkingDirectory(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return "";
  return result.stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1) ?? "";
}

function assertRootOwnership(state) {
  if (!processAlive(state.rootPid)) return;
  const workingDirectory = processWorkingDirectory(state.rootPid);
  if (workingDirectory !== state.launchRoot) {
    fail(
      `PID ${state.rootPid} no longer belongs to the preview launch root; refusing to signal it.`,
    );
  }
}

async function waitFor(test, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (test() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !test();
}

function pgrep(pattern) {
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf-8" });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`pgrep failed for ${pattern}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

function processCommandAndEnvironment(pid) {
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`ps could not inspect candidate PID ${pid}; refusing a false-zero proof.`);
  }
  return result.stdout;
}

function scopedMatches(state, pattern) {
  const scopeMarkers = [
    state.stateRoot,
    state.launchRoot,
    state.projectsRoot,
    state.piAgentDirectory,
    state.workflowSupervisorDirectory,
  ];
  return pgrep(pattern).filter((pid) => {
    const processDescription = processCommandAndEnvironment(pid);
    return scopeMarkers.some((marker) => marker && processDescription.includes(marker));
  });
}

function printPgrepProof(state) {
  console.log("Scoped pgrep verification:");
  let total = 0;
  for (const pattern of processPatterns) {
    const matches = scopedMatches(state, pattern);
    total += matches.length;
    console.log(`  ${pattern}: ${matches.length}${matches.length ? ` (${matches.join(", ")})` : ""}`);
  }
  console.log(`Owned preview processes: ${total}`);
  return total;
}

if (process.platform === "win32") {
  fail("The preview lifecycle currently requires POSIX process-group and pgrep semantics.");
}

const state = readState();
assertRootOwnership(state);

if (processGroupAlive(state.rootPid)) {
  process.kill(-state.rootPid, "SIGTERM");
  if (!(await waitFor(() => processGroupAlive(state.rootPid), 90_000))) {
    console.warn("Graceful shutdown did not finish; sending the launcher's second force signal.");
    process.kill(-state.rootPid, "SIGTERM");
    if (!(await waitFor(() => processGroupAlive(state.rootPid), 15_000))) {
      fail("Preview launcher process group survived its owned-tree shutdown.");
    }
  }
}

let remaining;
try {
  remaining = printPgrepProof(state);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (remaining !== 0) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  remaining = printPgrepProof(state);
}
if (remaining !== 0) fail("Owned preview processes remain after teardown.");

fs.rmSync(stateFile, { force: true });
if (!keepState) {
  fs.rmSync(state.stateRoot, { recursive: true, force: true });
  console.log(`Removed preview state tree: ${state.stateRoot}`);
} else {
  console.log(`Preserved preview state tree: ${state.stateRoot}`);
}
