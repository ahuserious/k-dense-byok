import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { secretRepresentationsForValue } from "./hosted-evidence-secrets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const scriptPath = path.join(scriptDirectory, "hosted-evidence-manifest.mjs");
const manifestFileName = "hosted-evidence-manifest.json";
const controlledEnvironmentNames = [
  "E2E_WORKERS",
  "INPUT_GREP",
  "GITHUB_RUN_NUMBER",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "E2E_SUITE_OUTCOME",
  "E2E_RUN_ID",
  "E2E_RUN_URL",
  "E2E_RUN_STARTED_AT",
  "E2E_SUITE_NAME",
  "E2E_PASSED",
  "E2E_FAILED",
  "E2E_SKIPPED",
  "KADY_E2E_WORKERS",
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
  "SERVICE_TOKEN",
  "DATABASE_PASSWORD",
  "SIGNING_SECRET",
  "DEPLOY_CREDENTIAL",
  "RELEASE_PAT",
  "BASIC_AUTH",
];

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-evidence-manifest-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runManifest(directory, additions = {}) {
  const environment = { ...process.env };
  for (const name of controlledEnvironmentNames) delete environment[name];
  Object.assign(environment, additions);
  return spawnSync(process.execPath, [scriptPath], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
  });
}

function readManifest(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, manifestFileName), "utf8"));
}

function writeLastRun(directory, runId, timestamp) {
  fs.mkdirSync(path.join(directory, ".stably"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, ".stably/last-run.json"),
    JSON.stringify({ runId, timestamp }),
  );
}

function stablyEpilogue(suiteName, runId) {
  return [
    `Suite "${suiteName}" run complete!`,
    `View results: https://app.stably.ai/project/test/playwright/history/${runId}`,
  ];
}

test("writes stable not-detected evidence when input files are missing", () => {
  withTemporaryDirectory((directory) => {
    const result = runManifest(directory, {
      E2E_WORKERS: "2",
      GITHUB_RUN_NUMBER: "77",
      GITHUB_SHA: "abc123",
      GITHUB_RUN_ID: "9001",
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = readManifest(directory);
    assert.deepEqual(JSON.parse(result.stdout), manifest);
    assert.equal(
      manifest.command,
      'npx playwright test --workers="2" --trace on > stably-test.log 2>&1',
    );
    assert.deepEqual(manifest.runnerFingerprint, {});
    assert.equal(manifest.inventory, null);
    assert.equal(manifest.summary, null);
    assert.equal(manifest.inventoryLine, "not detected");
    assert.equal(manifest.summaryLine, "not detected");
    assert.equal(manifest.outcome, "not run");
    assert.equal(manifest.stably.state, "not attached");
    assert.equal(manifest.stablyRunId, "not attached");
    assert.equal(manifest.stablyRunUrl, "not attached");
  });
});

test("grep mode parses a genuine multiline Playwright epilogue", () => {
  withTemporaryDirectory((directory) => {
    const suiteName = "sds-outer-loop-ci-88";
    const runId = "stably-1";
    const runStartedAt = Date.now() - 1_000;
    fs.writeFileSync(
      path.join(directory, "stably-test.log"),
      [
        "E2E inventory observed for filtered run: 249 total = 213 executing-substantive + 36 thin; 4 fixme + 0 skip.",
        "  2 failed",
        "  4 skipped",
        "  243 passed (2.1m)",
        ...stablyEpilogue(suiteName, runId),
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(directory, "runner-fingerprint.json"),
      `${JSON.stringify({
        hostname: "runner-7",
        uname: "Linux test-host",
        nodeVersion: "v22.19.0",
        image: "ubuntu-latest",
        nested: { arbitrary: "not retained" },
        egressIpv4: 12345,
      })}\n`,
    );
    writeLastRun(directory, runId, Date.now());
    const result = runManifest(directory, {
      E2E_WORKERS: "3",
      INPUT_GREP: "@live",
      GITHUB_RUN_NUMBER: "88",
      GITHUB_SHA: "def456",
      GITHUB_RUN_ID: "9002",
      E2E_SUITE_OUTCOME: "success",
      E2E_RUN_STARTED_AT: String(runStartedAt),
      E2E_SUITE_NAME: suiteName,
      KADY_E2E_WORKERS: "4",
      STABLY_API_KEY: "must-not-leak",
      STABLY_PROJECT_ID: "also-must-not-leak",
    });
    assert.equal(result.status, 0, result.stderr);
    const manifestText = fs.readFileSync(path.join(directory, manifestFileName), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(
      manifest.command,
      'npx playwright test --workers="3" --grep "@live" --trace on > stably-test.log 2>&1',
    );
    assert.equal(
      manifest.inventoryLine,
      "E2E inventory observed for filtered run: 249 total = 213 executing-substantive + 36 thin; 4 fixme + 0 skip.",
    );
    assert.equal(manifest.summaryLine, "  243 passed (2.1m)");
    assert.deepEqual(manifest.inventory, {
      collected: 249,
      substantive: 213,
      thin: 36,
      fixme: 4,
      skipped: 0,
    });
    assert.deepEqual(manifest.summary, {
      passed: 243,
      failed: 2,
      skipped: 4,
      duration: "2.1m",
    });
    assert.deepEqual(manifest.runnerFingerprint, {
      hostname: "runner-7",
      uname: "Linux test-host",
      nodeVersion: "v22.19.0",
    });
    assert.deepEqual(manifest.environment, {
      CI: "1",
      KADY_E2E_BASE_URL: "http://127.0.0.1:13000",
      workers: "3",
      KADY_E2E_WORKERS: "4",
      E2E_SUITE_NAME: suiteName,
      STABLY_CLI_VERSION: "4.12.28",
      STABLY_REPORTER_VERSION: "2.1.16",
      secretVariableNames: ["STABLY_API_KEY", "STABLY_PROJECT_ID"],
    });
    assert.equal(manifest.outcome, "success");
    assert.equal(manifest.stably.state, "attached");
    assert.equal(manifest.stablyRunId, runId);
    assert.equal(
      manifest.stablyRunUrl,
      `https://app.stably.ai/project/test/playwright/history/${runId}`,
    );
    assert.doesNotMatch(manifestText, /must-not-leak/);
    assert.equal(fs.existsSync(path.join(directory, "stably-test.log")), false);
    assert.equal(
      fs.existsSync(path.join(directory, "stably-test.scrubbed.log")),
      true,
    );
  });
});

test("scrubs every secret form from every retained input and stdout", () => {
  withTemporaryDirectory((directory) => {
    const suiteName = "sds-outer-loop-ci-encoded";
    const runId = "encoded-run-1";
    const runStartedAt = Date.now() - 1_000;
    const secrets = {
      STABLY_API_KEY: "alpha\"omega\\ space ~!+%",
      STABLY_PROJECT_ID: "alpha+beta%7E%21",
      SERVICE_TOKEN: "xy",
      DATABASE_PASSWORD: "xy-long-overlap",
      SIGNING_SECRET: "manifest secret ~!+% sentinel",
      DEPLOY_CREDENTIAL: "manifest\\credential\"sentinel",
      RELEASE_PAT: "manifest+pat%sentinel",
      BASIC_AUTH: "manifest auth sentinel",
    };
    const secretValues = Object.values(secrets);
    const encodedValues = secretValues.flatMap(secretRepresentationsForValue);

    fs.writeFileSync(
      path.join(directory, "stably-test.log"),
      [
        `prefix-${secrets.SIGNING_SECRET}-suffix E2E inventory verified: 249 total = 213 executing-substantive + 36 thin; 4 fixme + 0 skip.`,
        `249 passed / 0 failed / 0 skipped (2.1m) ${encodeURIComponent(secrets.DATABASE_PASSWORD)}`,
        ...stablyEpilogue(suiteName, runId),
      ].join("\n"),
    );
    writeLastRun(directory, runId, Date.now());
    fs.writeFileSync(
      path.join(directory, "preview-up.log"),
      `preview-${secrets.STABLY_PROJECT_ID}-suffix\n`,
    );
    fs.writeFileSync(
      path.join(directory, "runner-fingerprint.json"),
      `${JSON.stringify({
        hostname: `runner-${secrets.STABLY_API_KEY}-suffix`,
        uname: Buffer.from(secrets.SERVICE_TOKEN, "utf8").toString("base64"),
        egressIpv4: secrets.DEPLOY_CREDENTIAL,
        egressIpv6: encodeURIComponent(secrets.RELEASE_PAT),
        GITHUB_RUN_ID: secrets.BASIC_AUTH,
        GITHUB_SHA: secrets.STABLY_PROJECT_ID,
        nodeVersion: "v22.19.0",
        bunVersion: "x".repeat(600),
        nested: { secret: secretValues.join(":") },
        arbitrary: secrets.STABLY_API_KEY,
      })}\n`,
    );

    const result = runManifest(directory, {
      ...secrets,
      E2E_WORKERS: `2-${secrets.SERVICE_TOKEN}-suffix`,
      INPUT_GREP: `@live-${secrets.RELEASE_PAT}-suffix`,
      GITHUB_RUN_NUMBER: `88-${secrets.DEPLOY_CREDENTIAL}`,
      GITHUB_SHA: `sha-${secrets.STABLY_PROJECT_ID}-suffix`,
      GITHUB_RUN_ID: `github-${secrets.BASIC_AUTH}-suffix`,
      E2E_SUITE_OUTCOME: `success-${secrets.SIGNING_SECRET}-suffix`,
      E2E_RUN_STARTED_AT: String(runStartedAt),
      E2E_SUITE_NAME: suiteName,
      E2E_RUN_ID: `run-${secrets.STABLY_API_KEY}-suffix`,
      E2E_RUN_URL: `https://example.test/${secrets.STABLY_API_KEY}/${Buffer.from(
        secrets.DATABASE_PASSWORD,
        "utf8",
      ).toString("base64")}`,
      KADY_E2E_WORKERS: `4-${secrets.BASIC_AUTH}-suffix`,
    });
    assert.equal(result.status, 0, result.stderr);

    const manifestText = fs.readFileSync(path.join(directory, manifestFileName), "utf8");
    const stablyLogText = fs.readFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      "utf8",
    );
    const previewLogText = fs.readFileSync(
      path.join(directory, "preview-up.scrubbed.log"),
      "utf8",
    );
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(JSON.parse(result.stdout), manifest);
    assert.deepEqual(Object.keys(manifest.runnerFingerprint), [
      "hostname",
      "uname",
      "egressIpv4",
      "egressIpv6",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "nodeVersion",
      "bunVersion",
    ]);
    assert.equal(manifest.runnerFingerprint.bunVersion.length, 512);
    assert.deepEqual(manifest.inventory, {
      collected: 249,
      substantive: 213,
      thin: 36,
      fixme: 4,
      skipped: 0,
    });
    assert.deepEqual(manifest.summary, {
      passed: 249,
      failed: 0,
      skipped: 0,
      duration: "2.1m",
    });

    for (const secretValue of encodedValues) {
      assert.equal(
        manifestText.includes(secretValue),
        false,
        `manifest file retained secret form: ${secretValue}`,
      );
      assert.equal(
        result.stdout.includes(secretValue),
        false,
        `stdout retained secret form: ${secretValue}`,
      );
      assert.equal(
        stablyLogText.includes(secretValue),
        false,
        `Stably log retained secret form: ${secretValue}`,
      );
      assert.equal(
        previewLogText.includes(secretValue),
        false,
        `preview log retained secret form: ${secretValue}`,
      );
    }
    assert.match(manifestText, /<REDACTED#\d+>/);
    assert.equal(manifestText.includes("[redacted:"), false);
  });
});

test("workflow-shaped writer and manifest subprocess share the secret-bearing environment", () => {
  withTemporaryDirectory((directory) => {
    const secrets = {
      STABLY_API_KEY: "workflow api key \"sentinel\"",
      STABLY_PROJECT_ID: "workflow+project%sentinel",
    };
    const environment = { ...process.env, ...secrets };
    for (const name of controlledEnvironmentNames) {
      if (!(name in secrets)) delete environment[name];
    }
    Object.assign(environment, {
      E2E_WORKERS: "2",
      GITHUB_RUN_NUMBER: "99",
      GITHUB_SHA: "workflow-sha",
      GITHUB_RUN_ID: "workflow-run",
      E2E_SUITE_OUTCOME: "success",
      E2E_RUN_STARTED_AT: String(Date.now() - 1_000),
      E2E_SUITE_NAME: "sds-outer-loop-ci-99",
    });
    const writerProgram = `
      import { spawnSync } from "node:child_process";
      import fs from "node:fs";
      fs.writeFileSync("stably-test.log", [
        "E2E inventory verified: 1 total = 1 executing-substantive + 0 thin; 0 fixme + 0 skip.",
        "1 passed (1s)",
        process.env.STABLY_API_KEY,
        'Suite "sds-outer-loop-ci-99" run complete!',
        "View results: https://app.stably.ai/project/test/playwright/history/workflow-run-id",
      ].join("\\n"));
      fs.writeFileSync("preview-up.log", process.env.STABLY_PROJECT_ID);
      fs.mkdirSync(".stably", { recursive: true });
      fs.writeFileSync(".stably/last-run.json", JSON.stringify({
        runId: "workflow-run-id", timestamp: Date.now(),
      }));
      const result = spawnSync(process.execPath, [${JSON.stringify(scriptPath)}], {
        cwd: process.cwd(), env: process.env, encoding: "utf8",
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", writerProgram],
      { cwd: directory, env: environment, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const retainedFiles = [
      manifestFileName,
      "stably-test.scrubbed.log",
      "preview-up.scrubbed.log",
    ];
    for (const fileName of retainedFiles) {
      const retained = fs.readFileSync(path.join(directory, fileName), "utf8");
      for (const secretValue of Object.values(secrets)) {
        for (const representation of secretRepresentationsForValue(secretValue)) {
          assert.equal(
            retained.includes(representation),
            false,
            `${fileName} retained a workflow secret representation`,
          );
          assert.equal(
            result.stdout.includes(representation),
            false,
            "manifest stdout retained a workflow secret representation",
          );
        }
      }
    }
    assert.equal(fs.existsSync(path.join(directory, "stably-test.log")), false);
    assert.equal(fs.existsSync(path.join(directory, "preview-up.log")), false);
  });
});

test("workflow manifest step explicitly receives both Stably secrets", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/stably-cloud.yml"),
    "utf8",
  );
  const manifestStep = workflow.match(
    /- name: Write hosted evidence manifest[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(manifestStep, "hosted evidence manifest workflow step is missing");
  assert.match(manifestStep, /STABLY_API_KEY: \$\{\{ secrets\.STABLY_API_KEY \}\}/);
  assert.match(
    manifestStep,
    /STABLY_PROJECT_ID: \$\{\{ secrets\.STABLY_PROJECT_ID \}\}/,
  );
  assert.match(manifestStep, /run: node scripts\/hosted-evidence-manifest\.mjs/);
});

test("attached reporter fails evidence generation without a fresh run record", () => {
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(
      path.join(directory, "stably-test.log"),
      [
        "1 passed (1s)",
        'Suite "sds-outer-loop-ci-missing" run complete!',
        "View results: https://app.stably.ai/project/test/playwright/history/missing-run",
      ].join("\n"),
    );
    const result = runManifest(directory, {
      STABLY_API_KEY: "attached-api-key",
      STABLY_PROJECT_ID: "attached-project-id",
      E2E_RUN_STARTED_AT: String(Date.now() - 1_000),
      E2E_SUITE_NAME: "sds-outer-loop-ci-missing",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a fresh last-run record/);
    assert.equal(fs.existsSync(path.join(directory, manifestFileName)), false);
  });
});

test("attached reporter rejects stale records and mismatched suite evidence", async (context) => {
  await context.test("stale last-run record", () => {
    withTemporaryDirectory((directory) => {
      const runId = "stale-run";
      const suiteName = "sds-outer-loop-ci-stale";
      const runStartedAt = Date.now() - 1_000;
      fs.writeFileSync(
        path.join(directory, "stably-test.log"),
        ["1 passed (1s)", ...stablyEpilogue(suiteName, runId)].join("\n"),
      );
      writeLastRun(directory, runId, runStartedAt - 60_000);
      const staleDate = new Date(runStartedAt - 60_000);
      fs.utimesSync(path.join(directory, ".stably/last-run.json"), staleDate, staleDate);
      const result = runManifest(directory, {
        STABLY_API_KEY: "attached-api-key",
        STABLY_PROJECT_ID: "attached-project-id",
        E2E_RUN_STARTED_AT: String(runStartedAt),
        E2E_SUITE_NAME: suiteName,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a fresh last-run record/);
    });
  });

  await context.test("suite name mismatch", () => {
    withTemporaryDirectory((directory) => {
      const runId = "wrong-suite-run";
      const runStartedAt = Date.now() - 1_000;
      fs.writeFileSync(
        path.join(directory, "stably-test.log"),
        ["1 passed (1s)", ...stablyEpilogue("different-suite", runId)].join("\n"),
      );
      writeLastRun(directory, runId, Date.now());
      const result = runManifest(directory, {
        STABLY_API_KEY: "attached-api-key",
        STABLY_PROJECT_ID: "attached-project-id",
        E2E_RUN_STARTED_AT: String(runStartedAt),
        E2E_SUITE_NAME: "expected-suite",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not match the expected suite name/);
    });
  });
});
