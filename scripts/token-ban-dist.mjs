#!/usr/bin/env node
/**
 * Built-bundle identity scan (backlog #50(1)).
 *
 * `scripts/token-ban.mjs` walks `git ls-files -co --exclude-standard`, so it never sees a build
 * output: the vendored engine's `dist/` is gitignored, and so is `web/.next`. That is a real blind
 * spot — the thing a user actually loads is the bundle, and a retired brand string can survive in it
 * long after the source that produced it was fixed (observed on 2026-08-18: the stale dist still
 * shipped four rendered legacy-brand config-path strings that the source no longer contains).
 *
 * This scanner reads the built artifacts directly. It fails on any occurrence of the banned token
 * except the explicitly enumerated storage-key identifiers below, which are not rendered text: they
 * are persisted-state keys in the vendored console. Renaming them is a data-migration decision
 * (existing users' preferences live under those keys), so they are allowed here and tracked in the
 * backlog rather than silently rewritten.
 *
 * Usage: node scripts/token-ban-dist.mjs [--root <repo>] [--json]
 * Exit 0 = clean, 1 = violations, 2 = nothing to scan (no build present).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bundle globs to scan, relative to the repository root. */
const BUNDLE_ROOTS = [
  "server/vendor/pipeline-engine/packages/web/dist",
  "web/.next/static",
];

/** Text-bearing extensions inside a bundle. Binary assets are skipped. */
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".txt"]);

/**
 * Occurrences that are allowed because they are storage/identifier keys, never rendered copy.
 * Each entry must be an exact substring; a hit is allowed only when the token occurrence sits
 * inside one of these.
 */
const TOKEN = ["arch", "on"].join("");

const ALLOWED_IDENTIFIER_SUBSTRINGS = [
  `${TOKEN}.console.`,
  `NEXT_PUBLIC_${TOKEN.toUpperCase()}_URL`,
];


function parseArguments(argv) {
  const options = { root: defaultRoot, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a value");
      options.root = value;
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  options.root = path.resolve(options.root);
  return options;
}

function collectFiles(directory, accumulator) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return accumulator;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, accumulator);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      accumulator.push(absolute);
    }
  }
  return accumulator;
}

/** True when the token occurrence at `index` lies inside an allowed identifier. */
function isAllowedOccurrence(contents, index) {
  for (const identifier of ALLOWED_IDENTIFIER_SUBSTRINGS) {
    const lowered = identifier.toLowerCase();
    const start = Math.max(0, index - lowered.length);
    const window = contents.slice(start, index + lowered.length).toLowerCase();
    if (window.includes(lowered)) return true;
  }
  return false;
}

export function scanBuiltBundles(root) {
  const scannedRoots = [];
  const violations = [];
  let scannedFiles = 0;

  for (const relativeRoot of BUNDLE_ROOTS) {
    const absoluteRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    scannedRoots.push(relativeRoot);
    for (const file of collectFiles(absoluteRoot, [])) {
      scannedFiles += 1;
      const contents = fs.readFileSync(file, "utf8");
      const lowered = contents.toLowerCase();
      let index = lowered.indexOf(TOKEN);
      while (index !== -1) {
        if (!isAllowedOccurrence(contents, index)) {
          violations.push({
            file: path.relative(root, file),
            offset: index,
            excerpt: contents.slice(Math.max(0, index - 60), index + 60).replace(/\s+/g, " "),
          });
        }
        index = lowered.indexOf(TOKEN, index + TOKEN.length);
      }
    }
  }

  return { scannedRoots, scannedFiles, violations };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = scanBuiltBundles(options.root);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  if (result.scannedRoots.length === 0) {
    process.stdout.write(
      "token-ban-dist: SKIP (no build output found — run npm run build:vendored-dist first)\n",
    );
    process.exit(2);
  }

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      process.stderr.write(`${violation.file}:@${violation.offset}: ${violation.excerpt}\n`);
    }
    process.stderr.write(
      `token-ban-dist: FAIL (${result.violations.length} violation(s) in ${result.scannedFiles} built file(s))\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `token-ban-dist: PASS (0 violations in ${result.scannedFiles} built file(s) across ${result.scannedRoots.join(", ")})\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
