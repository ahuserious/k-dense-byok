import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardRepoRoot } from "./repo-root.ts";

interface AttributionManifest {
  algorithm: "sha256";
  files: Record<string, string>;
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("Phase R vendor attribution", () => {
  it("keeps the recorded license and provenance bytes", () => {
    const repoRoot = guardRepoRoot();
    const manifestPath = path.join(
      repoRoot,
      "server/test/guards/vendor-attribution.sha256.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AttributionManifest;
    expect(manifest.algorithm).toBe("sha256");
    for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
      const absolutePath = path.join(repoRoot, relativePath);
      expect(fs.existsSync(absolutePath), `Missing vendored attribution: ${relativePath}`).toBe(true);
      expect(sha256(absolutePath), `Attribution hash changed: ${relativePath}`).toBe(expectedHash);
    }
  });
});
