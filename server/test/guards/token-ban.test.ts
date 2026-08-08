import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

describe("Phase R token ban", () => {
  it("is shipped disabled behind its reviewed config flag", () => {
    const repoRoot = guardRepoRoot();
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/token-ban.mjs"), "--root", repoRoot],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(output).toContain("token-ban: DISABLED");
  });
});
