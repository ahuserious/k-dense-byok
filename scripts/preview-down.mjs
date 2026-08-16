#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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
import {
  acquirePreviewLifecycleLock,
  previewTeardownRecord,
  readPreviewStateCandidate,
  removePreviewStateFile,
} from "./preview-state.mjs";
import {
  previewWebProjectionMarkerPath,
  readPreviewWebProjectionMarker,
  removePreviewWebRoot,
} from "./preview-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const stateFile = path.join(repositoryRoot, "deploy", "preview", ".state.json");
const lifecycleLockFile = path.join(repositoryRoot, "deploy", "preview", ".lifecycle.lock");
const keepState = process.argv.includes("--keep-state");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateLifecycleRecord(state, source, { requireRootPid }) {
  const allowedTemporaryRoots = [os.tmpdir(), "/tmp"].map((candidate) =>
    fs.realpathSync(candidate),
  );
  if (
    state.version !== 1 ||
    typeof state.generation !== "string" ||
    !state.generation ||
    state.repositoryRoot !== repositoryRoot ||
    (requireRootPid && (!Number.isSafeInteger(state.rootPid) || state.rootPid < 1)) ||
    (state.rootPid !== null && state.rootPid !== undefined &&
      (!Number.isSafeInteger(state.rootPid) || state.rootPid < 1)) ||
    typeof state.stateRoot !== "string" ||
    typeof state.launchRoot !== "string" ||
    !state.ports ||
    Object.values(state.ports).some(
      (port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535,
    ) ||
    !path.resolve(state.launchRoot).startsWith(`${path.resolve(state.stateRoot)}${path.sep}`)
  ) {
    fail(`${source} failed ownership validation; refusing teardown.`);
  }
  const resolvedStateRoot = fs.existsSync(state.stateRoot)
    ? fs.realpathSync(state.stateRoot)
    : path.resolve(state.stateRoot);
  if (
    !path.basename(resolvedStateRoot).startsWith("kady-preview-") ||
    !allowedTemporaryRoots.includes(fs.realpathSync(path.dirname(resolvedStateRoot)))
  ) {
    fail(`${source} root is not an owned temporary directory; refusing teardown.`);
  }
  return state;
}

function peekLifecycleGeneration() {
  const candidate = readPreviewStateCandidate(stateFile);
  if (candidate.status === "valid" && typeof candidate.state?.generation === "string") {
    return candidate.state.generation;
  }
  try {
    return readPreviewWebProjectionMarker(repositoryRoot)?.generation ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

function readStateOrProjectionRecovery() {
  let marker;
  try {
    marker = readPreviewWebProjectionMarker(repositoryRoot);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  let selected;
  try {
    selected = previewTeardownRecord(stateFile, marker);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)} ` +
        "If preview processes remain, stop only the processes you can independently prove belong to this checkout, then remove the malformed state file.",
    );
  }
  if (selected.recoveredFromMarker) {
    console.warn(
      `Preview state is ${selected.stateStatus}; recovering teardown from projection generation ${selected.state.generation}.`,
    );
  }
  return {
    state: validateLifecycleRecord(
      selected.state,
      selected.recoveredFromMarker ? "Preview projection marker" : "Preview state",
      { requireRootPid: !selected.recoveredFromMarker },
    ),
    recoveredFromMarker: selected.recoveredFromMarker,
  };
}

function assertRootOwnership(state) {
  if (!state.rootPid) return;
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

let lifecycleLock;
try {
  lifecycleLock = acquirePreviewLifecycleLock(lifecycleLockFile, {
    operation: "preview-down",
    generation: peekLifecycleGeneration(),
    generationFiles: [stateFile, previewWebProjectionMarkerPath(repositoryRoot)],
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
function releaseLifecycleLock() {
  if (!lifecycleLock) return;
  const heldLock = lifecycleLock;
  lifecycleLock = null;
  heldLock.release();
}
process.once("exit", () => {
  try {
    releaseLifecycleLock();
  } catch (error) {
    console.error(
      `Preview lifecycle lock release failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

const { state, recoveredFromMarker } = readStateOrProjectionRecovery();
assertRootOwnership(state);
let listenerGroups;
try {
  listenerGroups = collectPreviewListenerGroups(repositoryRoot, state.ports);
} catch (error) {
  fail(
    `${error instanceof Error ? error.message : String(error)} ` +
      "Stop the unrelated listener or restore a matching lifecycle state, then rerun preview-down.",
  );
}

if (state.rootPid && processGroupAlive(state.rootPid)) {
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

if (removePreviewWebRoot(repositoryRoot, state.generation)) {
  console.log(`Removed preview web projection: ${path.join(repositoryRoot, "web", ".preview")}`);
}

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
if (recoveredFromMarker) {
  console.log(`Recovered teardown from projection marker generation ${state.generation}.`);
}
releaseLifecycleLock();
