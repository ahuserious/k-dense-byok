import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LATERAL_PASS_BEHAVIOR } from "../src/context/lateral-pass.ts";
import { WorkflowBehaviorRegistry } from "../src/workflows/behavior-registry.ts";
import { FileCompactionWatcherOperationStore } from
  "../src/workflows/compaction-watcher-operation-store.ts";
import {
  COMPACTION_WATCHER_BEHAVIOR,
  type DurableRestartProof,
  type WatchCompactionRequest,
} from "../src/workflows/compaction-watcher.ts";
import { registerContextEngineering } from "../src/workflows/context-watcher.ts";
import type { TrustedDagFusionCompactionAudit } from
  "../pi-packages/dag-fusion-drive/compaction-audit.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function recoveryProof(runId: string): DurableRestartProof {
  return {
    runId,
    checkpointId: "verified-checkpoint",
    restartToken: "single-use-restart-token",
    verified: true,
    sideEffectSafety: "idempotent",
  };
}

function semanticWatchRequest(sandboxRoot: string): WatchCompactionRequest {
  return {
    runId: "run-entrypoint",
    childRunId: "child-entrypoint",
    sandboxRoot,
    nodeId: "analysis",
    preCompactionRecord: "Goal: deliver A. TODO: verify evidence B.",
    compactedSummary: "Goal: deliver A.",
    userPrompt: "Deliver A with verified evidence B.",
    goal: "Deliver A with verified evidence B.",
    openTodos: ["Verify evidence B"],
  };
}

function setup(audit: TrustedDagFusionCompactionAudit) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-entrypoint-"));
  roots.push(sandboxRoot);
  const registry = new WorkflowBehaviorRegistry();
  const auditCompaction = vi.fn().mockResolvedValue({
    verdict: "context-rot",
    hallucinations: [],
    missedTodos: ["Verify evidence B"],
    promptDeviations: [],
  });
  const restartWorkflow = vi.fn().mockResolvedValue({ resumed: true });
  const repairAndRedeploy = vi.fn().mockImplementation(async (request) => ({
    redeployed: true,
    workflowRevision: 12,
    recovery: recoveryProof(request.runId),
  }));
  const proposeRescue = vi.fn().mockResolvedValue({ proposalId: "proposal-entrypoint" });
  const summarizeLateralPass = vi.fn().mockResolvedValue({
    summary: "Evidence B remains open.",
    goal: "Deliver A.",
    openTodos: [],
    decisions: [],
    constraints: ["Use verified evidence"],
  });
  const openCleanWindow = vi.fn().mockResolvedValue({ sessionId: "session-clean" });
  const admit = vi.fn().mockResolvedValue(undefined);
  const registration = registerContextEngineering({
    registry,
    runner: {
      restartWorkflow,
      repairAndRedeploy,
      proposeRescue,
      operationStore: new FileCompactionWatcherOperationStore(sandboxRoot),
      readFingerprintAudit: vi.fn().mockReturnValue(audit),
    },
    sessions: { summarizeLateralPass, openCleanWindow },
    models: { auditCompaction },
    budget: { admit },
    env: {},
  });
  return {
    sandboxRoot,
    registry,
    registration,
    auditCompaction,
    restartWorkflow,
    repairAndRedeploy,
    summarizeLateralPass,
    openCleanWindow,
    admit,
  };
}

describe("registerContextEngineering production entrypoint", () => {
  it("registers and dispatches watcher plus lateral-pass with runner, session, and budget fakes", async () => {
    const harness = setup({
      occurred: true,
      checks: [
        { attempt: 1, phase: "pre", passed: true },
        { attempt: 1, phase: "post", passed: true },
      ],
    });

    expect(harness.registry.capabilities(COMPACTION_WATCHER_BEHAVIOR)).toEqual([
      "restart-workflow",
      "escalate-fix-redeploy",
    ]);
    expect(harness.registry.capabilities(LATERAL_PASS_BEHAVIOR)).toEqual(["lateral-pass"]);
    await expect(
      harness.registration.watcher.watch(semanticWatchRequest(harness.sandboxRoot)),
    ).resolves.toMatchObject({
      status: "repaired-and-restarted",
      behavior: { redeployed: true, resumed: true, workflowRevision: 12 },
    });
    await expect(harness.registry.dispatch(LATERAL_PASS_BEHAVIOR, {
      capability: "lateral-pass",
      runId: "run-lateral",
      payload: {
        sourceSessionId: "session-source",
        userPrompt: "Deliver A with verified evidence B.",
        goal: "Deliver A with verified evidence B.",
        openTodos: ["Verify evidence B"],
        transcript: [{ role: "user", content: "Deliver A." }],
      },
    })).resolves.toMatchObject({
      handled: true,
      sourceSessionId: "session-source",
      targetSessionId: "session-clean",
      compacted: false,
    });
    expect(harness.admit.mock.calls).toEqual([
      [{ kind: "compaction-audit", model: expect.any(String), runId: "run-entrypoint" }],
      [{ kind: "fix-redeploy", model: expect.any(String), runId: "run-entrypoint" }],
      [{ kind: "lateral-pass", model: expect.any(String), runId: "run-lateral" }],
    ]);
    expect(harness.restartWorkflow).toHaveBeenCalledOnce();
    expect(harness.openCleanWindow).toHaveBeenCalledOnce();
  });

  it("takes a failed fingerprint directly to repair without an audit-model budget call", async () => {
    const harness = setup({
      occurred: true,
      checks: [
        { attempt: 1, phase: "pre", passed: true },
        { attempt: 1, phase: "post", passed: false, errorCode: "POST_MISMATCH" },
      ],
    });

    await expect(
      harness.registration.watcher.watch(semanticWatchRequest(harness.sandboxRoot)),
    ).resolves.toMatchObject({ status: "repaired-and-restarted" });
    expect(harness.auditCompaction).not.toHaveBeenCalled();
    expect(harness.admit).toHaveBeenCalledOnce();
    expect(harness.admit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "fix-redeploy",
    }));
  });

  it("makes no provider, budget, runner, or session call when no compaction occurred", async () => {
    const harness = setup({ occurred: false, checks: [] });

    await expect(
      harness.registration.watcher.watch(semanticWatchRequest(harness.sandboxRoot)),
    ).resolves.toMatchObject({ status: "not-compacted" });
    expect(harness.auditCompaction).not.toHaveBeenCalled();
    expect(harness.admit).not.toHaveBeenCalled();
    expect(harness.repairAndRedeploy).not.toHaveBeenCalled();
    expect(harness.restartWorkflow).not.toHaveBeenCalled();
    expect(harness.summarizeLateralPass).not.toHaveBeenCalled();
    expect(harness.openCleanWindow).not.toHaveBeenCalled();
  });
});

describe.skip("POST-INTEGRATION(S7)", () => {
  it("boots the real server and dispatches lateral-pass through the session route", async () => {
    const { buildApp } = await import("../src/index.ts");
    const app = await buildApp({ workflowController: null });
    try {
      const created = await app.inject({ method: "POST", url: "/sessions" });
      const sessionId = created.json().id as string;
      const response = await app.inject({
        method: "POST",
        url: `/sessions/${sessionId}/lateral-pass`,
        payload: {
          userPrompt: "Carry the work into a clean window.",
          goal: "Preserve all open work.",
          openTodos: ["Verify merge wiring"],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ compacted: false });
    } finally {
      await app.close();
    }
  });
});
