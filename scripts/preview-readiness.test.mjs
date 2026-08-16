import assert from "node:assert/strict";
import test from "node:test";

import {
  probePreviewService,
  waitForPreviewReadiness,
} from "./preview-readiness.mjs";

function service(role, timeoutMs = 1_000) {
  return { role, label: role, url: `http://preview.invalid/${role}`, timeoutMs };
}

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
