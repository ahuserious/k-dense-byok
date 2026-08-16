import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "../env-file.mjs";
import { createLaunchOverlay, previewEnvironment } from "./preview-environment.mjs";
import {
  classifyWorkflowEngineBuildOutcome,
  classifyWorkflowEngineListener,
  resolveWorkflowEnginePort,
  terminateOwnedProcessTree,
  waitForOwnedWorkflowEngine,
  workflowEngineConsumerEnvironment,
  workflowEnginePrerequisiteStatus,
  workflowEngineRuntimeOwnership,
} from "./vendored-dist-environment.mjs";

const ownedPids = new Set([101, 102]);
const fakeListenerOwner = (pid) => ownedPids.has(pid);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function reserveLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function recordedServicePids(serviceStatePath) {
  try {
    const state = JSON.parse(fs.readFileSync(serviceStatePath, "utf-8"));
    return Object.values(state.services ?? {})
      .map((service) => service?.pid)
      .filter((pid) => Number.isSafeInteger(pid));
  } catch {
    return [];
  }
}

async function reapProcessGroups(pids) {
  for (const pid of new Set(pids)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const livePid = [...new Set(pids)].find((pid) => {
      try { process.kill(-pid, 0); return true; } catch { return false; }
    });
    if (livePid === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForChildExit(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function assertLocalPortClosed(port, message) {
  if (!Number.isSafeInteger(port)) return;
  const closed = await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  });
  assert.equal(closed, true, message);
}

async function waitForLocalPortOpen(port, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${description} did not open port ${port}`);
}

test("workflow engine listener and build decision matrix", () => {
  const listenerCases = [
    {
      name: "reuse-owned-fresh",
      input: { listenerPids: [101], healthOk: true, distStatus: { ok: true } },
      action: "reuse-owned-fresh",
    },
    {
      name: "reuse-owned-stale-restart",
      input: { listenerPids: [101], healthOk: true, distStatus: { ok: false, status: "stale-inputs" } },
      action: "restart-owned",
    },
    {
      name: "foreign-listener-skip",
      input: { listenerPids: [999], healthOk: true, distStatus: { ok: true } },
      action: "skip-foreign",
    },
    {
      name: "missing-dist-restart",
      input: { listenerPids: [101], healthOk: false, distStatus: { ok: false, status: "missing-manifest" } },
      action: "restart-owned",
    },
    {
      name: "invalid-dist-restart",
      input: { listenerPids: [101], healthOk: false, distStatus: { ok: false, status: "invalid-output" } },
      action: "restart-owned",
    },
  ];

  for (const testCase of listenerCases) {
    const decision = classifyWorkflowEngineListener({
      ...testCase.input,
      isOwnedByCheckout: fakeListenerOwner,
    });
    assert.equal(decision.action, testCase.action, testCase.name);
  }

  const fakeBun = (exitCode) => exitCode;
  assert.equal(
    classifyWorkflowEngineBuildOutcome(fakeBun(0), { ok: true, status: "fresh" }),
    "start",
    "stale-rebuild-ok",
  );
  assert.equal(
    classifyWorkflowEngineBuildOutcome(fakeBun(1), { ok: false, status: "stale-inputs" }),
    "warn-continue",
    "stale-rebuild-fail-warn-continue",
  );
  assert.equal(
    classifyWorkflowEngineBuildOutcome(fakeBun(1), { ok: false, status: "invalid-output" }),
    "skip-engine",
    "invalid-rebuild-fail-skip",
  );
});

test("resolved engine port propagates to backend and browser consumer variables", () => {
  const environment = workflowEngineConsumerEnvironment({ KADY_PIPELINE_ENGINE_PORT: "3091" }, 13191);
  assert.equal(environment.KADY_PIPELINE_ENGINE_PORT, "13191");
  assert.equal(environment.KADY_ARCHON_PORT, "13191");
  assert.equal(environment.PIPELINE_ENGINE_BASE_URL, "http://127.0.0.1:13191");
  assert.equal(environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL, "http://127.0.0.1:13191");
  assert.equal(environment.KADY_PIPELINE_ENGINE_DISABLED, "0");
});

test("managed engine rejects conflicting explicit consumer origins", () => {
  assert.throws(
    () => workflowEngineConsumerEnvironment(
      { NEXT_PUBLIC_PIPELINE_ENGINE_URL: "https://preview.example.test" },
      13191,
    ),
    /conflicts with explicit NEXT_PUBLIC_PIPELINE_ENGINE_URL.*--external-engine mode is not implemented/,
  );
});

test("workflow engine readiness aborts without waiting for its timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await waitForOwnedWorkflowEngine({
    childPid: 101,
    childExited: () => false,
    listenersOn: () => [],
    isOwnedByChild: () => false,
    probeHealth: async () => false,
    wait: async () => assert.fail("aborted readiness must not sleep"),
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  assert.deepEqual(result, { status: "aborted" });
});

test("owned process-tree termination escalates and verifies disappearance", async () => {
  let alive = true;
  const signals = [];
  let clock = 0;
  await terminateOwnedProcessTree({
    treeGone: () => !alive,
    terminate: () => signals.push("TERM"),
    forceTerminate: () => {
      signals.push("KILL");
      alive = false;
    },
    wait: async (milliseconds) => { clock += milliseconds; },
    description: "test process tree",
    gracefulWaitMs: 10,
    forcedWaitMs: 10,
    pollMs: 5,
    now: () => clock,
  });
  assert.deepEqual(signals, ["TERM", "KILL"]);
});

test("engine port is resolved after modern or legacy values are loaded solely from .env", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-engine-port-env-"));
  const envPath = path.join(fixtureRoot, ".env");
  const previousModern = process.env.KADY_PIPELINE_ENGINE_PORT;
  const previousLegacy = process.env.KADY_ARCHON_PORT;
  const previousBackendOrigin = process.env.PIPELINE_ENGINE_BASE_URL;
  const previousBrowserOrigin = process.env.NEXT_PUBLIC_PIPELINE_ENGINE_URL;
  try {
    delete process.env.KADY_PIPELINE_ENGINE_PORT;
    delete process.env.KADY_ARCHON_PORT;
    fs.writeFileSync(envPath, "KADY_PIPELINE_ENGINE_PORT=13191\n");
    assert.equal(applyEnvFile(envPath, { override: true }), true);
    assert.equal(resolveWorkflowEnginePort(process.env), 13191);

    delete process.env.KADY_PIPELINE_ENGINE_PORT;
    fs.writeFileSync(envPath, "KADY_ARCHON_PORT=13192\n");
    assert.equal(applyEnvFile(envPath, { override: true }), true);
    assert.equal(resolveWorkflowEnginePort(process.env), 13192);
    assert.equal(resolveWorkflowEnginePort(process.env, 13193), 13193);

    delete process.env.KADY_ARCHON_PORT;
    fs.writeFileSync(
      envPath,
      "KADY_PIPELINE_ENGINE_PORT=13194\nPIPELINE_ENGINE_BASE_URL=https://external.example.test\n",
    );
    assert.equal(applyEnvFile(envPath, { override: true }), true);
    assert.throws(
      () => workflowEngineConsumerEnvironment(process.env, resolveWorkflowEnginePort(process.env)),
      /conflicts with explicit PIPELINE_ENGINE_BASE_URL/,
    );
  } finally {
    if (previousModern === undefined) delete process.env.KADY_PIPELINE_ENGINE_PORT;
    else process.env.KADY_PIPELINE_ENGINE_PORT = previousModern;
    if (previousLegacy === undefined) delete process.env.KADY_ARCHON_PORT;
    else process.env.KADY_ARCHON_PORT = previousLegacy;
    if (previousBackendOrigin === undefined) delete process.env.PIPELINE_ENGINE_BASE_URL;
    else process.env.PIPELINE_ENGINE_BASE_URL = previousBackendOrigin;
    if (previousBrowserOrigin === undefined) delete process.env.NEXT_PUBLIC_PIPELINE_ENGINE_URL;
    else process.env.NEXT_PUBLIC_PIPELINE_ENGINE_URL = previousBrowserOrigin;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("full-start prerequisite decision disables the engine when Bun is missing", () => {
  assert.deepEqual(
    workflowEnginePrerequisiteStatus({ sourcesPresent: true, bunPath: null }),
    { available: false, reason: "missing-bun" },
  );
});

test("disabled pipeline client rejects before fetch even when HTTP_PROXY is set", async () => {
  const previous = {
    disabled: process.env.KADY_PIPELINE_ENGINE_DISABLED,
    proxy: process.env.HTTP_PROXY,
    noProxy: process.env.NO_PROXY,
    fetch: globalThis.fetch,
  };
  let fetchCalls = 0;
  try {
    process.env.KADY_PIPELINE_ENGINE_DISABLED = "1";
    process.env.HTTP_PROXY = "http://proxy.invalid:8080";
    delete process.env.NO_PROXY;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    };
    const client = await import(
      `../server/src/agent/pipeline-engine/client.ts?disabled-test=${Date.now()}`
    );
    await assert.rejects(
      client.listWorkflows(),
      (error) => error instanceof client.PipelineEngineUnavailableError && /disabled by the launcher/.test(error.message),
    );
    assert.equal(fetchCalls, 0);
  } finally {
    if (previous.disabled === undefined) delete process.env.KADY_PIPELINE_ENGINE_DISABLED;
    else process.env.KADY_PIPELINE_ENGINE_DISABLED = previous.disabled;
    if (previous.proxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previous.proxy;
    if (previous.noProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous.noProxy;
    globalThis.fetch = previous.fetch;
  }
});

test(
  "launcher refuses a foreign engine listener before issuing any HTTP request",
  { skip: process.env.KADY_SOCKET_TESTS === "1" ? false : "requires local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1" },
  async () => {
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-foreign-listener-"));
    const listenerSource = `
      import http from "node:http";
      let requests = 0;
      const server = http.createServer((_request, response) => { requests += 1; response.end("ok"); });
      server.listen(0, "127.0.0.1", () => process.send({ type: "listening", port: server.address().port }));
      process.on("message", (message) => {
        if (message === "count") process.send({ type: "count", requests });
        if (message === "stop") server.close(() => process.exit(0));
      });
    `;
    const foreign = spawn(process.execPath, ["--input-type=module", "-e", listenerSource], {
      cwd: foreignRoot,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    try {
      const port = await new Promise((resolve, reject) => {
        foreign.once("error", reject);
        foreign.on("message", (message) => {
          if (message?.type === "listening") resolve(message.port);
        });
      });
      const launcher = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(repositoryRoot, "start.mjs"), "--check", "--engine-port", String(port)], {
          cwd: repositoryRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });
      assert.notEqual(launcher.code, 0, `${launcher.stdout}\n${launcher.stderr}`);
      assert.match(launcher.stderr, new RegExp(`Port ${port} is held by a process not owned by this checkout`));
      const requests = await new Promise((resolve) => {
        foreign.on("message", (message) => {
          if (message?.type === "count") resolve(message.requests);
        });
        foreign.send("count");
      });
      assert.equal(requests, 0);
    } finally {
      if (foreign.connected) foreign.send("stop");
      await new Promise((resolve) => foreign.once("exit", resolve));
      fs.rmSync(foreignRoot, { recursive: true, force: true });
    }
  },
);

test(
  "--engine-port keeps consumers off a foreign configured default port",
  { skip: process.env.KADY_SOCKET_TESTS === "1" ? false : "requires local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1" },
  async () => {
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-foreign-default-"));
    const listenerSource = `
      import http from "node:http";
      let requests = 0;
      const server = http.createServer((_request, response) => { requests += 1; response.end("foreign"); });
      server.listen(0, "127.0.0.1", () => process.send({ type: "listening", port: server.address().port }));
      process.on("message", (message) => {
        if (message === "count") process.send({ type: "count", requests });
        if (message === "stop") server.close(() => process.exit(0));
      });
    `;
    const foreign = spawn(process.execPath, ["--input-type=module", "-e", listenerSource], {
      cwd: foreignRoot,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    try {
      const foreignPort = await new Promise((resolve, reject) => {
        foreign.once("error", reject);
        foreign.on("message", (message) => {
          if (message?.type === "listening") resolve(message.port);
        });
      });
      const reservation = net.createServer();
      await new Promise((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const alternatePort = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));

      assert.throws(
        () => workflowEngineConsumerEnvironment(
          {
            KADY_PIPELINE_ENGINE_PORT: String(foreignPort),
            PIPELINE_ENGINE_BASE_URL: `http://127.0.0.1:${foreignPort}`,
            NEXT_PUBLIC_PIPELINE_ENGINE_URL: `http://127.0.0.1:${foreignPort}`,
          },
          alternatePort,
        ),
        /conflicts with explicit/,
      );

      const launcher = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(repositoryRoot, "start.mjs"), "--check", "--engine-port", String(alternatePort)],
          {
            cwd: repositoryRoot,
            env: {
              ...process.env,
              KADY_PIPELINE_ENGINE_PORT: String(foreignPort),
              PIPELINE_ENGINE_BASE_URL: `http://127.0.0.1:${foreignPort}`,
              NEXT_PUBLIC_PIPELINE_ENGINE_URL: `http://127.0.0.1:${foreignPort}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });
      assert.notEqual(launcher.code, 0, `${launcher.stdout}\n${launcher.stderr}`);
      assert.match(launcher.stderr, /conflicts with explicit/);
      const requests = await new Promise((resolve) => {
        foreign.on("message", (message) => {
          if (message?.type === "count") resolve(message.requests);
        });
        foreign.send("count");
      });
      assert.equal(requests, 0);
    } finally {
      if (foreign.connected) foreign.send("stop");
      await new Promise((resolve) => foreign.once("exit", resolve));
      fs.rmSync(foreignRoot, { recursive: true, force: true });
    }
  },
);

test(
  "workflow engine readiness rejects a bind-race before probing foreign HTTP",
  { skip: process.env.KADY_SOCKET_TESTS === "1" ? false : "requires local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1" },
  async () => {
    const foreign = net.createServer();
    await new Promise((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(0, "127.0.0.1", resolve);
    });
    let probes = 0;
    try {
      const result = await waitForOwnedWorkflowEngine({
        childPid: 101,
        childExited: () => false,
        listenersOn: () => [999],
        isOwnedByChild: () => false,
        probeHealth: async () => {
          probes += 1;
          return true;
        },
        wait: async () => {},
        timeoutMs: 100,
      });
      assert.deepEqual(result, { status: "foreign-listener", foreignPid: 999 });
      assert.equal(probes, 0);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  },
);

test(
  "post-exit foreign takeover is classified for launcher termination without requests",
  { skip: process.env.KADY_SOCKET_TESTS === "1" ? false : "requires local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1" },
  async () => {
    let requests = 0;
    const foreign = net.createServer((socket) => {
      requests += 1;
      socket.end();
    });
    await new Promise((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(0, "127.0.0.1", resolve);
    });
    try {
      const ownership = workflowEngineRuntimeOwnership({
        listenerPids: [999],
        childPid: 101,
        ownerPids: [101],
        isOwnedByChild: () => false,
        isOwnedByCheckout: () => false,
      });
      assert.deepEqual(ownership, { status: "foreign", foreignPid: 999 });
      assert.equal(requests, 0);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  },
);

test(
  "signal during delayed engine readiness leaves no detached descendant or listener",
  {
    skip: process.env.KADY_SOCKET_TESTS === "1" && process.platform !== "win32"
      ? false
      : "requires Unix process groups and local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1",
  },
  async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-launcher-signal-"));
    let ports;
    let launcher;
    let serviceStatePath;
    let enginePid;
    try {
      ports = {
        backend: await reserveLocalPort(),
        frontend: await reserveLocalPort(),
        engine: await reserveLocalPort(),
      };
      // Integration-only setup: readiness needs a real manifest whose build
      // environment names this reserved engine port. The entire test is gated
      // by KADY_SOCKET_TESTS=1, and the real staged build is inside cleanup.
      const build = spawnSync("npm", ["run", "build:vendored-dist"], {
        cwd: repositoryRoot,
        env: { ...process.env, NODE_ENV: "production", PORT: String(ports.engine) },
        encoding: "utf-8",
      });
      assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

      const fakeNpm = path.join(stateRoot, "fake-npm");
      fs.writeFileSync(fakeNpm, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
      const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
      const { launchRoot, shimDirectory } = createLaunchOverlay(
        repositoryRoot,
        stateRoot,
        fakeNpm,
        gitPath,
      );
      // This exercises normal launcher dependency flow with a no-op npm, while
      // retaining the overlay's byte-derived launcher instrumentation.
      fs.copyFileSync(fakeNpm, path.join(shimDirectory, "npm"));
      const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf-8" }).stdout.trim();
      const fakeBun = path.join(shimDirectory, "bun");
      fs.writeFileSync(
        fakeBun,
        `#!${process.execPath}
import http from "node:http";
if (process.argv.includes("--version")) { console.log(${JSON.stringify(bunVersion)}); process.exit(0); }
const server = http.createServer((_request, response) => { response.statusCode = 503; response.end("not ready"); });
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
        { mode: 0o700 },
      );
      serviceStatePath = path.join(stateRoot, "services.json");
      fs.writeFileSync(serviceStatePath, '{"version":1,"services":{}}\n');
      const environment = previewEnvironment(stateRoot, launchRoot, shimDirectory, ports);
      delete environment.KADY_PREVIEW;
      environment.NODE_ENV = "production";
      launcher = spawn(
        process.execPath,
        [path.join(launchRoot, "start.mjs"), "--no-browser"],
        {
          cwd: launchRoot,
          detached: true,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      launcher.stdout.on("data", (chunk) => { output += chunk; });
      launcher.stderr.on("data", (chunk) => { output += chunk; });
      const deadline = Date.now() + 20_000;
      let state;
      while (Date.now() < deadline) {
        state = JSON.parse(fs.readFileSync(serviceStatePath, "utf-8"));
        if (state.services?.["pipeline-engine"]?.state === "spawned") break;
        if (launcher.exitCode !== null) assert.fail(`launcher exited before engine readiness\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      enginePid = state?.services?.["pipeline-engine"]?.pid;
      assert.ok(Number.isSafeInteger(enginePid), `engine spawn was not observed\n${output}`);
      const launcherExit = new Promise((resolve) => launcher.once("exit", resolve));
      launcher.kill("SIGTERM");
      const exitCode = await Promise.race([
        launcherExit,
        new Promise((_, reject) => setTimeout(() => reject(new Error("launcher shutdown timed out")), 10_000)),
      ]);
      assert.equal(exitCode, 0, output);
      const finalState = JSON.parse(fs.readFileSync(serviceStatePath, "utf-8"));
      assert.equal(finalState.services["pipeline-engine"].state, "exited", output);
      assert.equal("backend" in finalState.services, false, output);
      assert.equal("frontend" in finalState.services, false, output);
      assert.doesNotMatch(output, /Backend on port|Frontend on port/);
      assert.throws(() => process.kill(-enginePid, 0), (error) => error?.code === "ESRCH");
      await assertLocalPortClosed(ports.engine, "workflow engine port remained open after shutdown");
    } finally {
      if (launcher?.exitCode === null) {
        try { process.kill(-launcher.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await waitForChildExit(launcher);
      await reapProcessGroups([
        ...recordedServicePids(serviceStatePath),
        ...(Number.isSafeInteger(enginePid) ? [enginePid] : []),
      ]);
      await assertLocalPortClosed(ports?.engine, "workflow engine port leaked during test cleanup");
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  },
);

test(
  "second launcher signal force-reaps an IPC-stuck backend process group",
  {
    skip: process.env.KADY_SOCKET_TESTS === "1" && process.platform !== "win32"
      ? false
      : "requires Unix process groups and local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1",
  },
  async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-launcher-force-"));
    const serviceStatePath = path.join(stateRoot, "services.json");
    const shutdownReceiptPath = path.join(stateRoot, "backend-received-shutdown");
    let launcher;
    let ports;
    try {
      ports = {
        backend: await reserveLocalPort(),
        frontend: await reserveLocalPort(),
        engine: await reserveLocalPort(),
      };
      const fakeNpm = path.join(stateRoot, "fake-npm");
      const fakeGit = path.join(stateRoot, "fake-git");
      fs.writeFileSync(fakeNpm, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
      fs.writeFileSync(fakeGit, `#!${process.execPath}\nconsole.log("git version 2.0.0");\n`, { mode: 0o700 });
      const { launchRoot, shimDirectory } = createLaunchOverlay(
        repositoryRoot,
        stateRoot,
        fakeNpm,
        fakeGit,
      );
      fs.writeFileSync(
        path.join(shimDirectory, "bun"),
        `#!${process.execPath}\nif (process.argv.includes("--version")) console.log("1.2.0");\n`,
        { mode: 0o700 },
      );

      const fakeServerRoot = path.join(stateRoot, "fake-server");
      const fakeWebRoot = path.join(stateRoot, "fake-web");
      const fakeBackend = path.join(fakeServerRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const fakeFrontend = path.join(fakeWebRoot, "node_modules", "next", "dist", "bin", "next");
      fs.mkdirSync(path.dirname(fakeBackend), { recursive: true });
      fs.mkdirSync(path.dirname(fakeFrontend), { recursive: true });
      fs.writeFileSync(
        fakeBackend,
        `import fs from "node:fs";
import http from "node:http";
const server = http.createServer((_request, response) => response.end("backend"));
process.on("message", (message) => {
  if (message?.type === "kady-shutdown") {
    fs.writeFileSync(${JSON.stringify(shutdownReceiptPath)}, "received\\n");
    process.send?.({ type: "fake-shutdown-received" });
  }
});
server.listen(Number(process.env.KADY_PORT), "127.0.0.1");
`,
      );
      fs.writeFileSync(
        fakeFrontend,
        `import http from "node:http";
const portIndex = process.argv.indexOf("-p");
const server = http.createServer((_request, response) => response.end("frontend"));
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
server.listen(Number(process.argv[portIndex + 1]), "127.0.0.1");
`,
      );
      fs.rmSync(path.join(launchRoot, "server"), { force: true });
      fs.rmSync(path.join(launchRoot, "web"), { force: true });
      fs.symlinkSync(fakeServerRoot, path.join(launchRoot, "server"), "dir");
      fs.symlinkSync(fakeWebRoot, path.join(launchRoot, "web"), "dir");
      fs.writeFileSync(serviceStatePath, '{"version":1,"services":{}}\n');

      const environment = previewEnvironment(stateRoot, launchRoot, shimDirectory, ports, {
        PATH: process.env.PATH,
        OLLAMA_BASE_URL: "http://127.0.0.1:9",
      });
      launcher = spawn(
        process.execPath,
        [path.join(launchRoot, "start.mjs"), "--no-browser"],
        {
          cwd: launchRoot,
          detached: true,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      launcher.stdout.on("data", (chunk) => { output += chunk; });
      launcher.stderr.on("data", (chunk) => { output += chunk; });

      const startupDeadline = Date.now() + 10_000;
      let state;
      while (Date.now() < startupDeadline) {
        state = JSON.parse(fs.readFileSync(serviceStatePath, "utf-8"));
        if (state.services?.backend?.state === "spawned" && state.services?.frontend?.state === "spawned") break;
        if (launcher.exitCode !== null) assert.fail(`launcher exited before fake services started\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const backendPid = state?.services?.backend?.pid;
      const frontendPid = state?.services?.frontend?.pid;
      assert.ok(Number.isSafeInteger(backendPid), output);
      assert.ok(Number.isSafeInteger(frontendPid), output);
      await waitForLocalPortOpen(ports.backend, "fake backend");
      await waitForLocalPortOpen(ports.frontend, "fake frontend");

      launcher.kill("SIGTERM");
      const gracefulDeadline = Date.now() + 2_000;
      while (!fs.existsSync(shutdownReceiptPath) && Date.now() < gracefulDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(fs.existsSync(shutdownReceiptPath), true, output);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(launcher.exitCode, null, "first signal must keep waiting for the stuck backend");
      assert.match(output, /Waiting for owned work to quiesce/);

      const launcherExit = new Promise((resolve) => launcher.once("exit", resolve));
      launcher.kill("SIGTERM");
      const exitCode = await Promise.race([
        launcherExit,
        new Promise((_, reject) => setTimeout(() => reject(new Error("forced launcher shutdown timed out")), 5_000)),
      ]);
      assert.equal(exitCode, 143, output);
      assert.match(output, /Forcing shutdown: \d+ owned process trees killed/);
      assert.throws(() => process.kill(-backendPid, 0), (error) => error?.code === "ESRCH");
      assert.throws(() => process.kill(-frontendPid, 0), (error) => error?.code === "ESRCH");
      await assertLocalPortClosed(ports.backend, "backend listener survived forced shutdown");
      await assertLocalPortClosed(ports.frontend, "frontend listener survived forced shutdown");
    } finally {
      if (launcher?.exitCode === null) {
        try { process.kill(-launcher.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await waitForChildExit(launcher);
      await reapProcessGroups(recordedServicePids(serviceStatePath));
      await assertLocalPortClosed(ports?.backend, "backend listener leaked during test cleanup");
      await assertLocalPortClosed(ports?.frontend, "frontend listener leaked during test cleanup");
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  },
);
