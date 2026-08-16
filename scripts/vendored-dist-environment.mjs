const sensitiveEnvironmentNamePattern =
  /(?:^|_)(?:API_KEY|AUTH[^_]*|CREDENTIALS?|KEY|PASSWORD|PAT|SECRET|TOKEN)(?:_|$)/i;
const usableStaleStatuses = new Set([
  "stale-inputs",
  "stale-git-head",
  "stale-build-env",
  "stale-dependencies",
]);

export function scrubSensitiveEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !sensitiveEnvironmentNamePattern.test(name) && !name.startsWith("GIT_CONFIG_"),
    ),
  );
}

export function previewVendoredDistEnvironment(
  stateRoot,
  shimDirectory,
  enginePort,
  ambientEnvironment = process.env,
) {
  const environment = {
    HOME: path.join(stateRoot, "home"),
    PATH: `${shimDirectory}${path.delimiter}${ambientEnvironment.PATH ?? ""}`,
    NODE_ENV: ambientEnvironment.NODE_ENV ?? "production",
    PORT: String(enginePort),
    TMPDIR: path.join(stateRoot, "tmp"),
  };
  for (const name of ["LANG", "CI"]) {
    if (ambientEnvironment[name] !== undefined) environment[name] = ambientEnvironment[name];
  }
  return environment;
}

export function classifyVendoredDistAfterBuildFailure(checkResult) {
  // These statuses are emitted only after the checker has verified every
  // recorded output and index.html asset reference. All other failures mean
  // there is no bundle the launcher can safely serve.
  return usableStaleStatuses.has(checkResult?.status) ? "serve-stale" : "skip-engine";
}

export function classifyWorkflowEngineListener({
  listenerPids,
  isOwnedByCheckout,
  healthOk,
  distStatus,
}) {
  if (listenerPids.length === 0) return { action: "start", pidsToStop: [] };
  const foreignPid = listenerPids.find((pid) => !isOwnedByCheckout(pid));
  if (foreignPid !== undefined) {
    return { action: "skip-foreign", foreignPid, pidsToStop: [] };
  }
  if (healthOk && distStatus?.ok) {
    return { action: "reuse-owned-fresh", pidsToStop: [] };
  }
  return { action: "restart-owned", pidsToStop: [...listenerPids] };
}

export function classifyWorkflowEngineBuildOutcome(buildExitCode, checkResult) {
  if (buildExitCode === 0) return "start";
  return classifyVendoredDistAfterBuildFailure(checkResult) === "serve-stale"
    ? "warn-continue"
    : "skip-engine";
}
import path from "node:path";
