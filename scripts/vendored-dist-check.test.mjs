import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkerPath = path.join(scriptDirectory, "vendored-dist-check.mjs");
const distRelative = path.join(
  "server",
  "vendor",
  "pipeline-engine",
  "packages",
  "web",
  "dist",
  "index.html",
);
const sourceRelative = path.join(
  "server",
  "vendor",
  "pipeline-engine",
  "packages",
  "web",
  "src",
  "newest.ts",
);

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-dist-check-"));
  const sourcePath = path.join(root, sourceRelative);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "export const value = 1;\n");
  try {
    callback({ root, sourcePath, distPath: path.join(root, distRelative) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeDist(distPath) {
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.writeFileSync(distPath, "<!doctype html>\n");
}

function runCheck(root, ...arguments_) {
  return spawnSync(process.execPath, [checkerPath, "--root", root, ...arguments_], {
    encoding: "utf-8",
  });
}

test("fails when the vendored dist index is absent", () => {
  withFixture(({ root }) => {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /vendored dist is missing/);
    assert.match(result.stderr, /packages\/web\/dist\/index\.html/);
  });
});

test("fails and names the newest input when the dist is stale", () => {
  withFixture(({ root, sourcePath, distPath }) => {
    writeDist(distPath);
    fs.utimesSync(distPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(sourcePath, new Date(3_000), new Date(3_000));

    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /newest input:/);
    assert.match(result.stderr, /packages\/web\/src\/newest\.ts/);
    assert.match(result.stderr, /dist index:/);
  });
});

test("passes when the dist is newer than every input", () => {
  withFixture(({ root, sourcePath, distPath }) => {
    writeDist(distPath);
    fs.utimesSync(sourcePath, new Date(1_000), new Date(1_000));
    fs.utimesSync(distPath, new Date(3_000), new Date(3_000));

    const result = runCheck(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /vendored-dist-check: PASS/);
    assert.equal(result.stderr, "");
  });
});

test("--json emits a stable machine-readable result", () => {
  withFixture(({ root, sourcePath, distPath }) => {
    writeDist(distPath);
    fs.utimesSync(distPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(sourcePath, new Date(3_000), new Date(3_000));

    const result = runCheck(root, "--json");
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed), [
      "ok",
      "status",
      "root",
      "distIndex",
      "distMtimeMs",
      "offendingInput",
      "offendingInputMtimeMs",
      "message",
    ]);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "stale");
    assert.equal(parsed.root, root);
    assert.equal(parsed.distIndex, distRelative.split(path.sep).join("/"));
    assert.equal(parsed.distMtimeMs, 1_000);
    assert.equal(parsed.offendingInput, sourceRelative.split(path.sep).join("/"));
    assert.equal(parsed.offendingInputMtimeMs, 3_000);
    assert.match(parsed.message, /is newer than/);
  });
});

