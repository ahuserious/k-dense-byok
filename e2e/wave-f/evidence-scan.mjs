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
} = {}) {
  const scrubbedLogs = scrubWaveFLogs({ workingDirectory, environment });
  const scanned = scanHostedEvidenceArtifacts({
    workingDirectory,
    environment,
    artifactPaths: WAVE_F_SCANNED_ARTIFACTS,
  });
  return { scrubbedLogs, ...scanned };
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
          `scrubbed logs: ${result.scrubbedLogs.join(", ") || "none"}\n`,
        process.env,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "wave-F evidence scan failed";
    process.stderr.write(safeDiagnostic(`wave-f-evidence: FAIL: ${message}\n`, process.env));
    process.exitCode = 1;
  }
}
