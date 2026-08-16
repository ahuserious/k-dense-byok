#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExplicitPreviewLockRecoverySafe,
  listenersOnPort,
  processesHoldingFile,
  quiescePreviewGeneration,
} from "./preview-processes.mjs";
import {
  readPreviewServiceStateSnapshot,
} from "./preview-readiness.mjs";
import {
  acquirePreviewLifecycleLock,
  previewTeardownRecord,
  readPreviewStateCandidate,
  recoverUnrecognizedPreviewLifecycleLock,
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
const recoverLock = process.argv.includes("--recover-lock");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateLifecycleRecord(state, source) {
  const allowedTemporaryRoots = [os.tmpdir(), "/tmp"].map((candidate) =>
    fs.realpathSync(candidate),
  );
  if (!state?.rootProcess) {
    fail(
      `${source} has no generation-bound launcher process; refusing recovery. ` +
        "Inspect the recorded ports and stop only processes whose PID identity you can independently prove, then remove the stale projection.",
    );
  }
  if (
    state.version !== 2 ||
    typeof state.generation !== "string" ||
    !state.generation ||
    state.repositoryRoot !== repositoryRoot ||
    !state.rootProcess ||
    !Number.isSafeInteger(state.rootProcess.pid) ||
    state.rootProcess.pid < 1 ||
    !Number.isSafeInteger(state.rootProcess.pgid) ||
    state.rootProcess.pgid < 1 ||
    state.rootProcess.generation !== state.generation ||
    !state.rootProcess.identity ||
    typeof state.rootProcess.identity.method !== "string" ||
    typeof state.rootProcess.identity.value !== "string" ||
    typeof state.serviceStatePath !== "string" ||
    path.resolve(state.serviceStatePath) !== path.join(path.resolve(state.stateRoot), "services.json") ||
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
    ),
    recoveredFromMarker: selected.recoveredFromMarker,
  };
}

function printListenerProof(state) {
  console.log("Preview listener verification:");
  let total = 0;
  for (const [role, port] of Object.entries(state.ports)) {
    const listeners = listenersOnPort(port);
    total += listeners.length;
    console.log(`  ${role} :${port}: ${listeners.length}${listeners.length ? ` (${listeners.join(", ")})` : ""}`);
  }
  console.log(`Remaining listeners on preview ports: ${total}`);
  return total;
}

function explicitLockRecoveryEvidence() {
  const candidate = readPreviewStateCandidate(stateFile);
  let marker = null;
  try {
    marker = readPreviewWebProjectionMarker(repositoryRoot);
  } catch (error) {
    throw new Error(
      `Explicit preview lock recovery cannot read the projection marker: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (candidate.status === "malformed" && !marker) {
    throw new Error(
      `Explicit preview lock recovery cannot prove recorded ports or processes because ${stateFile} is malformed and no projection marker exists.`,
    );
  }
  if (
    candidate.status === "valid" &&
    marker &&
    candidate.state?.generation !== marker.generation
  ) {
    throw new Error(
      `Explicit preview lock recovery refuses conflicting state generation ${candidate.state?.generation ?? "<missing>"} and marker generation ${marker.generation}.`,
    );
  }
  const source = candidate.status === "valid" ? candidate.state : marker;
  const generation = typeof source?.generation === "string" ? source.generation : null;
  if (source && !generation) {
    throw new Error("Explicit preview lock recovery cannot prove a generation from lifecycle artifacts.");
  }
  const ports = source?.ports && typeof source.ports === "object" ? source.ports : {};
  if (source && Object.keys(ports).length === 0) {
    throw new Error("Explicit preview lock recovery cannot prove preview ports from lifecycle artifacts.");
  }
  const records = [];
  const lifecycleSources = [source];
  if (candidate.status === "valid" && marker) lifecycleSources.push(marker);
  for (const lifecycleSource of lifecycleSources) {
    if (lifecycleSource?.rootProcess) records.push(lifecycleSource.rootProcess);
    const serviceStatePath = lifecycleSource?.serviceStatePath;
    if (lifecycleSource && typeof serviceStatePath !== "string") {
      throw new Error(
        "Explicit preview lock recovery cannot prove service processes without a recorded service-state path.",
      );
    }
    if (generation && typeof serviceStatePath === "string") {
      const serviceSnapshot = readPreviewServiceStateSnapshot(serviceStatePath, generation);
      if (serviceSnapshot.status !== "valid") {
        throw new Error(
          `Explicit preview lock recovery cannot prove service processes because ${serviceStatePath} is ${serviceSnapshot.status}.`,
        );
      }
      records.push(...Object.values(serviceSnapshot.services));
    }
  }
  return {
    candidate,
    marker,
    generation,
    ports,
    records,
  };
}

if (process.platform === "win32") {
  fail("The preview lifecycle currently requires POSIX process-group semantics.");
}

if (recoverLock) {
  let evidence;
  try {
    evidence = explicitLockRecoveryEvidence();
    const recovered = recoverUnrecognizedPreviewLifecycleLock(lifecycleLockFile, {
      verifySafeRecovery: () => assertExplicitPreviewLockRecoverySafe({
        lockFile: lifecycleLockFile,
        lockHolderPids: processesHoldingFile(lifecycleLockFile),
        records: evidence.records,
        generation: evidence.generation,
        ports: evidence.ports,
      }),
    });
    if (!recovered) console.log(`No preview lifecycle lock exists at ${lifecycleLockFile}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (evidence.candidate.status === "missing" && !evidence.marker) {
    console.log("No preview state or projection remains after explicit lock recovery.");
    process.exit(0);
  }
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
try {
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
} catch (error) {
  fail(
    `${error instanceof Error ? error.message : String(error)} ` +
      "Preview state and the temporary tree were retained. Stop only the named generation-bound survivor or foreign listener, then rerun preview-down.",
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
