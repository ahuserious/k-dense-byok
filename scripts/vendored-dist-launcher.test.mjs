import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkflowEngineBuildOutcome,
  classifyWorkflowEngineListener,
} from "./vendored-dist-environment.mjs";

const ownedPids = new Set([101, 102]);
const fakeListenerOwner = (pid) => ownedPids.has(pid);

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
