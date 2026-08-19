#!/usr/bin/env node
/**
 * Fail the build when a secret-shaped string appears in a diff.
 *
 * Scope, deliberately the prior art's: **added lines only**. `git diff --unified=0
 * <base>..<head>`, every `^+` line that is not a `+++` header. That is the shape the
 * pre-push scan used when it checked 26,986 added lines against the pattern set below.
 *
 * Two complementary halves:
 *
 *   · **Shape patterns** (this file). Fourteen patterns, reproducing the pre-push scan's
 *     printed report row for row. They catch a credential *shape* that nobody's
 *     environment happens to hold — a key pasted into a fixture, a colleague's token.
 *   · **The value-derived check** (`env-value`). `collectSecretRepresentations` from
 *     `scripts/hosted-evidence-secrets.mjs` expands every secret-shaped variable in this
 *     process's environment into all ten of its encodings (raw, JSON-escaped, percent,
 *     strict RFC3986, `+`-for-space, form, base64, base64url, …) and the added lines are
 *     searched for those. This catches the real leak the regexes miss: the actual key,
 *     base64'd into a fixture, in a shape no pattern anticipates.
 *
 * There is no second representation generator here. Writing one would be exactly the
 * duplication failure this wave rejects; the reviewed one is imported.
 *
 * Reporting rule, absolute: **counts and file names only.** Never a matched substring,
 * never a line's content, never a line number. Everything this script prints is built
 * from a pattern's own name, a count, and a path already in the diff's file list.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSecretRepresentations } from "./hosted-evidence-secrets.mjs";

/**
 * The pattern set: the superset of the fourteen rows the pre-push scan printed.
 *
 * The brief's prose calls it "12 credential patterns" while the pasted report prints 14
 * labelled rows; rows 11-14 are host/PII leaks rather than credentials, which is the most
 * likely origin of the drift. The instruction is to take the superset, so all fourteen
 * ship, each with a stable id and the human name the prior art printed.
 */
export const PATTERNS = [
  {
    id: "openai-sk",
    name: "openai sk-",
    // Covers OpenRouter's own `sk-or-v1-…` as well as OpenAI's `sk-…`.
    regex: /\bsk-[A-Za-z0-9_-]{16,}/,
  },
  { id: "aws-akia", name: "aws AKIA", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: "github-token",
    name: "github ghp/pat",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  { id: "slack-token", name: "slack xox", regex: /\bxox[abceoprs]-[A-Za-z0-9-]{10,}/ },
  {
    id: "private-key",
    name: "private key",
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  },
  { id: "google-api-key", name: "google AIza", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    id: "jwt",
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  { id: "tailscale-key", name: "tailscale tskey", regex: /\btskey-[A-Za-z0-9-]{10,}/ },
  {
    id: "ngrok-authtoken",
    name: "ngrok authtoken-shaped",
    regex: /\b[0-9A-Za-z]{20,}_[0-9A-Za-z]{20,}\b/,
  },
  {
    id: "generic-key-long",
    name: "generic key=long",
    regex:
      /(?:api[_-]?key|secret|token|password|passwd|credential)["'\s]*[=:]["'\s]*[A-Za-z0-9/+_-]{20,}/i,
  },
  { id: "tailnet-host", name: "tailnet host", regex: /\b[a-z0-9-]+\.ts\.net\b/i },
  {
    id: "ngrok-domain",
    name: "ngrok domain",
    regex: /\b[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev)\b/i,
  },
  {
    id: "operator-email",
    name: "operator email",
    // The operator's own address is deliberately NOT embedded here — writing it into a
    // tracked file would be the leak this gate exists to prevent. Instead: any address
    // that is not on the documented example/reserved list below.
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    reject: (line) =>
      /@(?:[A-Za-z0-9.-]*\.)?(?:example\.(?:com|org|net)|invalid|localhost|test|noreply\.github\.com|anthropic\.com|users\.noreply\.github\.com)\b/i.test(
        line,
      ),
  },
  {
    id: "local-abs-path",
    name: "local abs path",
    regex: /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Z]:\\Users\\)/,
  },
];

/** Human name for the value-derived row, printed after the fourteen shape rows. */
export const ENV_VALUE_PATTERN = {
  id: "env-value",
  name: "env var value (any encoding)",
};

/**
 * A representation shorter than this is not searched for. A three-character value would
 * match nearly every line and turn the gate into noise; the shape patterns above remain
 * responsible for short-but-structured credentials.
 */
export const MIN_ENV_VALUE_LENGTH = 12;

/**
 * Allowlist: exact repo-relative path + pattern id + a REQUIRED one-line reason.
 * An entry without a reason fails the gate itself (see `validateAllowlist`) — an
 * unexplained allowlist entry is how a real leak gets waved through a year later.
 *
 * `patternId: "*"` covers every SHAPE pattern for that path, for a file whose whole
 * purpose is to hold one fixture per pattern. It deliberately does NOT cover `env-value`:
 * a real key encoded into a fixture must fail the gate whatever file it is in, so the one
 * check that searches for actual environment values can never be wildcarded away.
 *
 * Stored in this file rather than beside it: this lane's writable set covers
 * `scripts/secret-diff-gate*.mjs` only, and an allowlist the gate cannot read is worse
 * than one that is slightly harder to skim.
 */
export const ALLOWLIST = [
  {
    path: "server/test/raindrop-context.test.ts",
    patternId: "openai-sk",
    reason:
      "Raindrop context fixture pins a synthetic sk- shaped string so the redaction test has something to redact.",
  },
  {
    path: "server/test/raindrop-context.test.ts",
    patternId: "generic-key-long",
    reason:
      "Same fixture: the redaction assertions need key=<long> shaped lines to prove the scrubber rewrites them.",
  },
  {
    path: "scripts/secret-diff-gate.test.mjs",
    patternId: "*",
    reason:
      "This gate's own fixture file plants one obviously fake value per shape pattern; that is the only way to prove each pattern fires. env-value stays enforced here.",
  },
  {
    path: "scripts/smoke-openrouter.test.mjs",
    patternId: "openai-sk",
    reason:
      "A literal sk- shaped string proves the smoke test refuses a key passed on the command line; it belongs to no account.",
  },
  {
    path: "scripts/secrets-prefill.mjs",
    patternId: "local-abs-path",
    reason:
      "The documented default source paths are absolute by necessity (lane F10 brief, D1.1); a home-directory path is a location, not a credential.",
  },
  {
    path: "docs/testing/secrets-and-smoke.md",
    patternId: "local-abs-path",
    reason:
      "The source-precedence table in the docs names those same default paths; documenting them is the point of the table.",
  },
];

export const USAGE = `secret-diff-gate — fail the build when a secret-shaped string appears in a diff.

Usage:
  node scripts/secret-diff-gate.mjs --base <sha> [--head <sha>]
  node scripts/secret-diff-gate.mjs --base <sha> --worktree
  node scripts/secret-diff-gate.mjs --help

Options:
  --base <sha>     Required. The commit the diff is measured from.
  --head <sha>     Defaults to HEAD. Ignored when --worktree is given.
  --worktree       Compare <base> against the working tree instead of a commit: tracked
                   modifications plus every untracked, non-ignored file (whose whole
                   content counts as added lines). This is the mode a lane uses before its
                   work is committed.
  --repo <path>    Repository root; defaults to this script's repository.
  --require-env-values
                   Exit 2 if the process holds no secret-shaped variables, i.e. if the
                   value-derived half of the gate had nothing to search for. Use this in
                   CI with the real secrets mapped into the job environment: without it a
                   job that ships no secrets reports a clean zero forever, which is the
                   strongest half of this gate silently not running.
  --help           This text.

Scope: ADDED lines only (git diff --unified=0), i.e. '+' lines that are not '+++' headers.

Output: pattern name, count, and file names. Never a matched substring, never a line's
content, never a line number.

Exit codes:
  0  clean
  1  findings (at least one non-allowlisted hit)
  2  usage or environment error, an allowlist entry without a reason, a git failure, or
     --require-env-values with no secret-shaped variable in the environment
`;

class UsageError extends Error {}
class EnvironmentError extends Error {}

// ------------------------------------------------------------------------------- git

function git(args, repository) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf-8" });
  if (result.error) {
    throw new EnvironmentError(`git could not be run: ${result.error.code}`);
  }
  if (result.status !== 0) {
    throw new EnvironmentError(
      `git ${args[0]} failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Added lines of a unified diff, grouped by the file they were added to.
 * Returns Map<repoRelativePath, string[]>.
 */
export function addedLinesByFile(diffText) {
  const byFile = new Map();
  let current = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (!line.startsWith("+")) continue;
    if (current === null) continue;
    byFile.get(current).push(line.slice(1));
  }
  return byFile;
}

function collectDiff({ repository, base, head, worktree }) {
  const byFile = worktree
    ? addedLinesByFile(git(["diff", "--unified=0", base, "--"], repository))
    : addedLinesByFile(git(["diff", "--unified=0", `${base}..${head}`, "--"], repository));
  if (!worktree) return byFile;
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repository)
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const relativePath of untracked) {
    // An untracked file has no blob to diff against: its whole content is added content.
    let content;
    try {
      content = fs.readFileSync(path.join(repository, relativePath), "utf-8");
    } catch {
      continue;
    }
    const existing = byFile.get(relativePath) ?? [];
    byFile.set(relativePath, [...existing, ...content.split("\n")]);
  }
  return byFile;
}

// --------------------------------------------------------------------------- scanning

export function validateAllowlist(allowlist = ALLOWLIST) {
  const knownIds = new Set([...PATTERNS.map((pattern) => pattern.id), ENV_VALUE_PATTERN.id]);
  for (const entry of allowlist) {
    if (!entry.path || !entry.patternId) {
      throw new UsageError("allowlist entry is missing a path or a pattern id");
    }
    if (entry.patternId !== "*" && !knownIds.has(entry.patternId)) {
      throw new UsageError(
        `allowlist entry for ${entry.path} names unknown pattern id "${entry.patternId}"`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      throw new UsageError(
        `allowlist entry ${entry.path}/${entry.patternId} has no usable reason; ` +
          "an unexplained allowlist entry is itself a gate failure",
      );
    }
  }
  return true;
}

/**
 * Representations of the secret-shaped variables in `environment`, long enough to be
 * worth searching for. Names are kept so the report can say WHICH variable leaked —
 * a name is not a value.
 */
export function environmentRepresentations(environment = process.env) {
  return collectSecretRepresentations(environment).filter(
    (representation) => representation.value.length >= MIN_ENV_VALUE_LENGTH,
  );
}

/**
 * Scan added lines. Returns
 *   { rows: [{ id, name, total, files: [{ path, count, allowlisted, names? }] }], failing }
 * `failing` counts only non-allowlisted hits.
 */
export function scanAddedLines(byFile, options = {}) {
  const allowlist = options.allowlist ?? ALLOWLIST;
  const representations = options.representations ?? environmentRepresentations();
  const allowed = new Set(allowlist.map((entry) => `${entry.path} ${entry.patternId}`));
  // `*` covers the shape patterns for a path, never the value-derived check.
  const isAllowlisted = (filePath, patternId) =>
    allowed.has(`${filePath} ${patternId}`) ||
    (patternId !== ENV_VALUE_PATTERN.id && allowed.has(`${filePath} *`));
  const rows = [];
  let failing = 0;

  for (const pattern of PATTERNS) {
    const files = [];
    let total = 0;
    for (const [filePath, lines] of byFile) {
      let count = 0;
      for (const line of lines) {
        if (!pattern.regex.test(line)) continue;
        if (pattern.reject && pattern.reject(line)) continue;
        count += 1;
      }
      if (count === 0) continue;
      const allowlisted = isAllowlisted(filePath, pattern.id);
      total += count;
      if (!allowlisted) failing += count;
      files.push({ path: filePath, count, allowlisted });
    }
    rows.push({ id: pattern.id, name: pattern.name, total, files });
  }

  const envFiles = [];
  let envTotal = 0;
  for (const [filePath, lines] of byFile) {
    const names = new Set();
    let count = 0;
    for (const line of lines) {
      const hit = representations.find((representation) => line.includes(representation.value));
      if (!hit) continue;
      names.add(hit.name);
      count += 1;
    }
    if (count === 0) continue;
    const allowlisted = isAllowlisted(filePath, ENV_VALUE_PATTERN.id);
    envTotal += count;
    if (!allowlisted) failing += count;
    envFiles.push({
      path: filePath,
      count,
      allowlisted,
      names: [...names].sort(),
    });
  }
  // A zero here has two completely different meanings — "every encoding of every secret
  // this process holds was searched for and none appeared" and "this process held no
  // secrets, so nothing was searched for" — and the second is the one CI produces by
  // default. The row therefore carries what it actually expanded, so `formatReport` can
  // say `not run` instead of printing an indistinguishable `0`. Counts only: a NAME is
  // printed only alongside a hit, where the leak has already happened.
  const variableNames = new Set(representations.map((representation) => representation.name));
  rows.push({
    id: ENV_VALUE_PATTERN.id,
    name: ENV_VALUE_PATTERN.name,
    total: envTotal,
    files: envFiles,
    variableCount: variableNames.size,
    representationCount: representations.length,
  });

  return { rows, failing };
}

// ---------------------------------------------------------------------------- report

export function formatReport({ rows, header, addedLineCount, fileCount }) {
  const lines = [header, ""];
  lines.push("Counts of ADDED lines matching each pattern, by file. Values never printed.");
  lines.push("");
  for (const row of rows) {
    if (row.id === ENV_VALUE_PATTERN.id && row.variableCount === 0) {
      lines.push(
        `- ${row.name}: not run — 0 secret-shaped variables in the environment`,
      );
      continue;
    }
    if (row.total === 0) {
      const expanded =
        row.id === ENV_VALUE_PATTERN.id
          ? ` (searched ${row.representationCount} representation(s) of ` +
            `${row.variableCount} secret-shaped variable(s))`
          : "";
      lines.push(`- ${row.name}: 0${expanded}`);
      continue;
    }
    lines.push(`- ${row.name}: ${row.total} in ${row.files.length} files`);
    for (const file of row.files) {
      const prefix = file.allowlisted ? "(allowlisted) " : "";
      const names = file.names?.length ? ` [names: ${file.names.join(", ")}]` : "";
      lines.push(`    - ${prefix}${file.path}: ${file.count}${names}`);
    }
  }
  lines.push("");
  lines.push(`Scanned ${addedLineCount} added lines across ${fileCount} files.`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------- argv/main

export function parseArguments(argv) {
  const options = {
    base: null,
    head: "HEAD",
    worktree: false,
    repository: null,
    requireEnvValues: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--worktree") {
      options.worktree = true;
      continue;
    }
    if (argument === "--require-env-values") {
      options.requireEnvValues = true;
      continue;
    }
    if (argument === "--base" || argument === "--head" || argument === "--repo") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new UsageError(`${argument} requires a value`);
      if (argument === "--base") options.base = value;
      else if (argument === "--head") options.head = value;
      else options.repository = value;
      index += 1;
      continue;
    }
    throw new UsageError(`unknown option: ${argument}`);
  }
  if (!options.help && options.base === null) throw new UsageError("--base is required");
  return options;
}

export function run(argv, streams = process, environment = process.env) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    streams.stderr.write(`secret-diff-gate: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    streams.stdout.write(USAGE);
    return 0;
  }

  const repository = path.resolve(
    options.repository ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );

  try {
    validateAllowlist();
    const byFile = collectDiff({
      repository,
      base: options.base,
      head: options.head,
      worktree: options.worktree,
    });
    const addedLineCount = [...byFile.values()].reduce(
      (total, lines) => total + lines.length,
      0,
    );
    const { rows, failing } = scanAddedLines(byFile, {
      representations: environmentRepresentations(environment),
    });
    const range = options.worktree
      ? `${options.base}..worktree`
      : `${options.base}..${options.head}`;
    // The date comes from the head commit, not from the clock: a gate whose report
    // changes when nothing changed is a gate nobody can diff.
    const stamp = options.worktree
      ? "working tree"
      : git(["show", "-s", "--format=%ad", "--date=short", options.head], repository).trim();
    const header = `# Secret/PII diff gate — ${range}, ${stamp}`;
    streams.stdout.write(
      `${formatReport({ rows, header, addedLineCount, fileCount: byFile.size })}\n`,
    );
    if (failing > 0) {
      streams.stderr.write(
        `secret-diff-gate: ${failing} non-allowlisted hit(s) in added lines. ` +
          "Remove the value, or add an allowlist entry with a reason.\n",
      );
      return 1;
    }
    // Ordering: findings outrank a not-run complaint, because a hit is a real leak and
    // this is a report about coverage. The report itself is already on stdout either way.
    const envRow = rows.find((row) => row.id === ENV_VALUE_PATTERN.id);
    if (options.requireEnvValues && (envRow?.variableCount ?? 0) === 0) {
      streams.stderr.write(
        "secret-diff-gate: --require-env-values was given and the environment holds 0 " +
          "secret-shaped variables, so the value-derived half of the gate did not run. " +
          "A tool that did not run is not a verdict. Map the secrets into this job.\n",
      );
      return 2;
    }
    return 0;
  } catch (error) {
    streams.stderr.write(`secret-diff-gate: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

export { UsageError, EnvironmentError };
