import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

const BLOCKED_REMOTE = /(?:github\.com[:/])?K-Dense-AI(?:\/|$)/i;

/** The invariant is push-side only: the K-Dense-AI upstream stays fetchable
 * (the re-baseline pins and topology checks depend on it) with its push URL
 * disabled (\`no_push\`). Only push destinations are banned here. */
function remotePushUrls(repoRoot: string): string[] {
  const remotes = execFileSync("git", ["remote"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  return remotes.flatMap((remote) =>
    execFileSync("git", ["remote", "get-url", "--push", "--all", remote], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

describe("Phase R remote allowlist", () => {
  it("rejects push URLs that resolve to K-Dense-AI", () => {
    const blocked = remotePushUrls(guardRepoRoot()).filter((url) => BLOCKED_REMOTE.test(url));
    expect(blocked, `Blocked K-Dense-AI push URLs:\n${blocked.join("\n")}`).toEqual([]);
  });
});
