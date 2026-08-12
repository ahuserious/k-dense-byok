#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPreviewListenerGroups,
  listenersOnPort,
  processAlive,
  processGroupAlive,
  processWorkingDirectory,
  stopProcessGroups,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";
import { removePreviewStateFile } from "./preview-state.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const stateFile = path.join(repositoryRoot, "deploy", "preview", ".state.json");
const keepState = process.argv.includes("--keep-state");

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

function printListenerProof(state) {
  console.log("Preview listener verification:");
  let total = 0;
  for (const [role, port] of Object.entries(state.ports)) {
    const listeners = listenersOnPort(port);
    total += listeners.length;
    console.log(`  ${role} :${port}: ${listeners.length}${listeners.length ? ` (${listeners.join(", ")})` : ""}`);
  }
  console.log(`Owned preview listeners: ${total}`);
  return total;
}

if (process.platform === "win32") {
  fail("The preview lifecycle currently requires POSIX process-group semantics.");
}

const state = readState();
assertRootOwnership(state);
let listenerGroups;
try {
  listenerGroups = collectPreviewListenerGroups(repositoryRoot, state.ports);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

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

// The launcher owns detached child groups. Capturing groups from the actual
// listeners before shutdown lets us reap a bun wrapper even if its server
// closes the port first or escaped the launcher's normal child accounting.
const refreshedGroups = collectPreviewListenerGroups(repositoryRoot, state.ports);
const groupsById = new Map(
  [...listenerGroups, ...refreshedGroups].map((group) => [group.groupId, group]),
);
const survivingGroups = await stopProcessGroups([...groupsById.values()]);
if (survivingGroups.length > 0) {
  fail(
    `Preview process groups survived teardown: ${survivingGroups.map(({ groupId }) => groupId).join(", ")}`,
  );
}

const occupiedAfterShutdown = await waitForPreviewPortsFree(state.ports, 15_000);
if (occupiedAfterShutdown.length > 0) {
  fail(
    `Preview ports did not become free after teardown: ${occupiedAfterShutdown
      .map(({ role, port, listeners }) => `${role} :${port} (${listeners.join(", ")})`)
      .join("; ")}`,
  );
}

const remaining = printListenerProof(state);
if (remaining !== 0) fail("Preview listeners remain after teardown.");

if (!(await removePreviewStateFile(stateFile))) {
  fail(`Preview lifecycle state did not clear after teardown: ${stateFile}`);
}
console.log(`Removed preview lifecycle state: ${stateFile}`);
if (!keepState) {
  fs.rmSync(state.stateRoot, { recursive: true, force: true });
  console.log(`Removed preview state tree: ${state.stateRoot}`);
} else {
  console.log(`Preserved preview state tree: ${state.stateRoot}`);
}
