#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSecretRepresentations,
  scrubText,
} from "./hosted-evidence-secrets.mjs";

const RAW_LOG_FILE_NAME = "stably-test.log";
const LOG_FILE_NAME = "stably-test.scrubbed.log";
const RAW_PREVIEW_LOG_FILE_NAME = "preview-up.log";
const PREVIEW_LOG_FILE_NAME = "preview-up.scrubbed.log";
const RUNNER_FINGERPRINT_FILE_NAME = "runner-fingerprint.json";
const MANIFEST_FILE_NAME = "hosted-evidence-manifest.json";
const MAX_FINGERPRINT_FIELD_LENGTH = 512;
const MAX_DURATION_LENGTH = 64;
const RUNNER_FINGERPRINT_FIELDS = [
  "hostname",
  "uname",
  "egressIpv4",
  "egressIpv6",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "nodeVersion",
  "bunVersion",
];

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

function readRunnerFingerprint(filePath, replacements) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const fingerprint = {};
    for (const field of RUNNER_FINGERPRINT_FIELDS) {
      const value = parsed[field];
      if (typeof value === "string") {
        fingerprint[field] = scrubText(value, replacements).slice(
          0,
          MAX_FINGERPRINT_FIELD_LENGTH,
        );
      }
    }
    return fingerprint;
  } catch {
    return {};
  }
}

function parseInventoryLine(line) {
  const match = line.match(
    /(\d+)\s+total\s*=\s*(\d+)\s+executing-substantive\s*\+\s*(\d+)\s+thin;\s*(\d+)\s+fixme\s*\+\s*(\d+)\s+skip/,
  );
  if (!match) return null;
  return {
    collected: Number(match[1]),
    substantive: Number(match[2]),
    thin: Number(match[3]),
    fixme: Number(match[4]),
    skipped: Number(match[5]),
  };
}

function environmentCount(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

function parseSummary(log, environment) {
  let passed = null;
  let failed = null;
  let skipped = null;
  let duration = null;
  for (const line of log.split(/\r?\n/)) {
    const passedMatch = line.match(/(\d+)\s+passed/);
    const failedMatch = line.match(/(\d+)\s+failed/);
    const skippedMatch = line.match(/(\d+)\s+(?:skipped|fixme)/);
    const durationMatch = line.match(/\((\d+(?:\.\d+)?(?:ms|s|m|h))\)/);
    if (passedMatch) passed = Number(passedMatch[1]);
    if (failedMatch) failed = Number(failedMatch[1]);
    if (skippedMatch) skipped = Number(skippedMatch[1]);
    if (durationMatch) duration = durationMatch[1].slice(0, MAX_DURATION_LENGTH);
  }
  passed = environmentCount(environment.E2E_PASSED) ?? passed;
  failed = environmentCount(environment.E2E_FAILED) ?? failed;
  skipped = environmentCount(environment.E2E_SKIPPED) ?? skipped;
  if (passed === null && failed === null && skipped === null) return null;
  return {
    passed,
    failed,
    skipped,
    duration,
  };
}

function writeScrubbedLog(workingDirectory, sourceName, destinationName, replacements) {
  const sourcePath = path.join(workingDirectory, sourceName);
  if (!fs.existsSync(sourcePath)) return;
  const destinationPath = path.join(workingDirectory, destinationName);
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
  const scrubbed = scrubText(fs.readFileSync(sourcePath, "utf8"), replacements);
  fs.writeFileSync(temporaryPath, scrubbed);
  fs.renameSync(temporaryPath, destinationPath);
  fs.unlinkSync(sourcePath);
}

function writeScrubbedLogs(workingDirectory, replacements) {
  writeScrubbedLog(
    workingDirectory,
    RAW_LOG_FILE_NAME,
    LOG_FILE_NAME,
    replacements,
  );
  writeScrubbedLog(
    workingDirectory,
    RAW_PREVIEW_LOG_FILE_NAME,
    PREVIEW_LOG_FILE_NAME,
    replacements,
  );
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
  const replacements = collectSecretRepresentations(environment);
  const log = readTextOrEmpty(path.join(workingDirectory, LOG_FILE_NAME));
  const rawInventoryLine = lastMatchingLine(log, (line) =>
    line.includes("E2E inventory "),
  );
  const rawSummaryLine = lastMatchingLine(log, (line) =>
    /[0-9]+ (passed|failed|skipped)/.test(line),
  );
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
      replacements,
    ),
    inventory: parseInventoryLine(rawInventoryLine),
    summary: parseSummary(log, environment),
    inventoryLine: scrubText(rawInventoryLine, replacements),
    summaryLine: scrubText(rawSummaryLine, replacements),
    outcome: environment.E2E_SUITE_OUTCOME || "not run",
    stablyRunId: environment.E2E_RUN_ID || "not detected",
    stablyRunUrl: environment.E2E_RUN_URL || "not detected",
  };
}

export function writeHostedEvidenceManifest(options = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const environment = options.environment ?? process.env;
  const replacements = collectSecretRepresentations(environment);
  writeScrubbedLogs(workingDirectory, replacements);
  const manifest = buildHostedEvidenceManifest({
    ...options,
    environment,
    workingDirectory,
  });
  // Scrub the final compact JSON bytes so JSON escaping cannot create a form
  // that bypasses the same disclosure boundary used for the uploaded logs.
  const serialized = scrubText(JSON.stringify(manifest), replacements);
  JSON.parse(serialized);
  fs.writeFileSync(path.join(workingDirectory, MANIFEST_FILE_NAME), serialized);
  process.stdout.write(serialized);
  return JSON.parse(serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeHostedEvidenceManifest();
}
