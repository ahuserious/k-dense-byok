/**
 * Minimal .env loader (no dependency). Imported FIRST in entry points so
 * process.env is populated before config.ts reads it.
 *
 * KADY_ENV_FILE selects an explicit absolute env file. KADY_PREVIEW=1 makes
 * that file exclusive, so preview processes never fall through to checkout
 * env files. Outside preview mode the configured file is loaded first, then
 * the repo-root `.env`, legacy `kady_agent/.env`, and `server/.env` paths. With
 * no KADY_ENV_FILE, normal launch behavior is unchanged. Existing process.env
 * values always win; start.mjs may already have loaded `.env` with override
 * precedence. The parser itself is shared with the launcher: repo-root
 * env-file.mjs.
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "../../env-file.mjs";
import { environmentFilePaths } from "./environment-files.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

export function loadEnvironmentFiles(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  // Later files do not override earlier ones (existing env always wins), so
  // order is just discovery preference.
  for (const file of environmentFilePaths(root, environment)) applyEnvFile(file);
}

loadEnvironmentFiles(repoRoot);

// Keep Kady's Pi credentials/settings separate from the user's standalone Pi
// CLI by default. The same environment variable is inherited by pi-subagents'
// child processes, so lead and child runs share one file-locked auth.json
// without copying OAuth tokens into process arguments or project files.
//
// An explicitly supplied PI_CODING_AGENT_DIR remains authoritative for users
// who intentionally want Kady and their Pi CLI to share configuration. Resolve
// it once here so child processes launched from a sandbox cwd see the same
// directory even when the configured value was relative.
const configuredPiDir =
  process.env.PI_CODING_AGENT_DIR?.trim() ||
  process.env.KADY_PI_AGENT_DIR?.trim() ||
  path.join(os.homedir(), ".kady", "pi-agent");
const expandedPiDir =
  configuredPiDir === "~"
    ? os.homedir()
    : configuredPiDir.startsWith("~/") || configuredPiDir.startsWith("~\\")
      ? path.join(os.homedir(), configuredPiDir.slice(2))
      : configuredPiDir;
process.env.PI_CODING_AGENT_DIR = path.resolve(repoRoot, expandedPiDir);
