import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SOURCES,
  loadDirectorySource,
  parseEnvText,
  variableNameForFile,
} from "./secrets-prefill.mjs";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "secrets-prefill.mjs",
);

/**
 * Every test builds its own fixture tree with fake values and always passes
 * `--no-default-sources`, so nothing here reads the owner's real sources, touches the
 * network, or depends on KADY_SOCKET_TESTS.
 */
function makeFixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "secrets-prefill-test-"));
}

/** A value long and unique enough that finding it anywhere is unambiguous evidence. */
function makeSentinel(label) {
  return `SENTINEL-${label}-${crypto.randomBytes(24).toString("hex")}`;
}

function runScript(args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf-8",
    env: options.env ?? { PATH: process.env.PATH ?? "" },
    cwd: options.cwd,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertNoSentinel(result, sentinel, context) {
  assert.ok(
    !result.stdout.includes(sentinel),
    `${context}: sentinel value appeared on stdout`,
  );
  assert.ok(
    !result.stderr.includes(sentinel),
    `${context}: sentinel value appeared on stderr`,
  );
}

test("parseEnvText mirrors env-file.mjs semantics", () => {
  const parsed = parseEnvText(
    [
      "# a comment",
      "",
      "PLAIN=value-one",
      'export QUOTED="value two"',
      "SINGLE='value three'",
      "TRAILING=value-four # not part of the value",
      "HASHLESS=value#five",
    ].join("\n"),
    "fixture",
  );
  assert.equal(parsed.get("PLAIN"), "value-one");
  assert.equal(parsed.get("QUOTED"), "value two");
  assert.equal(parsed.get("SINGLE"), "value three");
  assert.equal(parsed.get("TRAILING"), "value-four");
  assert.equal(parsed.get("HASHLESS"), "value#five");
});

test("parseEnvText names the file and line NUMBER, never the line content", () => {
  const sentinel = makeSentinel("parse");
  assert.throws(
    () => parseEnvText(`GOOD=fine\nthis is not an assignment ${sentinel}\n`, "fixture.env"),
    (error) => {
      assert.match(error.message, /fixture\.env/);
      assert.match(error.message, /line 2/);
      assert.ok(!error.message.includes(sentinel), "error message leaked the line content");
      return true;
    },
  );
});

test("variableNameForFile maps the owner's private-directory file names", () => {
  assert.equal(variableNameForFile("stably-api-key.txt"), "STABLY_API_KEY");
  assert.equal(variableNameForFile("stably-project-id.txt"), "STABLY_PROJECT_ID");
  assert.equal(variableNameForFile("9lives.txt"), null);
});

test("loadDirectorySource skips unusable files by NAME with a reason", () => {
  const fixture = makeFixtureDirectory();
  const sentinel = makeSentinel("dir");
  fs.writeFileSync(path.join(fixture, "good-key.txt"), `${sentinel}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, "multi-line.txt"), "a\nb\n", { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, "empty.txt"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(fixture, "big.txt"), "x".repeat(5000), { mode: 0o600 });
  fs.mkdirSync(path.join(fixture, "nested"));

  const loaded = loadDirectorySource(fixture);
  assert.equal(loaded.missing, false);
  assert.equal(loaded.entries.get("GOOD_KEY"), sentinel);
  const reasons = new Map(loaded.skips.map((skip) => [skip.fileName, skip.reason]));
  assert.match(reasons.get("multi-line.txt"), /single-line/);
  assert.match(reasons.get("empty.txt"), /empty/);
  assert.match(reasons.get("big.txt"), /single-value file/);
  assert.match(reasons.get("nested"), /not a regular file/);
  for (const reason of reasons.values()) {
    assert.ok(!reason.includes(sentinel), "a skip reason leaked a value");
  }
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("a missing source is a named skip, not an error and not a silent zero", () => {
  const fixture = makeFixtureDirectory();
  const absent = path.join(fixture, "not-here.env");
  const result = runScript([
    "--no-default-sources",
    "--no-ambient",
    "--source",
    absent,
    "--list",
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SKIPPED — path does not exist/);
  assert.match(result.stdout, /not-here\.env/);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("no mode prints a loaded value: --list, --help, and the error path", () => {
  const fixture = makeFixtureDirectory();
  const sentinel = makeSentinel("modes");
  const envFile = path.join(fixture, "fixture.env");
  fs.writeFileSync(envFile, `FIXTURE_API_KEY=${sentinel}\n`, { mode: 0o600 });

  const list = runScript(["--no-default-sources", "--no-ambient", "--source", envFile, "--list"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /FIXTURE_API_KEY/);
  assert.match(list.stdout, /present/);
  assertNoSentinel(list, sentinel, "--list");

  const help = runScript(["--no-default-sources", "--source", envFile, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Injection mode/);
  assertNoSentinel(help, sentinel, "--help");

  // Error path: an unparseable second source, with the first one already loaded.
  const broken = path.join(fixture, "broken.env");
  fs.writeFileSync(broken, `OK=fine\nnonsense line ${sentinel}\n`, { mode: 0o600 });
  const failed = runScript([
    "--no-default-sources",
    "--no-ambient",
    "--source",
    envFile,
    "--source",
    broken,
    "--list",
  ]);
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /line 2/);
  assertNoSentinel(failed, sentinel, "error path");

  const usage = runScript(["--no-such-option"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unknown option/);

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("--write refuses a tracked path and an unignored path, and allows an ignored one", () => {
  const fixture = makeFixtureDirectory();
  const sentinel = makeSentinel("write");
  const envFile = path.join(fixture, "fixture.env");
  fs.writeFileSync(envFile, `FIXTURE_API_KEY=${sentinel}\n`, { mode: 0o600 });

  const repository = path.join(fixture, "repo");
  fs.mkdirSync(repository);
  const git = (...args) =>
    spawnSync("git", args, { cwd: repository, encoding: "utf-8", stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.email", "lane@example.invalid");
  git("config", "user.name", "Lane Test");
  fs.writeFileSync(path.join(repository, ".gitignore"), "secrets.env\n");
  fs.writeFileSync(path.join(repository, "tracked.env"), "PLACEHOLDER=\n");
  git("add", ".gitignore", "tracked.env");
  git("commit", "--quiet", "-m", "fixture");

  const common = ["--no-default-sources", "--no-ambient", "--source", envFile, "--write"];

  const tracked = runScript([...common, path.join(repository, "tracked.env")], {
    cwd: repository,
  });
  assert.equal(tracked.status, 1);
  assert.match(tracked.stderr, /refusing to write/);
  assert.match(tracked.stderr, /git tracks this path/);
  assert.match(tracked.stderr, /tracked\.env/);
  assertNoSentinel(tracked, sentinel, "--write tracked");
  assert.equal(fs.readFileSync(path.join(repository, "tracked.env"), "utf-8"), "PLACEHOLDER=\n");

  const unignored = runScript([...common, path.join(repository, "loose.env")], {
    cwd: repository,
  });
  assert.equal(unignored.status, 1);
  assert.match(unignored.stderr, /does not ignore this path/);
  assert.equal(fs.existsSync(path.join(repository, "loose.env")), false);
  assertNoSentinel(unignored, sentinel, "--write unignored");

  const allowed = runScript([...common, path.join(repository, "secrets.env")], {
    cwd: repository,
  });
  assert.equal(allowed.status, 0);
  const written = path.join(repository, "secrets.env");
  assert.equal(fs.existsSync(written), true);
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  // The written file is the one place a value legitimately lands — on a path git both
  // ignores and does not track. The script's own output still must not contain it.
  assert.ok(fs.readFileSync(written, "utf-8").includes(sentinel));
  assertNoSentinel(allowed, sentinel, "--write allowed");

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("injection mode passes the environment to the child and returns its exit code", () => {
  const fixture = makeFixtureDirectory();
  const sentinel = makeSentinel("inject");
  const envFile = path.join(fixture, "fixture.env");
  fs.writeFileSync(envFile, `FIXTURE_API_KEY=${sentinel}\n`, { mode: 0o600 });
  const child = path.join(fixture, "child.mjs");
  // The child reports only the LENGTH of what it received, never the value.
  fs.writeFileSync(
    child,
    [
      "const value = process.env.FIXTURE_API_KEY ?? '';",
      "console.log(`child saw length=${value.length}`);",
      "process.exit(value.length === Number(process.argv[2]) ? 7 : 3);",
    ].join("\n"),
  );

  const before = fs.readdirSync(fixture).sort();
  const result = runScript([
    "--no-default-sources",
    "--no-ambient",
    "--source",
    envFile,
    "--",
    process.execPath,
    child,
    String(sentinel.length),
  ]);
  assert.equal(result.status, 7, "child exit code was not propagated");
  assert.match(result.stdout, new RegExp(`child saw length=${sentinel.length}`));
  assertNoSentinel(result, sentinel, "injection");
  // Injection must not stage the environment on disk to do its job.
  assert.deepEqual(fs.readdirSync(fixture).sort(), before);

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("injection mode reports a command that cannot be run, with exit code 2", () => {
  const result = runScript([
    "--no-default-sources",
    "--no-ambient",
    "--",
    "/nonexistent/definitely-not-a-command",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not run/);
});

test("the ambient environment outranks a file source", () => {
  const fixture = makeFixtureDirectory();
  const fileSentinel = makeSentinel("file");
  const ambientSentinel = makeSentinel("ambient");
  const envFile = path.join(fixture, "fixture.env");
  fs.writeFileSync(envFile, `FIXTURE_API_KEY=${fileSentinel}\n`, { mode: 0o600 });
  const child = path.join(fixture, "child.mjs");
  fs.writeFileSync(
    child,
    [
      "const value = process.env.FIXTURE_API_KEY ?? '';",
      "process.exit(value === process.env.EXPECTED_MARKER ? 0 : 4);",
    ].join("\n"),
  );

  const result = runScript(
    ["--no-default-sources", "--source", envFile, "--", process.execPath, child],
    {
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_API_KEY: ambientSentinel,
        EXPECTED_MARKER: ambientSentinel,
      },
    },
  );
  assert.equal(result.status, 0, "the file source overwrote the ambient value");
  assertNoSentinel(result, fileSentinel, "precedence");
  assertNoSentinel(result, ambientSentinel, "precedence");

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("the documented default source order is the one the script ships", () => {
  assert.deepEqual(
    DEFAULT_SOURCES.map((source) => source.name),
    ["ambient-env", "integration-worktree-env", "private-evidence-dir", "repo-root-env"],
  );
});
