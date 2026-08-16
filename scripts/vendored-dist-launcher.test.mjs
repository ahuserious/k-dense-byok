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
import { writeVendoredDistManifest, writeVendoredInstallStamp } from "./vendored-dist-check.mjs";
import {
  classifyWorkflowEngineBuildOutcome,
  classifyWorkflowEngineListener,
  previewVendoredDistFingerprintEnvironment,
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
  assert.fail(`owned process groups survived cleanup: ${[...new Set(pids)].join(", ")}`);
}

function writeFixtureFile(root, relativePath, content = "") {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function prepareHermeticLauncherCheckout(stateRoot, environment, ports) {
  const checkoutRoot = path.join(stateRoot, "checkout");
  const vendoredRoot = path.join("server", "vendor", "pipeline-engine");
  const webRoot = path.join(vendoredRoot, "packages", "web");
  writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "package.json"), "{}\n");
  writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "bun.lock"), "lockfileVersion = 1\n");
  writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "bunfig.toml"), "[test]\nroot = './packages'\n");
  writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "tsconfig.json"), "{}\n");
  for (const packageName of ["core", "workflows"]) {
    writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "packages", packageName, "package.json"), "{}\n");
    writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "packages", packageName, "tsconfig.json"), "{}\n");
    writeFixtureFile(checkoutRoot, path.join(vendoredRoot, "packages", packageName, "src", "index.ts"), "export {};\n");
  }
  writeFixtureFile(checkoutRoot, path.join(webRoot, "package.json"), "{}\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "tsconfig.json"), "{}\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "vite.config.ts"), "export default {};\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "src", "main.tsx"), "export {};\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "public", "logo.svg"), "<svg/>\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "index.html"), "<div id='root'></div>\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "dist", "index.html"), "<script src='/assets/app.js'></script>\n");
  writeFixtureFile(checkoutRoot, path.join(webRoot, "dist", "assets", "app.js"), "console.log('fixture');\n");
  fs.mkdirSync(path.join(checkoutRoot, vendoredRoot, "node_modules"), { recursive: true });
  writeFixtureFile(checkoutRoot, path.join("server", "node_modules", "tsx", "dist", "cli.mjs"), "process.exit(0);\n");
  writeFixtureFile(checkoutRoot, path.join("web", "node_modules", "next", "dist", "bin", "next"), "process.exit(0);\n");
  const buildEnvironment = previewVendoredDistFingerprintEnvironment(environment, ports.engine);
  writeVendoredInstallStamp(checkoutRoot, buildEnvironment);
  writeVendoredDistManifest(checkoutRoot, buildEnvironment);
  return checkoutRoot;
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
    const observedPids = new Set();
    try {
      ports = {
        backend: await reserveLocalPort(),
        frontend: await reserveLocalPort(),
        engine: await reserveLocalPort(),
      };
      const fakeNpm = path.join(stateRoot, "fake-npm");
      const fakeGit = path.join(stateRoot, "fake-git");
      fs.writeFileSync(fakeNpm, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
      fs.writeFileSync(fakeGit, `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("git version 2.0.0");
else if (args === "rev-parse HEAD") console.log("${"a".repeat(40)}");
else process.exit(2);
`, { mode: 0o700 });
      const { launchRoot, shimDirectory } = createLaunchOverlay(
        repositoryRoot,
        stateRoot,
        fakeNpm,
        fakeGit,
      );
      const fakeBun = path.join(shimDirectory, "bun");
      fs.writeFileSync(
        fakeBun,
        `#!${process.execPath}
import http from "node:http";
if (process.argv.includes("--version")) { console.log("1.3.8"); process.exit(0); }
const server = http.createServer((_request, response) => { response.statusCode = 503; response.end("not ready"); });
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
        { mode: 0o700 },
      );
      fs.writeFileSync(path.join(shimDirectory, "uv"), `#!${process.execPath}\nconsole.log("uv 0.8.0");\n`, { mode: 0o700 });
      serviceStatePath = path.join(stateRoot, "services.json");
      fs.writeFileSync(serviceStatePath, '{"version":1,"services":{}}\n');
      const environment = previewEnvironment(stateRoot, launchRoot, shimDirectory, ports);
      const fixtureRoot = prepareHermeticLauncherCheckout(stateRoot, environment, ports);
      fs.rmSync(path.join(launchRoot, "server"), { force: true });
      fs.rmSync(path.join(launchRoot, "web"), { force: true });
      fs.symlinkSync(path.join(fixtureRoot, "server"), path.join(launchRoot, "server"), "dir");
      fs.symlinkSync(path.join(fixtureRoot, "web"), path.join(launchRoot, "web"), "dir");
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
      const startupStartedAt = Date.now();
      const deadline = startupStartedAt + 45_000;
      let state;
      while (Date.now() < deadline) {
        state = JSON.parse(fs.readFileSync(serviceStatePath, "utf-8"));
        for (const service of Object.values(state.services ?? {})) {
          if (Number.isSafeInteger(service?.pid)) observedPids.add(service.pid);
        }
        if (state.services?.["pipeline-engine"]?.state === "spawned") break;
        if (launcher.exitCode !== null) {
          assert.fail(
            `launcher exited before engine readiness after ${Date.now() - startupStartedAt}ms\n${output}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      enginePid = state?.services?.["pipeline-engine"]?.pid;
      assert.ok(
        Number.isSafeInteger(enginePid),
        `engine spawn was not observed after ${Date.now() - startupStartedAt}ms\n${output}`,
      );
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
      for (const pid of recordedServicePids(serviceStatePath)) observedPids.add(pid);
      if (Number.isSafeInteger(enginePid)) observedPids.add(enginePid);
      await reapProcessGroups([...observedPids]);
      await assertLocalPortClosed(ports?.engine, "workflow engine port leaked during test cleanup");
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  },
);

test(
  "second launcher signal force-reaps an IPC-stuck backend and detached workflow supervisor",
  {
    skip: process.env.KADY_SOCKET_TESTS === "1" && process.platform !== "win32"
      ? false
      : "requires Unix process groups and local socket binding; orchestrator runs with KADY_SOCKET_TESTS=1",
  },
  async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-launcher-force-"));
    const serviceStatePath = path.join(stateRoot, "services.json");
    const shutdownReceiptPath = path.join(stateRoot, "backend-received-shutdown");
    const supervisorPidPath = path.join(stateRoot, "supervisor.pid");
    const observedPids = new Set();
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
      fs.writeFileSync(fakeGit, `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("git version 2.0.0");
else if (args === "rev-parse HEAD") console.log("${"b".repeat(40)}");
else process.exit(2);
`, { mode: 0o700 });
      const { launchRoot, shimDirectory } = createLaunchOverlay(
        repositoryRoot,
        stateRoot,
        fakeNpm,
        fakeGit,
      );
      fs.writeFileSync(
        path.join(shimDirectory, "bun"),
        `#!${process.execPath}
import http from "node:http";
if (process.argv.includes("--version")) { console.log("1.3.8"); process.exit(0); }
const server = http.createServer((_request, response) => response.end("healthy"));
process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
        { mode: 0o700 },
      );
      fs.writeFileSync(path.join(shimDirectory, "uv"), `#!${process.execPath}\nconsole.log("uv 0.8.0");\n`, { mode: 0o700 });

      const environment = previewEnvironment(stateRoot, launchRoot, shimDirectory, ports, {
        PATH: process.env.PATH,
        OLLAMA_BASE_URL: "http://127.0.0.1:9",
      });
      const checkoutRoot = prepareHermeticLauncherCheckout(stateRoot, environment, ports);
      const fakeServerRoot = path.join(checkoutRoot, "server");
      const fakeWebRoot = path.join(checkoutRoot, "web");
      const fakeBackend = path.join(fakeServerRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const fakeFrontend = path.join(fakeWebRoot, "node_modules", "next", "dist", "bin", "next");
      fs.mkdirSync(path.dirname(fakeBackend), { recursive: true });
      fs.mkdirSync(path.dirname(fakeFrontend), { recursive: true });
      fs.writeFileSync(
        fakeBackend,
        `import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
const supervisor = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)"], {
  detached: true,
  stdio: "ignore",
});
supervisor.unref();
fs.writeFileSync(${JSON.stringify(supervisorPidPath)}, String(supervisor.pid));
process.send?.({ type: "kady-supervisor", pid: supervisor.pid });
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

      const startupStartedAt = Date.now();
      const startupDeadline = startupStartedAt + 45_000;
      let state;
      while (Date.now() < startupDeadline) {
        state = JSON.parse(fs.readFileSync(serviceStatePath, "utf-8"));
        for (const service of Object.values(state.services ?? {})) {
          if (Number.isSafeInteger(service?.pid)) observedPids.add(service.pid);
        }
        if (state.services?.backend?.state === "spawned" &&
            state.services?.frontend?.state === "spawned" &&
            state.services?.["pipeline-engine"]?.state === "spawned" &&
            state.services?.["workflow-supervisor"]?.state === "spawned") break;
        if (launcher.exitCode !== null) {
          assert.fail(
            `launcher exited before fake services started after ${Date.now() - startupStartedAt}ms\n${output}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const backendPid = state?.services?.backend?.pid;
      const frontendPid = state?.services?.frontend?.pid;
      const enginePid = state?.services?.["pipeline-engine"]?.pid;
      const supervisorPid = state?.services?.["workflow-supervisor"]?.pid;
      const startupFailureDetails =
        `launcher services incomplete after ${Date.now() - startupStartedAt}ms\n${output}`;
      assert.ok(Number.isSafeInteger(backendPid), startupFailureDetails);
      assert.ok(Number.isSafeInteger(frontendPid), startupFailureDetails);
      assert.ok(Number.isSafeInteger(enginePid), startupFailureDetails);
      assert.ok(Number.isSafeInteger(supervisorPid), startupFailureDetails);
      assert.equal(supervisorPid, Number(fs.readFileSync(supervisorPidPath, "utf-8")), output);
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
      assert.throws(() => process.kill(-enginePid, 0), (error) => error?.code === "ESRCH");
      assert.throws(() => process.kill(supervisorPid, 0), (error) => error?.code === "ESRCH");
      await assertLocalPortClosed(ports.backend, "backend listener survived forced shutdown");
      await assertLocalPortClosed(ports.frontend, "frontend listener survived forced shutdown");
    } finally {
      if (launcher?.exitCode === null) {
        try { process.kill(-launcher.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await waitForChildExit(launcher);
      for (const pid of recordedServicePids(serviceStatePath)) observedPids.add(pid);
      if (fs.existsSync(supervisorPidPath)) observedPids.add(Number(fs.readFileSync(supervisorPidPath, "utf-8")));
      await reapProcessGroups([...observedPids].filter(Number.isSafeInteger));
      await assertLocalPortClosed(ports?.backend, "backend listener leaked during test cleanup");
      await assertLocalPortClosed(ports?.frontend, "frontend listener leaked during test cleanup");
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  },
);
