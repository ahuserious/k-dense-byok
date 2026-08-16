import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  preparePreviewWebRoot,
  readPreviewWebProjectionMarker,
  removePreviewWebRoot,
  updatePreviewWebProjectionMarker,
} from "./preview-environment.mjs";
import {
  acquirePreviewLifecycleLock,
  PREVIEW_LIFECYCLE_LOCK_VERSION,
  previewPidStartIdentity,
  previewTeardownRecord,
  publishPreviewStartGate,
  publishPreviewStateFile,
  recoverUnrecognizedPreviewLifecycleLock,
  removePreviewStateFile,
} from "./preview-state.mjs";

function createProjectionFixture(temporaryRoot, generation, { withRoot = true } = {}) {
  const repositoryRoot = path.join(temporaryRoot, "checkout");
  const checkoutWebRoot = path.join(repositoryRoot, "web");
  const stateRoot = path.join(temporaryRoot, `kady-preview-${generation}`);
  const launchRoot = path.join(stateRoot, "launch");
  const ports = { backend: 18100, frontend: 13100, engine: 13191 };
  fs.mkdirSync(path.join(checkoutWebRoot, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(checkoutWebRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, "server"), { recursive: true });
  fs.mkdirSync(launchRoot, { recursive: true });
  fs.writeFileSync(path.join(checkoutWebRoot, "src", "app", "page.tsx"), "page\n");
  fs.writeFileSync(path.join(checkoutWebRoot, "package.json"), "{}\n");
  fs.writeFileSync(path.join(repositoryRoot, "server", "package.json"), "{}\n");
  preparePreviewWebRoot(repositoryRoot, launchRoot, generation, {
    stateRoot,
    ports,
  });
  if (withRoot) {
    updatePreviewWebProjectionMarker(repositoryRoot, generation, {
      rootProcess: {
        pid: 321,
        pgid: 321,
        identity: { method: "test", value: "fixture-root" },
        generation,
      },
      serviceStatePath: path.join(stateRoot, "services.json"),
    });
  }
  return { repositoryRoot, stateRoot, launchRoot, ports };
}

test("refuses marker recovery without a generation-bound launcher process", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-null-root-"));
  try {
    const generation = "null-root-generation";
    const fixture = createProjectionFixture(temporaryRoot, generation, { withRoot: false });
    const marker = readPreviewWebProjectionMarker(fixture.repositoryRoot);
    assert.throws(
      () => previewTeardownRecord(path.join(temporaryRoot, ".state.json"), marker),
      /no generation-bound launcher process; refusing recovery/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function waitForLockOutcome(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for lock outcome")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ACQUIRED") || output.includes("REFUSED:")) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once("error", reject);
  });
}

test("publishes preview state through an atomic same-directory replacement", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-state-publish-"));
  try {
    const stateFile = path.join(temporaryRoot, ".state.json");
    fs.writeFileSync(stateFile, '{"version":0}\n');
    const state = { version: 1, generation: "atomic-generation", rootPid: 123 };
    publishPreviewStateFile(stateFile, state);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), state);
    assert.deepEqual(
      fs.readdirSync(temporaryRoot).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("recovers a lifecycle lock left by a SIGKILLed owner", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-kill-"));
  const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
  const stateModuleUrl = pathToFileURL(path.join(import.meta.dirname, "preview-state.mjs")).href;
  const holderScript = path.join(temporaryRoot, "hold-lock.mjs");
  try {
    fs.writeFileSync(
      holderScript,
      `import { acquirePreviewLifecycleLock } from ${JSON.stringify(stateModuleUrl)};\n` +
        `acquirePreviewLifecycleLock(${JSON.stringify(lockFile)}, { operation: "preview-up", generation: "killed-generation", identity: { method: "test", value: "test-child-start" } });\n` +
        `console.log("LOCKED");\nsetInterval(() => {}, 1000);\n`,
    );
    const child = spawn(process.execPath, [holderScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForOutput(child, "LOCKED");
    const childExit = waitForExit(child);
    child.kill("SIGKILL");
    const exit = await childExit;
    assert.equal(exit.signal, "SIGKILL");

    const messages = [];
    const recovered = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "next-generation",
      identity: { method: "test", value: "test-parent-start" },
      resolvePidStartIdentity: (pid) => {
        try {
          process.kill(pid, 0);
          return { method: "test", value: "unexpected-live-owner" };
        } catch (error) {
          if (error?.code === "ESRCH") return null;
          throw error;
        }
      },
      log: (message) => messages.push(message),
    });
    assert.match(
      messages.join("\n"),
      /Recovered stale lifecycle lock \(pid \d+, started test:test-child-start\)/,
    );
    recovered.release();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("recovers a reused PID only when lifecycle generations agree", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-reuse-"));
  try {
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
    const stateFile = path.join(temporaryRoot, ".state.json");
    const identities = new Map([
      [501, { method: "test", value: "old-start" }],
      [502, { method: "test", value: "new-command-start" }],
    ]);
    const resolvePidStartIdentity = (pid) => identities.get(pid) ?? null;
    fs.writeFileSync(stateFile, '{"generation":"owned-generation"}\n');
    acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "owned-generation",
      pid: 501,
      resolvePidStartIdentity,
    });
    identities.set(501, { method: "test", value: "reused-start" });
    const messages = [];
    const recovered = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-down",
      generation: "owned-generation",
      pid: 502,
      resolvePidStartIdentity,
      generationFiles: [stateFile],
      log: (message) => messages.push(message),
    });
    assert.match(messages.join("\n"), /pid 501, started test:old-start/);
    recovered.release();

    fs.writeFileSync(stateFile, '{"generation":"different-generation"}\n');
    identities.set(501, { method: "test", value: "second-old-start" });
    acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "owned-generation",
      pid: 501,
      resolvePidStartIdentity,
    });
    identities.set(501, { method: "test", value: "second-reused-start" });
    assert.throws(
      () => acquirePreviewLifecycleLock(lockFile, {
        operation: "preview-down",
        generation: "different-generation",
        pid: 502,
        resolvePidStartIdentity,
        generationFiles: [stateFile],
      }),
      /refuses stale-lock recovery.*different-generation.*owned-generation/s,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("legacy, unknown-identity, and zero-byte locks remain busy until explicit recovery", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-legacy-"));
  try {
    const cases = [
      {
        name: "live-v2",
        value: JSON.stringify({
          version: 2,
          operation: "preview-up",
          generation: "legacy-generation",
          pid: process.pid,
          identity: { method: "test", value: "legacy-live" },
        }),
      },
      {
        name: "unknown-method",
        value: JSON.stringify({
          version: PREVIEW_LIFECYCLE_LOCK_VERSION,
          operation: "preview-up",
          generation: "unknown-generation",
          pid: process.pid,
          identity: { method: "future-method", value: "opaque" },
        }),
      },
      { name: "zero-byte", value: "" },
    ];
    for (const testCase of cases) {
      const lockFile = path.join(temporaryRoot, `.lifecycle.${testCase.name}.lock`);
      fs.writeFileSync(lockFile, testCase.value);
      assert.throws(
        () => acquirePreviewLifecycleLock(lockFile, {
          operation: "preview-down",
          generation: "contender-generation",
          identity: { method: "test", value: "contender" },
        }),
        /legacy, malformed, or uses an unknown identity method and is busy.*--recover-lock/s,
      );
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("explicit recovery removes an unrecognized lock only after its proof succeeds", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-explicit-"));
  const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
  try {
    fs.writeFileSync(lockFile, "");
    assert.throws(
      () => recoverUnrecognizedPreviewLifecycleLock(lockFile, {
        identity: { method: "test", value: "recovery-owner" },
        verifySafeRecovery: () => { throw new Error("listener still alive"); },
      }),
      /listener still alive/,
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(recoverUnrecognizedPreviewLifecycleLock(lockFile, {
      identity: { method: "test", value: "recovery-owner" },
      verifySafeRecovery: () => {},
    }), true);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("three barrier-coordinated stale-lock contenders admit exactly one live owner", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-race-"));
  const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
  const gateFile = path.join(temporaryRoot, "go");
  const stateModuleUrl = pathToFileURL(path.join(import.meta.dirname, "preview-state.mjs")).href;
  try {
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({
        version: PREVIEW_LIFECYCLE_LOCK_VERSION,
        operation: "preview-up",
        generation: "stale-generation",
        pid: 999_999,
        identity: { method: "test", value: "dead" },
        createdAt: new Date(0).toISOString(),
      })}\n`,
    );
    const children = ["one", "two", "three"].map((name) => {
      const childScript = path.join(temporaryRoot, `${name}.mjs`);
      fs.writeFileSync(
        childScript,
        `import fs from "node:fs";\n` +
          `import { acquirePreviewLifecycleLock } from ${JSON.stringify(stateModuleUrl)};\n` +
          `while (!fs.existsSync(${JSON.stringify(gateFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);\n` +
          `try { acquirePreviewLifecycleLock(${JSON.stringify(lockFile)}, { operation: "preview-up", generation: ${JSON.stringify(name)}, identity: { method: "test", value: "race-live" }, resolvePidStartIdentity: (pid) => { try { process.kill(pid, 0); return { method: "test", value: "race-live" }; } catch (error) { if (error.code === "ESRCH") return null; throw error; } } }); console.log("ACQUIRED"); setInterval(() => {}, 1000); } catch (error) { console.log("REFUSED:" + error.message); }\n`,
      );
      return spawn(process.execPath, [childScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
    fs.writeFileSync(gateFile, "go\n");
    const outputs = await Promise.all(children.map(waitForLockOutcome));
    assert.equal(outputs.filter((output) => output.includes("ACQUIRED")).length, 1);
    assert.equal(outputs.filter((output) => output.includes("REFUSED:")).length, 2);
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("publishes a complete generation gate without a visible temporary file", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-gate-"));
  try {
    const gateFile = path.join(temporaryRoot, "start.gate");
    publishPreviewStartGate(gateFile, "gate-generation");
    assert.equal(fs.readFileSync(gateFile, "utf8"), "gate-generation\n");
    assert.deepEqual(fs.readdirSync(temporaryRoot), ["start.gate"]);
    assert.throws(
      () => publishPreviewStartGate(gateFile, "other-generation"),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("macOS PID identity forces locale and timezone invariance", () => {
  const observedEnvironments = [];
  const runCommand = (_command, _args, options) => {
    observedEnvironments.push(options.env);
    return { status: 0, stdout: "Sun Aug 16 12:34:56 2026\n", stderr: "" };
  };
  const originalLocale = process.env.LC_ALL;
  const originalTimezone = process.env.TZ;
  let first;
  let second;
  try {
    process.env.LC_ALL = "fr_FR.UTF-8";
    process.env.TZ = "Pacific/Honolulu";
    first = previewPidStartIdentity(700, {
      platform: "darwin",
      signalProcess: () => {},
      runCommand,
    });
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.TZ = "Europe/Berlin";
    second = previewPidStartIdentity(700, {
      platform: "darwin",
      signalProcess: () => {},
      runCommand,
    });
  } finally {
    if (originalLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLocale;
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    method: "ps-lstart-utc",
    value: "Sun Aug 16 12:34:56 2026",
  });
  for (const environment of observedEnvironments) {
    assert.equal(environment.LC_ALL, "C");
    assert.equal(environment.TZ, "UTC0");
  }
});

test("Linux PID identity combines boot ID with proc start ticks", () => {
  const fieldsFromState = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "424242"];
  const identity = previewPidStartIdentity(710, {
    platform: "linux",
    signalProcess: () => {},
    readFile: (file) => file.endsWith("boot_id")
      ? "boot-identity\n"
      : `710 (preview worker) ${fieldsFromState.join(" ")}\n`,
  });
  assert.deepEqual(identity, {
    method: "proc-stat",
    value: "boot-identity:424242",
  });
});

test("treats an identity method mismatch as live and refuses takeover", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-method-"));
  try {
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
    acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "method-generation",
      pid: 801,
      identity: { method: "test", value: "recorded" },
    });
    assert.throws(
      () => acquirePreviewLifecycleLock(lockFile, {
        operation: "preview-down",
        generation: "method-generation",
        pid: 802,
        identity: { method: "test", value: "contender" },
        resolvePidStartIdentity: () => ({
          method: "proc-stat",
          value: "same-process-different-method",
        }),
      }),
      /Preview lifecycle is busy: preview-up PID 801 is still starting/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

for (const stateStatus of ["malformed", "missing"]) {
  test(`recovers teardown from the projection marker when state is ${stateStatus}`, async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-state-recovery-"));
    const generation = `${stateStatus}-state-generation`;
    try {
      const fixture = createProjectionFixture(temporaryRoot, generation);
      const stateFile = path.join(temporaryRoot, ".state.json");
      if (stateStatus === "malformed") fs.writeFileSync(stateFile, '{"version":1');
      const marker = readPreviewWebProjectionMarker(fixture.repositoryRoot);
      const selected = previewTeardownRecord(stateFile, marker);
      assert.equal(selected.recoveredFromMarker, true);
      assert.equal(selected.stateStatus, stateStatus);
      assert.equal(selected.state.generation, generation);
      assert.equal(removePreviewWebRoot(fixture.repositoryRoot, selected.state.generation), true);
      assert.equal(await removePreviewStateFile(stateFile), true);
      assert.equal(
        fs.existsSync(path.join(fixture.repositoryRoot, "web", ".preview")),
        false,
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}

test("state removal blocks until the lifecycle file is absent", async () => {
  let checks = 0;
  let removed = false;
  const cleared = await removePreviewStateFile("preview-state.json", 100, {
    removeFile: () => {
      removed = true;
    },
    fileExists: () => removed && checks++ < 2,
    now: (() => {
      let time = 0;
      return () => time++;
    })(),
    pause: async () => {},
  });

  assert.equal(cleared, true);
  assert.ok(checks >= 3);
});

test("state removal reports a lifecycle file that never clears", async () => {
  const cleared = await removePreviewStateFile("preview-state.json", 2, {
    removeFile: () => {},
    fileExists: () => true,
    now: (() => {
      let time = 0;
      return () => time++;
    })(),
    pause: async () => {},
  });

  assert.equal(cleared, false);
});
