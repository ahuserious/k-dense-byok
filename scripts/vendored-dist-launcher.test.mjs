import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyWorkflowEngineBuildOutcome,
  classifyWorkflowEngineListener,
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
