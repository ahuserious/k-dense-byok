import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

const BLOCKED_REMOTE = /(?:github\.com[:/])?K-Dense-AI(?:\/|$)/i;

function remoteUrls(repoRoot: string): string[] {
  const remotes = execFileSync("git", ["remote"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  return remotes.flatMap((remote) =>
    execFileSync("git", ["remote", "get-url", "--all", remote], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

describe("Phase R remote allowlist", () => {
  it("rejects remotes that resolve directly to K-Dense-AI", () => {
    const blocked = remoteUrls(guardRepoRoot()).filter((url) => BLOCKED_REMOTE.test(url));
    expect(blocked, `Blocked K-Dense-AI remotes:\n${blocked.join("\n")}`).toEqual([]);
  });
});
