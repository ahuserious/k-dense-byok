const OBSERVER_HELPER_ANCHOR = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";
const SERVICE_EXIT_ANCHOR = `  children.push(child);
  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", () => {`;
const ENGINE_EXIT_ANCHOR = `  children.push(child);
  // Unlike the backend/frontend, an engine death is a degradation, not a
  // launcher failure: the /pipelines proxy answers 503 while it is down.
  child.on("exit", () => {`;

const OBSERVER_HELPER = `

// The hermetic preview overlay sets this path. The repository launcher stays
// unchanged; only its disposable copy records direct service process events.
const previewServiceStateFile = process.env.KADY_PREVIEW_SERVICE_STATE_FILE;
const previewGeneration = process.env.KADY_PREVIEW_GENERATION;
const previewStartGateFile = process.env.KADY_PREVIEW_START_GATE_FILE;
if (previewStartGateFile) {
  if (!previewGeneration) fail("Preview launcher gate requires KADY_PREVIEW_GENERATION.");
  const gateDeadline = Date.now() + 30_000;
  while (!fs.existsSync(previewStartGateFile) && Date.now() < gateDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!fs.existsSync(previewStartGateFile)) {
    fail(\`Preview launcher gate timed out for generation \${previewGeneration}.\`);
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

function recordPreviewServiceState(role, pid, state, exitCode = null, signal = null) {
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
  current.services[role] = {
    role,
    pid,
    pgid: pid,
    identity: state === "spawned"
      ? previewProcessIdentity(pid)
      : current.services[role]?.identity,
    generation: previewGeneration,
    state,
    exitCode,
    signal,
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
    `${OBSERVER_HELPER_ANCHOR}${OBSERVER_HELPER}`,
    "observer helper",
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    SERVICE_EXIT_ANCHOR,
    `  children.push(child);
  if (previewServiceStateFile) process.kill(child.pid, "SIGSTOP");
  recordPreviewServiceState(child.kadyRole, child.pid, "spawned");
  if (previewServiceStateFile) process.kill(child.pid, "SIGCONT");
  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", (exitCode, signal) => {
    recordPreviewServiceState(child.kadyRole, child.pid, "exited", exitCode, signal);`,
    "backend/frontend service hook",
  );
  return replaceExactlyOnce(
    instrumented,
    ENGINE_EXIT_ANCHOR,
    `  children.push(child);
  if (previewServiceStateFile) process.kill(child.pid, "SIGSTOP");
  recordPreviewServiceState(child.kadyRole, child.pid, "spawned");
  if (previewServiceStateFile) process.kill(child.pid, "SIGCONT");
  // Unlike the backend/frontend, an engine death is a degradation, not a
  // launcher failure: the /pipelines proxy answers 503 while it is down.
  child.on("exit", (exitCode, signal) => {
    recordPreviewServiceState(child.kadyRole, child.pid, "exited", exitCode, signal);`,
    "workflow-engine service hook",
  );
}
