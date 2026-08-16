import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { sealHostedEvidenceBundle } from "./hosted-evidence-scan.mjs";
import { scrubAndVerifyText } from "./hosted-evidence-secrets.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const realisticLogBytes = 2 * 1024 * 1024;

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-realistic-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i.test(name)) {
      delete environment[name];
    }
  }
  environment.KADY_E2E_BASE_URL = "http://127.0.0.1:13000";
  return environment;
}

function writeRequiredPayloadArtifacts(directory, log) {
  fs.mkdirSync(path.join(directory, ".stably/test-results"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".stably/test-results/result.txt"), "clean");
  fs.writeFileSync(path.join(directory, "stably-install.log"), "clean");
  fs.writeFileSync(path.join(directory, "browser-install-method.txt"), "clean");
  fs.writeFileSync(path.join(directory, "preview-up.scrubbed.log"), "clean");
  fs.writeFileSync(path.join(directory, "stably-test.scrubbed.log"), log);
  fs.writeFileSync(path.join(directory, "runner-fingerprint.json"), "{}");
  fs.writeFileSync(
    path.join(directory, "hosted-evidence-manifest.json"),
    JSON.stringify({ evidence: "clean", stably: { state: "not attached" } }),
  );
}

function syntheticReporterLog() {
  const lines = [];
  let bytes = 0;
  for (let index = 0; bytes < realisticLogBytes; index += 1) {
    const identifier = Buffer.from(`benign-artifact-${index}`, "utf8").toString("base64url");
    const line =
      `  ✓ e2e/generated-${index}.spec.ts:42:7 › realistic item ${index} ` +
      `${JSON.stringify({ identifier, revision: index % 7, valid: true })}\n`;
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  lines.push("  243 passed\n", "  4 skipped\n", "  0 failed (2.1m)\n");
  return lines.join("");
}

test("real Playwright list and a two-MiB reporter log stay within canonicalization bounds", () => {
  const listed = spawnSync("npx", ["playwright", "test", "--list"], {
    cwd: repositoryRoot,
    env: cleanEnvironment(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, listed.stderr);
  const listOutput = `${listed.stdout}${listed.stderr}`;
  assert.match(listOutput, /Total: 249 tests in \d+ files/);

  const environment = {
    STABLY_API_KEY: "realistic-log-secret-sentinel",
    STABLY_PROJECT_ID: "realistic-log-project-sentinel",
  };
  const listStartedAt = performance.now();
  const scrubbedList = scrubAndVerifyText(listOutput, environment);
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory, scrubbedList);
    const sealed = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment,
    });
    assert.match(sealed.bundleSha256, /^[a-f0-9]{64}$/);
  });
  const actualListMs = performance.now() - listStartedAt;
  assert.ok(actualListMs < 10_000, `real --list canonicalization took ${actualListMs.toFixed(1)}ms`);

  const syntheticLog = syntheticReporterLog();
  assert.ok(Buffer.byteLength(syntheticLog) >= realisticLogBytes);
  const syntheticStartedAt = performance.now();
  const scrubbedSynthetic = scrubAndVerifyText(syntheticLog, environment);
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory, scrubbedSynthetic);
    const sealed = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment,
    });
    assert.match(sealed.bundleSha256, /^[a-f0-9]{64}$/);
  });
  const syntheticSealMs = performance.now() - syntheticStartedAt;
  assert.ok(
    syntheticSealMs < 30_000,
    `two-MiB realistic scrub/scan/seal took ${syntheticSealMs.toFixed(1)}ms`,
  );
  console.log(
    `REALISTIC_LOG_TIMING actualListCanonicalMs=${actualListMs.toFixed(1)} ` +
      `synthetic2MiBScrubScanSealMs=${syntheticSealMs.toFixed(1)}`,
  );
});
