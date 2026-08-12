import assert from "node:assert/strict";
import test from "node:test";

import {
  occupiedPreviewPorts,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";

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
