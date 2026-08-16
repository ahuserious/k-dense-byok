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
} from "./preview-environment.mjs";
import {
  acquirePreviewLifecycleLock,
  previewTeardownRecord,
  publishPreviewStateFile,
  removePreviewStateFile,
} from "./preview-state.mjs";

function createProjectionFixture(temporaryRoot, generation) {
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
  return { repositoryRoot, stateRoot, launchRoot, ports };
}

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
        `acquirePreviewLifecycleLock(${JSON.stringify(lockFile)}, { operation: "preview-up", generation: "killed-generation", pidStartIdentity: "test-child-start" });\n` +
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
      pidStartIdentity: "test-parent-start",
      resolvePidStartIdentity: (pid) => {
        try {
          process.kill(pid, 0);
          return "unexpected-live-owner";
        } catch (error) {
          if (error?.code === "ESRCH") return null;
          throw error;
        }
      },
      log: (message) => messages.push(message),
    });
    assert.match(
      messages.join("\n"),
      /Recovered stale lifecycle lock \(pid \d+, started test-child-start\)/,
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
    const identities = new Map([[501, "old-start"], [502, "new-command-start"]]);
    const resolvePidStartIdentity = (pid) => identities.get(pid) ?? null;
    fs.writeFileSync(stateFile, '{"generation":"owned-generation"}\n');
    acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "owned-generation",
      pid: 501,
      resolvePidStartIdentity,
    });
    identities.set(501, "reused-start");
    const messages = [];
    const recovered = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-down",
      generation: "owned-generation",
      pid: 502,
      resolvePidStartIdentity,
      generationFiles: [stateFile],
      log: (message) => messages.push(message),
    });
    assert.match(messages.join("\n"), /pid 501, started old-start/);
    recovered.release();

    fs.writeFileSync(stateFile, '{"generation":"different-generation"}\n');
    identities.set(501, "second-old-start");
    acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "owned-generation",
      pid: 501,
      resolvePidStartIdentity,
    });
    identities.set(501, "second-reused-start");
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

test("recovers a dead version-one lock left by the previous launcher", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-preview-lock-v1-"));
  try {
    const lockFile = path.join(temporaryRoot, ".lifecycle.lock");
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({
        version: 1,
        operation: "preview-up",
        generation: "legacy-generation",
        pid: 601,
        acquiredAt: "2026-08-16T00:00:00.000Z",
      })}\n`,
    );
    const messages = [];
    const recovered = acquirePreviewLifecycleLock(lockFile, {
      operation: "preview-up",
      generation: "new-generation",
      pid: 602,
      pidStartIdentity: "new-start",
      resolvePidStartIdentity: () => null,
      log: (message) => messages.push(message),
    });
    assert.match(messages.join("\n"), /started unknown legacy identity/);
    recovered.release();
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
