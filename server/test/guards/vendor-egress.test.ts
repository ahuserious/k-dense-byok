import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

interface DenyRule {
  id: string;
  pattern: RegExp;
}

interface AllowlistEntry {
  relativePath: string;
  ruleId: string;
  pattern: RegExp;
  reason: string;
}

const DENY_RULES: readonly DenyRule[] = [
  {
    id: "analytics-sdk",
    pattern: /\bposthog(?:-node)?\b|@sentry\/|\bsentry\.io\b|\bsegment\.(?:com|io)\b|analytics\.js/gi,
  },
  {
    id: "analytics-endpoint",
    pattern: /us\.i\.posthog\.com|o\d+\.ingest\.sentry\.io|api\.segment\.io/gi,
  },
  {
    id: "upstream-update-endpoint",
    pattern: /api\.github\.com\/repos\/coleam00\/Archon\/releases\/latest/gi,
  },
  {
    id: "remote-web-asset",
    pattern: /fonts\.(?:googleapis|gstatic)\.com|cdn\.jsdelivr\.net|unpkg\.com/gi,
  },
];

/**
 * Generated artifacts may temporarily retain removed dependency names until
 * the orchestrator runs the lockfile gate. Runtime source and package manifests
 * are never allowlisted.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    relativePath: "bun.lock",
    ruleId: "analytics-sdk",
    pattern: /posthog/gi,
    reason: "Generated lockfile is refreshed by the orchestrator's bun install gate.",
  },
];

const BINARY_EXTENSIONS = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);

function vendorFiles(vendorRoot: string): string[] {
  const files: string[] = [];
  const pending = [vendorRoot];
  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    if (currentDirectory === undefined) break;
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(currentDirectory, entry.name);
      // Scan only first-party vendored source: dependency trees, VCS metadata,
      // and build artifacts contain third-party docs/shims that mention CDNs.
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === ".bun"
        ) continue;
        pending.push(absolutePath);
      }
      else if (entry.isFile() && !BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function isAllowed(relativePath: string, ruleId: string, matchedText: string): boolean {
  return ALLOWLIST.some(
    (entry) =>
      entry.relativePath === relativePath &&
      entry.ruleId === ruleId &&
      new RegExp(entry.pattern.source, entry.pattern.flags.replace("g", "")).test(matchedText),
  );
}

describe("vendored engine egress guard", () => {
  it("contains no unreviewed analytics, update, or remote-asset endpoints", () => {
    const vendorRoot = path.join(guardRepoRoot(), "server/vendor/archon-engine");
    const violations: string[] = [];

    for (const absolutePath of vendorFiles(vendorRoot)) {
      const relativePath = path.relative(vendorRoot, absolutePath).split(path.sep).join("/");
      const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        for (const rule of DENY_RULES) {
          const matches = line.match(new RegExp(rule.pattern.source, rule.pattern.flags));
          for (const matchedText of matches ?? []) {
            if (!isAllowed(relativePath, rule.id, matchedText)) {
              violations.push(
                `${relativePath}:${lineIndex + 1} [${rule.id}] ${matchedText}`,
              );
            }
          }
        }
      }
    }

    const allowlistRationale = ALLOWLIST.map(
      (entry) => `${entry.relativePath} [${entry.ruleId}]: ${entry.reason}`,
    ).join("\n");
    expect(
      violations,
      `Unexpected vendor egress markers:\n${violations.join("\n")}\n\nAllowlist:\n${allowlistRationale}`,
    ).toEqual([]);
  });
});
