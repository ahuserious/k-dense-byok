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
  ENV_VALUE_PATTERN,
  PATTERNS,
  formatReport,
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
 * Slack bot-token shapes are assembled at runtime so this tracked file never
 * contains a contiguous `xox` + family + hyphen literal. GitHub push protection
 * matches those shapes in history; a forward commit can only clean the tip.
 */
function plantedSlackBotShape() {
  const family = String.fromCharCode(98);
  return `xox${family}-0000000000-FAKEfakeFAKEfake`;
}

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
  { id: "slack-token", file: "slack.txt", line: plantedSlackBotShape() },
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

test("a zero value-derived row says 'not run' when the environment held no secrets", () => {
  // The two zeros this row can print mean opposite things: "every encoding of every
  // secret was searched for and none appeared" and "nothing was searched for". CI ships
  // no secrets by default, so the second is the one it produces, and an indistinguishable
  // `0` reads as the first. The row has to say which one happened.
  const byFile = new Map([["fixtures/planted.txt", [["AKI", "AFAKEFAKEFAKE0000"].join("")]]]);
  const empty = scanAddedLines(byFile, { allowlist: [], representations: [] });
  const emptyRow = empty.rows.find((row) => row.id === ENV_VALUE_PATTERN.id);
  assert.equal(emptyRow.variableCount, 0);
  const emptyReport = formatReport({
    rows: empty.rows,
    header: "# fixture",
    addedLineCount: 1,
    fileCount: 1,
  });
  assert.match(
    emptyReport,
    /- env var value \(any encoding\): not run — 0 secret-shaped variables in the environment/,
  );
  assert.ok(
    !emptyReport.includes(`- ${ENV_VALUE_PATTERN.name}: 0\n`),
    "a not-run row must not also print a bare zero",
  );

  // A real zero — variables were expanded and searched for — still reads as a zero, and
  // says how much was searched for. Counts only: no name appears without a hit.
  const loaded = scanAddedLines(byFile, {
    allowlist: [],
    representations: [
      { name: "FIXTURE_API_KEY", value: "aaaaaaaaaaaaaaaaaaaa" },
      { name: "FIXTURE_API_KEY", value: "YWFhYWFhYWFhYWFhYWFhYWFhYWE=" },
      { name: "OTHER_TOKEN", value: "bbbbbbbbbbbbbbbbbbbb" },
    ],
  });
  const loadedRow = loaded.rows.find((row) => row.id === ENV_VALUE_PATTERN.id);
  assert.equal(loadedRow.variableCount, 2);
  assert.equal(loadedRow.representationCount, 3);
  const loadedReport = formatReport({
    rows: loaded.rows,
    header: "# fixture",
    addedLineCount: 1,
    fileCount: 1,
  });
  assert.match(
    loadedReport,
    /- env var value \(any encoding\): 0 \(searched 3 representation\(s\) of 2 secret-shaped variable\(s\)\)/,
  );
  assert.ok(!loadedReport.includes("FIXTURE_API_KEY"), "a name leaked without a hit");
  assert.ok(!loadedReport.includes("OTHER_TOKEN"), "a name leaked without a hit");
});

test("--require-env-values exits 2 when the value-derived half had nothing to search for", () => {
  const { root, git, base } = makeRepository();
  fs.writeFileSync(path.join(root, "plain.txt"), "nothing to see here\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "clean");

  // An empty environment: exactly the state the CI job is in when no secret is mapped.
  const withoutSecrets = runGate(["--base", base, "--repo", root, "--require-env-values"], {
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(withoutSecrets.status, 2, "a gate that did not run must not report clean");
  assert.match(withoutSecrets.stderr, /--require-env-values was given/);
  assert.match(withoutSecrets.stderr, /did not run/);
  // The report is still printed; the exit code is what changes.
  assert.match(withoutSecrets.stdout, /not run — 0 secret-shaped variables/);

  // Without the flag the same state is a report, not an error — the flag is opt-in so a
  // local run over a repository does not need the owner's secrets loaded to be useful.
  const unflagged = runGate(["--base", base, "--repo", root], {
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unflagged.status, 0);
  assert.match(unflagged.stdout, /not run — 0 secret-shaped variables/);

  // With a secret-shaped variable present the flag is satisfied and the row is a real zero.
  const sentinel = `SENTINEL-${crypto.randomBytes(24).toString("hex")}`;
  const withSecrets = runGate(["--base", base, "--repo", root, "--require-env-values"], {
    env: { PATH: process.env.PATH ?? "", FIXTURE_API_KEY: sentinel },
  });
  assert.equal(withSecrets.status, 0);
  assert.match(withSecrets.stdout, /- env var value \(any encoding\): 0 \(searched \d+ representation/);
  assert.ok(!withSecrets.stdout.includes(sentinel), "the sentinel reached stdout");
  assert.ok(!withSecrets.stdout.includes("FIXTURE_API_KEY"), "a name appeared without a hit");

  fs.rmSync(root, { recursive: true, force: true });
});

test("--require-env-values outranks findings: exit 2, both complaints, on a dirty diff", () => {
  // The documented exit-code table said 2 meant "--require-env-values with no secret-shaped
  // variable in the environment", with no carve-out — but the code returned 1 for findings
  // before it ever evaluated the flag, so the documented 2 held only on a clean diff. A CI
  // job that both dropped its secret mapping and has an unrelated allowlist miss now
  // reports the reason that is actually actionable: its strongest half never ran.
  const { root, git, base } = makeRepository();
  fs.writeFileSync(
    path.join(root, "planted.txt"),
    ["AKI", "AQQQQQQQQQQQQQQQQ"].join("") + "\\n" + ["sk-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join("") + "\\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "planted");

  const emptyEnvironment = { PATH: process.env.PATH ?? "" };
  const both = runGate(["--base", base, "--repo", root, "--require-env-values"], {
    env: emptyEnvironment,
  });
  assert.equal(both.status, 2, "the not-run state outranks the findings");
  // Neither complaint is swallowed by the other: the hits are still named on stderr, the
  // not-run sentence is still there, and the precedence itself is stated rather than left
  // for a reader to infer from an exit code.
  assert.match(both.stderr, /non-allowlisted hit\(s\) in added lines/);
  assert.match(both.stderr, /--require-env-values was given/);
  assert.match(both.stderr, /exiting 2 rather than 1/);
  assert.match(both.stdout, /not run — 0 secret-shaped variables/);

  // The same dirty diff WITHOUT the flag is still a plain findings failure, exit 1.
  const findingsOnly = runGate(["--base", base, "--repo", root], { env: emptyEnvironment });
  assert.equal(findingsOnly.status, 1);
  assert.ok(!findingsOnly.stderr.includes("exiting 2 rather than 1"));

  // And with a secret-shaped variable present the value half DID run, so the findings win.
  const sentinel = `SENTINEL-${crypto.randomBytes(24).toString("hex")}`;
  const halfRan = runGate(["--base", base, "--repo", root, "--require-env-values"], {
    env: { PATH: process.env.PATH ?? "", FIXTURE_API_KEY: sentinel },
  });
  assert.equal(halfRan.status, 1, "with the half running, findings are the reason");
  assert.ok(!halfRan.stderr.includes("did not run"));
  assert.ok(!halfRan.stdout.includes(sentinel), "the sentinel reached stdout");

  fs.rmSync(root, { recursive: true, force: true });
});
