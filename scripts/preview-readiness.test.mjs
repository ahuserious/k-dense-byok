import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPreviewReadinessProcessesLive,
  probePreviewService,
  readPreviewServiceStateSnapshot,
  waitForPreviewReadiness,
} from "./preview-readiness.mjs";

const repositoryRoot = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

function service(role, timeoutMs = 1_000) {
  return { role, label: role, url: `http://preview.invalid/${role}`, timeoutMs };
}

const READINESS_GENERATION = "readiness-generation";

function recordedProcess(pid) {
  return {
    pid,
    pgid: pid,
    generation: READINESS_GENERATION,
    identity: { method: "ps-lstart-utc", value: `identity-${pid}` },
    state: "spawned",
  };
}

function readinessFixture(deadPids = []) {
  const lifecycleState = {
    generation: READINESS_GENERATION,
    launchRoot: repositoryRoot,
    rootProcess: { ...recordedProcess(10), role: "launcher" },
  };
  const serviceStates = {
    backend: { ...recordedProcess(20), role: "backend" },
    frontend: { ...recordedProcess(21), role: "frontend" },
    "pipeline-engine": { ...recordedProcess(22), role: "pipeline-engine" },
    "workflow-supervisor": { ...recordedProcess(23), role: "workflow-supervisor" },
  };
  const directoryByPid = new Map([
    [10, repositoryRoot],
    [20, fs.realpathSync(path.join(repositoryRoot, "server"))],
    [21, fs.realpathSync(path.join(repositoryRoot, "web"))],
    [22, fs.realpathSync(path.join(repositoryRoot, "server", "vendor", "pipeline-engine"))],
    [23, fs.realpathSync(path.join(repositoryRoot, "server"))],
  ]);
  const processOptions = {
    isAlive: (pid) => !deadPids.includes(pid),
    resolveIdentity: (pid) => ({ method: "ps-lstart-utc", value: `identity-${pid}` }),
    workingDirectory: (pid) => directoryByPid.get(pid) ?? "",
    resolveProcessGroup: (pid) => pid,
  };
  return { lifecycleState, serviceStates, processOptions };
}

test("distinguishes missing, unreadable, and malformed service-state files", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-service-state-"));
  try {
    assert.equal(
      readPreviewServiceStateSnapshot(path.join(temporaryRoot, "missing.json")).status,
      "missing",
    );
    assert.equal(readPreviewServiceStateSnapshot(temporaryRoot).status, "unreadable");
    const malformedFile = path.join(temporaryRoot, "malformed.json");
    fs.writeFileSync(malformedFile, "{");
    assert.equal(readPreviewServiceStateSnapshot(malformedFile).status, "malformed");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("includes a bounded unhealthy response body in readiness evidence", async () => {
  const result = await probePreviewService(
    service("frontend"),
    async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({
        error: "Preview web source drift detected at /checkout/web/src/app/page.tsx",
      }),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 503/);
  assert.match(result.detail, /web\/src\/app\/page\.tsx/);
});

test("requires the frontend health body to match the preview generation", async () => {
  const result = await probePreviewService(
    { ...service("frontend"), expectedGeneration: "generation-new" },
    async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ok", generation: "generation-old" }),
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /generation generation-old does not match generation-new/);
});

test("does not declare readiness until generation-bound process validation passes", async () => {
  let validations = 0;
  await waitForPreviewReadiness({
    services: [service("backend")],
    launcherProcess: { pid: 10, exitCode: null, signalCode: null },
    probe: async () => ({ ok: true, detail: "HTTP 200" }),
    readServiceStates: () => ({ backend: { generation: "generation-one" } }),
    validateReady: () => {
      validations += 1;
      if (validations === 1) throw new Error("identity pending");
    },
    now: () => 0,
    pause: async () => {},
  });
  assert.equal(validations, 2);
});

test("reaches readiness with a dead workflow-supervisor record", async () => {
  // The launcher does not own the supervisor and never records its exit, so a
  // dead supervisor record must not hold readiness. Its record still belongs
  // to the teardown set, which is proved by preview-processes' teardown tests.
  const { lifecycleState, serviceStates, processOptions } = readinessFixture([23]);
  const liveGroups = assertPreviewReadinessProcessesLive(
    repositoryRoot,
    lifecycleState,
    serviceStates,
    processOptions,
  );
  assert.deepEqual(liveGroups.map(({ record }) => record.pid).sort(), [10, 20, 21, 22]);

  const result = await waitForPreviewReadiness({
    services: [service("backend"), service("frontend"), service("pipeline-engine")],
    launcherProcess: { pid: 10, exitCode: null, signalCode: null },
    probe: async () => ({ ok: true, detail: "HTTP 200" }),
    readServiceStates: () => serviceStates,
    expectedGeneration: READINESS_GENERATION,
    validateReady: (states) => assertPreviewReadinessProcessesLive(
      repositoryRoot,
      lifecycleState,
      states,
      processOptions,
    ),
    now: () => 0,
    pause: async () => {},
  });
  assert.equal(result.every(([, probeResult]) => probeResult.ok), true);
});

test("refuses readiness when a launcher-owned process record is dead", () => {
  for (const deadPid of [10, 20, 21, 22]) {
    const { lifecycleState, serviceStates, processOptions } = readinessFixture([deadPid]);
    assert.throws(
      () => assertPreviewReadinessProcessesLive(
        repositoryRoot,
        lifecycleState,
        serviceStates,
        processOptions,
      ),
      new RegExp(`Preview readiness process PID ${deadPid} is no longer live`),
    );
  }
});

test("forwards the expected generation to the default service-state reader", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-readiness-"));
  try {
    const serviceStatePath = path.join(temporaryRoot, "services.json");
    fs.writeFileSync(serviceStatePath, `${JSON.stringify({
      version: 2,
      generation: "generation-two",
      services: { backend: { ...recordedProcess(20), role: "backend" } },
    })}\n`);
    const observedServiceStates = [];
    await waitForPreviewReadiness({
      services: [service("backend")],
      launcherProcess: { pid: 10, exitCode: null, signalCode: null },
      serviceStatePath,
      logPath: path.join(temporaryRoot, "preview.log"),
      probe: async () => ({ ok: true, detail: "HTTP 200" }),
      expectedGeneration: "generation-one",
      validateReady: (states) => { observedServiceStates.push(states); },
      now: () => 0,
      pause: async () => {},
    });
    // The default reader must forward the generation, so the file-level
    // generation-mismatch classification hides every foreign record.
    assert.deepEqual(observedServiceStates, [{}]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("ignores a transient launcher exit while service probes are still converging", async () => {
  const attempts = new Map();
  const result = await waitForPreviewReadiness({
    services: [service("backend"), service("frontend"), service("pipeline-engine")],
    launcherProcess: { pid: 10, exitCode: 0, signalCode: null },
    probe: async ({ role }) => {
      const attempt = (attempts.get(role) ?? 0) + 1;
      attempts.set(role, attempt);
      return attempt >= 2
        ? { ok: true, detail: "HTTP 200" }
        : { ok: false, detail: "fetch failed" };
    },
    readServiceStates: () => ({
      backend: { state: "spawned", pid: 20 },
      frontend: { state: "spawned", pid: 21 },
      "pipeline-engine": { state: "spawned", pid: 22 },
    }),
    now: () => 0,
    pause: async () => {},
  });
  assert.equal(result.every(([, probeResult]) => probeResult.ok), true);
  assert.deepEqual(Object.fromEntries(attempts), {
    backend: 2,
    frontend: 2,
    "pipeline-engine": 2,
  });
});

test("requires all health endpoints to succeed in the same probe pass", async () => {
  const attempts = new Map();
  await waitForPreviewReadiness({
    services: [service("backend"), service("frontend")],
    launcherProcess: { pid: 10, exitCode: null, signalCode: null },
    probe: async ({ role }) => {
      const attempt = (attempts.get(role) ?? 0) + 1;
      attempts.set(role, attempt);
      return role === "backend" || attempt >= 2
        ? { ok: true, detail: "HTTP 200" }
        : { ok: false, detail: "not listening" };
    },
    readServiceStates: () => ({}),
    now: () => 0,
    pause: async () => {},
  });
  assert.equal(attempts.get("backend"), 2);
  assert.equal(attempts.get("frontend"), 2);
});

test("reports a real service exit with exit code and log tail", async () => {
  await assert.rejects(
    waitForPreviewReadiness({
      services: [service("backend")],
      launcherProcess: { pid: 10, exitCode: 1, signalCode: null },
      probe: async () => ({ ok: false, detail: "fetch failed" }),
      readServiceStates: () => ({
        backend: { state: "exited", pid: 20, exitCode: 7, signal: null },
      }),
      readLogExcerpt: () => "backend fatal detail",
      now: () => 0,
      pause: async () => {},
    }),
    (error) => {
      assert.match(error.message, /service process PID 20 exited/);
      assert.match(error.message, /exit code 7/);
      assert.match(error.message, /backend fatal detail/);
      return true;
    },
  );
});

test("retries not-yet-listening sockets until the bounded health timeout", async () => {
  let currentTime = 0;
  await assert.rejects(
    waitForPreviewReadiness({
      services: [service("backend", 100)],
      launcherProcess: { pid: 10, exitCode: null, signalCode: null },
      probe: async () => ({ ok: false, detail: "ECONNREFUSED" }),
      readServiceStates: () => ({ backend: { state: "spawned", pid: 20 } }),
      readLogExcerpt: () => "still starting",
      now: () => currentTime,
      pause: async () => { currentTime += 50; },
    }),
    (error) => {
      assert.match(error.message, /health timed out after 100ms/);
      assert.match(error.message, /ECONNREFUSED/);
      assert.match(error.message, /still starting/);
      return true;
    },
  );
});
