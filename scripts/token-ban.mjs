#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArguments(argv) {
  const options = { root: defaultRoot, config: "config/token-ban.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" || argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  options.root = path.resolve(options.root);
  options.config = path.resolve(options.root, options.config);
  return options;
}

function globRegex(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "i");
}

function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

export function runTokenBan(options) {
  const config = JSON.parse(fs.readFileSync(options.config, "utf8"));
  if (config.enabled !== true) {
    return { enabled: false, violations: [] };
  }

  const token = String(config.token ?? "archon");
  const tokenPattern = new RegExp(escapeRegex(token), "i");
  const allowedPathPatterns = (config.allowedPaths ?? []).map(globRegex);
  const allowedIdentifiers = (config.allowedIdentifiers ?? []).map((value) =>
    String(value).toLowerCase(),
  );
  const vendorInternalRules = (config.vendorInternalIdentifiers ?? []).map((rule) => ({
    pathPattern: globRegex(String(rule.path)),
    identifiers: (rule.identifiers ?? []).map((value) => String(value).toLowerCase()),
  }));
  const selfPaths = new Set([
    path.relative(options.root, options.config).replaceAll(path.sep, "/"),
    "scripts/token-ban.mjs",
  ]);
  const violations = [];

  for (const relativePath of trackedFiles(options.root)) {
    if (selfPaths.has(relativePath)) continue;
    if (allowedPathPatterns.some((pattern) => pattern.test(relativePath))) continue;
    const absolutePath = path.join(options.root, relativePath);
    let content;
    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!tokenPattern.test(line)) continue;
      const lowerLine = line.toLowerCase();
      const pathScopedIdentifiers = vendorInternalRules
        .filter((rule) => rule.pathPattern.test(relativePath))
        .flatMap((rule) => rule.identifiers);
      const remainingLine = [...allowedIdentifiers, ...pathScopedIdentifiers]
        .sort((left, right) => right.length - left.length)
        .reduce(
          (candidate, identifier) => candidate.replaceAll(identifier, ""),
          lowerLine,
        );
      if (!tokenPattern.test(remainingLine)) continue;
      violations.push({ file: relativePath, line: lineIndex + 1, text: line.trim() });
    }
  }
  return { enabled: true, violations };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = runTokenBan(options);
  if (!result.enabled) {
    console.log("token-ban: DISABLED by config/token-ban.json");
    return;
  }
  if (result.violations.length === 0) {
    console.log("token-ban: PASS (0 violations)");
    return;
  }
  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}: banned token: ${violation.text}`);
  }
  console.error(`token-ban: FAIL (${result.violations.length} violations)`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
