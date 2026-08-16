import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  instrumentPreviewLauncher,
  previewStartGateMatches,
  previewSupervisorOwnershipRecordable,
  recordPreviewChildOrKill,
} from "./preview-launcher-observer.mjs";
import { recordSupervisorOwnership } from "./vendored-dist-environment.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("instruments every direct preview service spawn and exit", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "start.mjs"), "utf-8");
  const instrumented = instrumentPreviewLauncher(source);
  assert.equal(instrumented.match(/\n  recordSpawnedPreviewServiceOrKill\(child\);/g)?.length, 2);
  assert.equal(instrumented.match(/recordPreviewServiceState\(child\.kadyRole, child\.pid, "spawned"\)/g)?.length, 1);
  assert.equal(instrumented.match(/recordPreviewServiceState\(child\.kadyRole, child\.pid, "exited", exitCode, signal\)/g)?.length, 2);
  assert.match(
    instrumented,
    /recordPreviewServiceState\(child\.kadyRole, child\.pid, "spawned"\);\n  child\.on\("exit", \(exitCode, signal\) => recordPreviewEngineExit\(child, exitCode, signal\)\);/,
  );
  assert.match(
    instrumented,
    /const trackEarlyExit = \(\) => \{\n    childExited = true;\n  \};/,
  );
  assert.doesNotMatch(
    instrumented,
    /const trackEarlyExit = \([^)]*\) => \{[^}]*recordPreviewEngineExit/s,
  );
  assert.match(
    instrumented,
    /state === "spawned" && previous\?\.pid === pid && previous\.state === "exited"/,
  );
  assert.match(
    instrumented,
    /recordPreviewServiceState\(\s*"workflow-supervisor",\s*message\.pid,\s*"spawned",[\s\S]*\{ identity \}/,
  );
  // The injected supervisor record must sit inside the ownership-result gate,
  // after the launcher's own recordSupervisorOwnership() decision.
  assert.match(
    instrumented,
    /const result = recordSupervisorOwnership\(forcedSupervisorOwners, message\.pid, identity\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(previewSupervisorOwnershipRecordable\(result\)\) \{\n\s*recordPreviewServiceState\(\s*"workflow-supervisor",/,
  );
  assert.match(instrumented, /function previewSupervisorOwnershipRecordable\(ownershipResult\)/);
  assert.equal(
    instrumented.match(/recordPreviewServiceState\(\s*"workflow-supervisor"/g)?.length,
    1,
  );
  // The launcher's own retirement branch still follows the injected record.
  assert.match(instrumented, /if \(result === "identity-changed-retired"\) \{/);
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

test("a retired supervisor PID never reaches the preview service record", () => {
  // Drives the exact composition the instrumented launcher performs: the
  // launcher's ownership decision first, the preview record only for the
  // results that leave the launcher owning that PID.
  const forcedSupervisorOwners = new Map();
  const recorded = [];
  const reportSupervisor = (pid, identity) => {
    const result = recordSupervisorOwnership(forcedSupervisorOwners, pid, identity);
    if (previewSupervisorOwnershipRecordable(result)) recorded.push({ pid, identity });
    return result;
  };
  const firstIdentity = { method: "proc-stat", value: "boot-id:900", host: "host", boot: "boot" };
  const reusedIdentity = { method: "proc-stat", value: "boot-id:1700", host: "host", boot: "boot" };

  assert.equal(reportSupervisor(4242, firstIdentity), "recorded");
  assert.equal(reportSupervisor(4242, firstIdentity), "unchanged");
  assert.equal(reportSupervisor(4242, reusedIdentity), "identity-changed-retired");
  assert.equal(reportSupervisor(4242, null), "unverifiable");

  assert.deepEqual(recorded, [
    { pid: 4242, identity: firstIdentity },
    { pid: 4242, identity: firstIdentity },
  ]);
  assert.equal(forcedSupervisorOwners.get(4242).retired, true);
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

test("backend reports the workflow supervisor before launcher readiness", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "server", "src", "index.ts"), "utf-8");
  assert.match(source, /process\.send\?\.\(\{ type: "kady-supervisor", pid \}\)/);
  assert.match(source, /ensureWorkflowSupervisor\(\{\s*onOwnership: reportWorkflowSupervisorOwnership,/);
  const readyIndex = source.indexOf('process.send?.({ type: "kady-ready"');
  const finalSupervisorReportIndex = source.lastIndexOf("reportWorkflowSupervisor(", readyIndex);
  assert.ok(finalSupervisorReportIndex >= 0 && finalSupervisorReportIndex < readyIndex);
});

test("supervisor client reports fresh and inherited ownership before attachment", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, "server", "src", "workflows", "supervisor", "client.ts"),
    "utf-8",
  );
  assert.match(source, /onOwnership\?\.\(child\.pid\);[\s\S]*const deadline/);
  assert.match(
    source,
    /if \(readyInheritedState\) \{\s*options\.onOwnership\?\.\(readyInheritedState\.pid\);\s*const drainClient = await WorkflowSupervisorClient\.attach/,
  );
});
