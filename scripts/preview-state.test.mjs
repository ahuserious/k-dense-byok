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
  previewPidStartIdentity,
  previewTeardownRecord,
  publishPreviewStartGate,
  publishPreviewStateFile,
  recoverPreviewLifecycleLock,
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

test("mkdir contention admits one lifecycle owner and reports the other as BUSY", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-race-"));
  const lockDirectory = path.join(temporaryRoot, ".lifecycle.lock.d");
  const stateModuleUrl = pathToFileURL(path.join(import.meta.dirname, "preview-state.mjs")).href;
  try {
    const startContender = (name) => {
      const childScript = path.join(temporaryRoot, `${name}.mjs`);
      fs.writeFileSync(
        childScript,
        `import { acquirePreviewLifecycleLock } from ${JSON.stringify(stateModuleUrl)};\n` +
          `try { acquirePreviewLifecycleLock(${JSON.stringify(lockDirectory)}, { operation: "preview-up", generation: ${JSON.stringify(name)}, identity: { method: "test", value: "race-live" }, hostBootIdentity: { host: "test-host", boot: "test-boot" } }); console.log("ACQUIRED"); setInterval(() => {}, 1000); } catch (error) { console.log("REFUSED:" + error.message); }\n`,
      );
      return spawn(process.execPath, [childScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    };
    const first = startContender("one");
    assert.match(await waitForLockOutcome(first), /ACQUIRED/);
    const second = startContender("two");
    assert.match(
      await waitForLockOutcome(second),
      /REFUSED:Preview lifecycle BUSY: preview-up PID \d+/,
    );
    if (first.exitCode === null) first.kill("SIGKILL");
    if (second.exitCode === null) second.kill("SIGKILL");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("release removes the directory lock and allows reacquisition", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-release-"));
  const lockDirectory = path.join(temporaryRoot, ".lifecycle.lock.d");
  const options = {
    operation: "preview-up",
    generation: "release-generation",
    identity: { method: "test", value: "release-owner" },
    hostBootIdentity: { host: "test-host", boot: "test-boot" },
  };
  try {
    const first = acquirePreviewLifecycleLock(lockDirectory, options);
    assert.equal(fs.existsSync(path.join(lockDirectory, "owner.json")), true);
    const owner = JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8"));
    assert.equal(owner.version, 4);
    assert.deepEqual(owner.identity, {
      method: "test",
      value: "release-owner",
      host: "test-host",
      boot: "test-boot",
    });
    first.release();
    assert.equal(fs.existsSync(lockDirectory), false);
    const second = acquirePreviewLifecycleLock(lockDirectory, options);
    second.release();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("explicit recovery removes a dead current owner and refuses a live owner", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-owner-"));
  const lockDirectory = path.join(temporaryRoot, ".lifecycle.lock.d");
  const hostBoot = { host: "test-host", boot: "test-boot" };
  try {
    acquirePreviewLifecycleLock(lockDirectory, {
      operation: "preview-up",
      generation: "dead-generation",
      pid: 501,
      identity: { method: "test", value: "dead-owner" },
      hostBootIdentity: hostBoot,
    });
    assert.equal(recoverPreviewLifecycleLock(lockDirectory, {
      currentHostBootIdentity: hostBoot,
      resolvePidStartIdentity: () => null,
    }), true);
    acquirePreviewLifecycleLock(lockDirectory, {
      operation: "preview-up",
      generation: "live-generation",
      pid: 502,
      identity: { method: "test", value: "live-owner" },
      hostBootIdentity: hostBoot,
    });
    assert.throws(
      () => recoverPreviewLifecycleLock(lockDirectory, {
        currentHostBootIdentity: hostBoot,
        resolvePidStartIdentity: () => ({ method: "test", value: "live-owner" }),
      }),
      /refuses live owner PID 502/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("unreadable owner requires force and preserves the lock when forced proof fails", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-unreadable-"));
  const lockDirectory = path.join(temporaryRoot, ".lifecycle.lock.d");
  try {
    fs.mkdirSync(lockDirectory);
    assert.throws(
      () => recoverPreviewLifecycleLock(lockDirectory),
      /missing or unreadable.*--recover-lock --force/s,
    );
    assert.throws(
      () => recoverPreviewLifecycleLock(lockDirectory, {
        force: true,
        verifyForcedRecovery: () => { throw new Error("listener on preview port"); },
      }),
      /listener on preview port/,
    );
    assert.equal(fs.existsSync(lockDirectory), true);
    assert.equal(recoverPreviewLifecycleLock(lockDirectory, {
      force: true,
      verifyForcedRecovery: () => {},
    }), true);
    assert.equal(fs.existsSync(lockDirectory), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

for (const legacyOwner of [
  {
    version: 2,
    operation: "preview-up",
    generation: "legacy-v2-generation",
    pid: 502,
    pidStartIdentity: "ps-lstart:legacy-owner",
  },
  {
    version: 3,
    operation: "preview-up",
    generation: "legacy-v3-generation",
    pid: 503,
    identity: { method: "test", value: "legacy-owner" },
  },
]) test(`legacy v${legacyOwner.version} owner without host and boot is parsed but cannot be recovered automatically`, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-legacy-"));
  const legacyLockFile = path.join(temporaryRoot, ".lifecycle.lock");
  try {
    fs.writeFileSync(legacyLockFile, `${JSON.stringify(legacyOwner)}\n`);
    assert.throws(
      () => recoverPreviewLifecycleLock(
        path.join(temporaryRoot, ".lifecycle.lock.d"),
        {
          legacyLockFiles: [legacyLockFile],
          currentHostBootIdentity: { host: "test-host", boot: "test-boot" },
          resolvePidStartIdentity: () => null,
        },
      ),
      /cannot verify owner liveness.*host or boot identity differs or is missing/,
    );
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

test("explicit recovery refuses a different host or boot identity", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-method-"));
  try {
    const lockDirectory = path.join(temporaryRoot, ".lifecycle.lock.d");
    acquirePreviewLifecycleLock(lockDirectory, {
      operation: "preview-up",
      generation: "method-generation",
      pid: 801,
      identity: { method: "test", value: "recorded" },
      hostBootIdentity: { host: "original-host", boot: "original-boot" },
    });
    assert.throws(
      () => recoverPreviewLifecycleLock(lockDirectory, {
        currentHostBootIdentity: { host: "other-host", boot: "other-boot" },
        resolvePidStartIdentity: () => ({
          method: "test",
          value: "recorded",
        }),
      }),
      /cannot verify owner liveness.*host or boot identity differs/,
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
