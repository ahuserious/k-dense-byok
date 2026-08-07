import path from "node:path";
import { applyEnvFile } from "../../../../env-file.mjs";
import { getModelRuntime } from "../../agent/session-registry.ts";
import { REPO_ROOT } from "../../config.ts";
import {
  isWorkflowSupervisorCredentialKey,
  type WorkflowSupervisorCredentialKey,
} from "./credential-contract.ts";

const CREDENTIAL_ENV_NAMES: Record<
  WorkflowSupervisorCredentialKey,
  readonly string[]
> = {
  openrouter: ["OPENROUTER_API_KEY", "OR_API_KEY"],
  exa: ["EXA_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
};

const ENV_FILES = [
  path.join(REPO_ROOT, ".env"),
  path.join(REPO_ROOT, "kady_agent", ".env"),
  path.join(REPO_ROOT, "server", ".env"),
] as const;

/**
 * Reload only user-managed provider keys after Settings persisted them. No
 * credential bytes cross supervisor IPC, and unrelated inherited environment
 * values retain their original authority.
 */
export async function reloadWorkflowSupervisorCredentials(
  keys: readonly WorkflowSupervisorCredentialKey[],
): Promise<void> {
  if (
    keys.length < 1 ||
    new Set(keys).size !== keys.length ||
    !keys.every(isWorkflowSupervisorCredentialKey)
  ) {
    throw new Error("Workflow supervisor credential reload keys are invalid.");
  }

  const changedNames = new Set(keys.flatMap((key) => CREDENTIAL_ENV_NAMES[key]));
  const preserved = new Map<string, string | undefined>();
  for (const names of Object.values(CREDENTIAL_ENV_NAMES)) {
    for (const name of names) {
      if (!changedNames.has(name)) preserved.set(name, process.env[name]);
    }
  }
  for (const name of changedNames) delete process.env[name];

  // Root, legacy, then server mirrors env.ts discovery precedence. The first
  // file that defines a cleared name wins; unchanged managed keys are restored
  // below so a reload cannot silently replace an inherited shell credential.
  for (const file of ENV_FILES) applyEnvFile(file);
  for (const [name, value] of preserved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  if (keys.includes("openrouter")) {
    // Settings persists the canonical name. Do not resurrect a legacy alias
    // from an old .env line after the user explicitly clears the credential.
    delete process.env.OR_API_KEY;
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (key) await getModelRuntime().setRuntimeApiKey("openrouter", key);
    else await getModelRuntime().removeRuntimeApiKey("openrouter");
  }

  if (keys.includes("nvidia")) {
    const key = process.env.NVIDIA_API_KEY?.trim();
    if (key) await getModelRuntime().setRuntimeApiKey("nvidia", key);
    else await getModelRuntime().removeRuntimeApiKey("nvidia");
  }
}
