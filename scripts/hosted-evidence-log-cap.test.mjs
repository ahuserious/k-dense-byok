import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertHostedEvidenceLogWithinLimit,
  MAX_HOSTED_EVIDENCE_LOG_BYTES,
} from "./hosted-evidence-log-cap.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-log-cap-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts the cap and rejects the first oversized byte without reading the log", () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, "stably-test.log");
    fs.writeFileSync(logPath, "");
    fs.truncateSync(logPath, MAX_HOSTED_EVIDENCE_LOG_BYTES);
    assert.equal(
      assertHostedEvidenceLogWithinLimit(logPath),
      MAX_HOSTED_EVIDENCE_LOG_BYTES,
    );
    fs.truncateSync(logPath, MAX_HOSTED_EVIDENCE_LOG_BYTES + 1);
    assert.throws(
      () => assertHostedEvidenceLogWithinLimit(logPath),
      /raw evidence log exceeds 33554432-byte validation limit/,
    );
  });
});

test("workflow caps the colorless raw log before teardown or count extraction", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/stably-cloud.yml"),
    "utf8",
  );
  const completeSuite = workflow.match(
    /- name: Run complete Playwright suite[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  const filteredSuite = workflow.match(
    /- name: Run filtered Playwright suite[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  for (const suiteStep of [completeSuite, filteredSuite]) {
    assert.ok(suiteStep);
    assert.match(suiteStep, /FORCE_COLOR: "0"/);
    assert.match(suiteStep, /NO_COLOR: "1"/);
  }
  const capIndex = workflow.indexOf("- name: Enforce hosted evidence log size limit");
  const stopIndex = workflow.indexOf("- name: Stop hermetic preview");
  const countsIndex = workflow.indexOf("- name: Extract suite counts");
  assert.ok(capIndex > workflow.indexOf("- name: Run filtered Playwright suite"));
  assert.ok(stopIndex > capIndex);
  assert.ok(countsIndex > capIndex);
  assert.match(
    workflow.slice(countsIndex, workflow.indexOf("- name: Record suite outcome")),
    /steps\.evidence-log-cap\.outcome == 'success'/,
  );
});
