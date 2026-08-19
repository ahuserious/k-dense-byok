/**
 * Modal CLI (matrix row 50) — added ON TOP OF the existing SDK integration.
 *
 * What this deliberately does NOT do: submit, monitor, cancel, transfer files
 * for, build images for, or account the cost of a Modal job. server/src/modal/
 * manager.ts and adapter.ts already do all of that through the `modal` npm SDK,
 * durably, with a budget ledger and a job store. A second way to start a Modal
 * job would be a duplicate of an existing capability.
 *
 * What it adds, and all it adds, are the two things the SDK path cannot report:
 *   1. whether the `modal` binary is installed here, and at what version;
 *   2. which Modal workspace the configured token pair belongs to
 *      (`modal profile current`) — a user with two Modal accounts currently
 *      cannot tell from the app which one is being billed.
 *
 * Invariants:
 *   - One credential path. `modalConfigured()` here is the SAME function
 *     manager.ts calls, re-exported once from ./credentials.ts. No second env
 *     var, no second settings field, no second "configured?" computation.
 *   - Credentials reach the child through `env`, never argv, so they cannot be
 *     read out of `ps`.
 *   - Allow-listed subcommands only; no caller-supplied argv reaches the binary.
 *   - Nothing here touches transfer.ts, adapter.ts's sandbox creation, or
 *     environment.ts, so the documented "credentials are never copied into
 *     remote sandboxes" invariant (docs/modal-compute.md:8-15) is untouched.
 */
import { spawnSync } from "node:child_process";
import { lookPath } from "../binaries.ts";
import {
  MODAL_NOT_CONFIGURED_MESSAGE,
  modalConfigured,
  modalCredentialEnv,
} from "../modal/credentials.ts";

export const MODAL_CLI_BINARY = "modal";

export const MODAL_CLI_NOT_FOUND_MESSAGE =
  "Modal CLI not found. Install the Modal CLI to read workspace details.";

/** The complete set of subcommands this module may invoke. Read-only, both of them. */
const ALLOWED_COMMANDS = {
  version: ["--version"],
  profile: ["profile", "current"],
} as const;

export type ModalCliCommand = keyof typeof ALLOWED_COMMANDS;

const CLI_TIMEOUT_MS = 10_000;

export interface ModalCliProbe {
  binary: string;
  found: boolean;
  /**
   * Populated only when the binary was found. This is a success state the panel
   * renders, per the lane brief's "CLI: found at <path> / not found" requirement;
   * it is never placed in an error body, which is what #71 governs.
   */
  path: string | null;
  version: string | null;
}

export interface ModalCliResult {
  ok: boolean;
  code?: "NOT_CONFIGURED" | "CLI_NOT_FOUND" | "CLI_FAILED";
  detail?: string;
  stdout?: string;
}

/** Injectable so tests never spawn a real binary. */
export interface ModalCliDeps {
  lookPathImpl?: typeof lookPath;
  spawnSyncImpl?: typeof spawnSync;
  environment?: NodeJS.ProcessEnv;
}

function runBinary(
  binaryPath: string,
  args: readonly string[],
  credentialEnv: Record<string, string>,
  deps: ModalCliDeps,
): { status: number | null; stdout: string } {
  const spawnImpl = deps.spawnSyncImpl ?? spawnSync;
  const environment = deps.environment ?? process.env;
  const result = spawnImpl(binaryPath, [...args], {
    // Tokens travel here, not in `args`, so they never appear in `ps` output.
    env: { ...environment, ...credentialEnv },
    encoding: "utf-8",
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

/**
 * Whether the `modal` binary exists here and what it reports as its version.
 * Never throws; a missing binary is a state.
 *
 * The version probe needs no credentials, so it runs whether or not Modal is
 * configured — otherwise a user could not tell an uninstalled CLI from an
 * unconfigured account.
 */
export function probeModalCli(deps: ModalCliDeps = {}): ModalCliProbe {
  const lookPathFn = deps.lookPathImpl ?? lookPath;
  const resolvedPath = lookPathFn(MODAL_CLI_BINARY);
  if (resolvedPath === null) {
    return { binary: MODAL_CLI_BINARY, found: false, path: null, version: null };
  }
  let version: string | null = null;
  try {
    const { status, stdout } = runBinary(resolvedPath, ALLOWED_COMMANDS.version, {}, deps);
    if (status === 0 && stdout) version = stdout;
  } catch {
    // A binary that exists but cannot be executed is still "found"; the absent
    // version is the honest report of what happened.
  }
  return { binary: MODAL_CLI_BINARY, found: true, path: resolvedPath, version };
}

/**
 * Run one allow-listed, read-only Modal CLI subcommand.
 *
 * Fails closed on the SHARED credential computation with the SHARED message —
 * `modalConfigured()` and `MODAL_NOT_CONFIGURED_MESSAGE` are the same values
 * manager.ts uses, not a parallel copy.
 */
export function runModalCli(
  command: ModalCliCommand,
  deps: ModalCliDeps = {},
): ModalCliResult {
  const environment = deps.environment ?? process.env;
  const configured = deps.environment
    ? Boolean(environment.MODAL_TOKEN_ID && environment.MODAL_TOKEN_SECRET)
    : modalConfigured();
  if (!configured) {
    return { ok: false, code: "NOT_CONFIGURED", detail: MODAL_NOT_CONFIGURED_MESSAGE };
  }
  const credentialEnv = modalCredentialEnv(environment);
  if (credentialEnv === null) {
    return { ok: false, code: "NOT_CONFIGURED", detail: MODAL_NOT_CONFIGURED_MESSAGE };
  }

  const lookPathFn = deps.lookPathImpl ?? lookPath;
  const resolvedPath = lookPathFn(MODAL_CLI_BINARY);
  if (resolvedPath === null) {
    return { ok: false, code: "CLI_NOT_FOUND", detail: MODAL_CLI_NOT_FOUND_MESSAGE };
  }

  try {
    const { status, stdout } = runBinary(
      resolvedPath,
      ALLOWED_COMMANDS[command],
      credentialEnv,
      deps,
    );
    if (status !== 0) {
      // The CLI's own stderr can name local config paths; the user-facing text
      // names the next action instead (#71).
      return {
        ok: false,
        code: "CLI_FAILED",
        detail: `The Modal CLI exited with status ${String(status)}. Check the Modal credentials in Settings.`,
      };
    }
    return { ok: true, stdout };
  } catch {
    return {
      ok: false,
      code: "CLI_FAILED",
      detail: "The Modal CLI could not be executed. Check the Modal CLI installation.",
    };
  }
}
