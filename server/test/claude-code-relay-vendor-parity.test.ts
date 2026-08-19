/**
 * One discovery policy, two spellings — enforced, not assumed.
 *
 * `server/vendor/pipeline-engine/packages/providers/src/claude/binary-resolver.ts`
 * is the origin of the Claude Code resolution order. The Kady server cannot
 * import it: the module statically imports a package from the vendored engine's
 * own bun workspace, which this repo never installs (the scoped directory it
 * would live in exists nowhere under any node_modules), and the vendored engine
 * runs as a separate bun process. So the host relay re-declares the anchors, and
 * this test is the link: it reads the vendored file and fails the build if the
 * two drift.
 *
 * The alternative — a `paths` mapping in `server/tsconfig.json` plus a vitest
 * alias — is outside lane F2's writable set and is recorded in `INTEGRATION.md`.
 * If it is ever applied, this test should be replaced by a direct import.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_BIN_PATH_ENV_VAR,
  CLAUDE_BINARY_NAME,
  claudeNativeInstallerPath,
} from "../src/workflows/claude-code-relay.ts";

const VENDORED_RESOLVER = path.resolve(
  import.meta.dirname,
  "..",
  "vendor",
  "pipeline-engine",
  "packages",
  "providers",
  "src",
  "claude",
  "binary-resolver.ts",
);

const source = fs.readFileSync(VENDORED_RESOLVER, "utf-8");

describe("claude code relay ↔ vendored resolver parity", () => {
  it("reads the vendored resolver this repo actually ships", () => {
    expect(source).toContain("export async function resolveClaudeBinaryPath");
  });

  it("names the same override environment variable", () => {
    expect(CLAUDE_BIN_PATH_ENV_VAR).toBe("CLAUDE_BIN_PATH");
    expect(source).toContain(
      `export const CLAUDE_BIN_PATH_ENV_VAR = '${CLAUDE_BIN_PATH_ENV_VAR}'`,
    );
    expect(source).toContain(`process.env[CLAUDE_BIN_PATH_ENV_VAR]`);
  });

  it("names the same platform binary", () => {
    expect(source).toContain(
      "export const CLAUDE_BINARY_NAME = process.platform === 'win32' ? 'claude.exe' : 'claude'",
    );
    expect(CLAUDE_BINARY_NAME).toBe(
      process.platform === "win32" ? "claude.exe" : "claude",
    );
  });

  it("probes the same canonical native-installer location", () => {
    expect(source).toContain("export function claudeNativeInstallerPath(): string");
    expect(source).toContain(
      "return join(homedir(), '.local', 'bin', CLAUDE_BINARY_NAME);",
    );
    expect(source).toContain("const nativeInstallerPath = claudeNativeInstallerPath();");
    expect(claudeNativeInstallerPath().endsWith(
      path.join(".local", "bin", CLAUDE_BINARY_NAME),
    )).toBe(true);
  });

  it("still resolves in the vendored order: env, then config, then autodetect", () => {
    const environmentIndex = source.indexOf("const envPath = process.env[CLAUDE_BIN_PATH_ENV_VAR]");
    const configIndex = source.indexOf("if (configClaudeBinaryPath)");
    const autodetectIndex = source.indexOf("const nativeInstallerPath =");
    expect(environmentIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(environmentIndex);
    expect(autodetectIndex).toBeGreaterThan(configIndex);
  });

  /**
   * Ordering assertions between three known anchors cannot see a *fourth*. The
   * round-1 test caught a moved installer location and a moved dev short circuit
   * but stayed green when a new highest-priority source was inserted above the
   * environment variable — and an added source is the drift most likely to
   * actually happen, because it is what "support npm global installs" looks
   * like as a patch. So the *complete* ordered sequence of discovery-relevant
   * call sites inside `resolveClaudeBinaryPath` is asserted here: an added
   * source moves the sequence and fails the build.
   */
  it("has exactly these discovery call sites, in exactly this order", () => {
    const start = source.indexOf("export async function resolveClaudeBinaryPath");
    expect(start).toBeGreaterThan(-1);
    // The function body ends at the first closing brace in column 0 after it.
    const end = source.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    const body = source
      .slice(start, end)
      // Comments are documentation, not behaviour; a reworded comment must not
      // fail the build, but a new branch must.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

    const anchors =
      /process\.env\[[A-Za-z_$][\w$]*\]|validateAndExpand\(|pathKind\(|claudeNativeInstallerPath\(\)|BUNDLED_IS_BINARY|return [A-Za-z_$][\w$]*|throw new Error\(/g;
    expect(body.match(anchors)).toEqual([
      // 1. the environment override, honoured in dev mode too
      "process.env[CLAUDE_BIN_PATH_ENV_VAR]",
      "validateAndExpand(",
      "return resolvedEnv",
      // 2. the dev-mode short circuit, above the config override
      "BUNDLED_IS_BINARY",
      "return undefined",
      // 3. the config-file override
      "validateAndExpand(",
      "return resolvedConfig",
      // 4. autodetect: the native installer location
      "claudeNativeInstallerPath()",
      "pathKind(",
      "return nativeInstallerPath",
      // 5. not found
      "throw new Error(",
    ]);
  });

  it("still short-circuits dev mode above the config override — why the host applies its own", () => {
    // This is the reason the relay does not route the user's override through
    // `resolveClaudeBinaryPath`: in dev mode that function returns before it
    // ever looks at `configClaudeBinaryPath`, so the Settings control would
    // silently do nothing. If this line ever moves, revisit the relay.
    const devModeIndex = source.indexOf("if (!BUNDLED_IS_BINARY) return undefined;");
    const configIndex = source.indexOf("if (configClaudeBinaryPath)");
    expect(devModeIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(devModeIndex);
  });

  it("is unreachable from the server's module path, which is why parity is textual", () => {
    // The specifier is read out of the vendored file rather than written here,
    // so this stays true if the vendored engine renames its workspace package.
    const workspaceImport = /^import \{[^}]*\} from '(@[^'/]+\/[^']+)';$/m.exec(source);
    expect(
      workspaceImport,
      "The vendored resolver no longer imports a scoped workspace package; if the server can now import it directly, replace this file with a real import.",
    ).not.toBeNull();
    const scope = workspaceImport![1].split("/")[0];

    const serverRoot = path.resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(serverRoot, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    expect(declared).not.toContain(workspaceImport![1]);

    for (const candidate of [
      path.join(serverRoot, "node_modules", scope),
      path.resolve(serverRoot, "..", "node_modules", scope),
      path.join(serverRoot, "vendor", "pipeline-engine", "node_modules", scope),
    ]) {
      expect(fs.existsSync(candidate), `${candidate} exists, so a direct import may now be possible.`)
        .toBe(false);
    }
  });
});
