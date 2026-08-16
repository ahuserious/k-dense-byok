const sensitiveEnvironmentNamePattern = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const usableStaleStatuses = new Set([
  "stale-inputs",
  "stale-git-head",
  "stale-build-env",
]);

export function scrubSensitiveEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !sensitiveEnvironmentNamePattern.test(name)),
  );
}

export function classifyVendoredDistAfterBuildFailure(checkResult) {
  // These statuses are emitted only after the checker has verified every
  // recorded output and index.html asset reference. All other failures mean
  // there is no bundle the launcher can safely serve.
  return usableStaleStatuses.has(checkResult?.status) ? "serve-stale" : "skip-engine";
}
