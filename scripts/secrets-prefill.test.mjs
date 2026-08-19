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
  WriteRefusal,
  openGuardedWriteDescriptor,
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

/**
 * Build a throwaway git repository with `tracked.env` committed and `.gitignore` listing
 * every name a test wants git to ignore. Returns { fixture, repository, envFile, sentinel }.
 */
function makeWriteFixture(label, ignored) {
  const fixture = makeFixtureDirectory();
  const sentinel = makeSentinel(label);
  const envFile = path.join(fixture, "fixture.env");
  fs.writeFileSync(envFile, `FIXTURE_API_KEY=${sentinel}\n`, { mode: 0o600 });

  const repository = path.join(fixture, "repo");
  fs.mkdirSync(repository);
  const git = (...args) =>
    spawnSync("git", args, { cwd: repository, encoding: "utf-8", stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.email", "lane@example.invalid");
  git("config", "user.name", "Lane Test");
  fs.writeFileSync(path.join(repository, ".gitignore"), `${ignored.join("\n")}\n`);
  fs.writeFileSync(path.join(repository, "tracked.env"), "PLACEHOLDER=\n");
  git("add", ".gitignore", "tracked.env");
  git("commit", "--quiet", "-m", "fixture");
  return { fixture, repository, envFile, sentinel };
}

test("--write refuses a SYMLINK, even one git calls untracked and ignored", () => {
  // The reviewer's attack, verbatim: both git questions are about the NAME, so a link
  // that is itself ignored and untracked answers them correctly while the bytes land in
  // the tracked file it points at. Before the fix this printed `wrote 1 name(s)` at
  // exit 0 and `git status` reported ` M tracked.env`.
  const { fixture, repository, envFile, sentinel } = makeWriteFixture("symlink", ["link.env"]);
  fs.symlinkSync("tracked.env", path.join(repository, "link.env"));

  const trackedPath = path.join(repository, "tracked.env");
  const modeBefore = fs.statSync(trackedPath).mode & 0o777;
  const result = runScript(
    ["--no-default-sources", "--no-ambient", "--source", envFile, "--write",
      path.join(repository, "link.env")],
    { cwd: repository },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to write/);
  assert.match(result.stderr, /symbolic link/);
  assert.match(result.stderr, /link\.env/);
  assertNoSentinel(result, sentinel, "--write symlink");
  // The effect, not the message: the tracked file is byte-identical and its mode is
  // untouched, and git sees no modification.
  assert.equal(fs.readFileSync(trackedPath, "utf-8"), "PLACEHOLDER=\n");
  assert.equal(fs.statSync(trackedPath).mode & 0o777, modeBefore);
  const status = spawnSync("git", ["status", "--short"], {
    cwd: repository,
    encoding: "utf-8",
  });
  assert.equal(status.stdout.trim(), "", "git saw a modification after a refused write");

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("--write refuses a HARD LINK, which defeats the git questions with no link to see", () => {
  const { fixture, repository, envFile, sentinel } = makeWriteFixture("hardlink", ["hard.env"]);
  const trackedPath = path.join(repository, "tracked.env");
  fs.linkSync(trackedPath, path.join(repository, "hard.env"));

  const result = runScript(
    ["--no-default-sources", "--no-ambient", "--source", envFile, "--write",
      path.join(repository, "hard.env")],
    { cwd: repository },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to write/);
  assert.match(result.stderr, /2 hard links/);
  assertNoSentinel(result, sentinel, "--write hardlink");
  assert.equal(fs.readFileSync(trackedPath, "utf-8"), "PLACEHOLDER=\n");
  const status = spawnSync("git", ["status", "--short"], {
    cwd: repository,
    encoding: "utf-8",
  });
  assert.equal(status.stdout.trim(), "");

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("the descriptor guard refuses a link on its own, without asking git at all", () => {
  // The second layer, tested in isolation from the first. classifyWriteTarget's lstat
  // answers "is it a link right now"; this is what stops a link planted after that
  // answer, so it has to refuse a link even when nothing checked beforehand.
  const fixture = makeFixtureDirectory();
  const realFile = path.join(fixture, "real.txt");
  fs.writeFileSync(realFile, "untouched\n");
  const link = path.join(fixture, "link.txt");
  fs.symlinkSync(realFile, link);

  assert.throws(
    () => openGuardedWriteDescriptor(link),
    (error) => error instanceof WriteRefusal && /could not be opened without following a link/.test(error.message),
  );
  assert.equal(fs.readFileSync(realFile, "utf-8"), "untouched\n");

  const hard = path.join(fixture, "hard.txt");
  fs.linkSync(realFile, hard);
  assert.throws(
    () => openGuardedWriteDescriptor(hard),
    (error) => error instanceof WriteRefusal && /2 hard links/.test(error.message),
  );
  assert.equal(fs.readFileSync(realFile, "utf-8"), "untouched\n");

  // And on a plain file it succeeds, returning a descriptor already 0600 and truncated.
  const plain = path.join(fixture, "plain.txt");
  fs.writeFileSync(plain, "a much longer previous body that must not survive\n", { mode: 0o644 });
  const descriptor = openGuardedWriteDescriptor(plain);
  fs.writeSync(descriptor, "new\n", 0, "utf8");
  fs.closeSync(descriptor);
  assert.equal(fs.readFileSync(plain, "utf-8"), "new\n");
  assert.equal(fs.statSync(plain).mode & 0o777, 0o600);

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("--only bounds what --write emits, not just what --list reports", () => {
  // Without --only, --write emits every reported present name, which on a real machine is
  // every secret-shaped ambient variable. --only is the caller's control over that blast
  // radius, so it has to reach the written body and not stop at the printed table.
  const fixture = makeFixtureDirectory();
  const wanted = makeSentinel("wanted");
  const unwanted = makeSentinel("unwanted");
  const envFile = path.join(fixture, "fixture.env");
  fs.writeFileSync(
    envFile,
    `FIXTURE_API_KEY=${wanted}\nOTHER_API_TOKEN=${unwanted}\n`,
    { mode: 0o600 },
  );

  const repository = path.join(fixture, "repo");
  fs.mkdirSync(repository);
  const git = (...args) =>
    spawnSync("git", args, { cwd: repository, encoding: "utf-8", stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.email", "lane@example.invalid");
  git("config", "user.name", "Lane Test");
  fs.writeFileSync(path.join(repository, ".gitignore"), "secrets.env\n");
  git("add", ".gitignore");
  git("commit", "--quiet", "-m", "fixture");

  const target = path.join(repository, "secrets.env");
  const result = runScript(
    ["--no-default-sources", "--no-ambient", "--source", envFile,
      "--only", "FIXTURE_API_KEY", "--write", target],
    { cwd: repository },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /wrote 1 name\(s\)/);
  const body = fs.readFileSync(target, "utf-8");
  assert.ok(body.includes("FIXTURE_API_KEY="), "the requested name is missing");
  assert.ok(!body.includes("OTHER_API_TOKEN"), "an unrequested name was written");
  assert.ok(!body.includes(unwanted), "an unrequested VALUE was written");
  assertNoSentinel(result, wanted, "--write --only");
  assertNoSentinel(result, unwanted, "--write --only");

  fs.rmSync(fixture, { recursive: true, force: true });
});

test("an allowed --write over a longer existing file leaves no tail of the old body", () => {
  // O_TRUNC is not requested at open time (it would destroy the file before the hard-link
  // question could be answered), so the truncation happens on the descriptor afterwards.
  // If that were ever dropped, a shorter body would leave the previous file's tail behind.
  const { fixture, repository, envFile, sentinel } = makeWriteFixture("truncate", ["secrets.env"]);
  const target = path.join(repository, "secrets.env");
  const oldTail = "PREVIOUS_LONGER_BODY_THAT_MUST_NOT_SURVIVE=" + "x".repeat(400);
  fs.writeFileSync(target, `${oldTail}\n`, { mode: 0o644 });

  const result = runScript(
    ["--no-default-sources", "--no-ambient", "--source", envFile,
      "--only", "FIXTURE_API_KEY", "--write", target],
    { cwd: repository },
  );
  assert.equal(result.status, 0);
  const body = fs.readFileSync(target, "utf-8");
  assert.ok(!body.includes("PREVIOUS_LONGER_BODY"), "the previous body survived the write");
  assert.ok(body.includes(sentinel));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assertNoSentinel(result, sentinel, "--write truncating");

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
