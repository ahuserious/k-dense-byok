import { describe, expect, it, vi } from "vitest";
import { WorkflowBehaviorRegistry } from "../src/workflows/behavior-registry.ts";
import { createCompactionWatcher } from "../src/workflows/compaction-watcher.ts";
import { registerLateralPassBehavior } from "../src/context/lateral-pass.ts";
import {
  DurabilityWatcher,
  durabilityDispatchRef,
  type DurabilityRunSource,
} from "../src/workflows/durability-watcher.ts";
import { MemoryDurabilityJournal } from "../src/workflows/durability-journal.ts";
import {
  defaultDurabilitySettings,
  type DurabilitySettingsV1,
} from "../src/workflows/durability-settings.ts";
import type { WorkflowRunEventV1 } from "../src/workflows/run-state.ts";
import type { WorkflowRunRecord } from "../src/workflows/store.ts";
import type { WorkflowRunStopReceipt } from "../src/workflows/controller.ts";
import type { TrustedDagFusionCompactionAudit } from
  "../pi-packages/dag-fusion-drive/compaction-audit.ts";

const PROJECT_ID = "durability-signals-test";
const RUN_ID = "wrun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A rescue model that really resolves, with a 1M context window. */
const RESCUE_REF = "openrouter/openai/gpt-5.6-luna-pro";
const WATCHER_REF = "openrouter/qwen/qwen3.8-27b";

function runRecord(options: {
  status?: WorkflowRunRecord["state"]["status"];
  lastSeq?: number;
  nodes?: Array<{ id: string; kind: string }>;
} = {}): WorkflowRunRecord {
  return {
    manifest: {
      id: RUN_ID,
      workflowId: "workflow-durability",
      graphSha256: "a".repeat(64),
      sessionId: "session-durability",
      input: { goal: "Finish the durability run." },
      graph: {
        nodes: options.nodes ?? [{ id: "lean-proof", kind: "lean4" }],
      },
    },
    state: {
      status: options.status ?? "running",
      lastSeq: options.lastSeq ?? 4,
      recoverable: true,
      executions: {},
    },
  } as unknown as WorkflowRunRecord;
}

function event(
  seq: number,
  type: WorkflowRunEventV1["type"],
  extra: Partial<WorkflowRunEventV1> = {},
): WorkflowRunEventV1 {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    eventId: `event-${seq}`,
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    ...extra,
  } as WorkflowRunEventV1;
}

interface Harness {
  watcher: DurabilityWatcher;
  journal: MemoryDurabilityJournal;
  settings: DurabilitySettingsV1;
  summarize: ReturnType<typeof vi.fn>;
  repairAndRedeploy: ReturnType<typeof vi.fn>;
  restartWorkflow: ReturnType<typeof vi.fn>;
  semanticModel: ReturnType<typeof vi.fn>;
  stopRun: ReturnType<typeof vi.fn>;
  now: { value: number };
}

function harness(options: {
  settings?: Partial<DurabilitySettingsV1>;
  run?: WorkflowRunRecord;
  events?: WorkflowRunEventV1[];
  audit?: TrustedDagFusionCompactionAudit;
  semanticVerdict?: unknown;
} = {}): Harness {
  const settings: DurabilitySettingsV1 = {
    ...defaultDurabilitySettings(),
    enabled: true,
    rescueModel: { kind: "direct", ref: RESCUE_REF, effort: "xhigh" },
    ...options.settings,
  };
  const run = options.run ?? runRecord();
  const events = options.events ?? [];
  const registry = new WorkflowBehaviorRegistry();

  const restartWorkflow = vi.fn().mockResolvedValue({ resumed: true, detail: "resumed" });
  const repairAndRedeploy = vi.fn().mockResolvedValue({
    redeployed: true,
    workflowRevision: 2,
    recovery: {
      runId: RUN_ID,
      checkpointId: "event:4",
      restartToken: `replacement:${RUN_ID}:${"b".repeat(64)}`,
      verified: true as const,
      sideEffectSafety: "idempotent" as const,
    },
    detail: "repaired and redeployed",
  });
  const semanticModel = vi.fn().mockResolvedValue(
    options.semanticVerdict ?? {
      verdict: "clean",
      hallucinations: [],
      missedTodos: [],
      promptDeviations: [],
    },
  );
  createCompactionWatcher({
    registry,
    semanticModel,
    restartWorkflow,
    repairAndRedeploy,
    proposeRescue: vi.fn().mockResolvedValue({ proposalId: "proposal-1" }),
    operationStore: {
      async runExclusive(_key, operation) {
        let current: never | undefined;
        return operation({
          get current() {
            return current;
          },
          compareAndSwap(_expected, next) {
            current = {
              version: 1,
              operationKey: "key",
              sequence: 1,
              updatedAt: 0,
              ...next,
            } as never;
            return current!;
          },
        });
      },
    },
    env: {},
  });
  const summarize = vi.fn().mockResolvedValue({
    summary: "The lean proof node failed twice.",
    goal: "Finish the durability run.",
    openTodos: ["Repair the proof node"],
    decisions: ["Escalate to the rescue model"],
    constraints: ["Do not discard the failing node"],
  });
  registerLateralPassBehavior({
    registry,
    summarize,
    openCleanWindow: vi.fn().mockResolvedValue({ sessionId: "session-clean" }),
    env: {},
  });

  const runs: DurabilityRunSource = {
    readRun: (projectId, runId) =>
      projectId === PROJECT_ID && runId === run.manifest.id ? run : null,
    listRuns: () => [run],
    readRunEvents: (_projectId, _runId, requestOptions) => {
      const after = requestOptions?.after ?? 0;
      const remaining = events.filter((candidate) => candidate.seq > after);
      return { events: remaining, lastSeq: events.at(-1)?.seq ?? 0, hasMore: false };
    },
  };

  const journal = new MemoryDurabilityJournal();
  const now = { value: 1_700_000_000_000 };
  const stopRun = vi.fn().mockImplementation((runId: string): WorkflowRunStopReceipt => ({
    runId,
    stopped: true,
    terminalStatus: "cancelled",
    stoppedBy: "durability-watcher",
    reason: "stalled",
    distinguishedInRunEvents: true,
    detail: `Workflow run ${runId} was stopped and recorded as a durability stop.`,
  }));

  const watcher = new DurabilityWatcher({
    projectId: PROJECT_ID,
    readSettings: () => settings,
    journal,
    registry,
    runs,
    stopRun,
    semanticModel,
    readFingerprintAudit: () =>
      options.audit ?? { occurred: true, checks: [{ attempt: 1, phase: "pre", passed: true }] },
    now: () => now.value,
  });

  return {
    watcher,
    journal,
    settings,
    summarize,
    repairAndRedeploy,
    restartWorkflow,
    semanticModel,
    stopRun,
    now,
  };
}

function journalNames(journal: MemoryDurabilityJournal): string[] {
  return journal.read(PROJECT_ID, RUN_ID, { limit: 200 }).events.map((item) => item.name);
}

describe("durability watcher — per-signal firing on real observed state", () => {
  it("fires hallucination on an unsupported evidence check, and not when the toggle is off", async () => {
    const enabled = harness({
      settings: {
        signals: {
          ...defaultDurabilitySettings().signals,
          hallucination: { enabled: true, action: "observe", threshold: 1 },
        },
      },
      events: [
        event(5, "evidence_checked", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: { supported: false, sourceIds: [], summary: "no support" },
        }),
      ],
    });

    const observation = await enabled.watcher.observeRun(RUN_ID);

    expect(observation.fires.map((fire) => fire.signal)).toEqual(["hallucination"]);
    expect(journalNames(enabled.journal)).toContain("durability.signal.fired");

    const disabled = harness({
      events: [
        event(5, "evidence_checked", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: { supported: false, sourceIds: [], summary: "no support" },
        }),
      ],
    });
    const suppressed = await disabled.watcher.observeRun(RUN_ID);
    expect(suppressed.fires).toEqual([]);
    expect(suppressed.suppressed).toEqual(["hallucination"]);
    expect(journalNames(disabled.journal)).toContain("durability.signal.suppressed");
  });

  it("fires failed-script-run only for a node kind that runs an external process", async () => {
    const scriptNode = harness({
      settings: {
        signals: {
          ...defaultDurabilitySettings().signals,
          "failed-script-run": { enabled: true, action: "observe", threshold: 1 },
        },
      },
      events: [
        event(5, "node_failed", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: {
            error: { code: "LEAN_FAILED", message: "Lean rejected the proof.", retryable: true },
            routeCondition: "failure",
          },
        }),
      ],
    });
    expect((await scriptNode.watcher.observeRun(RUN_ID)).fires.map((fire) => fire.signal))
      .toEqual(["failed-script-run"]);

    const agentNode = harness({
      settings: {
        signals: {
          ...defaultDurabilitySettings().signals,
          "failed-script-run": { enabled: true, action: "observe", threshold: 1 },
        },
      },
      run: runRecord({ nodes: [{ id: "writer", kind: "agent" }] }),
      events: [
        event(5, "node_failed", {
          executionId: "exec-1",
          nodeId: "writer",
          attempt: 1,
          branchId: "entry",
          data: {
            error: { code: "AGENT_FAILED", message: "The agent failed.", retryable: true },
            routeCondition: "failure",
          },
        }),
      ],
    });
    expect((await agentNode.watcher.observeRun(RUN_ID)).fires).toEqual([]);
  });

  it("fires paused-no-progress from real run state, and not before the stall time", async () => {
    const paused = harness({
      settings: {
        stallMs: 60_000,
        signals: {
          ...defaultDurabilitySettings().signals,
          "paused-no-progress": { enabled: true, action: "observe", threshold: 1 },
        },
      },
      run: runRecord({ status: "paused" }),
    });

    expect((await paused.watcher.observeRun(RUN_ID)).fires).toEqual([]);
    paused.now.value += 59_000;
    expect((await paused.watcher.observeRun(RUN_ID)).fires).toEqual([]);
    paused.now.value += 2_000;
    expect((await paused.watcher.observeRun(RUN_ID)).fires.map((fire) => fire.signal))
      .toEqual(["paused-no-progress"]);
  });

  it("does not fire paused-no-progress while the run is still making progress", async () => {
    let lastSeq = 4;
    const run = runRecord({ status: "waiting" });
    Object.defineProperty(run.state, "lastSeq", { get: () => lastSeq });
    const progressing = harness({
      settings: {
        stallMs: 60_000,
        signals: {
          ...defaultDurabilitySettings().signals,
          "paused-no-progress": { enabled: true, action: "observe", threshold: 1 },
        },
      },
      run,
    });

    await progressing.watcher.observeRun(RUN_ID);
    progressing.now.value += 120_000;
    lastSeq = 9;
    expect((await progressing.watcher.observeRun(RUN_ID)).fires).toEqual([]);
  });

  it("never fires failed-skill-fire, because this build cannot observe it", async () => {
    const unobservable = harness({
      settings: {
        signals: {
          ...defaultDurabilitySettings().signals,
          // Forced past the settings guard on purpose: even a toggle that
          // somehow reads enabled must not produce a fire, because there is no
          // observation to fire on.
          "failed-skill-fire": { enabled: true, action: "observe", threshold: 1 },
        },
      },
      events: [
        event(5, "node_failed", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: {
            error: { code: "SKILL_FAILED", message: "A skill failed.", retryable: true },
            routeCondition: "failure",
          },
        }),
      ],
    });
    const observation = await unobservable.watcher.observeRun(RUN_ID);
    expect(observation.fires.some((fire) => fire.signal === "failed-skill-fire")).toBe(false);
  });

  it("fires compaction on a failed fingerprint check, and suppresses it when the toggle is off", async () => {
    const failedAudit: TrustedDagFusionCompactionAudit = {
      occurred: true,
      checks: [{ attempt: 1, phase: "post", passed: false, errorCode: "SUMMARY_MISMATCH" }],
    };
    const request = {
      runId: RUN_ID,
      childRunId: "child-1",
      sandboxRoot: "/sandbox",
      preCompactionRecord: "Decision B. TODO verify C.",
      compactedSummary: "Decision B.",
      userPrompt: "Verify C.",
      goal: "Verify C.",
      openTodos: ["Verify C"],
    };

    const on = harness({ audit: failedAudit });
    const fired = await on.watcher.watchCompaction(request);
    expect(fired.status).toBe("fired");
    expect(fired.signal).toBe("compaction");
    expect(on.repairAndRedeploy).toHaveBeenCalledOnce();

    const off = harness({
      audit: failedAudit,
      settings: {
        signals: {
          ...defaultDurabilitySettings().signals,
          compaction: { enabled: false, action: "escalate", threshold: 1 },
        },
      },
    });
    const suppressed = await off.watcher.watchCompaction(request);
    expect(suppressed.status).toBe("suppressed");
    expect(off.repairAndRedeploy).not.toHaveBeenCalled();
  });

  it("fires context-rot on the semantic verdict at the operator's watcher model", async () => {
    const rot = harness({
      semanticVerdict: {
        verdict: "context-rot",
        hallucinations: [],
        missedTodos: ["Verify C"],
        promptDeviations: [],
      },
    });
    const result = await rot.watcher.watchCompaction({
      runId: RUN_ID,
      childRunId: "child-1",
      sandboxRoot: "/sandbox",
      preCompactionRecord: "Decision B. TODO verify C.",
      compactedSummary: "Decision B.",
      userPrompt: "Verify C.",
      goal: "Verify C.",
      openTodos: ["Verify C"],
    });

    expect(result.status).toBe("fired");
    expect(result.signal).toBe("context-rot");
    // Gate B: the operator's watcher model reached the model call, with its
    // reasoning effort carried in the routing form the provider accepts.
    expect(rot.semanticModel.mock.calls[0][0].model).toBe(`${WATCHER_REF}-high`);
  });
});

describe("durability watcher — the escalation binds the rescue model (row 24)", () => {
  it("carries the rescue model and effort into BOTH the lateral pass and the repair call", async () => {
    const escalating = harness({
      settings: {
        signals: {
          ...defaultDurabilitySettings().signals,
          "failed-script-run": { enabled: true, action: "escalate", threshold: 1 },
        },
      },
      events: [
        event(5, "node_failed", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: {
            error: { code: "LEAN_FAILED", message: "Lean rejected the proof.", retryable: true },
            routeCondition: "failure",
          },
        }),
      ],
    });

    const observation = await escalating.watcher.observeRun(RUN_ID);

    expect(observation.fires[0]).toMatchObject({ signal: "failed-script-run", dispatched: true });
    expect(escalating.summarize.mock.calls[0][0].model).toBe(`${RESCUE_REF}-xhigh`);
    expect(escalating.repairAndRedeploy.mock.calls[0][0].model).toBe(`${RESCUE_REF}-xhigh`);
    expect(journalNames(escalating.journal)).toEqual(
      expect.arrayContaining([
        "durability.signal.fired",
        "durability.action.dispatched",
        "durability.escalation.started",
        "durability.escalation.completed",
        "durability.action.completed",
      ]),
    );
  });

  it("fails closed on an unresolved rescue model and leaves the run untouched", async () => {
    const unset = harness({
      settings: {
        // The shipped default: "GPT-5.6 Pro" resolves to three ids, so nothing
        // is chosen for the user.
        rescueModel: defaultDurabilitySettings().rescueModel,
        signals: {
          ...defaultDurabilitySettings().signals,
          "failed-script-run": { enabled: true, action: "escalate", threshold: 1 },
        },
      },
      events: [
        event(5, "node_failed", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: {
            error: { code: "LEAN_FAILED", message: "Lean rejected the proof.", retryable: true },
            routeCondition: "failure",
          },
        }),
      ],
    });

    const observation = await unset.watcher.observeRun(RUN_ID);

    expect(observation.fires[0]).toMatchObject({ dispatched: false });
    expect(observation.fires[0].detail).toContain("GPT-5.6 Pro");
    expect(observation.fires[0].detail).toContain("Pipeline options");
    // No silent fallback: nothing was summarized, repaired, or restarted.
    expect(unset.summarize).not.toHaveBeenCalled();
    expect(unset.repairAndRedeploy).not.toHaveBeenCalled();
    expect(unset.restartWorkflow).not.toHaveBeenCalled();
    expect(journalNames(unset.journal)).toContain("durability.model.unresolved");
  });

  it("rejects a rescue model whose context window is below the configured floor", async () => {
    const small = harness({
      settings: {
        rescueModel: { kind: "direct", ref: "openrouter/google/gemini-3.1-flash-lite" },
        minRescueContextWindow: 100_000_000,
        signals: {
          ...defaultDurabilitySettings().signals,
          "failed-script-run": { enabled: true, action: "escalate", threshold: 1 },
        },
      },
      events: [
        event(5, "node_failed", {
          executionId: "exec-1",
          nodeId: "lean-proof",
          attempt: 1,
          branchId: "entry",
          data: {
            error: { code: "LEAN_FAILED", message: "Lean rejected the proof.", retryable: true },
            routeCondition: "failure",
          },
        }),
      ],
    });

    const observation = await small.watcher.observeRun(RUN_ID);
    expect(observation.fires[0].dispatched).toBe(false);
    expect(observation.fires[0].detail).toContain("context window");
    expect(small.repairAndRedeploy).not.toHaveBeenCalled();
  });
});

describe("durability watcher — stop authority (#39 / N-A1)", () => {
  it("stops a run and records who stopped it", async () => {
    const stopping = harness({
      settings: {
        stallMs: 1_000,
        signals: {
          ...defaultDurabilitySettings().signals,
          "paused-no-progress": { enabled: true, action: "stop", threshold: 1 },
        },
      },
      run: runRecord({ status: "blocked" }),
    });

    await stopping.watcher.observeRun(RUN_ID);
    stopping.now.value += 2_000;
    const observation = await stopping.watcher.observeRun(RUN_ID);

    expect(observation.fires[0]).toMatchObject({ action: "stop", dispatched: true });
    expect(stopping.stopRun).toHaveBeenCalledOnce();
    const names = journalNames(stopping.journal);
    expect(names).toContain("durability.stop.requested");
    expect(names).toContain("durability.stop.completed");
    expect(stopping.watcher.watchedRuns()[0].stops).toBe(1);
  });

  it("refuses to stop past the configured limit, and leaves the run alone", async () => {
    const bounded = harness({
      settings: {
        stallMs: 1_000,
        stopPolicy: { allowStop: true, maxStopsPerRun: 0 },
        signals: {
          ...defaultDurabilitySettings().signals,
          "paused-no-progress": { enabled: true, action: "stop", threshold: 1 },
        },
      },
      run: runRecord({ status: "blocked" }),
    });

    await bounded.watcher.observeRun(RUN_ID);
    bounded.now.value += 2_000;
    const observation = await bounded.watcher.observeRun(RUN_ID);

    expect(observation.fires[0].dispatched).toBe(false);
    expect(observation.fires[0].detail).toContain("stop limit");
    expect(bounded.stopRun).not.toHaveBeenCalled();
  });

  it("refuses to stop when stopping is switched off", async () => {
    const off = harness({
      settings: {
        stallMs: 1_000,
        stopPolicy: { allowStop: false, maxStopsPerRun: 5 },
        signals: {
          ...defaultDurabilitySettings().signals,
          "paused-no-progress": { enabled: true, action: "stop", threshold: 1 },
        },
      },
      run: runRecord({ status: "blocked" }),
    });

    await off.watcher.observeRun(RUN_ID);
    off.now.value += 2_000;
    const observation = await off.watcher.observeRun(RUN_ID);

    expect(observation.fires[0].dispatched).toBe(false);
    expect(off.stopRun).not.toHaveBeenCalled();
  });
});

describe("durability watcher — lifecycle (#41)", () => {
  it("owns no timer and releases every run it was watching on close", async () => {
    const running = harness();
    await running.watcher.observeRun(RUN_ID);
    expect(running.watcher.watchedRuns()).toHaveLength(1);

    running.watcher.close();

    expect(running.watcher.watchedRuns()).toEqual([]);
    expect(journalNames(running.journal)).toContain("durability.watch.stopped");
    // The class exposes no timer of its own: it rides the caller's feed.
    expect(Object.getOwnPropertyNames(running.watcher)).not.toContain("timer");
  });

  it("releases a run once it reaches a terminal state", async () => {
    const finishing = harness({ run: runRecord({ status: "running" }) });
    await finishing.watcher.observeProject();
    expect(finishing.watcher.watchedRuns()).toHaveLength(1);

    const terminal = harness({ run: runRecord({ status: "succeeded" }) });
    await terminal.watcher.observeProject();
    expect(terminal.watcher.watchedRuns()).toEqual([]);
  });

  it("observes nothing at all while durability is switched off", async () => {
    const disabled = harness({ settings: { enabled: false } });
    expect(await disabled.watcher.observeProject()).toEqual([]);
    expect(disabled.watcher.watchedRuns()).toEqual([]);
  });
});

describe("durabilityDispatchRef", () => {
  it("carries reasoning effort in the routing form the provider accepts", () => {
    expect(durabilityDispatchRef({ ref: RESCUE_REF, effort: "xhigh" }))
      .toBe(`${RESCUE_REF}-xhigh`);
    expect(durabilityDispatchRef({ ref: WATCHER_REF })).toBe(WATCHER_REF);
  });
});
