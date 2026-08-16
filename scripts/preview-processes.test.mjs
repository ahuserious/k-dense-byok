import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertExplicitPreviewLockRecoverySafe,
  assertNoForeignPreviewListeners,
  assertPreviewServiceListenersOwned,
  occupiedPreviewPorts,
  quiescePreviewGeneration,
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

test("refuses readiness when a foreign listener races onto a recorded service port", () => {
  const serviceStates = {
    backend: {
      role: "backend",
      pid: 41,
      pgid: 41,
      generation: "generation-one",
      identity: { method: "test", value: "birth-one" },
    },
  };
  assert.throws(
    () => assertPreviewServiceListenersOwned(
      { backend: 18100 },
      serviceStates,
      "generation-one",
      {
        inspectPort: () => [77],
        resolveProcessGroup: () => 77,
      },
    ),
    /port 18100 held by pid 77 not owned by generation generation-one/i,
  );
});

test("explicit lock recovery requires no holder, live generation record, or listener", () => {
  const proof = {
    lockFile: "/checkout/deploy/preview/.lifecycle.lock",
    lockHolderPids: [],
    generation: "generation-one",
    ports: { backend: 18100 },
    records: [{
      role: "backend",
      pid: 41,
      pgid: 41,
      generation: "generation-one",
      identity: { method: "test", value: "birth-one" },
    }],
  };
  assert.throws(
    () => assertExplicitPreviewLockRecoverySafe(
      { ...proof, lockHolderPids: [99] },
      { isAlive: () => false, inspectPort: () => [] },
    ),
    /lsof reports holder PID\(s\) 99/,
  );
  assert.throws(
    () => assertExplicitPreviewLockRecoverySafe(proof, {
      isAlive: () => true,
      resolveIdentity: () => ({ method: "test", value: "birth-one" }),
      inspectPort: () => [],
    }),
    /process records survived teardown: 41/,
  );
  assert.throws(
    () => assertExplicitPreviewLockRecoverySafe(proof, {
      isAlive: () => false,
      inspectPort: () => [77],
    }),
    /ports still have listeners.*18100.*77/s,
  );
  assert.doesNotThrow(() => assertExplicitPreviewLockRecoverySafe(proof, {
    isAlive: () => false,
    inspectPort: () => [],
  }));
});

test("teardown fresh-reads and stops a service record published after its first read", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-late-record-"));
  try {
    const repositoryRoot = path.join(temporaryRoot, "checkout");
    let launchRoot = path.join(temporaryRoot, "launch");
    fs.mkdirSync(path.join(repositoryRoot, "server", "vendor", "pipeline-engine"), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, "web"), { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    launchRoot = fs.realpathSync(launchRoot);
    const generation = "late-record-generation";
    const records = {
      backend: {
        role: "backend",
        pid: 20,
        pgid: 20,
        generation,
        identity: { method: "test", value: "backend" },
      },
      frontend: {
        role: "frontend",
        pid: 21,
        pgid: 21,
        generation,
        identity: { method: "test", value: "frontend" },
      },
    };
    const snapshots = [
      { signature: "one", services: { backend: records.backend } },
      { signature: "two", services: records },
      { signature: "two", services: records },
    ];
    let readIndex = 0;
    const livePids = new Set([10, 20, 21]);
    const stoppedGroups = [];
    const identities = new Map([
      [10, { method: "test", value: "launcher" }],
      [20, records.backend.identity],
      [21, records.frontend.identity],
    ]);
    await quiescePreviewGeneration(
      repositoryRoot,
      {
        generation,
        launchRoot,
        rootProcess: {
          pid: 10,
          pgid: 10,
          generation,
          identity: identities.get(10),
        },
        ports: { backend: 18100, frontend: 13100, engine: 13191 },
      },
      {
        readServiceSnapshot: () => snapshots[Math.min(readIndex++, snapshots.length - 1)],
        stopGroups: async (groups) => {
          for (const { groupId } of groups) {
            stoppedGroups.push(groupId);
            livePids.delete(groupId);
          }
          return [];
        },
        inspectPort: () => [],
        pause: async () => {},
        now: () => 0,
        processOptions: {
          isAlive: (pid) => livePids.has(pid),
          resolveIdentity: (pid) => identities.get(pid) ?? null,
          resolveProcessGroup: (pid) => pid,
          workingDirectory: (pid) => pid === 10
            ? fs.realpathSync(launchRoot)
            : pid === 20
              ? fs.realpathSync(path.join(repositoryRoot, "server"))
              : fs.realpathSync(path.join(repositoryRoot, "web")),
        },
      },
    );
    assert.ok(readIndex >= 3);
    assert.deepEqual(new Set(stoppedGroups), new Set([10, 20, 21]));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
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
