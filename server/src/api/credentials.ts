/**
 * Runtime credential management for the bring-your-own-key model.
 *
 * Historically the only way to set a key was to edit the repo-root `.env` and
 * restart the app — a real wall for a non-technical scientist. These endpoints
 * let the Settings UI read key status and set keys live:
 *   - GET  /credentials  → masked status per provider (never the raw key)
 *   - PUT  /credentials  → set/clear any subset of keys, persist to `.env`,
 *                          and update process.env so in-flight sessions (and
 *                          the child `pi` processes pi-subagents spawns, which
 *                          inherit our environment) pick them up without a
 *                          restart. The OpenRouter key is additionally pushed
 *                          into the shared ModelRuntime.
 *
 * Managed keys: OpenRouter (model calls and cross-browser speech
 * transcription); NVIDIA (direct NVIDIA NIM model access via build.nvidia.com
 * API credits); the optional pi-web-access search providers — Exa,
 * Perplexity, Gemini (web search works without any of the three via the Exa MCP
 * fallback; a key unlocks the direct provider, and Gemini also unlocks
 * YouTube/video understanding); and the Modal remote-compute token pair
 * (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) that enables the `modal_run` tool.
 *
 * Keys are stored exactly where the app already expects them (repo-root
 * `.env`, plaintext, on the user's own machine) — we are removing friction,
 * not changing the trust model. The server binds to localhost only.
 *
 * Cross-process writes are serialized through a `.env.lock` owner-token file
 * created next to `.env` (same directory, so the O_EXCL create is atomic on
 * one filesystem), and the pre-mutation snapshot is revalidated by content
 * hash inside the lock so a concurrent change becomes a retryable conflict
 * instead of a silent lost update. The lock is advisory: writers that do not
 * take it (a user's editor, external scripts) are still detected by the hash
 * and stat re-checks when they write first, but cannot be excluded from the
 * final rename window itself.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { REPO_ROOT } from "../config.ts";
import { getModelRuntime } from "../agent/session-registry.ts";
import { validateModalCredentials } from "../modal/adapter.ts";
import { modalJobManager } from "../modal/manager.ts";
import type { WorkflowSupervisorCredentialKey } from "../workflows/supervisor/credential-contract.ts";

const ENV_PATH = path.join(REPO_ROOT, ".env");
export const MAX_CREDENTIAL_ENV_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_LOCK_BYTES = 4_096;
const CREDENTIAL_LOCK_TIMEOUT_MS = 2_000;
const CREDENTIAL_LOCK_RETRY_DELAY_MS = 25;
const CREDENTIAL_LOCK_STALE_MS = 10_000;
/** Recorded once so lock tokens can distinguish this process from a later
 * process that recycled the same pid. */
const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);
let credentialEnvPath = ENV_PATH;
let credentialMutationTail = Promise.resolve();

interface ManagedKey {
  /** Provider id in API payloads (GET response field). */
  id: string;
  /** PUT body field name. */
  bodyField: string;
  /** Canonical env var written to `.env`. */
  envVar: string;
  /** Secret-free id sent to the detached workflow supervisor after a change. */
  supervisorKey?: WorkflowSupervisorCredentialKey;
  /** Extra env vars read (and cleared) for backwards compatibility. */
  envAliases?: string[];
  /** Hook run after set/clear (e.g. push into ModelRuntime). */
  onChange?: (key: string | null) => Promise<void>;
}

const MANAGED_KEYS: ManagedKey[] = [
  {
    id: "openrouter",
    bodyField: "openrouterApiKey",
    envVar: "OPENROUTER_API_KEY",
    supervisorKey: "openrouter",
    envAliases: ["OR_API_KEY"],
    onChange: async (key) => {
      try {
        if (key) await getModelRuntime().setRuntimeApiKey("openrouter", key);
        else await getModelRuntime().removeRuntimeApiKey("openrouter");
      } catch {
        /* Runtime refresh failure does not undo the persisted environment change. */
      }
    },
  },
  {
    id: "nvidia",
    bodyField: "nvidiaApiKey",
    envVar: "NVIDIA_API_KEY",
    supervisorKey: "nvidia",
    onChange: async (key) => {
      try {
        if (key) await getModelRuntime().setRuntimeApiKey("nvidia", key);
        else await getModelRuntime().removeRuntimeApiKey("nvidia");
      } catch {
        /* Runtime refresh failure does not undo the persisted environment change. */
      }
    },
  },
  {
    id: "exa",
    bodyField: "exaApiKey",
    envVar: "EXA_API_KEY",
    supervisorKey: "exa",
  },
  {
    id: "perplexity",
    bodyField: "perplexityApiKey",
    envVar: "PERPLEXITY_API_KEY",
    supervisorKey: "perplexity",
  },
  {
    id: "gemini",
    bodyField: "geminiApiKey",
    envVar: "GEMINI_API_KEY",
    supervisorKey: "gemini",
  },
  // Modal remote compute is two env vars for one logical credential; both must
  // be set for modalConfigured() to flip true and the modal_run tool to register.
  { id: "modalTokenId", bodyField: "modalTokenId", envVar: "MODAL_TOKEN_ID" },
  { id: "modalTokenSecret", bodyField: "modalTokenSecret", envVar: "MODAL_TOKEN_SECRET" },
];

const MODAL_ID_FIELD = "modalTokenId";
const MODAL_SECRET_FIELD = "modalTokenSecret";
let modalCredentialValidator = validateModalCredentials;

/** Injectable only so credential route tests never contact Modal. */
export function setModalCredentialValidatorForTests(
  validator: typeof validateModalCredentials | null,
): void {
  modalCredentialValidator = validator ?? validateModalCredentials;
}

/** Redirect persistence in tests so the user's real repo .env is never touched. */
export function setCredentialEnvPathForTests(file: string | null): void {
  credentialEnvPath = file ?? ENV_PATH;
}

let credentialAfterSnapshotHook: (() => void | Promise<void>) | null = null;
let credentialBeforeRenameHook: (() => void) | null = null;

/** Test-only: interpose after the pre-mutation snapshot is read, before the
 * cross-process lock is taken, so tests can simulate an external writer. */
export function setCredentialAfterSnapshotHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  credentialAfterSnapshotHook = hook;
}

/** Test-only: interpose in the window between the final snapshot validation
 * and the rename that replaces `.env` — the cross-process race window that a
 * concurrent writer can land in. */
export function setCredentialBeforeRenameHookForTests(hook: (() => void) | null): void {
  credentialBeforeRenameHook = hook;
}

function readKey(spec: ManagedKey): string | null {
  for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/** Show only enough to recognize the key, never enough to use it. */
function mask(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

interface CredentialChange {
  spec: ManagedKey;
  value: string | null;
}

interface CredentialEnvSnapshot {
  contents: string;
  stat: fs.BigIntStats | null;
  /** sha256 of the exact bytes read; the authoritative change detector. */
  sha256: string;
}

/** Serialize exactly the subset understood by env-file.mjs. Its parser has no
 * quote escaping, so choose an absent delimiter and reject the rare value that
 * cannot be represented without changing bytes. */
function serializeCredentialValue(value: string): string | null {
  const unquotedRoundTrips =
    !value.startsWith('"') &&
    !value.startsWith("'") &&
    !/\s#/.test(value);
  if (unquotedRoundTrips) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return null;
}

function noFollowFlag(): number {
  return (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function sameFileIdentity(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  // Windows may report zero for both fields. The lstat/open regular-file checks
  // remain the available guarantee there.
  return (before.dev === 0n && before.ino === 0n) ||
    (before.dev === after.dev && before.ino === after.ino);
}

function sameFileVersion(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
}

function storageError(message: string): Error {
  const error = new Error(message);
  error.name = "CredentialStorageError";
  return error;
}

/** A concurrent writer changed the file: retryable, unlike a storage fault. */
function conflictError(message: string): Error {
  const error = new Error(message);
  error.name = "CredentialConflictError";
  return error;
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function credentialEnvSize(stat: fs.BigIntStats): number {
  if (
    stat.size < 0n ||
    stat.size > BigInt(MAX_CREDENTIAL_ENV_BYTES)
  ) {
    throw storageError(
      `Credential environment file exceeds ${MAX_CREDENTIAL_ENV_BYTES} bytes.`,
    );
  }
  return Number(stat.size);
}

/** Read at most one byte beyond the authenticated size so concurrent growth is
 * detected without allowing readFileSync to allocate from an unbounded file. */
function readBoundedCredentialEnv(
  descriptor: number,
  expectedSize: number,
): Buffer {
  const bytes = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (read === 0) break;
    offset += read;
  }
  if (offset > MAX_CREDENTIAL_ENV_BYTES) {
    throw storageError(
      `Credential environment file exceeds ${MAX_CREDENTIAL_ENV_BYTES} bytes.`,
    );
  }
  return bytes.subarray(0, offset);
}

function readCredentialEnv(): CredentialEnvSnapshot {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(credentialEnvPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { contents: "", stat: null, sha256: sha256Hex(Buffer.alloc(0)) };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw storageError("Credential environment path must be a regular file.");
  }
  credentialEnvSize(before);

  let descriptor: number;
  try {
    descriptor = fs.openSync(credentialEnvPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(String((error as NodeJS.ErrnoException).code))) {
      throw storageError("Credential environment path cannot be a symbolic link.");
    }
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw storageError("Credential environment file changed while it was being opened.");
    }
    const openedSize = credentialEnvSize(opened);
    const bytes = readBoundedCredentialEnv(descriptor, openedSize);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterSize = credentialEnvSize(after);
    if (
      !after.isFile() ||
      !sameFileVersion(opened, after) ||
      bytes.length !== afterSize
    ) {
      throw storageError("Credential environment file changed while it was being read.");
    }
    return { contents: bytes.toString("utf-8"), stat: after, sha256: sha256Hex(bytes) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function targetMatchesSnapshot(snapshot: CredentialEnvSnapshot): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(credentialEnvPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && snapshot.stat === null) return;
    throw storageError("Credential environment file changed before it could be replaced.");
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    throw storageError("Credential environment path must remain a regular file.");
  }
  if (
    snapshot.stat === null ||
    !sameFileVersion(snapshot.stat, current)
  ) {
    throw storageError("Credential environment file changed before it could be replaced.");
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Directory handles cannot be fsynced on every supported Windows
    // filesystem. On platforms that support it, durability failures surface.
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

interface CredentialLockOwner {
  version: 1;
  /** Random nonce: the actual ownership proof (pids are recycled). */
  token: string;
  pid: number;
  /** Owning process's start time; disambiguates a recycled pid. */
  startedAt: number;
  hostname: string;
  createdAt: number;
}

type CredentialLockObservation =
  | { kind: "missing" }
  | { kind: "unrecognized" }
  | { kind: "owned"; owner: CredentialLockOwner };

interface AcquiredCredentialEnvLock {
  lockFile: string;
  owner: CredentialLockOwner;
}

/** Create the lock atomically (O_CREAT|O_EXCL in the target's own directory);
 * null when another writer already holds it. */
function tryCreateCredentialEnvLock(lockFile: string): CredentialLockOwner | null {
  const owner: CredentialLockOwner = {
    version: 1,
    token: crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT_MS,
    hostname: os.hostname(),
    createdAt: Date.now(),
  };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      lockFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return owner;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      fs.rmSync(lockFile, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

function readCredentialEnvLock(lockFile: string): CredentialLockObservation {
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockFile, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (code === "ENOENT") return { kind: "missing" };
    if (["ELOOP", "EMLINK"].includes(code)) {
      throw storageError("Credential lock path cannot be a symbolic link.");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_LOCK_BYTES) {
      return { kind: "unrecognized" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(descriptor, "utf-8"));
    } catch {
      return { kind: "unrecognized" };
    }
    const record = parsed as Partial<CredentialLockOwner> | null;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      record?.version !== 1 ||
      typeof record.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.token) ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) < 1 ||
      !Number.isSafeInteger(record.startedAt) ||
      typeof record.hostname !== "string" ||
      record.hostname.length < 1 ||
      !Number.isSafeInteger(record.createdAt) ||
      (record.createdAt as number) < 0
    ) {
      return { kind: "unrecognized" };
    }
    return { kind: "owned", owner: record as CredentialLockOwner };
  } finally {
    fs.closeSync(descriptor);
  }
}

function credentialLockOwnerMayBeAlive(owner: CredentialLockOwner): boolean {
  // A lock written from another host can never be proven dead from here.
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Take over only a lock whose owner is provably dead AND older than the
 * stale bound AND unchanged on a confirming re-read. Anything live,
 * ambiguous, or unrecognized is left alone until the acquisition timeout.
 * (Two waiters can still race this unlink; the loser's O_EXCL create fails
 * and it re-enters the wait loop, so exclusion is preserved.) */
function recoverStaleCredentialEnvLock(
  lockFile: string,
  observed: CredentialLockOwner,
): boolean {
  if (Date.now() - observed.createdAt <= CREDENTIAL_LOCK_STALE_MS) return false;
  if (credentialLockOwnerMayBeAlive(observed)) return false;
  const confirmed = readCredentialEnvLock(lockFile);
  if (
    confirmed.kind !== "owned" ||
    confirmed.owner.token !== observed.token ||
    confirmed.owner.pid !== observed.pid ||
    confirmed.owner.startedAt !== observed.startedAt ||
    Date.now() - confirmed.owner.createdAt <= CREDENTIAL_LOCK_STALE_MS ||
    credentialLockOwnerMayBeAlive(confirmed.owner)
  ) {
    return false;
  }
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireCredentialEnvLock(): Promise<AcquiredCredentialEnvLock> {
  const lockFile = `${credentialEnvPath}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + CREDENTIAL_LOCK_TIMEOUT_MS;
  for (;;) {
    const owner = tryCreateCredentialEnvLock(lockFile);
    if (owner) return { lockFile, owner };
    const observed = readCredentialEnvLock(lockFile);
    if (
      observed.kind === "owned" &&
      recoverStaleCredentialEnvLock(lockFile, observed.owner)
    ) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw storageError(
        `Timed out waiting for the credential lock at ${lockFile}. ` +
          "If no other Kady process is saving credentials, delete that file and retry.",
      );
    }
    if (observed.kind !== "missing") {
      await new Promise((resolve) => setTimeout(resolve, CREDENTIAL_LOCK_RETRY_DELAY_MS));
    }
  }
}

/** Unlink only a lock that still carries our token: a stale-lock takeover
 * that raced us must not lose ITS lock to our release. */
function releaseCredentialEnvLock(acquired: AcquiredCredentialEnvLock): void {
  const observed = readCredentialEnvLock(acquired.lockFile);
  if (observed.kind !== "owned" || observed.owner.token !== acquired.owner.token) {
    return;
  }
  try {
    fs.unlinkSync(acquired.lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Apply every requested line change in memory, preserving comments and all
 * unmanaged lines. Legacy aliases are removed so a cleared key stays cleared
 * after restart. */
function renderCredentialEnv(
  snapshot: CredentialEnvSnapshot,
  changes: readonly CredentialChange[],
): string {
  let lines = snapshot.stat === null ? [] : snapshot.contents.split("\n");
  const assignmentName = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    const equals = trimmed.indexOf("=");
    if (equals < 0) return null;
    let name = trimmed.slice(0, equals).trim();
    if (name.startsWith("export ")) name = name.slice("export ".length).trim();
    return name || null;
  };
  for (const { spec, value } of changes) {
    const persistedNames = [spec.envVar, ...(spec.envAliases ?? [])];
    lines = lines.filter(
      (line) => !persistedNames.includes(assignmentName(line) ?? ""),
    );
    if (value === null) {
      // Empty assignments are intentional tombstones. The env loader treats
      // an empty string as defined, so lower-precedence legacy files cannot
      // resurrect a key that the user explicitly cleared.
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push(...persistedNames.map((name) => `${name}=`));
    } else {
      const rendered = serializeCredentialValue(value);
      if (rendered === null) {
        throw storageError("Credential value cannot be represented by the environment parser.");
      }
      // Keep a trailing newline tidy: append before any trailing blank lines.
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push(`${spec.envVar}=${rendered}`);
      lines.push(...(spec.envAliases ?? []).map((name) => `${name}=`));
    }
  }
  return lines.join("\n") + "\n";
}

/** Persist one complete, already-validated update with private permissions. */
function persistCredentialEnv(
  snapshot: CredentialEnvSnapshot,
  contents: string,
): void {
  if (Buffer.byteLength(contents, "utf-8") > MAX_CREDENTIAL_ENV_BYTES) {
    throw storageError(
      `Credential environment file exceeds ${MAX_CREDENTIAL_ENV_BYTES} bytes.`,
    );
  }
  const directory = path.dirname(credentialEnvPath);
  fs.mkdirSync(directory, { recursive: true });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw storageError("Credential environment directory must be a real directory.");
  }

  const temporary = path.join(
    directory,
    `.${path.basename(credentialEnvPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag(),
      0o600,
    );
    temporaryCreated = true;
    const temporaryStat = fs.fstatSync(descriptor);
    if (!temporaryStat.isFile()) {
      throw storageError("Credential environment temporary path is not a regular file.");
    }
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    targetMatchesSnapshot(snapshot);
    credentialBeforeRenameHook?.();
    fs.renameSync(temporary, credentialEnvPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  } finally {
    if (temporaryCreated) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function status() {
  const out: Record<string, { set: boolean; masked: string | null }> = {};
  for (const spec of MANAGED_KEYS) {
    const key = readKey(spec);
    out[spec.id] = key ? { set: true, masked: mask(key) } : { set: false, masked: null };
  }
  return out;
}

function normalizeCredentialValue(raw: unknown):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (raw !== null && typeof raw !== "string") {
    return { ok: false, error: "Credential values must be strings or null." };
  }
  if (typeof raw === "string" && /[\0\r\n]/.test(raw)) {
    return {
      ok: false,
      error: "Credential values must be a single line and cannot contain NUL bytes.",
    };
  }
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key === "") return { ok: true, value: null };
  // Do not hard-reject provider-specific formats, which may change; only guard
  // against obviously invalid pasted values.
  if (key.length < 8) {
    return { ok: false, error: "That key looks too short to be valid." };
  }
  if (serializeCredentialValue(key) === null) {
    return {
      ok: false,
      error: "That credential contains a combination of characters that cannot be saved safely.",
    };
  }
  return { ok: true, value: key };
}

async function withCredentialMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = credentialMutationTail;
  let release!: () => void;
  credentialMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export interface RegisterCredentialRoutesOptions {
  /** Reloads named providers in the detached supervisor; no key bytes cross IPC. */
  reloadCredentials?: (
    keys: readonly WorkflowSupervisorCredentialKey[],
  ) => Promise<unknown>;
}

export async function registerCredentialRoutes(
  app: FastifyInstance,
  options: RegisterCredentialRoutesOptions = {},
): Promise<void> {
  app.get("/credentials", async () => status());

  app.put<{ Body: Record<string, string | null | undefined> }>(
    "/credentials",
    async (req, reply) => {
      const provided = MANAGED_KEYS.filter((s) => req.body?.[s.bodyField] !== undefined);
      if (provided.length === 0) {
        reply.code(400);
        const fields = MANAGED_KEYS.map((s) => s.bodyField).join(", ");
        return { detail: `Provide at least one of: ${fields} (a string, or null to clear)` };
      }
      return withCredentialMutationLock(async () => {
        const changes: CredentialChange[] = [];
        const valuesByField = new Map<string, string | null>();
        for (const spec of provided) {
          const normalized = normalizeCredentialValue(req.body?.[spec.bodyField]);
          if (!normalized.ok) {
            reply.code(400);
            return { detail: normalized.error };
          }
          changes.push({ spec, value: normalized.value });
          valuesByField.set(spec.bodyField, normalized.value);
        }

        // Modal is one logical credential represented by two variables. Build
        // and validate its complete candidate pair before any state changes.
        const changesModal = valuesByField.has(MODAL_ID_FIELD) ||
          valuesByField.has(MODAL_SECRET_FIELD);
        if (changesModal) {
          const modalIdSpec = MANAGED_KEYS.find((spec) => spec.bodyField === MODAL_ID_FIELD)!;
          const modalSecretSpec = MANAGED_KEYS.find((spec) => spec.bodyField === MODAL_SECRET_FIELD)!;
          const tokenId = valuesByField.has(MODAL_ID_FIELD)
            ? valuesByField.get(MODAL_ID_FIELD) ?? null
            : readKey(modalIdSpec);
          const tokenSecret = valuesByField.has(MODAL_SECRET_FIELD)
            ? valuesByField.get(MODAL_SECRET_FIELD) ?? null
            : readKey(modalSecretSpec);
          if (Boolean(tokenId) !== Boolean(tokenSecret)) {
            reply.code(400);
            return {
              detail:
                "Modal credentials are a pair: provide both modalTokenId and modalTokenSecret, or clear both.",
            };
          }
          if (tokenId && tokenSecret) {
            try {
              await modalCredentialValidator(tokenId, tokenSecret);
            } catch {
              reply.code(400);
              return {
                detail: "Modal credentials could not be validated.",
                reason: "modal_credentials_invalid",
              };
            }
          }
        }

        try {
          const snapshot = readCredentialEnv();
          await credentialAfterSnapshotHook?.();
          const lock = await acquireCredentialEnvLock();
          try {
            // Cooperating writers serialize on `.env.lock`; the content hash
            // is the authoritative change detector for everything else. The
            // stat-based sameFileVersion re-check in persistCredentialEnv
            // stays as a fast-fail for writes landing after this point.
            const revalidated = readCredentialEnv();
            if (revalidated.sha256 !== snapshot.sha256) {
              throw conflictError("Credential environment file changed since it was read.");
            }
            persistCredentialEnv(revalidated, renderCredentialEnv(revalidated, changes));
          } finally {
            releaseCredentialEnvLock(lock);
          }
        } catch (error) {
          if ((error as Error).name === "CredentialConflictError") {
            reply.code(409);
            return {
              detail:
                "The .env file was changed by another process while saving. Retry the change.",
              reason: "credential_conflict",
              saved: false,
            };
          }
          reply.code(500);
          return {
            detail: "Credentials could not be saved safely. Check the .env file and retry.",
            reason: "credential_persistence_failed",
            saved: false,
          };
        }

        // The durable file is now complete, so expose the same complete update
        // to this process and its runtime consumers without an await between keys.
        for (const { spec, value } of changes) {
          if (value === null) {
            for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) {
              delete process.env[name];
            }
          } else {
            process.env[spec.envVar] = value;
            for (const alias of spec.envAliases ?? []) delete process.env[alias];
          }
        }
        for (const { spec, value } of changes) await spec.onChange?.(value);

        const supervisorKeys = [...new Set(
          provided.flatMap((spec) => spec.supervisorKey ? [spec.supervisorKey] : []),
        )];
        if (options.reloadCredentials && supervisorKeys.length > 0) {
          try {
            await options.reloadCredentials(supervisorKeys);
          } catch {
            reply.code(503);
            return {
              detail:
                "Credentials were saved, but the workflow supervisor reload failed. Retry the change or restart Kady.",
              reason: "workflow_supervisor_reload_failed",
              saved: true,
            };
          }
        }
        if (
          changesModal &&
          process.env.MODAL_TOKEN_ID &&
          process.env.MODAL_TOKEN_SECRET
        ) {
          // Jobs whose restart recovery was deferred while credentials were
          // absent can reattach immediately; no server restart or cold session
          // rebuild is required.
          await modalJobManager.recoverAllProjects();
        }
        return status();
      });
    },
  );
}
