import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowBehaviorRegistry } from "../src/workflows/behavior-registry.ts";
import { FileCompactionWatcherOperationStore } from
  "../src/workflows/compaction-watcher-operation-store.ts";
import {
  COMPACTION_WATCHER_BEHAVIOR,
  DEFAULT_COMPACTION_REPAIR_MODEL,
  DEFAULT_COMPACTION_WATCHER_MODEL,
  CompactionWatcherError,
  createCompactionWatcher,
  type CompactionSemanticModel,
  type DurableRestartProof,
  type WatchCompactionRequest,
} from "../src/workflows/compaction-watcher.ts";
import type { TrustedDagFusionCompactionAudit } from
  "../pi-packages/dag-fusion-drive/compaction-audit.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const cleanFingerprintAudit: TrustedDagFusionCompactionAudit = {
  occurred: true,
  checks: [
    { attempt: 1, phase: "pre", passed: true },
    { attempt: 1, phase: "post", passed: true },
  ],
};

function recoveryProof(runId: string): DurableRestartProof {
  return {
    runId,
    checkpointId: `checkpoint-${runId}`,
    restartToken: `restart-${runId}`,
    verified: true,
    sideEffectSafety: "idempotent",
  };
}

function watchRequest(): WatchCompactionRequest {
  return {
    runId: "wrun_context_rot",
    childRunId: "child-run-1",
    sandboxRoot: "/sandbox",
    nodeId: "analysis",
    preCompactionRecord: "User asked for A. Decision B was made. TODO: verify C.",
    compactedSummary: "The user asked for A and decision B was made.",
    userPrompt: "Complete A and verify C.",
    goal: "Produce A with verified C.",
    openTodos: ["Verify C"],
  };
}

function createHarness(options: {
  audit?: TrustedDagFusionCompactionAudit;
  semanticVerdict?: unknown;
  watcherModel?: string;
} = {}) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-watcher-"));
  roots.push(sandboxRoot);
  const registry = new WorkflowBehaviorRegistry();
  const semanticModel: CompactionSemanticModel = vi.fn().mockResolvedValue(
    options.semanticVerdict ?? {
      verdict: "clean",
      hallucinations: [],
      missedTodos: [],
      promptDeviations: [],
    },
  );
  const restartWorkflow = vi.fn().mockResolvedValue({ resumed: true });
  const repairAndRedeploy = vi.fn().mockImplementation(async (request) => ({
    redeployed: true,
    workflowRevision: 8,
    recovery: recoveryProof(request.runId),
  }));
  const proposeRescue = vi.fn().mockResolvedValue({
    proposalId: "proposal-1",
    detail: "Proposal recorded; no restart attempted.",
  });
  const readFingerprintAudit = vi.fn().mockReturnValue(
    options.audit ?? cleanFingerprintAudit,
  );
  const watcher = createCompactionWatcher({
    registry,
    semanticModel,
    restartWorkflow,
    repairAndRedeploy,
    proposeRescue,
    operationStore: new FileCompactionWatcherOperationStore(sandboxRoot),
    readFingerprintAudit,
    env: {},
    ...(options.watcherModel ? { watcherModel: options.watcherModel } : {}),
  });
  return {
    registry,
    watcher,
    semanticModel,
    restartWorkflow,
    repairAndRedeploy,
    proposeRescue,
    readFingerprintAudit,
  };
}

describe("compaction watcher behavior", () => {
  it("registers restart and fix-redeploy capabilities with auto-configured model slots", () => {
    const { registry, watcher } = createHarness();

    expect(registry.has(COMPACTION_WATCHER_BEHAVIOR)).toBe(true);
    expect(registry.capabilities(COMPACTION_WATCHER_BEHAVIOR)).toEqual([
      "restart-workflow",
      "escalate-fix-redeploy",
    ]);
    expect(watcher.watcherModel).toBe(DEFAULT_COMPACTION_WATCHER_MODEL);
    expect(watcher.repairModel).toBe(DEFAULT_COMPACTION_REPAIR_MODEL);
  });

  it("uses watcher authority when the upstream web origin is non-resumable", async () => {
    const { watcher, restartWorkflow, proposeRescue, semanticModel } = createHarness();
    const runId = "vendored-run-without-web-parent";
    const recovery = recoveryProof(runId);
    const resumeResponse = {
      resumable: false,
      restartRequired: true,
      restartWarning: "A new origin run could repeat side effects.",
    };

    await expect(watcher.restartStoppedWorkflow({
      runId,
      status: "stalled",
      recovery,
      resumeResponse,
    })).resolves.toMatchObject({ handled: true, resumable: true, resumed: true });
    expect(restartWorkflow).toHaveBeenCalledWith({
      runId,
      resume: true,
      originIndependent: true,
      recovery,
      resumeResponse,
      reason: "watcher-observed:stalled",
    });
    expect(proposeRescue).not.toHaveBeenCalled();
    expect(semanticModel).not.toHaveBeenCalled();
  });

  it("restarts only with exact durable recovery proof and carries the API response", async () => {
    const { watcher, restartWorkflow, proposeRescue } = createHarness();
    const runId = "recoverable-run";
    const recovery = recoveryProof(runId);
    const resumeResponse = {
      resumable: true,
      restartRequired: false,
      restartWarning: "Resume from the verified checkpoint only.",
    };

    await expect(watcher.restartStoppedWorkflow({
      runId,
      status: "stopped",
      recovery,
      resumeResponse,
    })).resolves.toMatchObject({ handled: true, resumable: true, resumed: true });
    expect(restartWorkflow).toHaveBeenCalledWith({
      runId,
      resume: true,
      originIndependent: true,
      recovery,
      resumeResponse,
      reason: "watcher-observed:stopped",
    });
    expect(proposeRescue).not.toHaveBeenCalled();
  });

  it("creates a proposal instead of restarting when durable recovery proof is absent", async () => {
    const { watcher, restartWorkflow, proposeRescue } = createHarness();

    await expect(watcher.restartStoppedWorkflow({
      runId: "run-without-checkpoint",
      status: "failed",
      resumeResponse: { resumable: true, restartRequired: false },
    })).resolves.toMatchObject({
      handled: true,
      resumable: false,
      proposal: {
        reason: "watcher-observed:failed:durable-recovery-proof-missing-or-invalid",
      },
    });
    expect(proposeRescue).toHaveBeenCalledOnce();
    expect(restartWorkflow).not.toHaveBeenCalled();
  });

  it("rejects invalid dispatch before any provider or workflow call", async () => {
    const {
      registry,
      semanticModel,
      restartWorkflow,
      repairAndRedeploy,
      proposeRescue,
      readFingerprintAudit,
    } = createHarness();

    await expect(registry.dispatch(COMPACTION_WATCHER_BEHAVIOR, {
      capability: "restart-workflow",
      runId: "run-no-payload",
    })).rejects.toBeInstanceOf(CompactionWatcherError);
    expect(readFingerprintAudit).not.toHaveBeenCalled();
    expect(semanticModel).not.toHaveBeenCalled();
    expect(restartWorkflow).not.toHaveBeenCalled();
    expect(repairAndRedeploy).not.toHaveBeenCalled();
    expect(proposeRescue).not.toHaveBeenCalled();
  });

  it("uses the fingerprint audit as a no-provider first pass", async () => {
    const audit: TrustedDagFusionCompactionAudit = {
      occurred: true,
      checks: [
        { attempt: 1, phase: "pre", passed: true },
        { attempt: 1, phase: "post", passed: false, errorCode: "POST_MISMATCH" },
      ],
    };
    const { watcher, semanticModel, repairAndRedeploy, restartWorkflow } =
      createHarness({ audit });

    await expect(watcher.watch(watchRequest())).resolves.toMatchObject({
      status: "repaired-and-restarted",
      behavior: {
        handled: true,
        redeployed: true,
        resumed: true,
        resumable: true,
      },
    });
    expect(semanticModel).not.toHaveBeenCalled();
    expect(repairAndRedeploy).toHaveBeenCalledWith(expect.objectContaining({
      runId: "wrun_context_rot",
      nodeId: "analysis",
      model: DEFAULT_COMPACTION_REPAIR_MODEL,
      reason: "fingerprint-audit:post:POST_MISMATCH",
      auditIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(restartWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      runId: "wrun_context_rot",
      resume: true,
      originIndependent: true,
      recovery: recoveryProof("wrun_context_rot"),
    }));
  });

  it("does not call a model when no compaction occurred", async () => {
    const audit: TrustedDagFusionCompactionAudit = { occurred: false, checks: [] };
    const { watcher, semanticModel, repairAndRedeploy, restartWorkflow } =
      createHarness({ audit });

    await expect(watcher.watch(watchRequest())).resolves.toEqual({
      status: "not-compacted",
      fingerprintAudit: audit,
    });
    expect(semanticModel).not.toHaveBeenCalled();
    expect(repairAndRedeploy).not.toHaveBeenCalled();
    expect(restartWorkflow).not.toHaveBeenCalled();
  });

  it("runs the mock semantic verdict pipeline and escalates detected context rot", async () => {
    const semanticVerdict = {
      verdict: "context-rot",
      hallucinations: ["The summary invented a completed deployment."],
      missedTodos: ["Verify C"],
      promptDeviations: [],
    };
    const { watcher, semanticModel, repairAndRedeploy, restartWorkflow } = createHarness({
      semanticVerdict,
      watcherModel: "openrouter/qwen/qwen3.6-flash",
    });

    await expect(watcher.watch(watchRequest())).resolves.toMatchObject({
      status: "repaired-and-restarted",
      semanticVerdict,
      behavior: { workflowRevision: 8, redeployed: true, resumed: true },
    });
    expect(semanticModel).toHaveBeenCalledOnce();
    expect(semanticModel).toHaveBeenCalledWith(expect.objectContaining({
      model: "openrouter/qwen/qwen3.6-flash",
      preCompactionRecord: watchRequest().preCompactionRecord,
      compactedSummary: watchRequest().compactedSummary,
      goal: watchRequest().goal,
      openTodos: ["Verify C"],
    }));
    expect(repairAndRedeploy).toHaveBeenCalledWith(expect.objectContaining({
      model: DEFAULT_COMPACTION_REPAIR_MODEL,
      reason: "semantic-context-rot",
      semanticVerdict,
    }));
    expect(restartWorkflow).toHaveBeenCalledOnce();
  });

  it("accepts a clean semantic verdict without repair or restart", async () => {
    const { watcher, semanticModel, repairAndRedeploy, restartWorkflow } = createHarness();

    await expect(watcher.watch(watchRequest())).resolves.toMatchObject({
      status: "clean",
      semanticVerdict: { verdict: "clean" },
    });
    expect(semanticModel).toHaveBeenCalledOnce();
    expect(repairAndRedeploy).not.toHaveBeenCalled();
    expect(restartWorkflow).not.toHaveBeenCalled();
  });

  it("retries restart from the persisted revision without creating a second deployment", async () => {
    const semanticVerdict = {
      verdict: "context-rot",
      hallucinations: [],
      missedTodos: ["Verify C"],
      promptDeviations: [],
    };
    const { watcher, repairAndRedeploy, restartWorkflow } = createHarness({ semanticVerdict });
    restartWorkflow
      .mockRejectedValueOnce(new Error("runner temporarily unavailable"))
      .mockResolvedValueOnce({ resumed: true });

    await expect(watcher.watch(watchRequest())).rejects.toMatchObject({
      code: "RESTART_PARTIAL_SUCCESS",
      operation: {
        phase: "restart-failed",
        workflowRevision: 8,
        recovery: recoveryProof("wrun_context_rot"),
      },
    });
    await expect(watcher.watch(watchRequest())).resolves.toMatchObject({
      status: "repaired-and-restarted",
      behavior: { workflowRevision: 8, redeployed: true, resumed: true },
    });
    expect(repairAndRedeploy).toHaveBeenCalledOnce();
    expect(restartWorkflow).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent invocations of the same durable operation", async () => {
    const semanticVerdict = {
      verdict: "context-rot",
      hallucinations: [],
      missedTodos: ["Verify C"],
      promptDeviations: [],
    };
    const { watcher, repairAndRedeploy, restartWorkflow } = createHarness({ semanticVerdict });
    let releaseRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    repairAndRedeploy.mockImplementationOnce(async (request) => {
      await repairGate;
      return {
        redeployed: true,
        workflowRevision: 8,
        recovery: recoveryProof(request.runId),
      };
    });

    const first = watcher.watch(watchRequest());
    const second = watcher.watch(watchRequest());
    await vi.waitFor(() => expect(repairAndRedeploy).toHaveBeenCalledOnce());
    releaseRepair();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { behavior: { resumed: true, workflowRevision: 8 } },
      { behavior: { resumed: true, workflowRevision: 8 } },
    ]);
    expect(repairAndRedeploy).toHaveBeenCalledOnce();
    expect(restartWorkflow).toHaveBeenCalledOnce();
  });
});
