import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoForeignPreviewListeners,
  occupiedPreviewPorts,
  recordedPreviewProcessGroup,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";

test("requires generation-bound identity before accepting a recorded process group", () => {
  const record = {
    pid: 41,
    pgid: 41,
    generation: "generation-one",
    identity: { method: "test", value: "birth-one" },
  };
  assert.deepEqual(
    recordedPreviewProcessGroup(record, "generation-one", "/checkout", {
      isAlive: () => true,
      resolveIdentity: () => ({ method: "test", value: "birth-one" }),
      resolveProcessGroup: () => 41,
      workingDirectory: () => "/checkout/server",
    }),
    { groupId: 41, listeners: [], record },
  );
  assert.throws(
    () => recordedPreviewProcessGroup(record, "generation-one", "/checkout", {
      isAlive: () => true,
      resolveIdentity: () => ({ method: "test", value: "different-birth" }),
      resolveProcessGroup: () => 41,
      workingDirectory: () => "/checkout/server",
    }),
    /identity no longer matches.*refusing to signal/,
  );
});

test("classifies an unrelated same-checkout listener as foreign without signalling it", () => {
  let signals = 0;
  assert.throws(
    () => assertNoForeignPreviewListeners(
      { backend: 18100 },
      [{ groupId: 100, listeners: [] }],
      {
        inspectPort: () => [77],
        resolveProcessGroup: () => 200,
        signalProcessGroup: () => { signals += 1; },
      },
    ),
    /listener PID 77 belongs to foreign process group 200; refusing to signal/,
  );
  assert.equal(signals, 0);
});

test("reports only listener-occupied preview ports", () => {
  const listeners = new Map([[18000, [11]], [13000, []], [13091, [22, 23]]]);
  assert.deepEqual(
    occupiedPreviewPorts(
      { backend: 18000, frontend: 13000, engine: 13091 },
      (port) => listeners.get(port) ?? [],
    ),
    [
      { role: "backend", port: 18000, listeners: [11] },
      { role: "engine", port: 13091, listeners: [22, 23] },
    ],
  );
});

test("free-port barrier retries until every chosen port is released", async () => {
  let inspection = 0;
  const occupied = await waitForPreviewPortsFree(
    { backend: 18000, frontend: 13000, engine: 13091 },
    1_000,
    {
      inspectPort: () => (inspection++ < 3 ? [91] : []),
      now: (() => {
        let current = 0;
        return () => current += 10;
      })(),
      pause: async () => {},
    },
  );
  assert.deepEqual(occupied, []);
});

test("free-port barrier returns exact holdouts at its deadline", async () => {
  const occupied = await waitForPreviewPortsFree(
    { backend: 18000 },
    50,
    {
      inspectPort: () => [77],
      now: (() => {
        let current = 0;
        return () => current += 30;
      })(),
      pause: async () => {},
    },
  );
  assert.deepEqual(occupied, [{ role: "backend", port: 18000, listeners: [77] }]);
});
