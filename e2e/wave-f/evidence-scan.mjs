#!/usr/bin/env node
// Scrub-and-scan the Wave-F evidence tree before it is uploaded, the way Job A does for its own.
//
// WHY THIS EXISTS. Job A uploads exactly one file, `hosted-evidence-bundle.tar`, and only when
// `scripts/hosted-evidence-scan.mjs` has walked every artifact -- including inside every trace.zip
// -- and found no representation of any secret in the job's environment. Round 1's Wave-F job
// uploaded `.stably/test-results/**` raw. Playwright traces capture full request AND response
// bodies, and five lanes are about to add specs that may well drive credential surfaces (F1's
// provider keys, F10's own secret prefill). "Nothing in this job's environment carries a secret
// today" is a fact about today, not a property of the job.
//
// It reuses the existing scanner rather than re-deriving one: `scanHostedEvidenceArtifacts` is
// exported, takes an explicit `artifactPaths`, and throws `secret representation detected in
// <artifactRef>` on a hit. A second implementation of that walk would be a duplicate of an existing
// capability and would drift from it. The only Wave-F-specific parts are the artifact list and the
// two log files, which are scrubbed here into `.scrubbed.log` siblings so the raw ones are never
// what gets uploaded.
//
// Every artifact is `required: false`: this runs under `if: always()`, including after a preview
// that never came up, and a missing screenshot tree must not turn a legible suite failure into an
// illegible scan failure. What must never be optional is the scan of whatever IS there.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertHostedEvidenceLogWithinLimit } from "../../scripts/hosted-evidence-log-cap.mjs";
import { scanHostedEvidenceArtifacts } from "../../scripts/hosted-evidence-scan.mjs";
import { scrubAndVerifyText } from "../../scripts/hosted-evidence-secrets.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Raw log -> the scrubbed sibling that is uploaded in its place. */
export const WAVE_F_LOGS = [
  { raw: "wave-f-test.log", scrubbed: "wave-f-test.scrubbed.log" },
  { raw: "wave-f-preview-up.log", scrubbed: "wave-f-preview-up.scrubbed.log" },
];

export const WAVE_F_SCANNED_ARTIFACTS = [
  { path: ".stably/wave-f-evidence", required: false },
  { path: ".stably/test-results", required: false },
  { path: "wave-f-test.scrubbed.log", required: false },
  { path: "wave-f-preview-up.scrubbed.log", required: false },
  { path: "wave-f-runner-fingerprint.json", required: false },
];

function walkRegularFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Wave-F evidence retention refuses symbolic link: ${candidate}`);
      }
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      }
    }
  };
  visit(rootPath);
  return files;
}

function lastInventoryObservation(logText) {
  const pattern =
    /E2E inventory observed for filtered run: (\d+) total = (\d+) executing-substantive \+ (\d+) thin; (\d+) fixme \+ (\d+) skip\./g;
  const matches = [...logText.matchAll(pattern)];
  const match = matches.at(-1);
  if (!match) {
    throw new Error(
      "Wave-F suite succeeded without the filtered inventory observation; retention cannot be " +
        "reconciled to the number of executed items.",
    );
  }
  return {
    total: Number(match[1]),
    substantive: Number(match[2]),
    thin: Number(match[3]),
    fixme: Number(match[4]),
    skip: Number(match[5]),
  };
}

function assertNonEmptyFiles(files, label) {
  for (const file of files) {
    if (fs.statSync(file).size === 0) {
      throw new Error(`Wave-F ${label} artifact is empty: ${file}`);
    }
  }
}

/**
 * A successful suite is not enough for row 38: every executed item must retain the three Playwright
 * artifacts and at least one deterministic `evidence.shot()` PNG. This runs before the secret scan,
 * so an incomplete bundle is never uploaded merely because `actions/upload-artifact` found a log.
 */
export function assertWaveFEvidenceRetention({
  workingDirectory = repositoryRoot,
  suiteOutcome = process.env.WAVE_F_SUITE_OUTCOME ?? "unknown",
  ciRunId = process.env.GITHUB_RUN_ID ?? null,
} = {}) {
  if (suiteOutcome !== "success") {
    return { enforced: false, suiteOutcome };
  }

  const rawLogPath = path.join(workingDirectory, "wave-f-test.log");
  if (!fs.existsSync(rawLogPath)) {
    throw new Error("Wave-F suite succeeded but wave-f-test.log is missing.");
  }
  const inventory = lastInventoryObservation(fs.readFileSync(rawLogPath, "utf8"));
  if (inventory.fixme !== 0 || inventory.skip !== 0) {
    throw new Error(
      `Wave-F suite reported ${String(inventory.fixme)} fixme and ${String(inventory.skip)} skip; ` +
        "row 38 requires retained evidence for every collected item.",
    );
  }

  const evidenceRoot = path.join(workingDirectory, ".stably", "wave-f-evidence");
  const testResultsRoot = path.join(workingDirectory, ".stably", "test-results");
  const evidenceFiles = walkRegularFiles(evidenceRoot);
  const resultFiles = walkRegularFiles(testResultsRoot);
  const allManifests = evidenceFiles.filter((file) => path.basename(file) === "run.json");
  const manifests = allManifests.filter((file) => {
    if (ciRunId === null) return true;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return manifest.ciRunId === ciRunId;
  });

  const manifestRelation = ciRunId === null ? "at least" : "exactly";
  const manifestCountIsValid = ciRunId === null
    ? manifests.length >= inventory.total
    : manifests.length === inventory.total;
  if (!manifestCountIsValid) {
    throw new Error(
      `Wave-F suite retained ${String(manifests.length)} current run.json manifest(s); expected ` +
        `${manifestRelation} ${String(inventory.total)} for the successful items.`,
    );
  }

  let deterministicPngs = 0;
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (
      !Array.isArray(manifest.shots) ||
      manifest.shots.length === 0 ||
      !manifest.shots.every((shot) => typeof shot === "string" && path.basename(shot) === shot)
    ) {
      throw new Error(`Wave-F manifest has no safe deterministic screenshot names: ${manifestPath}`);
    }
    for (const shot of manifest.shots) {
      const screenshotPath = path.join(path.dirname(manifestPath), shot);
      if (!fs.existsSync(screenshotPath) || fs.statSync(screenshotPath).size === 0) {
        throw new Error(`Wave-F manifest points at a missing or empty screenshot: ${screenshotPath}`);
      }
      deterministicPngs += 1;
    }
  }

  const videos = resultFiles.filter((file) => path.basename(file) === "video.webm");
  const traces = resultFiles.filter((file) => path.basename(file) === "trace.zip");
  const screenshots = resultFiles.filter((file) => /^test-finished-\d+\.png$/.test(path.basename(file)));
  for (const [label, files] of [
    ["video", videos],
    ["trace", traces],
    ["end-of-test screenshot", screenshots],
  ]) {
    if (files.length < inventory.total) {
      throw new Error(
        `Wave-F suite retained ${String(files.length)} ${label} artifact(s); expected at least ` +
          `${String(inventory.total)} for the successful items.`,
      );
    }
    assertNonEmptyFiles(files, label);
  }

  return {
    enforced: true,
    suiteOutcome,
    inventory,
    manifests: manifests.length,
    deterministicPngs,
    videos: videos.length,
    traces: traces.length,
    screenshots: screenshots.length,
  };
}

export function scrubWaveFLogs({ workingDirectory = repositoryRoot, environment = process.env } = {}) {
  const written = [];
  for (const { raw, scrubbed } of WAVE_F_LOGS) {
    const rawPath = path.join(workingDirectory, raw);
    if (!fs.existsSync(rawPath)) continue;
    // Size first: the scrub reads the whole file into a string, and an unbounded log is its own
    // denial of service. This is the same limit Job A applies to stably-test.log.
    assertHostedEvidenceLogWithinLimit(rawPath);
    const scrubbedText = scrubAndVerifyText(fs.readFileSync(rawPath, "utf8"), environment);
    fs.writeFileSync(path.join(workingDirectory, scrubbed), scrubbedText);
    written.push(scrubbed);
  }
  return written;
}

export function scanWaveFEvidence({
  workingDirectory = repositoryRoot,
  environment = process.env,
  suiteOutcome = process.env.WAVE_F_SUITE_OUTCOME ?? "unknown",
  ciRunId = process.env.GITHUB_RUN_ID ?? null,
} = {}) {
  const retention = assertWaveFEvidenceRetention({ workingDirectory, suiteOutcome, ciRunId });
  const scrubbedLogs = scrubWaveFLogs({ workingDirectory, environment });
  const scanned = scanHostedEvidenceArtifacts({
    workingDirectory,
    environment,
    artifactPaths: WAVE_F_SCANNED_ARTIFACTS,
  });
  return { retention, scrubbedLogs, ...scanned };
}

function safeDiagnostic(value, environment) {
  try {
    return scrubAndVerifyText(value, environment);
  } catch {
    return "wave-f-evidence: diagnostic redacted\n";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = scanWaveFEvidence();
    process.stdout.write(
      safeDiagnostic(
        `wave-f-evidence: scanned ${String(result.includedPaths.length)} artifact path(s) ` +
          `(${result.includedPaths.join(", ") || "none present"}), ` +
          `${String(result.accountedBytes)} bytes accounted; ` +
          `scrubbed logs: ${result.scrubbedLogs.join(", ") || "none"}; ` +
          `retention: ${result.retention.enforced ? JSON.stringify(result.retention) : "not enforced"}\n`,
        process.env,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "wave-F evidence scan failed";
    process.stderr.write(safeDiagnostic(`wave-f-evidence: FAIL: ${message}\n`, process.env));
    process.exitCode = 1;
  }
}
