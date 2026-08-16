import path from "node:path";

export function explicitEnvironmentFile(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const configuredPath = environment.KADY_ENV_FILE?.trim();
  if (!configuredPath) return null;
  if (!path.isAbsolute(configuredPath)) {
    throw new Error("KADY_ENV_FILE must be an absolute path.");
  }
  return path.normalize(configuredPath);
}

export function environmentFilePaths(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const standardPaths = [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, "kady_agent", ".env"),
    path.join(repoRoot, "server", ".env"),
  ];
  const configuredPath = explicitEnvironmentFile(environment);
  if (!configuredPath) return standardPaths;
  if (environment.KADY_PREVIEW === "1") return [configuredPath];
  return [configuredPath, ...standardPaths.filter((file) => file !== configuredPath)];
}

export function credentialEnvironmentFilePath(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return explicitEnvironmentFile(environment) ?? path.join(repoRoot, ".env");
}
