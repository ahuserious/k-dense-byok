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
    assert.deepEqual(manifest.runnerFingerprint, {
      error: "runner-fingerprint.json unavailable",
    });
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
        "E2E inventory observed for filtered run: 2 total",
        "1 passed",
        "E2E inventory observed for filtered run: 3 total",
        "3 passed / 0 failed / 0 skipped",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(directory, "runner-fingerprint.json"),
      `${JSON.stringify({ hostname: "runner-7", image: "ubuntu-latest" })}\n`,
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
    assert.equal(manifest.inventoryLine, "E2E inventory observed for filtered run: 3 total");
    assert.equal(manifest.summaryLine, "3 passed / 0 failed / 0 skipped");
    assert.deepEqual(manifest.runnerFingerprint, {
      hostname: "runner-7",
      image: "ubuntu-latest",
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
