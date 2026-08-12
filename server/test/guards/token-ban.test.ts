import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

describe("Phase R token ban", () => {
  it("keeps deprecated compatibility exceptions exact and justified", () => {
    const repoRoot = guardRepoRoot();
    const config = JSON.parse(
      readFileSync(path.join(repoRoot, "config/token-ban.json"), "utf8"),
    ) as {
      token: string;
      deprecatedCompatibilityIdentifiers: Array<{
        path: string;
        identifiers: string[];
        comment: string;
      }>;
    };

    expect(config.deprecatedCompatibilityIdentifiers).toHaveLength(11);
    for (const rule of config.deprecatedCompatibilityIdentifiers) {
      expect(rule.path).not.toMatch(/[*?]/);
      expect(rule.comment).toMatch(/^deprecated-compat:/);
      expect(rule.identifiers.length).toBeGreaterThan(0);
      for (const identifier of rule.identifiers) {
        expect(identifier.toLowerCase()).toContain(config.token.toLowerCase());
      }
    }
  });

  it("is enabled and the repository passes", () => {
    const repoRoot = guardRepoRoot();
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/token-ban.mjs"), "--root", repoRoot],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(output).toContain("token-ban: PASS (0 violations)");
  });
});
