import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

interface WorkflowInventory {
  entryModule: string;
}

describe("Phase R typed workflow runtime exports", () => {
  it("matches the reviewed public export snapshot", async () => {
    const repoRoot = guardRepoRoot();
    const inventory = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "docs/inventory/typed-workflow-engine.json"), "utf8"),
    ) as WorkflowInventory;
    const expected = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "server/test/guards/typed-workflow-exports.snapshot.json"),
        "utf8",
      ),
    ) as string[];
    const entryUrl = pathToFileURL(path.join(repoRoot, inventory.entryModule));
    entryUrl.searchParams.set("r1-guard", `${Date.now()}-${Math.random()}`);
    const runtime = await import(entryUrl.href) as Record<string, unknown>;
    expect(Object.keys(runtime).sort()).toEqual(expected);
  });
});
