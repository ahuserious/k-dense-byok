import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertForcedPreviewLockRecoverySafe,
  assertNoForeignPreviewListeners,
  assertPreviewServiceListenersOwned,
  occupiedPreviewPorts,
  quiescePreviewGeneration,
  recordedPreviewProcessGroup,
  waitForPreviewPortsFree,
} from "./preview-processes.mjs";
import { readPreviewServiceStateSnapshot } from "./preview-readiness.mjs";

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

test("forced lock recovery requires no preview listener or state-root process", () => {
  const proof = {
    ports: { backend: 18100 },
    stateRoots: ["/tmp/kady-preview-proof"],
  };
  assert.throws(
    () => assertForcedPreviewLockRecoverySafe(proof, {
      inspectPort: () => [77],
      inspectStateRoot: () => [],
    }),
    /refuses listeners.*18100.*77/s,
  );
  assert.throws(
    () => assertForcedPreviewLockRecoverySafe(proof, {
      inspectPort: () => [],
      inspectStateRoot: () => [99],
    }),
    /PID\(s\) 99 referencing exact state root \/tmp\/kady-preview-proof/,
  );
  assert.doesNotThrow(() => assertForcedPreviewLockRecoverySafe(proof, {
    inspectPort: () => [],
    inspectStateRoot: () => [],
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

test("teardown refuses a present semantically invalid service record", async () => {
  const generation = "invalid-record-generation";
  await assert.rejects(
    quiescePreviewGeneration(
      "/checkout",
      {
        generation,
        launchRoot: "/launch",
        rootProcess: {
          pid: 10,
          pgid: 10,
          generation,
          identity: { method: "test", value: "launcher" },
        },
        ports: { backend: 18100, frontend: 13100, engine: 13191 },
      },
      {
        readServiceSnapshot: () => ({
          status: "valid",
          signature: "invalid",
          services: { backend: { role: "backend", pid: "not-a-pid" } },
        }),
        stopGroups: async () => [],
        processOptions: { isAlive: () => false },
        now: () => 0,
        pause: async () => {},
      },
    ),
    /service record backend is present but invalid; refusing teardown/,
  );
});

// Every non-"valid" service-state status must stop teardown at the first read.
// The refusal harness below drives the real quiescePreviewGeneration loop over a
// real on-disk service-state file classified by the real
// readPreviewServiceStateSnapshot, so the classifier and the quiesce refusal are
// proven together rather than in isolation.
//
// By design the recorded launcher group is stopped BEFORE the first service-state
// read (quiescePreviewGeneration stops the root group, then enters the read loop),
// so process group 10 is the only group these tests expect to see stopped. Any
// additional group id would mean teardown signalled a service after refusing.
const REFUSAL_GENERATION = "refusal-generation";
const REFUSAL_LAUNCHER_GROUP_ID = 10;

function previewRefusalHarness(serviceStatePath) {
  const stoppedGroupIds = [];
  let serviceStateReadCount = 0;
  const rootProcessRecord = {
    pid: REFUSAL_LAUNCHER_GROUP_ID,
    pgid: REFUSAL_LAUNCHER_GROUP_ID,
    generation: REFUSAL_GENERATION,
    identity: { method: "test", value: "launcher" },
  };
  const runTeardown = () => quiescePreviewGeneration(
    "/checkout",
    {
      generation: REFUSAL_GENERATION,
      launchRoot: "/launch",
      rootProcess: rootProcessRecord,
      ports: { backend: 18100, frontend: 13100, engine: 13191 },
    },
    {
      readServiceSnapshot: () => {
        serviceStateReadCount += 1;
        return readPreviewServiceStateSnapshot(serviceStatePath, REFUSAL_GENERATION);
      },
      stopGroups: async (groups) => {
        for (const { groupId } of groups) stoppedGroupIds.push(groupId);
        return [];
      },
      inspectPort: () => {
        throw new Error("Teardown inspected a port after refusing an incomplete service record.");
      },
      now: () => 0,
      pause: async () => {
        throw new Error("Teardown polled again after refusing an incomplete service record.");
      },
      processOptions: {
        isAlive: (pid) => pid === REFUSAL_LAUNCHER_GROUP_ID,
        resolveIdentity: (pid) =>
          (pid === REFUSAL_LAUNCHER_GROUP_ID ? rootProcessRecord.identity : null),
        resolveProcessGroup: (pid) => pid,
        workingDirectory: () => "/launch",
      },
    },
  );
  return {
    runTeardown,
    stoppedGroupIds,
    serviceStateReadCount: () => serviceStateReadCount,
  };
}

async function assertTeardownRefusesStatus(serviceStatePath, status) {
  const { runTeardown, stoppedGroupIds, serviceStateReadCount } =
    previewRefusalHarness(serviceStatePath);
  await assert.rejects(
    runTeardown(),
    new RegExp(
      `Preview generation ${REFUSAL_GENERATION} service state is ${status}; ` +
        "refusing teardown without a complete process record\\.",
    ),
  );
  // Only the recorded launcher group, stopped before the first read by design.
  assert.deepEqual(stoppedGroupIds, [REFUSAL_LAUNCHER_GROUP_ID]);
  assert.equal(serviceStateReadCount(), 1);
}

async function withServiceStateDirectory(run) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-refusal-"));
  try {
    return await run(temporaryRoot);
  } finally {
    fs.chmodSync(temporaryRoot, 0o700);
    for (const entry of fs.readdirSync(temporaryRoot)) {
      try {
        fs.chmodSync(path.join(temporaryRoot, entry), 0o600);
      } catch {
        // A file the case already removed needs no permission restoration.
      }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("teardown refuses a missing service state without stopping any service group", async () => {
  await withServiceStateDirectory(async (temporaryRoot) => {
    // No file is written: readPreviewServiceStateSnapshot classifies ENOENT as missing.
    await assertTeardownRefusesStatus(path.join(temporaryRoot, "services.json"), "missing");
  });
});

test("teardown refuses an unreadable service state without stopping any service group", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("chmod 000 does not deny reads for root; the unreadable branch is unobservable here.");
    return;
  }
  await withServiceStateDirectory(async (temporaryRoot) => {
    const serviceStatePath = path.join(temporaryRoot, "services.json");
    fs.writeFileSync(
      serviceStatePath,
      `${JSON.stringify({ version: 2, generation: REFUSAL_GENERATION, services: {} })}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(serviceStatePath, 0o000);
    let readDenied = false;
    try {
      fs.readFileSync(serviceStatePath, "utf-8");
    } catch {
      readDenied = true;
    }
    if (!readDenied) {
      t.skip("This filesystem still permits reads at mode 000; the unreadable branch is unobservable here.");
      return;
    }
    await assertTeardownRefusesStatus(serviceStatePath, "unreadable");
  });
});

test("teardown refuses a malformed service state without stopping any service group", async () => {
  await withServiceStateDirectory(async (temporaryRoot) => {
    const serviceStatePath = path.join(temporaryRoot, "services.json");
    fs.writeFileSync(serviceStatePath, "{", { mode: 0o600 });
    await assertTeardownRefusesStatus(serviceStatePath, "malformed");
  });
});

test("teardown refuses a generation-mismatched service state without stopping any service group", async () => {
  await withServiceStateDirectory(async (temporaryRoot) => {
    const serviceStatePath = path.join(temporaryRoot, "services.json");
    fs.writeFileSync(
      serviceStatePath,
      `${JSON.stringify({
        version: 2,
        generation: "a-different-generation",
        services: {
          backend: {
            role: "backend",
            pid: 20,
            pgid: 20,
            generation: "a-different-generation",
            identity: { method: "test", value: "backend" },
          },
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assertTeardownRefusesStatus(serviceStatePath, "generation-mismatch");
  });
});

test("teardown refuses a structurally invalid service state without stopping any service group", async () => {
  await withServiceStateDirectory(async (temporaryRoot) => {
    const serviceStatePath = path.join(temporaryRoot, "services.json");
    // Right generation, wrong shape: `services` must be a plain object.
    fs.writeFileSync(
      serviceStatePath,
      `${JSON.stringify({ version: 2, generation: REFUSAL_GENERATION, services: [] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assertTeardownRefusesStatus(serviceStatePath, "invalid");
  });
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
