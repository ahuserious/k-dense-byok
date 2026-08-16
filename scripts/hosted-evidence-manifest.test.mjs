import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
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
      'npx stably test --workers="2" --suiteName "sds-outer-loop-ci-77" > stably-test.log 2>&1',
    );
    assert.deepEqual(manifest.runnerFingerprint, {});
    assert.equal(manifest.inventory, null);
    assert.equal(manifest.summary, null);
    assert.equal(manifest.inventoryLine, "not detected");
    assert.equal(manifest.summaryLine, "not detected");
    assert.equal(manifest.outcome, "not run");
    assert.equal(manifest.stablyRunId, "not detected");
    assert.equal(manifest.stablyRunUrl, "not detected");
  });
});

test("grep mode records exact command, final log lines, and redacted environment", () => {
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(
      path.join(directory, "stably-test.log"),
      [
        "E2E inventory observed for filtered run: 2 total = 2 executing-substantive + 0 thin; 0 fixme + 0 skip.",
        "1 passed",
        "E2E inventory observed for filtered run: 3 total = 3 executing-substantive + 0 thin; 0 fixme + 0 skip.",
        "3 passed / 0 failed / 0 skipped (4.2s)",
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
    const result = runManifest(directory, {
      E2E_WORKERS: "3",
      INPUT_GREP: "@live",
      GITHUB_RUN_NUMBER: "88",
      GITHUB_SHA: "def456",
      GITHUB_RUN_ID: "9002",
      E2E_SUITE_OUTCOME: "success",
      E2E_RUN_ID: "stably-1",
      E2E_RUN_URL: "https://stably.ai/runs/stably-1",
      KADY_E2E_WORKERS: "4",
      STABLY_API_KEY: "must-not-leak",
      STABLY_PROJECT_ID: "also-must-not-leak",
    });
    assert.equal(result.status, 0, result.stderr);
    const manifestText = fs.readFileSync(path.join(directory, manifestFileName), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(
      manifest.command,
      'npx stably test --workers="3" --grep "@live" --suiteName "sds-outer-loop-ci-88" > stably-test.log 2>&1',
    );
    assert.equal(
      manifest.inventoryLine,
      "E2E inventory observed for filtered run: 3 total = 3 executing-substantive + 0 thin; 0 fixme + 0 skip.",
    );
    assert.equal(manifest.summaryLine, "3 passed / 0 failed / 0 skipped (4.2s)");
    assert.deepEqual(manifest.inventory, {
      collected: 3,
      substantive: 3,
      thin: 0,
      fixme: 0,
      skipped: 0,
    });
    assert.deepEqual(manifest.summary, {
      passed: 3,
      failed: 0,
      skipped: 0,
      duration: "4.2s",
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
      secretVariableNames: ["STABLY_API_KEY", "STABLY_PROJECT_ID"],
    });
    assert.equal(manifest.outcome, "success");
    assert.equal(manifest.stablyRunId, "stably-1");
    assert.equal(manifest.stablyRunUrl, "https://stably.ai/runs/stably-1");
    assert.doesNotMatch(manifestText, /must-not-leak/);
  });
});

test("scrubs every secret form from every retained input and stdout", () => {
  withTemporaryDirectory((directory) => {
    const secrets = {
      STABLY_API_KEY: "manifest/api-key+sentinel?x=1",
      STABLY_PROJECT_ID: "manifest/project+sentinel?x=2",
      SERVICE_TOKEN: "manifest/token+sentinel?x=3",
      DATABASE_PASSWORD: "manifest/password+sentinel?x=4",
      SIGNING_SECRET: "manifest/secret+sentinel?x=5",
      DEPLOY_CREDENTIAL: "manifest/credential+sentinel?x=6",
      RELEASE_PAT: "manifest/pat+sentinel?x=7",
      BASIC_AUTH: "manifest/auth+sentinel?x=8",
    };
    const secretValues = Object.values(secrets);
    const encodedValues = secretValues.flatMap((value) => [
      value,
      encodeURIComponent(value),
      Buffer.from(value, "utf8").toString("base64"),
      Buffer.from(value, "utf8").toString("base64url"),
    ]);

    fs.writeFileSync(
      path.join(directory, "stably-test.log"),
      [
        `prefix-${secrets.SIGNING_SECRET}-suffix E2E inventory verified: 249 total = 213 executing-substantive + 36 thin; 4 fixme + 0 skip.`,
        `249 passed / 0 failed / 0 skipped (2.1m) ${encodeURIComponent(secrets.DATABASE_PASSWORD)}`,
      ].join("\n"),
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
      E2E_RUN_ID: `run-${secrets.STABLY_API_KEY}-suffix`,
      E2E_RUN_URL: `https://example.test/${secrets.STABLY_API_KEY}/${Buffer.from(
        secrets.DATABASE_PASSWORD,
        "utf8",
      ).toString("base64")}`,
      KADY_E2E_WORKERS: `4-${secrets.BASIC_AUTH}-suffix`,
    });
    assert.equal(result.status, 0, result.stderr);

    const manifestText = fs.readFileSync(path.join(directory, manifestFileName), "utf8");
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
    }
    for (const secretName of Object.keys(secrets)) {
      assert.match(manifestText, new RegExp(`\\[redacted:${secretName}\\]`));
    }
  });
});
