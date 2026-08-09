import { describe, expect, it, vi } from "vitest";
import { WorkflowBehaviorRegistry } from "../src/workflows/behavior-registry.ts";
import {
  COMPACTION_WATCHER_BEHAVIOR,
  DEFAULT_COMPACTION_REPAIR_MODEL,
  DEFAULT_COMPACTION_WATCHER_MODEL,
  CompactionWatcherError,
  createCompactionWatcher,
  type CompactionSemanticModel,
  type WatchCompactionRequest,
} from "../src/workflows/compaction-watcher.ts";
import type { TrustedDagFusionCompactionAudit } from
  "../pi-packages/dag-fusion-drive/compaction-audit.ts";

const cleanFingerprintAudit: TrustedDagFusionCompactionAudit = {
  occurred: true,
  checks: [
    { attempt: 1, phase: "pre", passed: true },
    { attempt: 1, phase: "post", passed: true },
  ],
};

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
  const repairAndRedeploy = vi.fn().mockResolvedValue({
    redeployed: true,
    workflowRevision: 8,
  });
  const readFingerprintAudit = vi.fn().mockReturnValue(
    options.audit ?? cleanFingerprintAudit,
  );
  const watcher = createCompactionWatcher({
    registry,
    semanticModel,
    restartWorkflow,
    repairAndRedeploy,
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

  it("dispatches watcher-owned restart even when the upstream API says non-resumable", async () => {
    const { watcher, restartWorkflow, repairAndRedeploy, semanticModel } = createHarness();

    await expect(watcher.restartStoppedWorkflow({
      runId: "vendored-run-without-web-parent",
      status: "stalled",
      resumeResponse: {
        resumable: false,
        restartRequired: true,
        restartWarning: "A new origin run could repeat side effects.",
      },
    })).resolves.toMatchObject({
      handled: true,
      resumable: true,
      resumed: true,
    });
    expect(restartWorkflow).toHaveBeenCalledWith({
      runId: "vendored-run-without-web-parent",
      resume: true,
      originIndependent: true,
      upstreamResumable: false,
      reason: "watcher-observed:stalled",
    });
    expect(repairAndRedeploy).not.toHaveBeenCalled();
    expect(semanticModel).not.toHaveBeenCalled();
  });

  it("rejects invalid dispatch before any provider or workflow call", async () => {
    const {
      registry,
      semanticModel,
      restartWorkflow,
      repairAndRedeploy,
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
  });

  it("uses the fingerprint audit as a no-provider first pass", async () => {
    const audit: TrustedDagFusionCompactionAudit = {
      occurred: true,
      checks: [
        { attempt: 1, phase: "pre", passed: true },
        {
          attempt: 1,
          phase: "post",
          passed: false,
          errorCode: "POST_MISMATCH",
        },
      ],
    };
    const {
      watcher,
      semanticModel,
      repairAndRedeploy,
      restartWorkflow,
    } = createHarness({ audit });

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
    expect(repairAndRedeploy).toHaveBeenCalledWith({
      runId: "wrun_context_rot",
      nodeId: "analysis",
      model: DEFAULT_COMPACTION_REPAIR_MODEL,
      reason: "fingerprint-audit:post:POST_MISMATCH",
    });
    expect(restartWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      runId: "wrun_context_rot",
      resume: true,
      originIndependent: true,
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
    const {
      watcher,
      semanticModel,
      repairAndRedeploy,
      restartWorkflow,
    } = createHarness({ semanticVerdict, watcherModel: "openrouter/qwen/qwen3.6-flash" });

    await expect(watcher.watch(watchRequest())).resolves.toMatchObject({
      status: "repaired-and-restarted",
      semanticVerdict,
      behavior: {
        workflowRevision: 8,
        redeployed: true,
        resumed: true,
      },
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
});
