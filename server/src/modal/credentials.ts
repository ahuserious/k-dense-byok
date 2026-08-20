/**
 * The single statement of Modal's credential contract.
 *
 * Modal is one logical credential expressed as two environment variables, and
 * before this module the "not configured" message existed twice — byte-identical
 * and unshared — in manager.ts and adapter.ts. Anything that needs to know
 * whether Modal is usable, or to tell the user it is not, imports from here.
 * A second credential path to one service is a bug; so is a second copy of the
 * sentence that describes it.
 *
 * `modalConfigured` is re-exported rather than reimplemented so there is exactly
 * one computation of "is Modal configured?" in the process.
 */
import { modalConfigured } from "../config.ts";

export { modalConfigured };

/**
 * The environment variable NAMES Modal needs. Names only — no consumer of this
 * module ever reads, logs, or echoes the values.
 */
export const MODAL_TOKEN_ENV_VARS = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] as const;

/**
 * The canonical not-configured message. Originally duplicated at
 * manager.ts:259 and adapter.ts:89; both now import this constant, and so does
 * the CLI path added for matrix row 50.
 */
export const MODAL_NOT_CONFIGURED_MESSAGE =
  "Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings.";

/** Which of the required variable NAMES are absent. Never returns a value. */
export function missingModalEnvVars(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return MODAL_TOKEN_ENV_VARS.filter((name) => !environment[name]);
}

/**
 * The credentials a child process needs, as an env fragment.
 *
 * Returned as `env` entries and never as argv, so a spawned `modal` binary's
 * tokens cannot be read out of `ps`. Returns null when Modal is not configured,
 * which is the caller's signal to fail closed rather than spawn anything.
 */
export function modalCredentialEnv(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> | null {
  const tokenId = environment.MODAL_TOKEN_ID;
  const tokenSecret = environment.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) return null;
  return { MODAL_TOKEN_ID: tokenId, MODAL_TOKEN_SECRET: tokenSecret };
}
