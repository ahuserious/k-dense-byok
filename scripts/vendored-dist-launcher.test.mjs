import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyWorkflowEngineBuildOutcome,
  classifyWorkflowEngineListener,
  workflowEngineConsumerEnvironment,
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
  const environment = workflowEngineConsumerEnvironment(
    {
      KADY_PIPELINE_ENGINE_PORT: "3091",
      PIPELINE_ENGINE_BASE_URL: "http://127.0.0.1:3091",
      NEXT_PUBLIC_PIPELINE_ENGINE_URL: "http://127.0.0.1:3091",
    },
    13191,
    { overrideExisting: true },
  );
  assert.equal(environment.KADY_PIPELINE_ENGINE_PORT, "13191");
  assert.equal(environment.PIPELINE_ENGINE_BASE_URL, "http://127.0.0.1:13191");
  assert.equal(environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL, "http://127.0.0.1:13191");
  assert.equal(environment.KADY_PIPELINE_ENGINE_DISABLED, "0");
});

test("resolved environment port fills missing consumers without replacing an explicit browser origin", () => {
  const environment = workflowEngineConsumerEnvironment(
    { NEXT_PUBLIC_PIPELINE_ENGINE_URL: "https://preview.example.test" },
    13191,
  );
  assert.equal(environment.KADY_PIPELINE_ENGINE_PORT, "13191");
  assert.equal(environment.PIPELINE_ENGINE_BASE_URL, "http://127.0.0.1:13191");
  assert.equal(environment.NEXT_PUBLIC_PIPELINE_ENGINE_URL, "https://preview.example.test");
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

      const configured = workflowEngineConsumerEnvironment(
        {
          KADY_PIPELINE_ENGINE_PORT: String(foreignPort),
          PIPELINE_ENGINE_BASE_URL: `http://127.0.0.1:${foreignPort}`,
          NEXT_PUBLIC_PIPELINE_ENGINE_URL: `http://127.0.0.1:${foreignPort}`,
        },
        alternatePort,
        { overrideExisting: true },
      );
      assert.equal(configured.PIPELINE_ENGINE_BASE_URL, `http://127.0.0.1:${alternatePort}`);
      assert.equal(configured.NEXT_PUBLIC_PIPELINE_ENGINE_URL, `http://127.0.0.1:${alternatePort}`);

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
      assert.equal(launcher.code, 0, `${launcher.stdout}\n${launcher.stderr}`);
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
