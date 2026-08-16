#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSecretRepresentations,
  scrubAndVerifyText,
  scrubText,
} from "./hosted-evidence-secrets.mjs";

const RAW_LOG_FILE_NAME = "stably-test.log";
const LOG_FILE_NAME = "stably-test.scrubbed.log";
const RAW_PREVIEW_LOG_FILE_NAME = "preview-up.log";
const PREVIEW_LOG_FILE_NAME = "preview-up.scrubbed.log";
const RUNNER_FINGERPRINT_FILE_NAME = "runner-fingerprint.json";
const MANIFEST_FILE_NAME = "hosted-evidence-manifest.json";
const STABLY_LAST_RUN_FILE_NAMES = [
  ".stably/last-run.json",
  "e2e/.stably/last-run.json",
];
const STABLY_CLI_VERSION = "4.12.28";
const STABLY_REPORTER_VERSION = "2.1.16";
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

function writeScrubbedLog(workingDirectory, sourceName, destinationName, environment) {
  const sourcePath = path.join(workingDirectory, sourceName);
  if (!fs.existsSync(sourcePath)) return;
  const destinationPath = path.join(workingDirectory, destinationName);
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
  const scrubbed = scrubAndVerifyText(fs.readFileSync(sourcePath, "utf8"), environment);
  fs.writeFileSync(temporaryPath, scrubbed);
  fs.renameSync(temporaryPath, destinationPath);
  fs.unlinkSync(sourcePath);
}

function reporterAttached(environment) {
  const apiKeyPresent = Boolean(environment.STABLY_API_KEY);
  const projectIdPresent = Boolean(environment.STABLY_PROJECT_ID);
  if (apiKeyPresent !== projectIdPresent) {
    throw new Error("Stably reporter credentials are incomplete.");
  }
  return apiKeyPresent && projectIdPresent;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function stablyResultUrl(log, runId) {
  const candidates = stripAnsi(log).match(/https:\/\/[^\s]+/g) ?? [];
  for (const candidate of candidates.reverse()) {
    const cleaned = candidate.replace(/[),.;]+$/, "");
    try {
      const url = new URL(cleaned);
      if (
        url.protocol === "https:" &&
        (url.hostname === "stably.ai" || url.hostname.endsWith(".stably.ai")) &&
        decodeURIComponent(url.pathname)
          .split("/")
          .filter(Boolean)
          .at(-1) === runId
      ) {
        return url.href;
      }
    } catch {
      // Continue to the next reporter URL candidate.
    }
  }
  return null;
}

function readStablyRun(workingDirectory, environment, log) {
  const attached = reporterAttached(environment);
  const suiteName =
    environment.E2E_SUITE_NAME ??
    `sds-outer-loop-ci-${environment.GITHUB_RUN_NUMBER ?? ""}`;
  if (!attached) {
    return {
      state: "not attached",
      cliVersion: STABLY_CLI_VERSION,
      reporterVersion: STABLY_REPORTER_VERSION,
      suiteName,
      lastRunFile: null,
      runId: null,
      url: null,
    };
  }

  const runStartedAt = Number(environment.E2E_RUN_STARTED_AT);
  if (!Number.isSafeInteger(runStartedAt) || runStartedAt <= 0) {
    throw new Error("Attached Stably evidence requires E2E_RUN_STARTED_AT.");
  }
  const now = Date.now();
  const lowerBound = runStartedAt - 5_000;
  const upperBound = now + 60_000;
  const validLastRuns = [];
  for (const relativePath of STABLY_LAST_RUN_FILE_NAMES) {
    const lastRunPath = path.join(workingDirectory, relativePath);
    try {
      const parsed = JSON.parse(fs.readFileSync(lastRunPath, "utf8"));
      const stat = fs.statSync(lastRunPath);
      if (
        typeof parsed?.runId === "string" &&
        /^[A-Za-z0-9_-]+$/.test(parsed.runId) &&
        Number.isSafeInteger(parsed.timestamp) &&
        parsed.timestamp >= lowerBound &&
        parsed.timestamp <= upperBound &&
        stat.mtimeMs >= lowerBound &&
        stat.mtimeMs <= upperBound
      ) {
        validLastRuns.push({ relativePath, runId: parsed.runId });
      }
    } catch {
      // A missing or malformed candidate cannot be authoritative.
    }
  }
  if (validLastRuns.length === 0) {
    throw new Error("Attached Stably evidence requires a fresh last-run record.");
  }
  const distinctRunIds = new Set(validLastRuns.map(({ runId }) => runId));
  if (distinctRunIds.size !== 1) {
    throw new Error("Attached Stably last-run records disagree.");
  }
  const { relativePath: lastRunFile, runId } = validLastRuns[0];
  const plainLog = stripAnsi(log);
  if (!plainLog.includes(`Suite \"${suiteName}\" run complete!`)) {
    throw new Error("Attached Stably run does not match the expected suite name.");
  }
  const url = stablyResultUrl(log, runId);
  if (url === null) {
    throw new Error("Attached Stably evidence requires a matching run ID and URL.");
  }
  return {
    state: "attached",
    cliVersion: STABLY_CLI_VERSION,
    reporterVersion: STABLY_REPORTER_VERSION,
    suiteName,
    lastRunFile,
    runId,
    url,
  };
}

function writeScrubbedLogs(workingDirectory, environment) {
  writeScrubbedLog(
    workingDirectory,
    RAW_LOG_FILE_NAME,
    LOG_FILE_NAME,
    environment,
  );
  writeScrubbedLog(
    workingDirectory,
    RAW_PREVIEW_LOG_FILE_NAME,
    PREVIEW_LOG_FILE_NAME,
    environment,
  );
}

function suiteCommand(environment) {
  const workers = environment.E2E_WORKERS ?? "";
  const grep = environment.INPUT_GREP ?? "";
  if (grep !== "") {
    return `npx playwright test --workers="${workers}" --grep "${grep}" ` +
      `--trace on > stably-test.log 2>&1`;
  }
  return `npx playwright test --workers="${workers}" --trace on > stably-test.log 2>&1`;
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
  const stably = readStablyRun(workingDirectory, environment, log);
  return {
    command: suiteCommand(environment),
    environment: {
      CI: "1",
      KADY_E2E_BASE_URL: "http://127.0.0.1:13000",
      workers: environment.E2E_WORKERS ?? "",
      KADY_E2E_WORKERS: environment.KADY_E2E_WORKERS || null,
      E2E_SUITE_NAME:
        environment.E2E_SUITE_NAME ??
        `sds-outer-loop-ci-${environment.GITHUB_RUN_NUMBER ?? ""}`,
      STABLY_CLI_VERSION,
      STABLY_REPORTER_VERSION,
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
    stably,
    stablyRunId: stably.runId ?? "not attached",
    stablyRunUrl: stably.url ?? "not attached",
  };
}

export function writeHostedEvidenceManifest(options = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const environment = options.environment ?? process.env;
  writeScrubbedLogs(workingDirectory, environment);
  const manifest = buildHostedEvidenceManifest({
    ...options,
    environment,
    workingDirectory,
  });
  // Scrub the final compact JSON bytes so JSON escaping cannot create a form
  // that bypasses the same disclosure boundary used for the uploaded logs.
  const serialized = scrubAndVerifyText(JSON.stringify(manifest), environment);
  JSON.parse(serialized);
  fs.writeFileSync(path.join(workingDirectory, MANIFEST_FILE_NAME), serialized);
  process.stdout.write(serialized);
  return JSON.parse(serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeHostedEvidenceManifest();
}
