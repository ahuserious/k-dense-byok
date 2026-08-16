import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  instrumentPreviewLauncher,
  previewStartGateMatches,
  recordPreviewChildOrKill,
} from "./preview-launcher-observer.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("instruments every direct preview service spawn and exit", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "start.mjs"), "utf-8");
  const instrumented = instrumentPreviewLauncher(source);
  assert.equal(instrumented.match(/\n  recordSpawnedPreviewServiceOrKill\(child\);/g)?.length, 2);
  assert.equal(instrumented.match(/recordPreviewServiceState\(child\.kadyRole, child\.pid, "spawned"\)/g)?.length, 1);
  assert.equal(instrumented.match(/recordPreviewServiceState\(child\.kadyRole, child\.pid, "exited", exitCode, signal\)/g)?.length, 2);
  assert.match(instrumented, /KADY_PREVIEW_SERVICE_STATE_FILE/);
  assert.match(instrumented, /KADY_PREVIEW_START_GATE_FILE/);
  assert.match(instrumented, /KADY_PREVIEW_GENERATION/);
  assert.match(instrumented, /ps-lstart-utc/);
  assert.equal(instrumented.match(/process\.kill\(child\.pid, "SIGSTOP"\)/g)?.length, 2);
  assert.equal(instrumented.match(/process\.kill\(child\.pid, "SIGCONT"\)/g)?.length, 2);
  assert.match(instrumented, /timed out waiting for exact generation/);
  assert.match(instrumented, /process\.kill\(-child\.pid, "SIGKILL"\)/);
});

test("start gate refuses absent, empty, and wrong-generation publications", () => {
  const absentError = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.equal(previewStartGateMatches("gate", "generation", () => { throw absentError; }), false);
  assert.equal(previewStartGateMatches("gate", "generation", () => ""), false);
  assert.equal(previewStartGateMatches("gate", "generation", () => "other-generation\n"), false);
  assert.equal(previewStartGateMatches("gate", "generation", () => "generation\n"), true);
});

test("recording failure kills the stopped child group before rethrowing", () => {
  const signals = [];
  assert.throws(
    () => recordPreviewChildOrKill(
      { pid: 42 },
      () => { throw new Error("durable record failed"); },
      (pid, signal) => signals.push([pid, signal]),
    ),
    /durable record failed/,
  );
  assert.deepEqual(signals, [[-42, "SIGKILL"]]);
});

test("fails closed when launcher anchors drift", () => {
  assert.throws(
    () => instrumentPreviewLauncher("const sleep = () => {};"),
    /expected one stable anchor/,
  );
});
