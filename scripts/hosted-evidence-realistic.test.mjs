import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { sealHostedEvidenceBundle } from "./hosted-evidence-scan.mjs";
import { scrubAndVerifyText } from "./hosted-evidence-secrets.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const realisticLogBytes = 2 * 1024 * 1024;
const syntheticTargetBytes = 1024 * 1024 * 1024;
const syntheticZipCount = 200;
const largeInnerBytes = 100 * 1024 * 1024;
const reactDevtoolsLine =
  '{"type":"info","text":"%cDownload the React DevTools for a better development experience: https://reactjs.org/link/react-devtools"}\n';

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

function findRealTraceZip() {
  const resultsDirectory = path.join(repositoryRoot, ".stably/test-results");
  if (!fs.existsSync(resultsDirectory)) return null;
  const stack = [resultsDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name === "trace.zip") return entryPath;
    }
  }
  return null;
}

function writeTraceLikeContent(filePath, targetBytes, extraRandomBytes = 0) {
  const chunks = [reactDevtoolsLine];
  let bytes = Buffer.byteLength(reactDevtoolsLine);
  for (let index = 0; bytes < targetBytes; index += 1) {
    const identifier = Buffer.from(`trace-span-${index}`, "utf8").toString("base64url");
    const line = `${JSON.stringify({
      type: "frame",
      identifier,
      index,
      ok: true,
    })}\n`;
    chunks.push(line);
    bytes += Buffer.byteLength(line);
  }
  fs.writeFileSync(filePath, chunks.join(""));
  if (extraRandomBytes > 0) {
    const randomPath = path.join(path.dirname(filePath), "random-100m.bin");
    const randomBytes = Buffer.alloc(extraRandomBytes);
    randomFillSync(randomBytes);
    fs.writeFileSync(randomPath, randomBytes);
    return randomPath;
  }
  return null;
}

function zipStore(sourceDirectory, archivePath, entries) {
  const zipped = spawnSync("zip", ["-q", "-0", archivePath, ...entries], {
    cwd: sourceDirectory,
    encoding: "utf8",
  });
  assert.equal(zipped.status, 0, zipped.stderr);
}

test("real Playwright list and a two-MiB reporter log stay within scanner bounds", () => {
  const listed = spawnSync("npx", ["playwright", "test", "--list"], {
    cwd: repositoryRoot,
    env: cleanEnvironment(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, listed.stderr);
  const listOutput = `${listed.stdout}${listed.stderr}`;

  // This test is about scanner bounds, not about the inventory — the count is here only to prove a REAL,
  // complete listing reached the scanner rather than a truncated or empty one. It used to assert a literal
  // `Total: 261`, which made it a second inventory pin that nobody maintained: the 2026-08-18 wave moved the
  // real pin in e2e/item-count-reporter.ts to 253 and this line went red for a reason that had nothing to do
  // with scanner bounds. Cross-check the reporter's own verified total against Playwright's instead, so the
  // single source of truth stays the pin and this stays a bounds test. It still fails on a truncated list,
  // on a missing reporter line, and on the two disagreeing — which is everything it was ever really guarding.
  const inventory = listOutput.match(/E2E inventory verified: (\d+) total = \d+ executing-substantive/);
  assert.ok(inventory, `the inventory reporter line must be present in a full listing:\n${listOutput.slice(0, 400)}`);
  assert.match(listOutput, new RegExp(`Total: ${inventory[1]} tests in \\d+ files`));

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
  assert.ok(actualListMs < 10_000, `real --list scan took ${actualListMs.toFixed(1)}ms`);

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

test("H4: synthetic 200-trace / 1 GiB payload seals in under five minutes", { timeout: 5 * 60 * 1000 }, () => {
  const environment = {
    STABLY_API_KEY: "synthetic-1gib-secret-sentinel",
    STABLY_PROJECT_ID: "synthetic-1gib-project-sentinel",
  };
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory, "clean");
    const tracesDirectory = path.join(directory, ".stably/test-results");
    const sourceDirectory = path.join(directory, "trace-source");
    fs.mkdirSync(sourceDirectory);
    const smallTarget = Math.ceil(
      (syntheticTargetBytes - largeInnerBytes) / (syntheticZipCount - 1),
    );
    const smallTracePath = path.join(sourceDirectory, "0-trace.trace");
    writeTraceLikeContent(smallTracePath, smallTarget);
    const templateZip = path.join(tracesDirectory, "template-trace.zip");
    zipStore(sourceDirectory, templateZip, ["0-trace.trace"]);
    let totalBytes = fs.statSync(templateZip).size;
    for (let index = 1; index < syntheticZipCount; index += 1) {
      const copyPath = path.join(tracesDirectory, `trace-${index}.zip`);
      if (index === syntheticZipCount - 1) {
        const largeRandom = writeTraceLikeContent(
          smallTracePath,
          64 * 1024,
          largeInnerBytes,
        );
        const largeZip = path.join(tracesDirectory, `trace-${index}.zip`);
        zipStore(sourceDirectory, largeZip, [
          "0-trace.trace",
          path.basename(largeRandom),
        ]);
        totalBytes += fs.statSync(largeZip).size;
        continue;
      }
      fs.copyFileSync(templateZip, copyPath);
      totalBytes += fs.statSync(copyPath).size;
    }
    assert.ok(totalBytes >= syntheticTargetBytes, `payload was only ${totalBytes} bytes`);

    const startedAt = performance.now();
    const sealed = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment,
    });
    const elapsedMs = performance.now() - startedAt;
    const elapsedSeconds = elapsedMs / 1000;
    assert.match(sealed.bundleSha256, /^[a-f0-9]{64}$/);
    assert.ok(
      elapsedMs < 5 * 60 * 1000,
      `synthetic 1 GiB seal took ${elapsedSeconds.toFixed(3)}s`,
    );
    console.log(
      `SYNTHETIC_1GIB_TIMING seconds=${elapsedSeconds.toFixed(3)} ` +
        `bytes=${totalBytes} zips=${syntheticZipCount} ` +
        `payloadSha256=${sealed.payloadSha256}`,
    );
  });
});

test("real Playwright trace.zip from .stably/test-results seals if present", () => {
  const realTrace = findRealTraceZip();
  if (realTrace === null) {
    console.log(
      "REAL_TRACE_SKIP reason=no-trace-zip-in-.stably/test-results",
    );
    return;
  }
  const environment = {
    STABLY_API_KEY: "real-trace-secret-sentinel",
    STABLY_PROJECT_ID: "real-trace-project-sentinel",
  };
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory, `${reactDevtoolsLine}clean\n`);
    fs.copyFileSync(
      realTrace,
      path.join(directory, ".stably/test-results", "real-trace.zip"),
    );
    const startedAt = performance.now();
    const sealed = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment,
    });
    const elapsedMs = performance.now() - startedAt;
    assert.match(sealed.bundleSha256, /^[a-f0-9]{64}$/);
    console.log(
      `REAL_TRACE_TIMING seconds=${(elapsedMs / 1000).toFixed(3)} ` +
        `source=${path.relative(repositoryRoot, realTrace)} ` +
        `bytes=${fs.statSync(realTrace).size}`,
    );
  });
});
