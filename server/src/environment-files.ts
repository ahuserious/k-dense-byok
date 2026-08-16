import fs from "node:fs";
import path from "node:path";
import { isWithin } from "./path-containment.ts";

function canonicalExistingPath(
  configuredPath: string,
  environmentName: string,
): string {
  try {
    return fs.realpathSync(configuredPath);
  } catch {
    throw new Error(`${environmentName} must resolve to an existing path.`);
  }
}

export function explicitEnvironmentFile(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const previewMode = environment.KADY_PREVIEW === "1";
  const configuredValue = environment.KADY_ENV_FILE;
  if (!previewMode) {
    if (configuredValue !== undefined) {
      throw new Error("KADY_ENV_FILE is supported only when KADY_PREVIEW=1.");
    }
    return null;
  }

  const configuredPath = configuredValue?.trim();
  if (!configuredPath) {
    throw new Error("KADY_PREVIEW=1 requires an absolute KADY_ENV_FILE.");
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new Error("KADY_PREVIEW=1 requires KADY_ENV_FILE to be absolute.");
  }

  const launchRootValue = environment.KADY_PREVIEW_LAUNCH_ROOT?.trim();
  if (!launchRootValue || !path.isAbsolute(launchRootValue)) {
    throw new Error(
      "KADY_PREVIEW=1 requires an absolute KADY_PREVIEW_LAUNCH_ROOT.",
    );
  }
  const canonicalLaunchRoot = canonicalExistingPath(
    launchRootValue,
    "KADY_PREVIEW_LAUNCH_ROOT",
  );
  if (!fs.statSync(canonicalLaunchRoot).isDirectory()) {
    throw new Error("KADY_PREVIEW_LAUNCH_ROOT must resolve to a directory.");
  }

  const canonicalEnvFile = canonicalExistingPath(configuredPath, "KADY_ENV_FILE");
  if (!fs.statSync(canonicalEnvFile).isFile()) {
    throw new Error("KADY_ENV_FILE must resolve to a regular file.");
  }
  if (
    canonicalEnvFile === canonicalLaunchRoot ||
    !isWithin(canonicalLaunchRoot, canonicalEnvFile)
  ) {
    throw new Error(
      "KADY_ENV_FILE must resolve within KADY_PREVIEW_LAUNCH_ROOT.",
    );
  }
  return canonicalEnvFile;
}

export function environmentFilePaths(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredPath = explicitEnvironmentFile(environment);
  if (environment.KADY_PREVIEW === "1") {
    if (configuredPath === null) {
      throw new Error("KADY_PREVIEW=1 did not resolve KADY_ENV_FILE.");
    }
    return [configuredPath];
  }
  return [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, "kady_agent", ".env"),
    path.join(repoRoot, "server", ".env"),
  ];
}

export function credentialEnvironmentFilePath(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return explicitEnvironmentFile(environment) ?? path.join(repoRoot, ".env");
}
