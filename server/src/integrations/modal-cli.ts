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
 * Both are rendered by Settings ▸ Connectors ▸ Known integrations ▸ Modal.
 *
 * Invariants:
 *   - One credential path. The only "is Modal configured?" test on this path is
 *     `modalCredentialEnv()` from ../modal/credentials.ts, which is also the
 *     module holding the message manager.ts throws. No second env var, no second
 *     settings field, no second computation.
 *   - Credentials reach the child through `env`, never argv, so they cannot be
 *     read out of `ps`.
 *   - Allow-listed subcommands only; no caller-supplied argv reaches the binary.
 *   - Nothing spawns synchronously. Every spawn here is async and off the
 *     request path's critical section, so a slow or hung Python CLI cannot stall
 *     the Fastify event loop for every other client.
 *   - Nothing here touches transfer.ts, adapter.ts's sandbox creation, or
 *     environment.ts, so the documented "credentials are never copied into
 *     remote sandboxes" invariant (docs/modal-compute.md:8-15) is untouched.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookPath } from "../binaries.ts";
import {
  MODAL_NOT_CONFIGURED_MESSAGE,
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

/** How long a version reading is reused before another spawn is allowed. */
export const MODAL_VERSION_CACHE_TTL_MS = 5 * 60_000;

export interface ModalCliProbe {
  binary: string;
  found: boolean;
  /**
   * Populated only when the binary was found. This is a success state the panel
   * renders, per the lane brief's "CLI: found at <path> / not found" requirement;
   * it is never placed in an error body, which is what #71 governs.
   */
  path: string | null;
  /** null when no version has been read yet — see modalCliPresence(). */
  version: string | null;
}

export interface ModalCliResult {
  ok: boolean;
  code?: "NOT_CONFIGURED" | "CLI_NOT_FOUND" | "CLI_FAILED";
  detail?: string;
  stdout?: string;
}

/** The async runner's shape: promisify(execFile) satisfies it. */
export type ModalExecFile = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    encoding: "utf-8";
  },
) => Promise<{ stdout: string; stderr: string }>;

/** Injectable so tests never spawn a real binary. */
export interface ModalCliDeps {
  lookPathImpl?: typeof lookPath;
  execFileImpl?: ModalExecFile;
  environment?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile) as unknown as ModalExecFile;

/**
 * Run the binary. `status` is 0 on success, the child's exit code when it ran
 * and failed, and null when it could not be executed at all — three states the
 * caller reports differently.
 */
async function runBinary(
  binaryPath: string,
  args: readonly string[],
  credentialEnv: Record<string, string>,
  deps: ModalCliDeps,
): Promise<{ status: number | null; stdout: string }> {
  const execImpl = deps.execFileImpl ?? execFileAsync;
  const environment = deps.environment ?? process.env;
  try {
    const { stdout } = await execImpl(binaryPath, [...args], {
      // Tokens travel here, not in `args`, so they never appear in `ps` output.
      env: { ...environment, ...credentialEnv },
      encoding: "utf-8",
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    return { status: 0, stdout: (stdout ?? "").trim() };
  } catch (error) {
    // promisify(execFile) rejects with `code` = the exit status for a child that
    // ran and failed, and with a string errno (ENOENT, ETIMEDOUT) for one that
    // never ran.
    const code = (error as { code?: unknown }).code;
    return { status: typeof code === "number" ? code : null, stdout: "" };
  }
}

interface VersionCacheEntry {
  /** The resolved binary path the reading belongs to. */
  path: string;
  version: string | null;
  readAtMs: number;
}

let versionCache: VersionCacheEntry | null = null;

/** Test hook: drop the memoised version so a case starts from a known state. */
export function resetModalCliVersionCache(): void {
  versionCache = null;
}

/**
 * Whether the `modal` binary exists here — WITHOUT spawning anything.
 *
 * `GET /integrations` is served from this: PATH resolution is a few `stat`
 * calls, while `modal --version` is a ~0.7s Python start that would block the
 * whole event loop on every mount of the Connectors tab. The version is filled
 * in from the memoised reading when one exists, and is honestly `null` until the
 * explicit `GET /integrations/modal/cli` route has taken one.
 */
export function modalCliPresence(deps: ModalCliDeps = {}): ModalCliProbe {
  const lookPathFn = deps.lookPathImpl ?? lookPath;
  const resolvedPath = lookPathFn(MODAL_CLI_BINARY);
  if (resolvedPath === null) {
    return { binary: MODAL_CLI_BINARY, found: false, path: null, version: null };
  }
  const cached = versionCache?.path === resolvedPath ? versionCache.version : null;
  return { binary: MODAL_CLI_BINARY, found: true, path: resolvedPath, version: cached };
}

/**
 * Read the CLI version, spawning at most once per MODAL_VERSION_CACHE_TTL_MS per
 * resolved path. Never throws; a missing or unrunnable binary is a state.
 *
 * The version probe needs no credentials, so it runs whether or not Modal is
 * configured — otherwise a user could not tell an uninstalled CLI from an
 * unconfigured account.
 */
export async function probeModalCli(deps: ModalCliDeps = {}): Promise<ModalCliProbe> {
  const lookPathFn = deps.lookPathImpl ?? lookPath;
  const resolvedPath = lookPathFn(MODAL_CLI_BINARY);
  if (resolvedPath === null) {
    return { binary: MODAL_CLI_BINARY, found: false, path: null, version: null };
  }
  const fresh =
    versionCache !== null &&
    versionCache.path === resolvedPath &&
    Date.now() - versionCache.readAtMs < MODAL_VERSION_CACHE_TTL_MS;
  if (fresh) {
    return {
      binary: MODAL_CLI_BINARY,
      found: true,
      path: resolvedPath,
      version: versionCache!.version,
    };
  }
  const { status, stdout } = await runBinary(resolvedPath, ALLOWED_COMMANDS.version, {}, deps);
  // A binary that exists but cannot be executed is still "found"; the absent
  // version is the honest report of what happened.
  const version = status === 0 && stdout ? stdout : null;
  versionCache = { path: resolvedPath, version, readAtMs: Date.now() };
  return { binary: MODAL_CLI_BINARY, found: true, path: resolvedPath, version };
}

/**
 * Run one allow-listed, read-only Modal CLI subcommand.
 *
 * Fails closed on the SHARED credential module with the SHARED message:
 * `modalCredentialEnv()` returning null IS the "not configured" test — there is
 * no second copy of the pair check here — and MODAL_NOT_CONFIGURED_MESSAGE is
 * the same constant manager.ts throws.
 */
export async function runModalCli(
  command: ModalCliCommand,
  deps: ModalCliDeps = {},
): Promise<ModalCliResult> {
  const environment = deps.environment ?? process.env;
  const credentialEnv = modalCredentialEnv(environment);
  if (credentialEnv === null) {
    return { ok: false, code: "NOT_CONFIGURED", detail: MODAL_NOT_CONFIGURED_MESSAGE };
  }

  const lookPathFn = deps.lookPathImpl ?? lookPath;
  const resolvedPath = lookPathFn(MODAL_CLI_BINARY);
  if (resolvedPath === null) {
    return { ok: false, code: "CLI_NOT_FOUND", detail: MODAL_CLI_NOT_FOUND_MESSAGE };
  }

  const { status, stdout } = await runBinary(
    resolvedPath,
    ALLOWED_COMMANDS[command],
    credentialEnv,
    deps,
  );
  if (status === null) {
    return {
      ok: false,
      code: "CLI_FAILED",
      detail: "The Modal CLI could not be executed. Check the Modal CLI installation.",
    };
  }
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
}
