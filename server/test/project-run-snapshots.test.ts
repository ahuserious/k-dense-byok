import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectRunSnapshotManifest,
  createProject,
  createProjectRunSnapshot,
  deleteProjectRunSnapshot,
  ProjectRunSnapshotLimitError,
  projectRunSnapshotExists,
  resolvePaths,
} from "../src/projects.ts";

function createSnapshotProject(label: string): { projectId: string; sandbox: string; kadyDir: string } {
  const projectId = `snapshot-${label}-${crypto.randomBytes(3).toString("hex")}`;
  createProject({ name: `Snapshot ${label}`, projectId });
  const paths = resolvePaths(projectId);
  return { projectId, sandbox: paths.sandbox, kadyDir: paths.kadyDir };
}

describe("project run snapshots", () => {
  it("honors Git ignores and privacy exclusions before enforcing aggregate bounds", async () => {
    const { sandbox } = createSnapshotProject("bounds");
    fs.writeFileSync(path.join(sandbox, ".gitignore"), "ignored/\n", "utf-8");
    fs.mkdirSync(path.join(sandbox, "ignored"), { recursive: true });
    fs.mkdirSync(path.join(sandbox, "node_modules", "package"), { recursive: true });
    fs.mkdirSync(path.join(sandbox, ".venv"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "visible-a.txt"), "1234", "utf-8");
    fs.writeFileSync(path.join(sandbox, "visible-b.txt"), "5678", "utf-8");
    fs.writeFileSync(path.join(sandbox, "ignored", "large.bin"), "x".repeat(1_000), "utf-8");
    fs.writeFileSync(path.join(sandbox, "node_modules", "package", "cache.js"), "cached", "utf-8");
    fs.writeFileSync(path.join(sandbox, ".venv", "cache.py"), "cached", "utf-8");
    fs.writeFileSync(path.join(sandbox, ".env.local"), "TOKEN=secret", "utf-8");

    const manifest = await buildProjectRunSnapshotManifest(sandbox, {
      maxFiles: 100,
      maxBytes: 10_000,
    });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["visible-a.txt", "visible-b.txt"]),
    );
    for (const excludedPath of [
      "ignored/large.bin",
      "node_modules/package/cache.js",
      ".venv/cache.py",
      ".env.local",
    ]) {
      expect(manifest.entries.map((entry) => entry.path)).not.toContain(excludedPath);
    }

    await expect(buildProjectRunSnapshotManifest(sandbox, {
      maxFiles: 1,
      maxBytes: 10_000,
    })).rejects.toBeInstanceOf(ProjectRunSnapshotLimitError);
    await expect(buildProjectRunSnapshotManifest(sandbox, {
      maxFiles: 100,
      maxBytes: 3,
    })).rejects.toBeInstanceOf(ProjectRunSnapshotLimitError);
  });

  it("deletes terminal snapshot refs, manifests, and the last reachability root for removed data", async () => {
    const { projectId, sandbox, kadyDir } = createSnapshotProject("cleanup");
    const runIdentity = "engine-admission-cleanup";
    const identityHash = crypto.createHash("sha256").update(runIdentity).digest("hex");
    const manifestPath = path.join(kadyDir, "run-snapshots", `${identityHash}.json`);
    const dataPath = path.join(sandbox, "ephemeral-data.txt");
    fs.writeFileSync(dataPath, "snapshot-only-data", "utf-8");

    const snapshotSha = await createProjectRunSnapshot(projectId, runIdentity);
    expect(await projectRunSnapshotExists(projectId, runIdentity)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    fs.rmSync(dataPath);
    expect(execFileSync(
      "git",
      ["-C", sandbox, "show", `${snapshotSha}:ephemeral-data.txt`],
      { encoding: "utf-8" },
    )).toBe("snapshot-only-data");

    await deleteProjectRunSnapshot(projectId, runIdentity);
    expect(await projectRunSnapshotExists(projectId, runIdentity)).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);

    execFileSync("git", ["-C", sandbox, "reflog", "expire", "--expire=now", "--all"]);
    execFileSync("git", ["-C", sandbox, "gc", "--prune=now"]);
    expect(() => execFileSync("git", ["-C", sandbox, "cat-file", "-e", snapshotSha], {
      stdio: "ignore",
    })).toThrow();
  });
});
