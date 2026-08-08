import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

interface MarkerRule {
  id: string;
  pattern: RegExp;
}

interface MarkerAllowlistEntry {
  relativePath: string;
  ruleId: string;
  pattern: string;
  reason: string;
}

type NetworkCapability =
  | "fetch"
  | "websocket"
  | "node-http-import"
  | "node-http-call"
  | "network-sdk"
  | "network-subprocess";

interface NetworkCallSiteEntry {
  relativePath: string;
  capability: NetworkCapability;
  expectedOccurrences: number;
  disposition: "required-local" | "gated-off" | "retained-explicit";
  adrReference: string;
  reason: string;
}

interface EgressManifest {
  schemaVersion: 1;
  networkCallSites: NetworkCallSiteEntry[];
  markerAllowlist: MarkerAllowlistEntry[];
}

interface SourceFile {
  relativePath: string;
  source: string;
}

interface NetworkHit {
  relativePath: string;
  capability: NetworkCapability;
  line: number;
  matchedText: string;
}

interface NetworkRule {
  capability: Exclude<NetworkCapability, "node-http-call">;
  pattern: RegExp;
}

const MARKER_RULES: readonly MarkerRule[] = [
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

const NETWORK_RULES: readonly NetworkRule[] = [
  // Do not classify SDK methods such as discord.js channel.fetch().
  { capability: "fetch", pattern: /(^|[^.\w])(?:(?:globalThis|window)\.)?fetch\s*\(/gm },
  { capability: "websocket", pattern: /\bnew\s+WebSocket\s*\(/g },
  {
    capability: "node-http-import",
    pattern: /(?:from\s*["'](?:node:)?https?["']|require\s*\(\s*["'](?:node:)?https?["']\s*\))/g,
  },
  {
    capability: "network-sdk",
    pattern: /\bnew\s+(?:Octokit|App|Client|WebClient|SocketModeClient)\s*\(/g,
  },
  {
    capability: "network-subprocess",
    pattern:
      /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\([\s\S]{0,500}?\b(?:curl|wget)\b/g,
  },
];

const NODE_HTTP_CALL_PATTERN =
  /(?:\b[$A-Z_a-z][$\w]*\s*\.\s*)?\b(?:request|get)\s*\(/g;
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const BINARY_EXTENSIONS = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);
const MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "vendor-egress.manifest.json",
);

function readManifest(): EgressManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as EgressManifest;
}

function filesRecursively(root: string, includeFile: (absolutePath: string) => boolean): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    if (currentDirectory === undefined) break;
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === ".bun"
        ) continue;
        pending.push(absolutePath);
      } else if (entry.isFile() && includeFile(absolutePath)) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function vendorFiles(vendorRoot: string): string[] {
  return filesRecursively(
    vendorRoot,
    absolutePath => !BINARY_EXTENSIONS.has(path.extname(absolutePath).toLowerCase()),
  );
}

function firstPartySourceFiles(vendorRoot: string): SourceFile[] {
  const packagesRoot = path.join(vendorRoot, "packages");
  return filesRecursively(packagesRoot, absolutePath => {
    const basename = path.basename(absolutePath);
    return (
      SOURCE_EXTENSIONS.has(path.extname(absolutePath)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(basename) &&
      !absolutePath.includes(`${path.sep}__tests__${path.sep}`)
    );
  }).map(absolutePath => ({
    relativePath: path.relative(vendorRoot, absolutePath).split(path.sep).join("/"),
    source: fs.readFileSync(absolutePath, "utf8"),
  }));
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function hitsForPattern(
  sourceFile: SourceFile,
  capability: NetworkCapability,
  pattern: RegExp,
): NetworkHit[] {
  return [...sourceFile.source.matchAll(new RegExp(pattern.source, pattern.flags))].map(match => ({
    relativePath: sourceFile.relativePath,
    capability,
    line: lineAt(sourceFile.source, match.index ?? 0),
    matchedText: match[0].replace(/\s+/g, " ").trim().slice(0, 120),
  }));
}

function scanNetworkCapabilities(sourceFile: SourceFile): NetworkHit[] {
  const hits = NETWORK_RULES.flatMap(rule =>
    hitsForPattern(sourceFile, rule.capability, rule.pattern),
  );
  if (hits.some(hit => hit.capability === "node-http-import")) {
    hits.push(...hitsForPattern(sourceFile, "node-http-call", NODE_HTTP_CALL_PATTERN));
  }
  return hits;
}

function callSiteKey(relativePath: string, capability: NetworkCapability): string {
  return `${relativePath} [${capability}]`;
}

function networkCoverageFailures(
  sourceFiles: readonly SourceFile[],
  manifestEntries: readonly NetworkCallSiteEntry[],
): string[] {
  const hitsByKey = new Map<string, NetworkHit[]>();
  for (const sourceFile of sourceFiles) {
    for (const hit of scanNetworkCapabilities(sourceFile)) {
      const key = callSiteKey(hit.relativePath, hit.capability);
      hitsByKey.set(key, [...(hitsByKey.get(key) ?? []), hit]);
    }
  }

  const manifestByKey = new Map(
    manifestEntries.map(entry => [callSiteKey(entry.relativePath, entry.capability), entry]),
  );
  const failures: string[] = [];

  for (const [key, hits] of hitsByKey) {
    const manifestEntry = manifestByKey.get(key);
    if (manifestEntry === undefined) {
      failures.push(
        ...hits.map(
          hit =>
            `unreviewed ${key}:${String(hit.line)} ${hit.matchedText}`,
        ),
      );
      continue;
    }
    if (manifestEntry.expectedOccurrences !== hits.length) {
      failures.push(
        `${key} expected ${String(manifestEntry.expectedOccurrences)} occurrence(s), found ${String(hits.length)}`,
      );
    }
  }

  for (const [key] of manifestByKey) {
    if (!hitsByKey.has(key)) failures.push(`stale manifest entry ${key}`);
  }
  return failures;
}

function isMarkerAllowed(
  allowlist: readonly MarkerAllowlistEntry[],
  relativePath: string,
  ruleId: string,
  matchedText: string,
): boolean {
  return allowlist.some(
    entry =>
      entry.relativePath === relativePath &&
      entry.ruleId === ruleId &&
      new RegExp(entry.pattern, "i").test(matchedText),
  );
}

describe("vendored engine egress guard", () => {
  it("contains no unreviewed analytics, update, or remote-asset endpoints", () => {
    const vendorRoot = path.join(guardRepoRoot(), "server/vendor/archon-engine");
    const manifest = readManifest();
    const violations: string[] = [];

    for (const absolutePath of vendorFiles(vendorRoot)) {
      const relativePath = path.relative(vendorRoot, absolutePath).split(path.sep).join("/");
      const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        for (const rule of MARKER_RULES) {
          const matches = line.match(new RegExp(rule.pattern.source, rule.pattern.flags));
          for (const matchedText of matches ?? []) {
            if (!isMarkerAllowed(manifest.markerAllowlist, relativePath, rule.id, matchedText)) {
              violations.push(
                `${relativePath}:${String(lineIndex + 1)} [${rule.id}] ${matchedText}`,
              );
            }
          }
        }
      }
    }

    expect(violations, `Unexpected vendor egress markers:\n${violations.join("\n")}`).toEqual([]);
  });

  it("requires every first-party network-capable call site to match the manifest", () => {
    const vendorRoot = path.join(guardRepoRoot(), "server/vendor/archon-engine");
    const manifest = readManifest();
    expect(networkCoverageFailures(firstPartySourceFiles(vendorRoot), manifest.networkCallSites))
      .toEqual([]);
  });

  it("keeps the machine manifest path-specific, reasoned, and linked to the ADR", () => {
    const manifest = readManifest();
    const adr = fs.readFileSync(path.join(guardRepoRoot(), "docs/adr/S2a-vendor-egress.md"), "utf8");
    const keys = manifest.networkCallSites.map(entry =>
      callSiteKey(entry.relativePath, entry.capability),
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of manifest.networkCallSites) {
      expect(entry.relativePath.startsWith("packages/")).toBe(true);
      expect(entry.expectedOccurrences).toBeGreaterThan(0);
      expect(["required-local", "gated-off", "retained-explicit"]).toContain(
        entry.disposition,
      );
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(adr).toContain(entry.adrReference);
    }
    for (const entry of manifest.markerAllowlist) {
      expect(entry.relativePath.trim().length).toBeGreaterThan(0);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["fetch", `export const leak = () => fetch("https://example.invalid/ping");`],
    ["websocket", `export const socket = new WebSocket("wss://example.invalid/events");`],
    ["network-sdk", `export const client = new Octokit({ auth: "secret" });`],
    ["network-subprocess", `exec("curl https://example.invalid/ping");`],
  ] as const)("rejects an unknown %s call site", (capability, source) => {
    const failures = networkCoverageFailures(
      [{ relativePath: "packages/core/src/unknown-egress.ts", source }],
      [],
    );
    expect(failures.some(failure => failure.includes(`[${capability}]`))).toBe(true);
  });
});
