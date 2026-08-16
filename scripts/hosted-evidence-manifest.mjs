#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_FILE_NAME = "stably-test.log";
const RUNNER_FINGERPRINT_FILE_NAME = "runner-fingerprint.json";
const MANIFEST_FILE_NAME = "hosted-evidence-manifest.json";

function readTextOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function lastMatchingLine(text, predicate) {
  let match = "not detected";
  for (const line of text.split(/\r?\n/)) {
    if (predicate(line)) match = line;
  }
  return match;
}

function readRunnerFingerprint(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { error: "runner-fingerprint.json unavailable" };
  }
}

function suiteCommand(environment) {
  const suiteName = `sds-outer-loop-ci-${environment.GITHUB_RUN_NUMBER ?? ""}`;
  const workers = environment.E2E_WORKERS ?? "";
  const grep = environment.INPUT_GREP ?? "";
  if (grep !== "") {
    return `npx stably test --workers="${workers}" --grep "${grep}" ` +
      `--suiteName "${suiteName}" > stably-test.log 2>&1`;
  }
  return `npx stably test --workers="${workers}" ` +
    `--suiteName "${suiteName}" > stably-test.log 2>&1`;
}

export function buildHostedEvidenceManifest({
  workingDirectory = process.cwd(),
  environment = process.env,
} = {}) {
  const log = readTextOrEmpty(path.join(workingDirectory, LOG_FILE_NAME));
  return {
    command: suiteCommand(environment),
    environment: {
      CI: "1",
      KADY_E2E_BASE_URL: "http://127.0.0.1:13000",
      workers: environment.E2E_WORKERS ?? "",
      KADY_E2E_WORKERS: environment.KADY_E2E_WORKERS || null,
      secretVariableNames: ["STABLY_API_KEY", "STABLY_PROJECT_ID"],
    },
    GITHUB_SHA: environment.GITHUB_SHA ?? "",
    GITHUB_RUN_ID: environment.GITHUB_RUN_ID ?? "",
    runnerFingerprint: readRunnerFingerprint(
      path.join(workingDirectory, RUNNER_FINGERPRINT_FILE_NAME),
    ),
    inventoryLine: lastMatchingLine(log, (line) => line.includes("E2E inventory ")),
    summaryLine: lastMatchingLine(log, (line) => /[0-9]+ (passed|failed)/.test(line)),
    outcome: environment.E2E_SUITE_OUTCOME || "not run",
    stablyRunId: environment.E2E_RUN_ID || "not detected",
    stablyRunUrl: environment.E2E_RUN_URL || "not detected",
  };
}

export function writeHostedEvidenceManifest(options = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const manifest = buildHostedEvidenceManifest({ ...options, workingDirectory });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(workingDirectory, MANIFEST_FILE_NAME), serialized);
  process.stdout.write(serialized);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeHostedEvidenceManifest();
}
