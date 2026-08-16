import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyEnvFile } from "../env-file.mjs";
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
    const environmentModuleUrl = new URL("./vendored-dist-environment.mjs", import.meta.url).href;
    const harnessSource = `
      import { spawn } from "node:child_process";
      import { terminateOwnedProcessTree, waitForOwnedWorkflowEngine } from ${JSON.stringify(environmentModuleUrl)};
      const engineSource = \`
        import http from "node:http";
        const server = http.createServer((_request, response) => response.end("not-ready"));
        process.on("SIGTERM", () => {});
        server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
      \`;
      const engine = spawn(process.execPath, ["--input-type=module", "-e", engineSource], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const port = await new Promise((resolve, reject) => {
        engine.once("error", reject);
        engine.once("message", (message) => resolve(message.port));
      });
      process.send({ type: "ready", enginePid: engine.pid, port });
      const controller = new AbortController();
      let stopping = null;
      process.on("SIGTERM", () => {
        controller.abort();
        stopping ??= terminateOwnedProcessTree({
          treeGone: () => {
            try { process.kill(-engine.pid, 0); return false; }
            catch (error) { return error?.code === "ESRCH"; }
          },
          terminate: () => process.kill(-engine.pid, "SIGTERM"),
          forceTerminate: () => process.kill(-engine.pid, "SIGKILL"),
          wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          description: \`test workflow engine tree rooted at PID \${engine.pid}\`,
          gracefulWaitMs: 100,
          forcedWaitMs: 2_000,
        }).then(() => process.exit(0), (error) => {
          console.error(error.message);
          process.exit(1);
        });
      });
      await waitForOwnedWorkflowEngine({
        childPid: engine.pid,
        childExited: () => engine.exitCode !== null || engine.signalCode !== null,
        listenersOn: () => [engine.pid],
        isOwnedByChild: () => true,
        probeHealth: async () => false,
        wait: (milliseconds) => new Promise((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        }),
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      if (stopping) await stopping;
    `;
    const harness = spawn(process.execPath, ["--input-type=module", "-e", harnessSource], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let enginePid;
    let port;
    let stderr = "";
    harness.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      const ready = await new Promise((resolve, reject) => {
        harness.once("error", reject);
        harness.once("message", resolve);
      });
      enginePid = ready.enginePid;
      port = ready.port;
      harness.kill("SIGTERM");
      const exitCode = await new Promise((resolve) => harness.once("exit", resolve));
      assert.equal(exitCode, 0, stderr);
      assert.throws(() => process.kill(-enginePid, 0), (error) => error?.code === "ESRCH");
      await assert.rejects(
        new Promise((resolve, reject) => {
          const socket = net.connect(port, "127.0.0.1");
          socket.once("connect", () => { socket.destroy(); resolve(); });
          socket.once("error", reject);
        }),
      );
    } finally {
      if (harness.exitCode === null) harness.kill("SIGKILL");
      if (enginePid) {
        try { process.kill(-enginePid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  },
);
