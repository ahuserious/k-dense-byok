import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOSTED_EVIDENCE_ARTIFACT_PATHS,
  scanHostedEvidenceArtifacts,
} from "./hosted-evidence-scan.mjs";
import { secretRepresentationsForValue } from "./hosted-evidence-secrets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const scannerPath = path.join(scriptDirectory, "hosted-evidence-scan.mjs");

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-evidence-scan-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("detects every required secret representation without printing its value", () => {
  withTemporaryDirectory((directory) => {
    const secret = "alpha\"omega\\ space ~!+%";
    const environment = { STABLY_API_KEY: secret };
    const artifactName = "evidence.log";
    const artifactPath = path.join(directory, artifactName);
    for (const representation of secretRepresentationsForValue(secret)) {
      fs.writeFileSync(artifactPath, `prefix-${representation}-suffix`);
      assert.throws(
        () =>
          scanHostedEvidenceArtifacts({
            workingDirectory: directory,
            environment,
            artifactPaths: [artifactName],
          }),
        (error) => {
          assert.match(error.message, /evidence\.log/);
          assert.equal(error.message.includes(secret), false);
          return true;
        },
      );
    }
  });
});

test("inspects zip contents and reports only the artifact path", () => {
  withTemporaryDirectory((directory) => {
    const secret = "archive secret +% sentinel";
    const sourceDirectory = path.join(directory, "zip-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "trace-secret.txt"), secret);
    const zipResult = spawnSync(
      "zip",
      ["-q", path.join(directory, "trace.zip"), "trace-secret.txt"],
      { cwd: sourceDirectory, encoding: "utf8" },
    );
    assert.equal(zipResult.status, 0, zipResult.stderr);

    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_PROJECT_ID: secret },
          artifactPaths: ["trace.zip"],
        }),
      (error) => {
        assert.match(error.message, /trace\.zip/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });
});

test("detects secrets in archive entry names without echoing the entry", () => {
  withTemporaryDirectory((directory) => {
    const secret = "secret-filename-sentinel";
    const sourceDirectory = path.join(directory, "zip-source");
    fs.mkdirSync(sourceDirectory);
    const secretFileName = `trace-${secret}.txt`;
    fs.writeFileSync(path.join(sourceDirectory, secretFileName), "clean content");
    const zipResult = spawnSync(
      "zip",
      ["-q", path.join(directory, "trace.zip"), secretFileName],
      { cwd: sourceDirectory, encoding: "utf8" },
    );
    assert.equal(zipResult.status, 0, zipResult.stderr);

    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["trace.zip"],
        }),
      (error) => {
        assert.equal(error.message, "secret representation detected in artifact: trace.zip");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });
});

test("CLI scans the workflow artifact set and fails closed before upload", () => {
  withTemporaryDirectory((directory) => {
    const secret = "workflow scan secret";
    fs.writeFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      new URLSearchParams([["value", secret]]).toString().slice("value=".length),
    );
    const result = spawnSync(process.execPath, [scannerPath], {
      cwd: directory,
      env: { ...process.env, STABLY_API_KEY: secret },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stably-test\.scrubbed\.log/);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stdout, "");
    assert.ok(HOSTED_EVIDENCE_ARTIFACT_PATHS.includes("playwright-report"));
    assert.ok(HOSTED_EVIDENCE_ARTIFACT_PATHS.includes("test-results"));
    assert.ok(HOSTED_EVIDENCE_ARTIFACT_PATHS.includes(".stably/test-results"));
  });
});

test("passes clean text and clean archive artifacts", () => {
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(path.join(directory, "clean.log"), "no retained credentials");
    const sourceDirectory = path.join(directory, "clean-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "trace.txt"), "clean trace");
    const zipResult = spawnSync(
      "zip",
      ["-q", path.join(directory, "clean.zip"), "trace.txt"],
      { cwd: sourceDirectory, encoding: "utf8" },
    );
    assert.equal(zipResult.status, 0, zipResult.stderr);

    assert.deepEqual(
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: { STABLY_API_KEY: "absent secret" },
        artifactPaths: ["clean.log", "clean.zip"],
      }),
      { scannedPaths: 2 },
    );
  });
});

test("workflow scans the exact scrubbed upload set before artifact upload", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/stably-cloud.yml"),
    "utf8",
  );
  const scanStep = workflow.match(
    /- name: Scan hosted evidence artifacts[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(scanStep, "hosted evidence scan workflow step is missing");
  assert.match(scanStep, /STABLY_API_KEY: \$\{\{ secrets\.STABLY_API_KEY \}\}/);
  assert.match(scanStep, /STABLY_PROJECT_ID: \$\{\{ secrets\.STABLY_PROJECT_ID \}\}/);
  assert.match(scanStep, /run: node scripts\/hosted-evidence-scan\.mjs/);

  const uploadStep = workflow.match(
    /- name: Upload GitHub-runner evidence[\s\S]*?(?=\n\n  stably-cloud:)/,
  )?.[0];
  assert.ok(uploadStep, "hosted evidence upload workflow step is missing");
  assert.match(uploadStep, /steps\.artifact-scan\.outcome == 'success'/);
  for (const artifactPath of HOSTED_EVIDENCE_ARTIFACT_PATHS) {
    assert.ok(uploadStep.includes(artifactPath), `${artifactPath} is not uploaded`);
  }
  assert.doesNotMatch(uploadStep, /^\s+preview-up\.log$/m);
  assert.doesNotMatch(uploadStep, /^\s+stably-test\.log$/m);
});
