import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const checkerPath = path.join(scriptDirectory, "ownership-check.mjs");

function runChecker(checkout, ...arguments_) {
  return spawnSync(process.execPath, [path.join(checkout, "scripts", "ownership-check.mjs"), ...arguments_], {
    cwd: checkout,
    encoding: "utf-8",
  });
}

function git(checkout, ...arguments_) {
  const result = spawnSync("git", arguments_, { cwd: checkout, encoding: "utf-8" });
  assert.equal(result.status, 0, `${arguments_.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function writeFixtureFile(checkout, relativePath, contents) {
  const filePath = path.join(checkout, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createGitFixture() {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "kady-ownership-fixture-"));
  writeFixtureFile(checkout, "scripts/ownership-check.mjs", fs.readFileSync(checkerPath));
  writeFixtureFile(checkout, "docs/inventory/files.json", "{\"files\":[]}\n");
  writeFixtureFile(checkout, "docs/inventory/ownership.json", `${JSON.stringify({
    lanes: {
      C1: ["owned/**"],
      S2: ["other/**"],
      R1: ["policy/**"],
    },
    handoffs: [],
  }, null, 2)}\n`);
  writeFixtureFile(checkout, "other/source.txt", "source\n");
  git(checkout, "init", "--quiet");
  git(checkout, "config", "user.name", "Ownership Test");
  git(checkout, "config", "user.email", "ownership@example.invalid");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "fixture base");
  return { checkout, base: git(checkout, "rev-parse", "HEAD") };
}

test("ownership writer/base flags reject joined, unknown, duplicate, and option-shaped values", () => {
  for (const arguments_ of [
    ["--writer=C1", "--base", "abcdef0"],
    ["--writter", "C1", "--base", "abcdef0"],
    ["--writer", "C1", "--writer", "C1", "--base", "abcdef0"],
    ["--writer", "C1", "--base", "-s"],
    ["--writer", "C1", "--base", "HEAD"],
    ["--head", "abcdef0"],
    ["--writer", "C1", "--base", "abcdef0", "--head=1234567"],
    ["--writer", "C1", "--base", "abcdef0", "--head", "HEAD"],
  ]) {
    const result = spawnSync(process.execPath, [checkerPath, ...arguments_], {
      cwd: repositoryRoot,
      encoding: "utf-8",
    });
    assert.equal(result.status, 2, `${arguments_.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /ownership-check: FAIL/);
  }
});

test("fork branch-name spoofing cannot select a lane without base-mapped actor authority", () => {
  const { checkout } = createGitFixture();
  try {
    const absent = runChecker(
      checkout,
      "--resolve-writer",
      "--actor",
      "ahuserious",
      "--head-ref",
      "lane/C1-authorized",
      "--mapping",
      "docs/inventory/lane-writers.json",
    );
    assert.equal(absent.status, 2, `${absent.stdout}\n${absent.stderr}`);
    assert.match(absent.stderr, /mapping is absent or unreadable/);

    writeFixtureFile(
      checkout,
      "docs/inventory/lane-writers.json",
      `${JSON.stringify({
        $comment: "Base-controlled lane writer policy.",
        writers: {
          ahuserious: ["C1", "C3", "C5", "C4", "C2b", "R1"],
        },
      }, null, 2)}\n`,
    );
    const spoofed = runChecker(
      checkout,
      "--resolve-writer",
      "--actor",
      "untrusted-fork-user",
      "--head-ref",
      "lane/C1-spoof",
      "--mapping",
      "docs/inventory/lane-writers.json",
    );
    assert.equal(spoofed.status, 2, `${spoofed.stdout}\n${spoofed.stderr}`);
    assert.match(spoofed.stderr, /untrusted-fork-user is not authorized for C1/);

    const authorized = runChecker(
      checkout,
      "--resolve-writer",
      "--actor",
      "ahuserious",
      "--head-ref",
      "lane/C1-authorized",
      "--mapping",
      "docs/inventory/lane-writers.json",
    );
    assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
    assert.equal(authorized.stdout.trim(), "C1");

    const mixedCaseLane = runChecker(
      checkout,
      "--resolve-writer",
      "--actor",
      "ahuserious",
      "--head-ref",
      "lane/c2b-authorized",
      "--mapping",
      "docs/inventory/lane-writers.json",
    );
    assert.equal(mixedCaseLane.status, 0, `${mixedCaseLane.stdout}\n${mixedCaseLane.stderr}`);
    assert.equal(mixedCaseLane.stdout.trim(), "C2b");
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("explicit head is inspected by the trusted base checker without executing head code", () => {
  const { checkout, base } = createGitFixture();
  try {
    writeFixtureFile(checkout, "other/head-change.txt", "unauthorized\n");
    writeFixtureFile(checkout, "scripts/ownership-check.mjs", "process.exit(0);\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "candidate attempts to bypass checker");
    const head = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "--quiet", "--detach", base);

    const result = runChecker(checkout, "--writer", "C1", "--base", base, "--head", head);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /other\/head-change\.txt/);
    assert.match(result.stderr, /scripts\/ownership-check\.mjs/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("writer validation reads policy from the trusted fixture base", () => {
  const { checkout, base } = createGitFixture();
  try {
    const candidatePolicy = JSON.parse(fs.readFileSync(path.join(checkout, "docs/inventory/ownership.json")));
    candidatePolicy.handoffs.push({
      from: "R1",
      to: "C1",
      path: "docs/inventory/ownership.json",
      scope: "candidate-only grant",
    });
    writeFixtureFile(checkout, "docs/inventory/ownership.json", `${JSON.stringify(candidatePolicy, null, 2)}\n`);
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "candidate policy grant");

    const result = runChecker(checkout, "--writer", "C1", "--base", base);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /trusted base/);
    assert.match(result.stderr, /docs\/inventory\/ownership\.json/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("worktree mode includes tracked but uncommitted changes", () => {
  const { checkout, base } = createGitFixture();
  try {
    writeFixtureFile(checkout, "owned/committed.txt", "owned candidate change\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "owned candidate change");
    writeFixtureFile(checkout, "other/source.txt", "uncommitted cross-lane edit\n");
    const result = runChecker(checkout, "--writer", "C1", "--base", base);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /other\/source\.txt/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("cross-lane rename authorizes both source and destination", () => {
  const { checkout, base } = createGitFixture();
  try {
    fs.mkdirSync(path.join(checkout, "owned"), { recursive: true });
    git(checkout, "mv", "other/source.txt", "owned/destination.txt");
    git(checkout, "commit", "--quiet", "-m", "cross-lane rename");

    const result = runChecker(checkout, "--writer", "C1", "--base", base);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /other\/source\.txt/);
    assert.doesNotMatch(result.stderr, /owned\/destination\.txt\n?$/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
