export const WORKFLOW_SUPERVISOR_CREDENTIAL_KEYS = [
  "openrouter",
  "exa",
  "perplexity",
  "gemini",
] as const;

export type WorkflowSupervisorCredentialKey =
  (typeof WORKFLOW_SUPERVISOR_CREDENTIAL_KEYS)[number];

export function isWorkflowSupervisorCredentialKey(
  value: unknown,
): value is WorkflowSupervisorCredentialKey {
  return typeof value === "string" &&
    (WORKFLOW_SUPERVISOR_CREDENTIAL_KEYS as readonly string[]).includes(value);
}
