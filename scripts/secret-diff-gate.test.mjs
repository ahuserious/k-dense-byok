import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWLIST,
  PATTERNS,
  addedLinesByFile,
  environmentRepresentations,
  scanAddedLines,
  validateAllowlist,
} from "./secret-diff-gate.mjs";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "secret-diff-gate.mjs",
);

/**
 * One planted, obviously-fake value per pattern, each in its own file so a row can be
 * asserted against a file name. None of these is a real credential: every one is a shape.
 */
const PLANTED = [
  { id: "openai-sk", file: "openai.txt", line: "const key = '" + ["sk-", "FAKEFAKEfake0000000000000000000000"].join("") + "'" },
  { id: "aws-akia", file: "aws.txt", line: ["AKI", "AFAKEFAKEFAKE0000"].join("") },
  {
    id: "github-token",
    file: "github.txt",
    line: ["ghp", "_FAKEfakeFAKEfakeFAKEfakeFAKEfake0000"].join(""),
  },
  { id: "slack-token", file: "slack.txt", line: ["xox", String.fromCharCode(98), "-0000000000-FAKEfakeFAKEfake"].join("") },
  { id: "private-key", file: "pem.txt", line: ["---", "--BEGIN RSA PRIVATE KEY-----"].join("") },
  {
    id: "google-api-key",
    file: "google.txt",
    line: ["AIz", "aFAKEfakeFAKEfakeFAKEfakeFAKEfake000"].join(""),
  },
  {
    id: "jwt",
    file: "jwt.txt",
    line: ["eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEfakeFAKEfake"].join(""),
  },
  { id: "tailscale-key", file: "tailscale.txt", line: ["tsk", "ey-auth-FAKEfakeFAKEfake"].join("") },
  {
    id: "ngrok-authtoken",
    file: "ngrok-token.txt",
    line: "2FAKEfakeFAKEfakeFAKEfake_3FAKEfakeFAKEfakeFAKE",
  },
  {
    id: "generic-key-long",
    file: "generic.txt",
    line: "api_key=FAKEfakeFAKEfakeFAKEfake0000",
  },
  { id: "tailnet-host", file: "tailnet.txt", line: "https://laptop-fake.ts.net/api" },
  { id: "ngrok-domain", file: "ngrok.txt", line: "https://fake-tunnel.ngrok-free.app/hook" },
  { id: "operator-email", file: "email.txt", line: "contact: someone@realish-domain.co" },
  { id: "local-abs-path", file: "abspath.txt", line: "/Users/someone/Documents/project/x" },
];

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secret-diff-gate-test-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  git("init", "--quiet");
  git("config", "user.email", "lane@example.invalid");
  git("config", "user.name", "Lane Test");
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  return { root, git, base };
}

function runGate(args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf-8",
    env: options.env ?? { PATH: process.env.PATH ?? "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("addedLinesByFile takes '+' lines only, never the '+++' header", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -0,0 +1,2 @@",
    "+first added",
    "+second added",
    "-removed line",
    " context line",
  ].join("\n");
  const byFile = addedLinesByFile(diff);
  assert.deepEqual([...byFile.keys()], ["a.txt"]);
  assert.deepEqual(byFile.get("a.txt"), ["first added", "second added"]);
});

test("every pattern fires on its planted value, the gate exits 1, and nothing is echoed", () => {
  const { root, git, base } = makeRepository();
  for (const planted of PLANTED) {
    fs.writeFileSync(path.join(root, planted.file), `${planted.line}\n`);
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "planted");

  const result = runGate(["--base", base, "--repo", root]);
  assert.equal(result.status, 1, `expected findings; stderr: ${result.stderr}`);

  for (const planted of PLANTED) {
    const pattern = PATTERNS.find((entry) => entry.id === planted.id);
    assert.ok(pattern, `unknown pattern id ${planted.id}`);
    const row = new RegExp(`- ${pattern.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}: [1-9]`);
    assert.match(result.stdout, row, `pattern ${planted.id} reported 0`);
    assert.match(
      result.stdout,
      new RegExp(`${planted.file}: \\d+`),
      `file ${planted.file} missing from the report`,
    );
    // The whole point: the report names the file and the count, never the value.
    assert.ok(
      !result.stdout.includes(planted.line),
      `report echoed the planted line for ${planted.id}`,
    );
  }
  assert.match(result.stderr, /non-allowlisted hit/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an allowlisted path is marked and does not fail the gate", () => {
  const { root, git, base } = makeRepository();
  const allowlisted = ALLOWLIST[0];
  const filePath = path.join(root, allowlisted.path);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "const key = '" + ["sk-", "FAKEFAKEfake0000000000000000000000"].join("") + "';\\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "allowlisted fixture");

  const result = runGate(["--base", base, "--repo", root]);
  assert.equal(result.status, 0, `expected a clean gate; stderr: ${result.stderr}`);
  assert.match(result.stdout, new RegExp(`\\(allowlisted\\) ${allowlisted.path}: \\d+`));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the value-derived check finds a base64'd env value no regex would match", () => {
  const { root, git, base } = makeRepository();
  const sentinel = `FAKEVALUE-${crypto.randomBytes(24).toString("hex")}`;
  const encoded = Buffer.from(sentinel, "utf8").toString("base64");
  fs.writeFileSync(path.join(root, "payload.json"), `{"blob": "${encoded}"}\n`);
  git("add", ".");
  git("commit", "--quiet", "-m", "encoded value");

  const clean = runGate(["--base", base, "--repo", root]);
  assert.equal(clean.status, 0, "a base64 blob alone must not trip a shape pattern");

  const withSecret = runGate(["--base", base, "--repo", root], {
    env: { PATH: process.env.PATH ?? "", FIXTURE_API_KEY: sentinel },
  });
  assert.equal(withSecret.status, 1, "the encoded env value was not detected");
  assert.match(withSecret.stdout, /env var value \(any encoding\): 1 in 1 files/);
  assert.match(withSecret.stdout, /payload\.json: 1 \[names: FIXTURE_API_KEY\]/);
  assert.ok(!withSecret.stdout.includes(sentinel), "the report echoed the secret");
  assert.ok(!withSecret.stdout.includes(encoded), "the report echoed the encoded secret");
  assert.ok(!withSecret.stderr.includes(sentinel));
  fs.rmSync(root, { recursive: true, force: true });
});

test("--worktree sees uncommitted and untracked files", () => {
  const { root, git, base } = makeRepository();
  fs.writeFileSync(path.join(root, "untracked.txt"), ["AKI", "AFAKEFAKEFAKE0000"].join("") + "\\n");
  fs.appendFileSync(path.join(root, "README.md"), ["tsk", "ey-auth-FAKEfakeFAKEfake"].join("") + "\\n");
  git("add", "README.md");

  const committed = runGate(["--base", base, "--repo", root]);
  assert.equal(committed.status, 0, "nothing is committed yet, so the commit range is clean");

  const worktree = runGate(["--base", base, "--repo", root, "--worktree"]);
  assert.equal(worktree.status, 1);
  assert.match(worktree.stdout, /aws AKIA: 1 in 1 files/);
  assert.match(worktree.stdout, /untracked\.txt: 1/);
  assert.match(worktree.stdout, /tailscale tskey: 1 in 1 files/);
  assert.match(worktree.stdout, /working tree/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a clean diff exits 0 and prints a zero for every pattern", () => {
  const { root, git, base } = makeRepository();
  fs.writeFileSync(path.join(root, "plain.txt"), "nothing to see here\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "clean");

  const result = runGate(["--base", base, "--repo", root]);
  assert.equal(result.status, 0);
  for (const pattern of PATTERNS) {
    assert.ok(
      result.stdout.includes(`- ${pattern.name}: 0`),
      `pattern ${pattern.id} missing its zero row`,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("usage and environment errors exit 2, never 0", () => {
  const missingBase = runGate([]);
  assert.equal(missingBase.status, 2);
  assert.match(missingBase.stderr, /--base is required/);

  const unknown = runGate(["--base", "HEAD", "--nonsense"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/);

  const badRepo = runGate(["--base", "HEAD", "--repo", "/nonexistent-repo-path"]);
  assert.equal(badRepo.status, 2);
});

test("an allowlist entry without a reason is itself a failure", () => {
  assert.equal(validateAllowlist(), true);
  assert.throws(
    () => validateAllowlist([{ path: "a.ts", patternId: "openai-sk" }]),
    /no usable reason/,
  );
  assert.throws(
    () => validateAllowlist([{ path: "a.ts", patternId: "openai-sk", reason: "because" }]),
    /no usable reason/,
  );
  assert.throws(
    () =>
      validateAllowlist([
        { path: "a.ts", patternId: "not-a-pattern", reason: "a sufficiently long reason" },
      ]),
    /unknown pattern id/,
  );
});

test("environmentRepresentations ignores values too short to search for", () => {
  const representations = environmentRepresentations({
    SHORT_TOKEN: "abc",
    LONG_API_KEY: "abcdefghijklmnopqrstuvwxyz",
    NOT_A_SECRET_NAME: "abcdefghijklmnopqrstuvwxyz",
  });
  const names = new Set(representations.map((representation) => representation.name));
  assert.ok(names.has("LONG_API_KEY"));
  assert.ok(!names.has("SHORT_TOKEN"));
  assert.ok(!names.has("NOT_A_SECRET_NAME"));
});

test("scanAddedLines counts LINES, matching the prior art's '26,986 added lines' scope", () => {
  const byFile = new Map([
    ["a.txt", [["AKI", "AFAKEFAKEFAKE0000"].join(""), ["AKI", "AFAKEFAKEFAKE0001"].join(""), "harmless"]],
  ]);
  const { rows, failing } = scanAddedLines(byFile, { allowlist: [], representations: [] });
  const aws = rows.find((row) => row.id === "aws-akia");
  assert.equal(aws.total, 2);
  assert.deepEqual(aws.files, [{ path: "a.txt", count: 2, allowlisted: false }]);
  assert.equal(failing, 2);
});

test("a '*' allowlist entry covers shape patterns but never the value-derived check", () => {
  const byFile = new Map([["fixtures/planted.txt", [["AKI", "AFAKEFAKEFAKE0000"].join(""), "leaked-value-here-000"]]]);
  const { rows, failing } = scanAddedLines(byFile, {
    allowlist: [
      {
        path: "fixtures/planted.txt",
        patternId: "*",
        reason: "a fixture file that holds one planted value per pattern",
      },
    ],
    representations: [{ name: "FIXTURE_API_KEY", value: "leaked-value-here-000" }],
  });
  const aws = rows.find((row) => row.id === "aws-akia");
  assert.equal(aws.files[0].allowlisted, true, "the shape pattern should be allowlisted");
  const envValue = rows.find((row) => row.id === "env-value");
  assert.equal(envValue.total, 1);
  assert.equal(envValue.files[0].allowlisted, false, "'*' must not cover env-value");
  assert.equal(failing, 1, "only the env-value hit should fail the gate");
});
