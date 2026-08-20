#!/usr/bin/env node
/**
 * Assemble the run environment from the owner's existing local sources and inject it
 * into a child process, so a test run is exercised with real credentials — without any
 * value ever being printed, logged, written to a tracked path, or committed.
 *
 * The three rules this script exists to enforce:
 *
 *   1. It never prints a value. Its entire human output is built from variable NAMES,
 *      source names, and the words `present`/`absent`. As defence in depth every byte it
 *      writes is passed through `scrubText` from `hosted-evidence-secrets.mjs` and then
 *      re-scanned with `findSecretRepresentation`; if a representation somehow survived
 *      into the output the write fails closed instead of leaking. The scrubber's inputs
 *      are the values loaded from a FILE or DIRECTORY source — the values this script
 *      read itself. Ambient values are not fed to it, because no code path prints an
 *      ambient value; the claim is narrowed to what the code does rather than left
 *      reading wider than the guard actually is.
 *   2. It never persists a value to a path git would keep. `--write` asks git twice —
 *      `ls-files --error-unmatch` (tracked?) and `check-ignore` (ignored?) — and refuses
 *      unless the target is untracked AND ignored. Both questions are about a NAME, so
 *      the name is pinned to its bytes first: a symlink, a hard-linked file, a non-regular
 *      file and a symlinked PARENT are each refused before git is consulted, and the write
 *      opens with O_NOFOLLOW|O_NONBLOCK, re-checks the descriptor's link count, file type,
 *      parent-directory inode and own inode, and applies mode and bytes to the descriptor
 *      — so neither a link nor an ancestor directory planted after the check is followed.
 *   3. A missing source is a skip with a named reason, never an error and never a silent
 *      zero; an unparseable source is an error naming the file and the LINE NUMBER, never
 *      the line's content.
 *
 * Deliberately NOT implemented: an `--emit-for-eval NAME` mode that prints one value to
 * stdout for `VAR="$(…)"` capture. It cannot coexist with rule 1 — a printed value lands
 * in the shell's history, in any `set -x` trace, and in whatever log wraps the caller.
 * Injection mode (`-- <command>`) covers every use it would have served.
 *
 * The .env parser below mirrors `env-file.mjs` (the shared parser used by start.mjs and
 * server/src/env.ts): `export KEY=value` prefixes, single/double quoting, and unquoted
 * trailing `# comments`. It is a separate implementation on purpose — this one must not
 * mutate `process.env`, must report a line NUMBER for a malformed line rather than
 * skipping it, and `env-file.mjs` is outside this lane's writable set.
 */

import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectSecretRepresentations,
  findSecretRepresentation,
  scrubText,
  secretRepresentationsForValue,
} from "./hosted-evidence-secrets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDirectory, "..");

/**
 * Documented default sources, highest precedence first. `kind: "ambient"` is the running
 * process environment; `kind: "env-file"` is a KEY=VALUE file; `kind: "directory"` is a
 * directory of one-value-per-file secrets (file name -> variable name).
 *
 * These are defaults, not hardcoded-only: `--source <path>` is repeatable and
 * `--no-default-sources` drops every entry below the ambient environment, so someone who
 * is not this owner can point the script at their own layout.
 */
export const DEFAULT_SOURCES = [
  { kind: "ambient", name: "ambient-env", path: null },
  {
    kind: "env-file",
    name: "integration-worktree-env",
    path: "/Users/DanBot/Documents/ChatGPT/dfg-integration-20260807-135127/.env",
  },
  {
    kind: "directory",
    name: "private-evidence-dir",
    path:
      "/Users/DanBot/Documents/ChatGPT/dfg-evidence-20260807-135127/s11/" +
      "PRIVATE-do-not-share",
  },
  { kind: "env-file", name: "repo-root-env", path: path.join(REPO_ROOT, ".env") },
];

/**
 * Names always shown in the listing even when nothing supplies them, so an absent
 * credential reads as `absent` instead of vanishing from the table. The two STABLY_*
 * names are the ones `hosted-evidence-secrets.mjs` already classifies explicitly.
 */
export const REPORTED_BASELINE_NAMES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
];

/**
 * Values shorter than this are excluded from the output scrubber. Redacting a 1-3
 * character value would rewrite unrelated text (a lone "1" appears in every table), and
 * the scrubber is defence in depth, not the primary guarantee: no code path interpolates
 * a loaded value into output at all, whatever its length.
 */
export const MIN_SCRUBBABLE_VALUE_LENGTH = 8;

/** A single-value file larger than this is skipped as "not a single-value file". */
export const MAX_VALUE_FILE_BYTES = 4096;

class UsageError extends Error {}

// --------------------------------------------------------------------------- parsing

/**
 * Parse KEY=VALUE text. Returns a Map of name -> value in file order.
 * Throws a UsageError naming `label` and the 1-based line NUMBER (never the content)
 * when a line is neither blank, nor a comment, nor a well-formed assignment.
 */
export function parseEnvText(text, label) {
  const entries = new Map();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) {
      throw new UsageError(
        `unparseable line in ${label}: line ${index + 1} is not blank, a comment, or KEY=VALUE`,
      );
    }
    let key = line.slice(0, equals).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new UsageError(
        `unparseable line in ${label}: line ${index + 1} has a malformed variable name`,
      );
    }
    let value = line.slice(equals + 1).trim();
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (quoted) {
      value = quoted[1] ?? quoted[2];
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    entries.set(key, value);
  }
  return entries;
}

/** file name -> variable name: drop the extension, non-alphanumerics become `_`, upper. */
export function variableNameForFile(fileName) {
  const withoutExtension = fileName.replace(/\.[^.]*$/, "");
  const candidate = withoutExtension.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return /^[A-Z][A-Z0-9_]*$/.test(candidate) ? candidate : null;
}

/**
 * Read one directory of one-value-per-file secrets. Every rejected file is reported by
 * NAME with a reason; nothing about its content reaches the report.
 */
export function loadDirectorySource(directory) {
  const entries = new Map();
  const skips = [];
  let fileNames;
  try {
    fileNames = fs.readdirSync(directory).sort();
  } catch (error) {
    return { entries, skips, missing: true, reason: describeFilesystemError(error) };
  }
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      skips.push({ fileName, reason: describeFilesystemError(error) });
      continue;
    }
    if (!stat.isFile()) {
      skips.push({ fileName, reason: "not a regular file" });
      continue;
    }
    if (stat.size > MAX_VALUE_FILE_BYTES) {
      skips.push({
        fileName,
        reason: `larger than ${MAX_VALUE_FILE_BYTES} bytes; not a single-value file`,
      });
      continue;
    }
    const variableName = variableNameForFile(fileName);
    if (!variableName) {
      skips.push({ fileName, reason: "file name does not map to a variable name" });
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      skips.push({ fileName, reason: describeFilesystemError(error) });
      continue;
    }
    const value = raw.replace(/\n$/, "");
    if (value.includes("\n") || value.includes("\0")) {
      skips.push({ fileName, reason: "not a single-line value" });
      continue;
    }
    if (value === "") {
      skips.push({ fileName, reason: "empty file" });
      continue;
    }
    // Mode is reported, not enforced: a loosened mode is the owner's to fix, and failing
    // here would turn a hygiene warning into an outage in the middle of a test run.
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      skips.push({
        fileName,
        reason: `readable beyond the owner (mode ${mode.toString(8).padStart(4, "0")}); value still loaded`,
      });
    }
    entries.set(variableName, value);
  }
  return { entries, skips, missing: false, reason: null };
}

function describeFilesystemError(error) {
  const code = error && typeof error === "object" ? error.code : null;
  if (code === "ENOENT") return "path does not exist";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "ENOTDIR") return "path is not a directory";
  return `unreadable (${code ?? "unknown error"})`;
}

/** Read one KEY=VALUE file. A missing file is a named skip, not an error. */
export function loadEnvFileSource(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    return {
      entries: new Map(),
      skips: [],
      missing: true,
      reason: describeFilesystemError(error),
    };
  }
  return {
    entries: parseEnvText(text, filePath),
    skips: [],
    missing: false,
    reason: null,
  };
}

// ------------------------------------------------------------------------- assembling

/**
 * Read every configured source in precedence order (highest first) and produce:
 *   - `assembled`: the full environment to hand a child process
 *   - `resolution`: name -> { source, present } for the reported names only
 *   - `sourceReports`: one entry per source, loaded/skipped with a reason
 *   - `loadedValues`: every value read from a NON-ambient source, for the scrubber
 */
export function assembleEnvironment({ sources, ambient, only }) {
  const assembled = { ...ambient };
  const ownerBySource = new Map();
  const sourceReports = [];
  const loadedValues = new Set();
  const contributedNames = new Set();

  for (const source of sources) {
    if (source.kind === "ambient") {
      sourceReports.push({
        name: source.name,
        path: null,
        status: "loaded",
        reason: null,
        count: Object.keys(ambient).length,
        skips: [],
      });
      for (const [name, value] of Object.entries(ambient)) {
        if (typeof value === "string" && value !== "" && !ownerBySource.has(name)) {
          ownerBySource.set(name, source.name);
        }
      }
      continue;
    }
    let loaded;
    if (source.kind === "directory") loaded = loadDirectorySource(source.path);
    else loaded = loadEnvFileSource(source.path);

    if (loaded.missing) {
      sourceReports.push({
        name: source.name,
        path: source.path,
        status: "skipped",
        reason: loaded.reason,
        count: 0,
        skips: [],
      });
      continue;
    }
    sourceReports.push({
      name: source.name,
      path: source.path,
      status: "loaded",
      reason: null,
      count: loaded.entries.size,
      skips: loaded.skips,
    });
    for (const [name, value] of loaded.entries) {
      contributedNames.add(name);
      if (value.length >= MIN_SCRUBBABLE_VALUE_LENGTH) loadedValues.add(value);
      // Precedence: the first source to supply a non-empty value wins, and sources are
      // visited highest-first, so a lower source never overwrites a higher one.
      if (value === "") continue;
      if (assembled[name] === undefined || assembled[name] === "") {
        assembled[name] = value;
      }
      if (!ownerBySource.has(name)) ownerBySource.set(name, source.name);
    }
  }

  const ambientSecretNames = new Set(
    collectSecretRepresentations(ambient).map((representation) => representation.name),
  );
  const reportedNames = new Set([
    ...REPORTED_BASELINE_NAMES,
    ...contributedNames,
    ...ambientSecretNames,
  ]);
  const resolution = new Map();
  for (const name of [...reportedNames].sort()) {
    if (only.length > 0 && !only.includes(name)) continue;
    const value = assembled[name];
    const present = typeof value === "string" && value !== "";
    resolution.set(name, {
      source: present ? (ownerBySource.get(name) ?? "unattributed") : null,
      present,
    });
  }
  return { assembled, resolution, sourceReports, loadedValues: [...loadedValues] };
}

// ---------------------------------------------------------------------------- output

/**
 * Build the guarded writer pair. Every write is scrubbed against the representations of
 * every loaded value and then re-scanned; a surviving representation aborts the process
 * rather than emitting the line.
 */
export function createGuardedWriters(loadedValues, streams = process) {
  const textRepresentations = [];
  const byteRepresentations = [];
  for (const value of loadedValues) {
    for (const representation of secretRepresentationsForValue(value)) {
      textRepresentations.push({ name: "loaded-value", value: representation });
      byteRepresentations.push({
        name: "loaded-value",
        bytes: Buffer.from(representation, "utf8"),
      });
    }
  }
  const guard = (text) => {
    const scrubbed = scrubText(text, textRepresentations);
    if (
      byteRepresentations.length > 0 &&
      findSecretRepresentation(
        Buffer.from(scrubbed, "utf8"),
        byteRepresentations,
        "secrets-prefill output",
      )
    ) {
      throw new Error(
        "refusing to write output: a loaded value survived scrubbing (this is a bug)",
      );
    }
    return scrubbed;
  };
  return {
    out: (text) => streams.stdout.write(guard(text)),
    err: (text) => streams.stderr.write(guard(text)),
    guard,
  };
}

export function formatSourceReports(sourceReports) {
  const lines = ["Sources, highest precedence first:"];
  for (const report of sourceReports) {
    const location = report.path === null ? "(process environment)" : report.path;
    if (report.status === "skipped") {
      lines.push(`  - ${report.name}: SKIPPED — ${report.reason} — ${location}`);
      continue;
    }
    lines.push(`  - ${report.name}: loaded ${report.count} name(s) — ${location}`);
    for (const skip of report.skips) {
      lines.push(`      · ${skip.fileName}: ${skip.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatResolution(resolution) {
  const rows = [...resolution.entries()];
  const nameWidth = rows.reduce((width, [name]) => Math.max(width, name.length), 4);
  const lines = [
    `${"NAME".padEnd(nameWidth)}  ${"SOURCE".padEnd(24)}  STATUS`,
    `${"-".repeat(nameWidth)}  ${"-".repeat(24)}  ------`,
  ];
  for (const [name, entry] of rows) {
    lines.push(
      `${name.padEnd(nameWidth)}  ${(entry.source ?? "-").padEnd(24)}  ` +
        `${entry.present ? "present" : "absent"}`,
    );
  }
  const presentCount = rows.filter(([, entry]) => entry.present).length;
  lines.push("");
  lines.push(`${presentCount} of ${rows.length} reported name(s) present. Values are never printed.`);
  return lines.join("\n");
}

export const HELP_TEXT = `secrets-prefill — assemble the run environment from local sources and inject it.

Usage:
  node scripts/secrets-prefill.mjs --list [options]
  node scripts/secrets-prefill.mjs --write <path> [options]
  node scripts/secrets-prefill.mjs [options] -- <command> [args...]
  node scripts/secrets-prefill.mjs --help

Modes:
  --list                 Print the resolved NAME / SOURCE / present-absent table and exit 0.
                         This is the only reporting mode; it prints no values, ever.
  -- <command> [args...] Injection mode. Runs <command> with the assembled environment,
                         inheriting stdio, and exits with the child's exit code. The
                         environment is passed through the process table only — nothing
                         is written to disk to do it.
  --write <path>         Write the reported present names to <path> as KEY=VALUE, mode
                         0600. REFUSES unless git reports the path as untracked AND
                         ignored; the refusal names the path and the reason and exits 1.
                         It also refuses a symbolic link, a hard-linked file and a
                         non-regular file BEFORE asking git, because both git questions
                         are about the name and not about the bytes it reaches, and it
                         opens with O_NOFOLLOW so a link planted after the check is not
                         followed either.
                         Scope: without --only this writes EVERY reported present name,
                         which includes every secret-shaped ambient variable. Pair it
                         with --only to choose the blast radius.
  --help                 This text.

Options:
  --source <path>        Add a source, repeatable, highest-precedence first among the
                         explicit sources and above every default source. A path that is
                         a directory is read as one-value-per-file (file name mapped to a
                         variable name: extension dropped, non-alphanumerics to '_',
                         upper-cased); any other path is read as a KEY=VALUE file.
  --no-default-sources   Use only --source entries (and the ambient environment).
  --no-ambient           Do not seed from the current process environment. Injection mode
                         then hands the child only what the sources supplied.
  --only <NAME>          Restrict the reported set to <NAME>, repeatable. This governs
                         both --list and what --write emits, so "--write <path> --only
                         OPENROUTER_API_KEY" writes exactly that one name. It does not
                         change what injection mode passes to the child, which is the
                         whole assembled environment.

Source precedence, highest first (the defaults):
  1. ambient-env               the current process environment
  2. integration-worktree-env  /Users/DanBot/Documents/ChatGPT/dfg-integration-20260807-135127/.env
  3. private-evidence-dir      …/dfg-evidence-20260807-135127/s11/PRIVATE-do-not-share
                               (stably-api-key.txt -> STABLY_API_KEY,
                                stably-project-id.txt -> STABLY_PROJECT_ID)
  4. repo-root-env             <repo>/.env  (gitignored)
  Explicit --source entries sort between 1 and 2, in the order given.
  A missing source is a SKIP with a named reason, never an error and never a silent zero.

Exit codes:
  0  success (--list, --help, --write allowed) or, in injection mode, the child's 0
  1  refusal: --write target is tracked or not ignored (or the child exited 1)
  2  usage or environment error (or the child exited 2)

Guarantees:
  · No value is printed in any mode, including --help, --list and every error path. Error
    messages about unparseable sources name the file and the LINE NUMBER only.
  · Every byte this script writes is scrubbed against the representations of every value
    it loaded FROM A FILE OR DIRECTORY SOURCE, and re-scanned, before it is emitted.
    Ambient values are not in the scrubber's input set because no path prints one.
  · Injection mode inherits the child's stdio: what the CHILD prints is the child's
    responsibility. Point it at a command that does not print secrets.

Examples:
  node scripts/secrets-prefill.mjs --list
  node scripts/secrets-prefill.mjs -- node scripts/smoke-openrouter.mjs --require-key
  node scripts/secrets-prefill.mjs --source ./my-secrets.env --no-default-sources --list
  node scripts/secrets-prefill.mjs --only OPENROUTER_API_KEY --write ./local.env
`;

// ------------------------------------------------------------------------------- git

function gitSays(args, cwd) {
  const result = spawnSync("git", args, { cwd, stdio: "ignore" });
  if (result.error) {
    throw new UsageError(`git is required for --write but could not be run: ${result.error.code}`);
  }
  return result.status === 0;
}

/**
 * Decide whether `--write <target>` is allowed. Allowed only when git reports the path as
 * BOTH untracked and ignored. Returns { allowed, reason }.
 *
 * The git queries run in the target's OWN directory, not in this repository: `--write`
 * may legitimately point outside this clone, and asking this repo about a path it has
 * never heard of would answer "untracked, unignored" for the wrong reason. A target that
 * is in no git repository at all is refused — an unanswerable question fails closed.
 */
/**
 * The (device, inode) pair a directory path names RIGHT NOW, or null if the path is not a
 * directory. `lstat`, not `stat`: a symlink named as the parent must not be resolved into
 * the identity of what it points at, or the caller's later comparison would be satisfied
 * by exactly the swap it exists to detect.
 */
export function directoryIdentity(directoryPath) {
  let stats;
  try {
    // Device and inode identifiers are platform-sized integers. BigInt avoids treating
    // two distinct 64-bit identities as equal after Number precision loss.
    stats = fs.lstatSync(directoryPath, { bigint: true });
  } catch {
    return null;
  }
  if (!stats.isDirectory()) return null;
  return { dev: stats.dev, ino: stats.ino };
}

export function classifyWriteTarget(target, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, target);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new UsageError(`--write target directory does not exist: ${parent}`);
  }
  // Every git answer below is about the string `resolved`, so it is only worth anything
  // while that string keeps naming the same directory. The identity is captured here and
  // re-checked at open time; see `openGuardedWriteDescriptor`.
  const parentIdentity = directoryIdentity(parent);
  if (parentIdentity === null) {
    return {
      resolved,
      parentIdentity: null,
      allowed: false,
      reason:
        "the target's parent is not a directory (a symbolic link named as the parent is " +
        "refused rather than resolved: git would answer about a path that reaches " +
        "somewhere else)",
    };
  }
  // `path.resolve` is LEXICAL: it does not resolve symlinks. Every git question below is
  // therefore a question about this NAME, not about the bytes the name reaches. An
  // ignored-and-untracked symlink aimed at a tracked file answers "untracked" and
  // "ignored" correctly about itself while the write lands in the tracked file — both
  // branches evaluate as designed and a credential still becomes committable. So the
  // filesystem is interrogated first, with `lstat`, which never follows a link, and a
  // link is refused outright rather than resolved and re-asked about: refusing cannot be
  // subtly wrong, and no legitimate caller needs to write a secret through a link.
  let targetStats = null;
  try {
    targetStats = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new UsageError(`--write target cannot be inspected: ${error.code}`);
    }
  }
  if (targetStats?.isSymbolicLink()) {
    return {
      resolved,
      parentIdentity,
      allowed: false,
      reason:
        "this path is a symbolic link; git would answer about the link while the write " +
        "landed on whatever it points at, so a link is refused without asking git",
    };
  }
  if (targetStats && !targetStats.isFile()) {
    return {
      resolved,
      parentIdentity,
      allowed: false,
      reason: "this path exists and is not a regular file",
    };
  }
  if (targetStats && targetStats.nlink > 1) {
    // A hard link defeats the git questions exactly as a symlink does, with no link to
    // see: the other name for these bytes can be tracked while this one is not.
    return {
      resolved,
      parentIdentity,
      allowed: false,
      reason:
        `this path has ${targetStats.nlink} hard links; another name for the same bytes ` +
        "may be tracked, and git was only asked about this one",
    };
  }
  if (!gitSays(["rev-parse", "--is-inside-work-tree"], parent)) {
    return {
      resolved,
      parentIdentity,
      allowed: false,
      reason:
        "path is not inside a git repository, so neither tracked-ness nor ignored-ness can be established",
    };
  }
  const tracked = gitSays(["ls-files", "--error-unmatch", "--", resolved], parent);
  if (tracked) {
    return {
      resolved,
      parentIdentity,
      allowed: false,
      reason: "git tracks this path; writing a secret here would commit it",
    };
  }
  const ignored = gitSays(["check-ignore", "--quiet", "--", resolved], parent);
  if (!ignored) {
    return {
      resolved,
      parentIdentity,
      allowed: false,
      reason: "git does not ignore this path; an untracked-but-unignored file is one `git add .` from being committed",
    };
  }
  return { resolved, parentIdentity, allowed: true, reason: null };
}

/** A refusal raised by the descriptor-level guard below, distinct from a usage error. */
class WriteRefusal extends Error {}

/**
 * Open `resolved` for writing without ever following a link, and hand back a descriptor
 * that is already mode 0600 and truncated. Throws `WriteRefusal` instead of opening.
 *
 * This is the TOCTOU half of the write guard, and it is a SEPARATE layer from the `lstat`
 * in `classifyWriteTarget` on purpose. That `lstat` answers "is this a link right now",
 * which on its own is a check-then-use race: the name can be re-pointed in the window
 * between the answer and the write.
 *
 * FOUR conditions, and it takes all four, because each one alone has a documented escape:
 *
 *   1. O_NOFOLLOW — open() itself fails if the FINAL path component is a symlink, so a
 *      link planted inside the window is never followed. It covers the final component
 *      and nothing above it, which is why 4 exists.
 *   2. `fstat().nlink === 1` on the descriptor actually held, not on a name that may since
 *      have been re-pointed. A hard link defeats the git questions with no link to see.
 *   3. `fstat().isFile()` — `classifyWriteTarget` refuses a non-regular file, but that was
 *      a question about the name, and a FIFO or a device planted in the window reached
 *      this open. O_NONBLOCK is requested for the same reason: opening a FIFO for writing
 *      with no reader BLOCKS FOREVER, and a script whose whole contract is to fail loudly
 *      must not hang without a message. With O_NONBLOCK that open fails ENXIO instead.
 *      (On a regular file O_NONBLOCK is a no-op.)
 *   4. the PARENT still names the same directory inode it named when git was asked, and
 *      the path still names the same file inode the descriptor holds. O_NOFOLLOW covers
 *      only the last component by definition, so replacing an ancestor DIRECTORY with a
 *      symlink inside the window redirected the whole open — a real, reproduced escape:
 *      classify `repo/ok/secrets.env` (untracked, ignored, allowed), swap `repo/ok` for a
 *      symlink to `repo/real`, and the write landed in the tracked `repo/real/secrets.env`.
 *      Comparing (dev, ino) rather than the string catches ANY ancestor swap, because a
 *      swap that changes what the parent path reaches necessarily changes which inode the
 *      parent path lstats to. The second half — the descriptor's inode against the inode
 *      the path lstats to now — is what stops an attacker restoring the directory after
 *      the open so the parent check passes over a descriptor already pointing elsewhere.
 *
 * Node exposes no `openat(2)`, so 4 is an identity check rather than an atomic
 * directory-relative open; its residual is stated in `docs/testing/secrets-and-smoke.md`.
 *
 * O_TRUNC is deliberately NOT requested: truncating at open time would destroy the file
 * before any of these questions could be answered. The truncation happens after all four,
 * on the descriptor. So does the chmod — the previous `chmodSync(path)` followed a symlink
 * and silently rewrote a tracked file's mode through exactly this hole.
 */
export function openGuardedWriteDescriptor(resolved, expectedParentIdentity) {
  if (!expectedParentIdentity || typeof expectedParentIdentity.ino !== "bigint") {
    // Not a defaultable argument: silently re-deriving the identity here would compare the
    // parent against itself and re-open exactly the hole this parameter closes.
    throw new WriteRefusal(
      "the caller supplied no parent-directory identity to check against, so an ancestor " +
        "swap between the git check and this open could not be ruled out",
    );
  }
  const parent = path.dirname(resolved);
  const parentBefore = directoryIdentity(parent);
  if (
    parentBefore === null ||
    parentBefore.dev !== expectedParentIdentity.dev ||
    parentBefore.ino !== expectedParentIdentity.ino
  ) {
    throw new WriteRefusal(
      "the target's parent directory is no longer the directory git was asked about; an " +
        "ancestor of this path was replaced after the check",
    );
  }

  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (
    !Number.isInteger(noFollow) ||
    noFollow <= 0 ||
    !Number.isInteger(nonBlock) ||
    nonBlock <= 0
  ) {
    throw new WriteRefusal(
      "this platform does not expose the no-follow and nonblocking open flags required " +
        "for a fail-closed secret write",
    );
  }

  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow | nonBlock,
      0o600,
    );
  } catch (error) {
    throw new WriteRefusal(
      `the path could not be opened as a plain unlinked file (${error.code})`,
    );
  }

  const refuse = (message) => {
    fs.closeSync(descriptor);
    throw new WriteRefusal(message);
  };
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile()) {
    refuse("the opened file is not a regular file; something was planted at this path");
  }
  if (opened.nlink > 1n) {
    refuse(
      `the opened file has ${opened.nlink} hard links; another name for the same bytes ` +
        "may be tracked",
    );
  }
  // Re-asked AFTER the open, against the descriptor being held. Everything before this
  // point described a name; this is the first question about the object.
  const parentAfter = directoryIdentity(parent);
  if (
    parentAfter === null ||
    parentAfter.dev !== expectedParentIdentity.dev ||
    parentAfter.ino !== expectedParentIdentity.ino
  ) {
    refuse(
      "the target's parent directory changed identity while the file was being opened; " +
        "the descriptor may not be the file git was asked about",
    );
  }
  let named;
  try {
    named = fs.lstatSync(resolved, { bigint: true });
  } catch (error) {
    refuse(`the target path could no longer be inspected after opening it (${error.code})`);
  }
  if (named.dev !== opened.dev || named.ino !== opened.ino) {
    refuse(
      "the open descriptor is not the file this path names; the path was redirected " +
        "between the check and the open",
    );
  }

  fs.fchmodSync(descriptor, 0o600);
  fs.ftruncateSync(descriptor, 0);
  return descriptor;
}

function quoteEnvValue(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// -------------------------------------------------------------------------- argv/main

export function parseArguments(argv) {
  const options = {
    mode: null,
    sources: [],
    useDefaults: true,
    useAmbient: true,
    only: [],
    writePath: null,
    command: [],
  };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      options.command = argv.slice(index + 1);
      break;
    }
    if (argument === "--help" || argument === "-h") {
      options.mode = "help";
      continue;
    }
    if (argument === "--list") {
      if (options.mode === "write") throw new UsageError("--list and --write are exclusive");
      if (options.mode !== "help") options.mode = "list";
      continue;
    }
    if (argument === "--no-default-sources") {
      options.useDefaults = false;
      continue;
    }
    if (argument === "--no-ambient") {
      options.useAmbient = false;
      continue;
    }
    if (argument === "--source" || argument === "--only" || argument === "--write") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new UsageError(`${argument} requires a value`);
      }
      if (argument === "--source") options.sources.push(value);
      else if (argument === "--only") options.only.push(value);
      else {
        if (options.mode === "list") throw new UsageError("--list and --write are exclusive");
        if (options.writePath !== null) throw new UsageError("--write may be given once");
        options.writePath = value;
        if (options.mode !== "help") options.mode = "write";
      }
      index += 1;
      continue;
    }
    throw new UsageError(`unknown option: ${argument}`);
  }
  if (options.mode === null) {
    options.mode = options.command.length > 0 ? "inject" : "help";
  }
  if (options.mode === "inject" && options.command.length === 0) {
    throw new UsageError("injection mode needs a command after `--`");
  }
  return options;
}

export function buildSourceList(options) {
  const explicit = options.sources.map((sourcePath) => {
    const resolved = path.resolve(sourcePath);
    let kind = "env-file";
    try {
      if (fs.statSync(resolved).isDirectory()) kind = "directory";
    } catch {
      // A missing explicit source stays an env-file and is reported as a named skip.
    }
    return { kind, name: `source:${sourcePath}`, path: resolved };
  });
  const defaults = options.useDefaults
    ? DEFAULT_SOURCES.filter((source) => source.kind !== "ambient")
    : [];
  const ambient = options.useAmbient
    ? [DEFAULT_SOURCES.find((source) => source.kind === "ambient")]
    : [];
  return [...ambient, ...explicit, ...defaults];
}

export async function run(argv, environment = process.env, streams = process) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const writers = createGuardedWriters([], streams);
    writers.err(`secrets-prefill: ${error.message}\n`);
    writers.err("Run with --help for usage.\n");
    return 2;
  }

  if (options.mode === "help") {
    const writers = createGuardedWriters([], streams);
    writers.out(HELP_TEXT);
    return 0;
  }

  const sources = buildSourceList(options);
  const ambient = options.useAmbient ? { ...environment } : {};
  let assembly;
  try {
    assembly = assembleEnvironment({ sources, ambient, only: options.only });
  } catch (error) {
    // Even here the message is file+line only; scrub anyway in case a source name is odd.
    const writers = createGuardedWriters([], streams);
    writers.err(`secrets-prefill: ${error.message}\n`);
    return 2;
  }
  const writers = createGuardedWriters(assembly.loadedValues, streams);

  if (options.mode === "list") {
    writers.out(`${formatSourceReports(assembly.sourceReports)}\n\n`);
    writers.out(`${formatResolution(assembly.resolution)}\n`);
    return 0;
  }

  if (options.mode === "write") {
    let verdict;
    try {
      verdict = classifyWriteTarget(options.writePath);
    } catch (error) {
      writers.err(`secrets-prefill: ${error.message}\n`);
      return 2;
    }
    if (!verdict.allowed) {
      writers.err(
        `secrets-prefill: refusing to write ${verdict.resolved}: ${verdict.reason}\n`,
      );
      return 1;
    }
    const names = [...assembly.resolution.keys()].filter(
      (name) => assembly.resolution.get(name).present,
    );
    const body = names
      .map((name) => `${name}=${quoteEnvValue(assembly.assembled[name])}`)
      .join("\n");
    let descriptor;
    try {
      descriptor = openGuardedWriteDescriptor(verdict.resolved, verdict.parentIdentity);
    } catch (error) {
      writers.err(
        `secrets-prefill: refusing to write ${verdict.resolved}: ${error.message}\n`,
      );
      return 1;
    }
    try {
      fs.writeSync(descriptor, `${body}\n`, 0, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    writers.out(`secrets-prefill: wrote ${names.length} name(s) to ${verdict.resolved} (mode 0600)\n`);
    return 0;
  }

  // Injection mode. The environment reaches the child through the process table only.
  const [command, ...args] = options.command;
  const child = spawn(command, args, {
    env: assembly.assembled,
    stdio: "inherit",
    cwd: process.cwd(),
  });
  return await new Promise((resolve) => {
    child.on("error", (error) => {
      writers.err(`secrets-prefill: could not run ${command}: ${error.code ?? error.message}\n`);
      resolve(2);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        writers.err(`secrets-prefill: ${command} terminated on ${signal}\n`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}

export { UsageError, WriteRefusal };
