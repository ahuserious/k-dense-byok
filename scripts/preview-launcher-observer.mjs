const OBSERVER_HELPER_ANCHOR = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";
const SERVICE_EXIT_ANCHOR = `  children.push(child);
  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", () => {`;
const ENGINE_SPAWN_ANCHOR = `  children.push(child);
  let childExited = false;
  const trackEarlyExit = () => {
    childExited = true;
  };`;
const ENGINE_EXIT_ANCHOR = `  child.on("exit", () => {
    if (shuttingDown) return;`;

const OBSERVER_HELPER = `

// The hermetic preview overlay sets this path. The repository launcher stays
// unchanged; only its disposable copy records direct service process events.
const previewServiceStateFile = process.env.KADY_PREVIEW_SERVICE_STATE_FILE;
function recordPreviewServiceState(role, pid, state, exitCode = null, signal = null) {
  if (!previewServiceStateFile) return;
  let current = { version: 1, services: {} };
  try {
    current = JSON.parse(fs.readFileSync(previewServiceStateFile, "utf-8"));
  } catch {
    // The preview owns this new state file; an absent initial file is safe.
  }
  current.services ??= {};
  current.services[role] = {
    role,
    pid,
    state,
    exitCode,
    signal,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = \`\${previewServiceStateFile}.\${process.pid}.tmp\`;
  fs.writeFileSync(temporaryPath, \`\${JSON.stringify(current, null, 2)}\\n\`, { mode: 0o600 });
  fs.renameSync(temporaryPath, previewServiceStateFile);
}
function recordPreviewEngineExit(child, exitCode, signal) {
  recordPreviewServiceState(child.kadyRole, child.pid, "exited", exitCode, signal);
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
  recordPreviewServiceState(child.kadyRole, child.pid, "spawned");
  // Fires for both exit-code and signal deaths, during boot and after.
  child.on("exit", (exitCode, signal) => {
    recordPreviewServiceState(child.kadyRole, child.pid, "exited", exitCode, signal);`,
    "backend/frontend service hook",
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    ENGINE_SPAWN_ANCHOR,
    `  children.push(child);
  recordPreviewServiceState(child.kadyRole, child.pid, "spawned");
  let childExited = false;
  const trackEarlyExit = (exitCode, signal) => {
    childExited = true;
    recordPreviewEngineExit(child, exitCode, signal);
  };`,
    "workflow-engine spawn hook",
  );
  return replaceExactlyOnce(
    instrumented,
    ENGINE_EXIT_ANCHOR,
    `  child.on("exit", (exitCode, signal) => {
    recordPreviewEngineExit(child, exitCode, signal);
    if (shuttingDown) return;`,
    "workflow-engine exit hook",
  );
}
