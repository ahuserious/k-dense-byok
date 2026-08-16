#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_FILE_NAME = "stably-test.log";
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
const SECRET_ENVIRONMENT_NAME_PATTERN =
  /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i;
const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
]);

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

function secretReplacements(environment) {
  const replacements = [];
  for (const [name, value] of Object.entries(environment)) {
    if (
      typeof value !== "string" ||
      value === "" ||
      (!SECRET_ENVIRONMENT_NAME_PATTERN.test(name) &&
        !EXPLICIT_SECRET_ENVIRONMENT_NAMES.has(name))
    ) {
      continue;
    }

    const base64 = Buffer.from(value, "utf8").toString("base64");
    const variants = new Set([
      value,
      encodeURIComponent(value),
      base64,
      base64.replace(/=+$/, ""),
      base64.replace(/\+/g, "-").replace(/\//g, "_"),
      base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    ]);
    for (const variant of variants) {
      if (variant !== "") {
        replacements.push({ name, value: variant });
      }
    }
  }
  return replacements.sort((left, right) => right.value.length - left.value.length);
}

function scrubString(value, replacements) {
  let scrubbed = value;
  for (const replacement of replacements) {
    scrubbed = scrubbed.split(replacement.value).join(`[redacted:${replacement.name}]`);
  }
  return scrubbed;
}

function scrubManifestValue(value, replacements) {
  if (typeof value === "string") return scrubString(value, replacements);
  if (Array.isArray(value)) {
    return value.map((entry) => scrubManifestValue(entry, replacements));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        scrubString(key, replacements),
        scrubManifestValue(entry, replacements),
      ]),
    );
  }
  return value;
}

function scrubSerializedJson(serialized, replacements) {
  const parsed = JSON.parse(serialized);
  return JSON.stringify(scrubManifestValue(parsed, replacements), null, 2);
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
        fingerprint[field] = scrubString(value, replacements).slice(
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

function parseSummaryLine(line) {
  const passed = line.match(/(\d+)\s+passed/);
  const failed = line.match(/(\d+)\s+failed/);
  const skipped = line.match(/(\d+)\s+skipped/);
  if (!passed && !failed && !skipped) return null;
  const duration = line.match(/\((\d+(?:\.\d+)?(?:ms|s|m|h))\)/)?.[1] ?? null;
  return {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0,
    duration:
      typeof duration === "string" ? duration.slice(0, MAX_DURATION_LENGTH) : null,
  };
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
  const replacements = secretReplacements(environment);
  const log = readTextOrEmpty(path.join(workingDirectory, LOG_FILE_NAME));
  const rawInventoryLine = lastMatchingLine(log, (line) =>
    line.includes("E2E inventory "),
  );
  const rawSummaryLine = lastMatchingLine(log, (line) =>
    /[0-9]+ (passed|failed|skipped)/.test(line),
  );
  return scrubManifestValue({
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
    summary: parseSummaryLine(rawSummaryLine),
    inventoryLine: scrubString(rawInventoryLine, replacements),
    summaryLine: scrubString(rawSummaryLine, replacements),
    outcome: environment.E2E_SUITE_OUTCOME || "not run",
    stablyRunId: environment.E2E_RUN_ID || "not detected",
    stablyRunUrl: environment.E2E_RUN_URL || "not detected",
  }, replacements);
}

export function writeHostedEvidenceManifest(options = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const environment = options.environment ?? process.env;
  const manifest = buildHostedEvidenceManifest({
    ...options,
    environment,
    workingDirectory,
  });
  // Treat the serialized document as the final disclosure boundary so the file
  // and stdout cannot diverge from the same complete-manifest scrub.
  const serialized = `${scrubSerializedJson(
    JSON.stringify(manifest),
    secretReplacements(environment),
  )}\n`;
  fs.writeFileSync(path.join(workingDirectory, MANIFEST_FILE_NAME), serialized);
  process.stdout.write(serialized);
  return JSON.parse(serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeHostedEvidenceManifest();
}
