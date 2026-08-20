import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  createSession,
  getModelRegistry,
  getModelRuntime,
} from "../agent/session-registry.ts";
import {
  assertModelAuthentication,
  modelReference,
  resolveModel,
} from "../agent/models.ts";
import {
  installDagFusionCompactionEventSink,
  type DagFusionCompactionEvent,
} from "../agent/dag-fusion-bridge.ts";
import { resolvePaths, listProjects } from "../projects.ts";
import { billingCountsTowardBudget, billingForModel } from "../cost/billing.ts";
import { emptySnapshot, isBudgetExceeded, recordRun } from "../cost/ledger.ts";
import {
  readTrustedDagFusionCompactionAudit,
  readTrustedDagFusionCompactionRecords,
} from "../../pi-packages/dag-fusion-drive/compaction-audit.ts";
import { LATERAL_PASS_BEHAVIOR, type LateralPassMessage } from "../context/lateral-pass.ts";
import { WorkflowBehaviorRegistry } from "./behavior-registry.ts";
import { FileCompactionWatcherOperationStore } from
  "./compaction-watcher-operation-store.ts";
import type {
  CompactionSemanticModelRequest,
  DurableRestartProof,
  WatcherRepairRequest,
  WatcherRestartRequest,
} from "./compaction-watcher.ts";
import { CompactionWatcherRetryableRepairError } from "./compaction-watcher.ts";
import { registerContextEngineering } from "./context-watcher.ts";
import type { WorkflowRunController, WorkflowRunStopReceipt } from "./controller.ts";
import {
  FileDurabilityJournal,
  type DurabilityJournal,
  type DurabilityTimelinePage,
} from "./durability-journal.ts";
import {
  FileDurabilitySettingsStore,
  parseDurabilitySettings,
  type DurabilitySettingsStore,
  type DurabilitySettingsV1,
} from "./durability-settings.ts";
import { resolveDurabilityModels, type DurabilityPresetResolver } from
  "./durability-model-policy.ts";
import { DurabilityWatcher, type DurabilityObservation } from "./durability-watcher.ts";
import {
  WorkflowStoreError,
  workflowStore,
  type WorkflowRunRecord,
  type WorkflowStore,
} from "./store.ts";

const CONTEXT_ENGINEERING_LEDGER_SESSION = "context-engineering";
const STOPPED_RUN_POLL_MS = 5_000;
const MAX_MODEL_OUTPUT_TOKENS = 8_000;

/**
 * #41: nothing this lane starts may outlive or pile up.
 *
 * The durability sweep runs inside the 5-second stopped-run feed, and it now
 * makes real provider calls. A slow or hung provider would otherwise hold a
 * tick open indefinitely, so every durability-originated model call is bounded
 * here: an AbortSignal reaches `runtime.complete` (which honours it), and a
 * wall-clock race bounds the call even when the completion seam ignores the
 * signal. Four minutes is generous for a 1M-context rescue at xhigh and far
 * below the point at which a stuck call would matter.
 */
const DURABILITY_MODEL_TIMEOUT_MS = 240_000;

export class DurabilityModelTimeoutError extends Error {
  constructor(model: string, timeoutMs: number) {
    super(
      `The durability model ${model} did not answer within ${Math.round(timeoutMs / 1000)} ` +
        "seconds and was cancelled. The run was left exactly as it was.",
    );
    this.name = "DurabilityModelTimeoutError";
  }
}

export interface ContextEngineeringModelCall {
  projectId: string;
  model: string;
  instruction: string;
  input: unknown;
  /** Caller cancellation, honoured by `runtime.complete`. */
  signal?: AbortSignal;
  /** Provider-side wall clock for this one call. */
  timeoutMs?: number;
}

export interface ContextEngineeringProductionOptions {
  store?: WorkflowStore;
  completeJson?(call: ContextEngineeringModelCall): Promise<unknown>;
  onError?(error: unknown): void;
  /** Durability configuration and timeline seams; production uses the file-backed pair. */
  durabilitySettings?: DurabilitySettingsStore;
  durabilityJournal?: DurabilityJournal;
  /** Team A's preset resolver, once F1 lands. Absent means preset refs fail closed. */
  presetResolver?: DurabilityPresetResolver;
}

export interface DispatchLateralPassRequest {
  sourceSessionId: string;
  userPrompt: string;
  goal: string;
  openTodos: string[];
  transcript: LateralPassMessage[];
}

function unwrapJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function productionCompleteJson(call: ContextEngineeringModelCall): Promise<unknown> {
  const runtime = getModelRuntime();
  const model = resolveModel(call.model, getModelRegistry());
  await assertModelAuthentication(model, runtime);
  const context: Context = {
    systemPrompt: `${call.instruction} Respond with one strict JSON value and no prose.`,
    messages: [{
      role: "user",
      content: JSON.stringify(call.input),
      timestamp: Date.now(),
    }],
  };
  const message = await runtime.complete(model, context, {
    maxTokens: MAX_MODEL_OUTPUT_TOKENS,
    ...(call.signal ? { signal: call.signal } : {}),
    ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
  });
  if (["error", "aborted", "pending"].includes(message.stopReason)) {
    throw new Error(message.errorMessage ?? `Context model stopped with ${message.stopReason}.`);
  }
  const text = message.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n");
  if (!text.trim()) throw new Error("Context model returned no JSON.");
  const billing = await billingForModel(model, runtime);
  const usage = message.usage;
  recordRun({
    sessionId: CONTEXT_ENGINEERING_LEDGER_SESSION,
    projectId: call.projectId,
    model: modelReference(model),
    role: "workflow",
    before: emptySnapshot(),
    after: {
      costUsd: usage.cost.total,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      total: usage.totalTokens,
    },
    billing,
  });
  return unwrapJson(text);
}

async function assertBudgetAdmission(projectId: string, modelRef: string): Promise<void> {
  const runtime = getModelRuntime();
  const model: Model<Api> = resolveModel(modelRef, getModelRegistry());
  const billing = await billingForModel(model, runtime);
  const budget = isBudgetExceeded(projectId);
  if (billingCountsTowardBudget(billing) && budget.exceeded) {
    throw new Error(
      `Project spend limit reached (${budget.totalUsd} / ${String(budget.limitUsd)}).`,
    );
  }
}

function proposalReceipt(projectId: string, request: {
  runId: string;
  nodeId?: string;
  reason: string;
  resumeResponse?: unknown;
  recovery?: unknown;
}): { proposalId: string; detail: string } {
  const paths = resolvePaths(projectId);
  const directory = path.join(paths.workflowsDir, "context-watcher", "proposals");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const proposalId = `context-proposal-${createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex")
    .slice(0, 24)}`;
  const file = path.join(directory, `${proposalId}.json`);
  const serialized = `${JSON.stringify({
    version: 1,
    proposalId,
    createdAt: Date.now(),
    applied: false,
    ...request,
  }, null, 2)}\n`;
  try {
    fs.writeFileSync(file, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { proposalId, detail: `Persisted unapplied rescue proposal ${proposalId}.` };
}

function repairRequestId(runId: string, auditIdentity: string): string {
  return `context-repair-${createHash("sha256")
    .update(runId)
    .update("\0")
    .update(auditIdentity)
    .digest("hex")
    .slice(0, 32)}`;
}

function nativeRestartToken(runId: string, lastSeq: number, graphSha256: string): string {
  return `native:${runId}:${lastSeq}:${graphSha256}`;
}

function recoverableSourceProof(source: WorkflowRunRecord): DurableRestartProof | undefined {
  if (
    source.state.status !== "interrupted" || !source.state.recoverable ||
    !Number.isSafeInteger(source.state.lastSeq) || source.state.lastSeq < 1 ||
    !/^[a-f0-9]{64}$/.test(source.manifest.graphSha256)
  ) return undefined;
  return {
    runId: source.manifest.id,
    checkpointId: `event:${source.state.lastSeq}`,
    restartToken: nativeRestartToken(
      source.manifest.id,
      source.state.lastSeq,
      source.manifest.graphSha256,
    ),
    verified: true,
    sideEffectSafety: "idempotent",
  };
}

class ProjectContextEngineeringRuntime {
  readonly registry = new WorkflowBehaviorRegistry();
  readonly registration;
  readonly durability: DurabilityWatcher;

  constructor(
    readonly projectId: string,
    private readonly controller: WorkflowRunController | null,
    private readonly store: WorkflowStore,
    private readonly completeJson: (call: ContextEngineeringModelCall) => Promise<unknown>,
    settingsStore: DurabilitySettingsStore,
    journal: DurabilityJournal,
    presetResolver: DurabilityPresetResolver | undefined,
    onError: (error: unknown) => void,
  ) {
    const paths = resolvePaths(projectId);
    this.registration = registerContextEngineering({
      registry: this.registry,
      runner: {
        operationStore: new FileCompactionWatcherOperationStore(paths.sandbox),
        readFingerprintAudit: readTrustedDagFusionCompactionAudit,
        restartWorkflow: (request) => this.restartWorkflow(request),
        repairAndRedeploy: (request) => this.repairAndRedeploy(request),
        proposeRescue: async (request) => proposalReceipt(projectId, request),
      },
      sessions: {
        // Bounded like every other model call the 5-second feed can reach: the
        // durability watcher's `lateral-pass` action dispatches this behavior
        // from inside a sweep (#41).
        summarizeLateralPass: (request) => this.durabilityCompleteJson({
          projectId,
          model: request.model,
          instruction: request.instruction,
          input: request,
        }),
        openCleanWindow: async (request) => {
          const session = await createSession(projectId, paths);
          session.sessionManager.appendMessage({
            role: "user",
            content: [{
              type: "text",
              text: [
                "Server-created LATERAL-PASS handoff (the source session was not compacted):",
                JSON.stringify(request),
              ].join("\n"),
            }],
            timestamp: Date.now(),
          } as never);
          return { sessionId: session.sessionId };
        },
      },
      models: {
        auditCompaction: (request: CompactionSemanticModelRequest) => this.completeJson({
          projectId,
          model: request.model,
          instruction: request.instruction,
          input: request,
        }),
      },
      budget: {
        admit: ({ model }) => assertBudgetAdmission(projectId, model),
      },
    });
    // ONE watcher: durability owns the toggles, the operator-selected models,
    // stop authority and the timeline, and dispatches through the behaviors
    // registered immediately above rather than registering its own.
    this.durability = new DurabilityWatcher({
      projectId,
      readSettings: () => settingsStore.read(projectId),
      journal,
      registry: this.registry,
      runs: this.store,
      readFingerprintAudit: readTrustedDagFusionCompactionAudit,
      semanticModel: async (request) => {
        await assertBudgetAdmission(projectId, request.model);
        return this.durabilityCompleteJson({
          projectId,
          model: request.model,
          instruction: request.instruction,
          input: request,
        });
      },
      ...(presetResolver ? { presetResolver } : {}),
      ...(this.controller
        ? {
          stopRun: (runId: string, reason: string): WorkflowRunStopReceipt =>
            this.controller!.stopRun(projectId, runId, {
              reason,
              stoppedBy: "durability-watcher",
            }),
        }
        : {}),
      onError,
    });
  }

  /**
   * Every model call the durability sweep can reach, bounded (#41).
   *
   * The sweep runs inside a 5-second `setInterval`, so an unbounded provider
   * call would hold a tick open for as long as the provider hangs. The abort
   * signal reaches `runtime.complete`; the race bounds the call even when the
   * injected completion seam ignores the signal, which is what makes this
   * testable and what stops a stubbed or non-compliant provider from stalling
   * the feed. Nothing is retried and the run is never touched on a timeout.
   */
  private async durabilityCompleteJson(
    call: Omit<ContextEngineeringModelCall, "signal" | "timeoutMs">,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DurabilityModelTimeoutError(call.model, DURABILITY_MODEL_TIMEOUT_MS));
      }, DURABILITY_MODEL_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        this.completeJson({
          ...call,
          signal: controller.signal,
          timeoutMs: DURABILITY_MODEL_TIMEOUT_MS,
        }),
        expiry,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispatchLateralPass(request: DispatchLateralPassRequest) {
    return this.registry.dispatch(LATERAL_PASS_BEHAVIOR, {
      capability: "lateral-pass",
      runId: `lateral-${randomUUID()}`,
      payload: { ...request },
    });
  }

  private async repairAndRedeploy(request: WatcherRepairRequest) {
    const source = this.store.readRun(this.projectId, request.runId);
    if (!source) throw new Error(`Context repair source run ${request.runId} is missing.`);
    const sourceRecovery = recoverableSourceProof(source);
    if (!sourceRecovery) {
      const reason = `context-repair-requires-verified-recovery:${request.reason}`;
      const proposal = proposalReceipt(this.projectId, {
        runId: request.runId,
        ...(request.nodeId ? { nodeId: request.nodeId } : {}),
        reason,
      });
      return {
        redeployed: false,
        proposal: { proposalId: proposal.proposalId, reason },
        detail: `${proposal.detail} No replacement was created or started.`,
      };
    }
    const definitionAtAudit = this.store.readDefinition(
      this.projectId,
      source.manifest.workflowId,
    );
    if (!definitionAtAudit) throw new Error(`Workflow ${source.manifest.workflowId} is missing.`);
    const expectedRevision = definitionAtAudit.revision;
    const repairedGraph = await this.durabilityCompleteJson({
      projectId: this.projectId,
      model: request.model,
      instruction: [
        "Repair the supplied WorkflowGraphDocument to remove the detected context rot.",
        "Preserve all additive capabilities and return the complete repaired document.",
      ].join(" "),
      input: {
        request,
        workflowRevision: expectedRevision,
        workflow: definitionAtAudit.graph,
        // Row 24: the failing run's context, carried through the escalate
        // dispatch. `request` already carries it, but it is named separately
        // here so a repair prompt cannot lose it in the request envelope.
        ...(request.carriedContext ? { carriedContext: request.carriedContext } : {}),
      },
    });
    const current = this.store.readDefinition(this.projectId, source.manifest.workflowId);
    if (!current) throw new Error(`Workflow ${source.manifest.workflowId} is missing.`);
    if (current.revision !== expectedRevision) {
      throw new CompactionWatcherRetryableRepairError(
        `Workflow ${source.manifest.workflowId} changed from revision ${expectedRevision} to ${current.revision} while repair was running.`,
      );
    }
    let saved: ReturnType<WorkflowStore["saveDefinition"]>;
    try {
      saved = this.store.saveDefinition(
        this.projectId,
        source.manifest.workflowId,
        repairedGraph,
        { expectedRevision },
      );
    } catch (error) {
      if (error instanceof WorkflowStoreError && error.code === "CONFLICT") {
        throw new CompactionWatcherRetryableRepairError(
          `Workflow ${source.manifest.workflowId} changed after revision ${expectedRevision} was audited.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (saved.revision === expectedRevision) {
      return { redeployed: false, detail: "Repair model did not produce a new workflow revision." };
    }
    const replacement = this.store.createRun(this.projectId, {
      workflowId: saved.id,
      expectedWorkflowRevision: saved.revision,
      requestId: repairRequestId(request.runId, request.auditIdentity),
      requestedBy: "agent",
      ...(source.manifest.sessionId ? { sessionId: source.manifest.sessionId } : {}),
      input: {
        ...(source.manifest.input.goal ? { goal: source.manifest.input.goal } : {}),
        ...(source.manifest.input.files ? { files: source.manifest.input.files } : {}),
        variables: {
          ...(source.manifest.input.variables ?? {}),
          _kadyContextRepair: {
            sourceRunId: request.runId,
            auditIdentity: request.auditIdentity,
            workflowRevision: saved.revision,
            sourceCheckpointId: sourceRecovery.checkpointId,
            sourceLastSeq: source.state.lastSeq,
            sourceGraphSha256: source.manifest.graphSha256,
            sideEffectSafety: sourceRecovery.sideEffectSafety,
          },
        },
      },
    });
    return {
      redeployed: true,
      workflowRevision: saved.revision,
      recovery: {
        runId: request.runId,
        checkpointId: sourceRecovery.checkpointId,
        restartToken: `replacement:${replacement.id}:${request.auditIdentity}`,
        verified: true as const,
        sideEffectSafety: sourceRecovery.sideEffectSafety,
      },
      detail: `Persisted workflow revision ${saved.revision} and replacement ${replacement.id}.`,
    };
  }

  private async restartWorkflow(request: WatcherRestartRequest) {
    if (!this.controller) return { resumed: false, detail: "Workflow execution is disabled." };
    const native = /^native:(wrun_[a-f0-9]{32}):([0-9]+):([a-f0-9]{64})$/.exec(
      request.recovery.restartToken,
    );
    if (native) {
      const current = this.store.readRun(this.projectId, native[1]);
      if (
        !current || current.manifest.id !== request.runId ||
        current.state.status !== "interrupted" || !current.state.recoverable ||
        current.state.lastSeq !== Number(native[2]) || current.manifest.graphSha256 !== native[3]
      ) return { resumed: false, detail: "Native restart proof no longer matches durable run state." };
      this.controller.resume(this.projectId, current.manifest.id);
      return { resumed: true, detail: `Watcher resumed ${current.manifest.id}.` };
    }
    const replacement = /^replacement:(wrun_[a-f0-9]{32}):([a-f0-9]{64})$/.exec(
      request.recovery.restartToken,
    );
    if (!replacement) return { resumed: false, detail: "Watcher restart token is invalid." };
    const run = this.store.readRun(this.projectId, replacement[1]);
    const repair = run?.manifest.input.variables?._kadyContextRepair as
      | Record<string, unknown>
      | undefined;
    if (
      !run || repair?.sourceRunId !== request.runId ||
      repair.auditIdentity !== replacement[2] ||
      repair.sourceCheckpointId !== request.recovery.checkpointId ||
      repair.sideEffectSafety !== request.recovery.sideEffectSafety ||
      !Number.isSafeInteger(repair.sourceLastSeq) ||
      typeof repair.sourceGraphSha256 !== "string"
    ) return { resumed: false, detail: "Replacement restart proof does not match its manifest." };
    const source = this.store.readRun(this.projectId, request.runId);
    if (
      !source || source.state.status !== "interrupted" || !source.state.recoverable ||
      source.state.lastSeq !== repair.sourceLastSeq ||
      source.manifest.graphSha256 !== repair.sourceGraphSha256
    ) return { resumed: false, detail: "Replacement source recovery proof is no longer valid." };
    if (run.state.status === "queued") this.controller.start(this.projectId, run.manifest.id);
    else if (!["running", "waiting", "blocked", "paused", "succeeded"].includes(run.state.status)) {
      return { resumed: false, detail: `Replacement run is ${run.state.status}.` };
    }
    return { resumed: true, detail: `Watcher started replacement ${run.manifest.id}.` };
  }
}

/** Real server composition for all S7 registry behaviors and durable event feeds. */
export class ContextEngineeringProduction {
  private readonly runtimes = new Map<string, ProjectContextEngineeringRuntime>();
  private readonly store: WorkflowStore;
  private readonly completeJson: (call: ContextEngineeringModelCall) => Promise<unknown>;
  private readonly onError: (error: unknown) => void;
  private readonly removeCompactionSink: () => void;
  private readonly seenStoppedRuns = new Set<string>();
  private readonly durabilitySettings: DurabilitySettingsStore;
  private readonly durabilityJournal: DurabilityJournal;
  private readonly presetResolver: DurabilityPresetResolver | undefined;
  private stoppedRunTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * #41: the 5-second feed must not stack sweeps. A durability sweep now makes
   * real provider calls, so under a slow provider each tick would start another
   * full project sweep while the previous escalation was still awaiting, and
   * the pre-existing restart scan would queue behind all of them. A tick that
   * arrives while a sweep is in flight is a no-op.
   */
  private observingDurability = false;
  private skippedDurabilitySweeps = 0;

  constructor(
    private readonly controller: WorkflowRunController | null,
    options: ContextEngineeringProductionOptions = {},
  ) {
    this.store = options.store ?? workflowStore;
    this.completeJson = options.completeJson ?? productionCompleteJson;
    this.onError = options.onError ?? (() => {});
    this.durabilitySettings = options.durabilitySettings ?? new FileDurabilitySettingsStore();
    this.durabilityJournal = options.durabilityJournal ?? new FileDurabilityJournal();
    this.presetResolver = options.presetResolver;
    this.removeCompactionSink = installDagFusionCompactionEventSink(
      (event) => this.handleDagFusionCompaction(event),
      { onError: this.onError },
    );
  }

  forProject(projectId: string): ProjectContextEngineeringRuntime {
    let runtime = this.runtimes.get(projectId);
    if (!runtime) {
      runtime = new ProjectContextEngineeringRuntime(
        projectId,
        this.controller,
        this.store,
        this.completeJson,
        this.durabilitySettings,
        this.durabilityJournal,
        this.presetResolver,
        this.onError,
      );
      this.runtimes.set(projectId, runtime);
    }
    return runtime;
  }

  dispatchLateralPass(projectId: string, request: DispatchLateralPassRequest) {
    return this.forProject(projectId).dispatchLateralPass(request);
  }

  async handleDagFusionCompaction(event: DagFusionCompactionEvent): Promise<void> {
    for (const project of listProjects()) {
      const source = this.store.readRun(project.id, event.ownerRunId);
      if (!source) continue;
      const paths = resolvePaths(project.id);
      const records = readTrustedDagFusionCompactionRecords(paths.sandbox, event.childRunId);
      const runtime = this.forProject(project.id);
      for (const record of records) {
        const request = {
          runId: event.ownerRunId,
          ...(event.nodeId ? { nodeId: event.nodeId } : {}),
          childRunId: event.childRunId,
          sandboxRoot: paths.sandbox,
          preCompactionRecord: record.preCompactionRecord,
          compactedSummary: record.compactedSummary,
          userPrompt: record.userPrompt,
          goal: record.goal,
          openTodos: record.openTodos,
        };
        // Durability owns the compaction and context-rot toggles. When it is
        // switched off the pre-existing watcher runs unchanged, so nothing
        // that worked before this lane depends on the new settings.
        const durabilityResult = await runtime.durability.watchCompaction(request);
        if (durabilityResult.status === "disabled") {
          await runtime.registration.watcher.watch(request);
        }
      }
      return;
    }
    throw new Error(
      `Compaction event source run ${event.ownerRunId} is not yet available for durable delivery.`,
    );
  }

  /**
   * Durability settings for a project, and how its models resolve right now.
   *
   * This is a READ. It deliberately does not call `forProject`, which would
   * instantiate a per-project runtime, register behaviours, construct the file
   * operation store (creating a state directory and publishing a process
   * identity) and cache all of it forever — as a side effect of a GET. A
   * project the watcher is not yet observing simply reports no watched runs,
   * which is the truth.
   */
  durabilityState(projectId: string) {
    const settings = this.durabilitySettings.read(projectId);
    const runtime = this.runtimes.get(projectId);
    const watchedRuns = runtime?.durability.watchedRuns() ?? [];
    return {
      settings,
      resolution: resolveDurabilityModels(settings, this.presetResolver),
      watchedRuns,
      stopPolicy: settings.stopPolicy,
      // §6.7: F6 must be able to render a Stop control disabled WITH A REASON
      // before the click, not discover the refusal from a 409 after it.
      stopAvailability: watchedRuns.map((run) => this.stopAvailability(settings, run)),
    };
  }

  /** "Can this run be stopped, and if not, why not" — as data, before the click. */
  private stopAvailability(
    settings: DurabilitySettingsV1,
    run: { runId: string; status: string; stops: number },
  ): { runId: string; canStop: boolean; reason?: string } {
    if (!this.controller) {
      return {
        runId: run.runId,
        canStop: false,
        reason: "Workflow execution is disabled in this build, so a run cannot be stopped.",
      };
    }
    if (!settings.stopPolicy.allowStop) {
      return {
        runId: run.runId,
        canStop: false,
        reason:
          "Stopping runs is switched off. Turn on Pipeline options ▸ Durability ▸ Allow stop.",
      };
    }
    if (!["queued", "running", "waiting", "blocked", "paused"].includes(run.status)) {
      return {
        runId: run.runId,
        canStop: false,
        reason: `This run is ${run.status}, so there is nothing left to stop.`,
      };
    }
    if (run.stops >= settings.stopPolicy.maxStopsPerRun) {
      return {
        runId: run.runId,
        canStop: false,
        reason:
          `This run has already been stopped ${run.stops} time(s), the configured maximum. ` +
          "Raise the stop limit in Pipeline options ▸ Durability.",
      };
    }
    return { runId: run.runId, canStop: true };
  }

  writeDurabilitySettings(projectId: string, patch: unknown): DurabilitySettingsV1 {
    const merged = parseDurabilitySettings(patch, this.durabilitySettings.read(projectId));
    return this.durabilitySettings.write(projectId, merged);
  }

  durabilityTimeline(
    projectId: string,
    runId: string,
    options?: { after?: number; limit?: number },
  ): DurabilityTimelinePage {
    return this.durabilityJournal.read(projectId, runId, options);
  }

  /** An operator-requested stop. Same seam the watcher uses, different actor. */
  stopRun(projectId: string, runId: string, reason: string): WorkflowRunStopReceipt {
    if (!this.controller) {
      throw new Error("Workflow execution is disabled in this build, so a run cannot be stopped.");
    }
    const receipt = this.controller.stopRun(projectId, runId, {
      reason,
      stoppedBy: "operator",
    });
    const run = this.store.readRun(projectId, runId);
    this.durabilityJournal.append(projectId, {
      name: "durability.stop.completed",
      runId,
      runLastSeq: run?.state.lastSeq ?? 0,
      action: "stop",
      ok: receipt.stopped,
      detail: `An operator stopped this run: ${reason}.`,
    });
    return receipt;
  }

  /** How many ticks were skipped because a sweep was still in flight. */
  durabilitySweepsSkipped(): number {
    return this.skippedDurabilitySweeps;
  }

  async observeDurability(): Promise<DurabilityObservation[]> {
    if (this.observingDurability) {
      this.skippedDurabilitySweeps += 1;
      return [];
    }
    this.observingDurability = true;
    const observations: DurabilityObservation[] = [];
    try {
      for (const project of listProjects()) {
        // One unreadable project must not take the background feed down with
        // it. A feed that throws is how a backend gets orphaned (#41).
        try {
          observations.push(...await this.forProject(project.id).durability.observeProject());
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.observingDurability = false;
    }
    return observations;
  }

  async scanStoppedRuns(): Promise<void> {
    // The durability watcher rides this existing feed rather than starting a
    // timer of its own: one lifecycle, nothing new that can be orphaned (#41).
    await this.observeDurability().catch((error) => {
      this.onError(error);
      return [];
    });
    for (const project of listProjects()) {
      for (const run of this.store.listRuns(project.id, 200)) {
        if (!["blocked", "failed", "interrupted"].includes(run.state.status)) continue;
        const identity = `${project.id}:${run.manifest.id}:${run.state.status}:${run.state.lastSeq}`;
        if (this.seenStoppedRuns.has(identity)) continue;
        const recovery = recoverableSourceProof(run);
        await this.forProject(project.id).registration.watcher.restartStoppedWorkflow({
          runId: run.manifest.id,
          status: run.state.status,
          ...(recovery ? { recovery } : {}),
          resumeResponse: {
            resumable: run.state.recoverable,
            restartRequired: !run.state.recoverable,
            ...(run.state.lastError?.message
              ? { restartWarning: run.state.lastError.message }
              : {}),
          },
        });
        this.seenStoppedRuns.add(identity);
      }
    }
  }

  startStoppedRunFeed(): void {
    if (this.stoppedRunTimer) return;
    void this.scanStoppedRuns().catch(this.onError);
    this.stoppedRunTimer = setInterval(() => {
      void this.scanStoppedRuns().catch(this.onError);
    }, STOPPED_RUN_POLL_MS);
    this.stoppedRunTimer.unref();
  }

  close(): void {
    if (this.stoppedRunTimer) clearInterval(this.stoppedRunTimer);
    this.stoppedRunTimer = undefined;
    for (const runtime of this.runtimes.values()) runtime.durability.close();
    this.removeCompactionSink();
  }
}
