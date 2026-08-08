import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

describe("Phase R publication block", () => {
  it("keeps the explicit publication-block marker", () => {
    const marker = path.join(guardRepoRoot(), "docs", "PUBLICATION-BLOCKED");
    expect(fs.existsSync(marker), `Missing publication marker: ${marker}`).toBe(true);
  });
});
