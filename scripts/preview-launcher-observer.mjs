import fs from "node:fs";

const OBSERVER_HELPER_ANCHOR = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";
const SERVICE_SPAWN_ANCHOR = `  registerChild(child, role);
  if (role === "backend") {`;
const SERVICE_EXIT_ANCHOR = `  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", () => {`;
const ENGINE_SPAWN_ANCHOR = `  registerChild(child, "pipeline-engine");
  let childExited = false;
  const trackEarlyExit = () => {
    childExited = true;
  };`;
const SUPERVISOR_OWNERSHIP_ANCHOR =
  "      const result = recordSupervisorOwnership(forcedSupervisorOwners, message.pid, identity);";

export function previewStartGateMatches(
  gateFile,
  generation,
  readFile = (file) => fs.readFileSync(file, "utf8"),
) {
  try {
    return readFile(gateFile) === `${generation}\n`;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// recordSupervisorOwnership() returns exactly one of "unverifiable",
// "recorded", "unchanged", or "identity-changed-retired"
// (scripts/vendored-dist-environment.mjs:329-344). Only the two results that
// leave the launcher owning that PID may name it in the preview service
// record: "identity-changed-retired" means the OS reused the PID and the
// launcher deliberately disowned it, and "unverifiable" means no identity was
// captured at all.
export function previewSupervisorOwnershipRecordable(ownershipResult) {
  return ownershipResult === "recorded" || ownershipResult === "unchanged";
}

export function recordPreviewChildOrKill(
  child,
  recordChild,
  signalProcess = process.kill,
) {
  try {
    recordChild();
  } catch (error) {
    try {
      signalProcess(-child.pid, "SIGKILL");
    } catch {
      try { signalProcess(child.pid, "SIGKILL"); } catch {}
    }
    throw error;
  }
}

const OBSERVER_HELPER = `

// The hermetic preview overlay sets this path. The repository launcher stays
// unchanged; only its disposable copy records direct service process events.
const previewServiceStateFile = process.env.KADY_PREVIEW_SERVICE_STATE_FILE;
const previewGeneration = process.env.KADY_PREVIEW_GENERATION;
const previewStartGateFile = process.env.KADY_PREVIEW_START_GATE_FILE;
if (previewStartGateFile) {
  if (!previewGeneration) fail("Preview launcher gate requires KADY_PREVIEW_GENERATION.");
  const gateDeadline = Date.now() + 30_000;
  while (!previewStartGateMatches(previewStartGateFile, previewGeneration) && Date.now() < gateDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!previewStartGateMatches(previewStartGateFile, previewGeneration)) {
    fail(\`Preview launcher gate timed out waiting for exact generation \${previewGeneration}.\`);
  }
}

function previewProcessIdentity(pid) {
  if (process.platform === "linux") {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const statText = fs.readFileSync(\`/proc/\${pid}/stat\`, "utf8");
    const closingParenthesis = statText.lastIndexOf(")");
    const fieldsFromState = statText.slice(closingParenthesis + 2).trim().split(/\\s+/);
    const startTime = fieldsFromState[19];
    if (!bootId || !/^\\d+$/.test(startTime ?? "")) {
      throw new Error(\`Could not parse proc-stat identity for preview service PID \${pid}.\`);
    }
    return { method: "proc-stat", value: \`\${bootId}:\${startTime}\` };
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  const value = result.stdout?.trim();
  if (result.status !== 0 || !value) {
    throw new Error(\`Could not resolve ps-lstart-utc identity for preview service PID \${pid}.\`);
  }
  return { method: "ps-lstart-utc", value };
}

function recordPreviewServiceState(role, pid, state, exitCode = null, signal = null, details = {}) {
  if (!previewServiceStateFile) return;
  if (!previewGeneration) throw new Error("Preview service state requires a generation.");
  let current = { version: 2, generation: previewGeneration, services: {} };
  try {
    current = JSON.parse(fs.readFileSync(previewServiceStateFile, "utf-8"));
  } catch {
    // The preview owns this new state file; an absent initial file is safe.
  }
  if (current.generation !== previewGeneration) {
    throw new Error("Preview service state generation changed during launcher execution.");
  }
  current.services ??= {};
  const previous = current.services[role];
  if (state === "spawned" && previous?.pid === pid && previous.state === "exited") return;
  current.services[role] = {
    role,
    pid,
    pgid: pid,
    identity: details.identity ?? (state === "spawned"
      ? previewProcessIdentity(pid)
      : current.services[role]?.identity),
    generation: previewGeneration,
    state,
    exitCode,
    signal,
    ...details,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = \`\${previewServiceStateFile}.\${process.pid}.tmp\`;
  const descriptor = fs.openSync(temporaryPath, "w", 0o600);
  fs.writeFileSync(descriptor, \`\${JSON.stringify(current, null, 2)}\\n\`);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  fs.renameSync(temporaryPath, previewServiceStateFile);
  const directoryDescriptor = fs.openSync(path.dirname(previewServiceStateFile), "r");
  fs.fsyncSync(directoryDescriptor);
  fs.closeSync(directoryDescriptor);
}
function recordPreviewEngineExit(child, exitCode, signal) {
  recordPreviewServiceState(child.kadyRole, child.pid, "exited", exitCode, signal);
}

// Both statements run while the child is still SIGSTOPped: the durable spawn
// record and the permanent exit recorder are installed before the child can
// make progress, and a failed record kills the stopped group. The body is
// deliberately at two-space indentation — the generated adjacency of these two
// lines is what the launcher-observer regression asserts.
function recordSpawnedPreviewServiceOrKill(child) {
  recordPreviewChildOrKill(child, () => {
  recordPreviewServiceState(child.kadyRole, child.pid, "spawned");
  child.on("exit", (exitCode, signal) => recordPreviewEngineExit(child, exitCode, signal));
  });
}`;

function replaceExactlyOnce(source, anchor, replacement, label) {
  const firstIndex = source.indexOf(anchor);
  if (firstIndex === -1 || source.indexOf(anchor, firstIndex + anchor.length) !== -1) {
    throw new Error(`Could not instrument the preview launcher ${label}; expected one stable anchor.`);
  }
  return source.replace(anchor, replacement);
}

export function instrumentPreviewLauncher(source) {
  let instrumented = replaceExactlyOnce(
    source,
    OBSERVER_HELPER_ANCHOR,
    `${OBSERVER_HELPER_ANCHOR}\n${previewStartGateMatches.toString()}\n${previewSupervisorOwnershipRecordable.toString()}\n${recordPreviewChildOrKill.toString()}${OBSERVER_HELPER}`,
    "observer helper",
  );
  // registerChild() is the launcher's synchronous ownership registration, so
  // stopping the child there closes the same spawn window the lifecycle lane
  // documented: the service cannot make progress before its generation-bound
  // record exists, and a failed record kills the stopped group.
  instrumented = replaceExactlyOnce(
    instrumented,
    SERVICE_SPAWN_ANCHOR,
    `  registerChild(child, role);
  if (previewServiceStateFile) process.kill(child.pid, "SIGSTOP");
  recordSpawnedPreviewServiceOrKill(child);
  if (previewServiceStateFile) process.kill(child.pid, "SIGCONT");
  if (role === "backend") {`,
    "backend/frontend service spawn hook",
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    SERVICE_EXIT_ANCHOR,
    `  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", (exitCode, signal) => {
    recordPreviewServiceState(child.kadyRole, child.pid, "exited", exitCode, signal);`,
    "backend/frontend service exit hook",
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    ENGINE_SPAWN_ANCHOR,
    `  registerChild(child, "pipeline-engine");
  if (previewServiceStateFile) process.kill(child.pid, "SIGSTOP");
  recordSpawnedPreviewServiceOrKill(child);
  if (previewServiceStateFile) process.kill(child.pid, "SIGCONT");
  let childExited = false;
  const trackEarlyExit = () => {
    childExited = true;
  };`,
    "workflow-engine spawn hook",
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    SUPERVISOR_OWNERSHIP_ANCHOR,
    `${SUPERVISOR_OWNERSHIP_ANCHOR}
      // The preview record may name only a supervisor PID the launcher still
      // owns; a retired (reused) PID stays out of the teardown set.
      if (previewSupervisorOwnershipRecordable(result)) {
        recordPreviewServiceState(
          "workflow-supervisor",
          message.pid,
          "spawned",
          null,
          null,
          { identity },
        );
      }`,
    "workflow-supervisor ownership hook",
  );
  return instrumented;
}
