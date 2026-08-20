import { createHash } from "node:crypto";
import type { WorkflowBehaviorRegistry } from "./behavior-registry.ts";
import {
  COMPACTION_WATCHER_BEHAVIOR,
  compactionAuditIdentity,
  fingerprintFailure,
  parseCompactionSemanticVerdict,
  validateSemanticRecord,
  type CompactionSemanticModel,
  type CompactionSemanticVerdict,
  type CompactionWatcherBehaviorResult,
  type WatchCompactionRequest,
} from "./compaction-watcher.ts";
import { LATERAL_PASS_BEHAVIOR, type LateralPassMessage } from "../context/lateral-pass.ts";
import type { TrustedDagFusionCompactionAudit } from
  "../../pi-packages/dag-fusion-drive/compaction-audit.ts";
import type { WorkflowRunEventV1, WorkflowRunStatus } from "./run-state.ts";
import type { WorkflowRunRecord } from "./store.ts";
import type { WorkflowRunStopReceipt } from "./controller.ts";
import {
  durabilitySignalDescriptor,
  type DurabilityAction,
  type DurabilitySettingsV1,
  type DurabilitySignalId,
} from "./durability-settings.ts";
import {
  requireDurabilityModel,
  resolveDurabilityModels,
  DurabilityModelUnavailableError,
  type DurabilityPresetResolver,
  type DurabilityModelResolution,
  type DurabilityResolutionReport,
} from "./durability-model-policy.ts";
import type { DurabilityJournal, DurabilityTimelineEvent } from "./durability-journal.ts";

/**
 * ONE durability watcher.
 *
 * Rows 23 and 44 are the same capability reached two ways, so this module is
 * the only implementation and both the pipeline-options UI and the workflow
 * supervisor skill drive it. It does not fork the compaction watcher: it reuses
 * that module's audit parsing, dispatches the SAME registered behaviors
 * (`escalate-fix-redeploy`, `lateral-pass`) through the SAME frozen registry,
 * and adds only what was missing — per-signal toggles, an operator-selected
 * model, stop authority, and a timeline.
 */

/** Node kinds that execute an external process, and can therefore fail as a script. */
const PROCESS_EXECUTING_NODE_KINDS = new Set(["lean4"]);

const STALLABLE_STATUSES = new Set<WorkflowRunStatus>(["paused", "waiting", "blocked"]);
// `interrupted` is deliberately NOT terminal: it is the recoverable state the
// existing feed already acts on, and the state a durability escalation repairs.
const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);
const RUN_EVENT_PAGE = 200;
const MAX_RUN_EVENT_PAGES = 32;

export interface DurabilityRunSource {
  readRun(projectId: string, runId: string): WorkflowRunRecord | null;
  listRuns(projectId: string, limit?: number): WorkflowRunRecord[];
  readRunEvents(
    projectId: string,
    runId: string,
    options?: { after?: number; limit?: number },
  ): { events: WorkflowRunEventV1[]; lastSeq: number; hasMore: boolean };
}

export interface DurabilityStopSeam {
  (runId: string, reason: string): WorkflowRunStopReceipt;
}

export interface DurabilityWatcherDependencies {
  projectId: string;
  /** Read on every observation, so a settings change takes effect immediately. */
  readSettings(): DurabilitySettingsV1;
  journal: DurabilityJournal;
  registry: WorkflowBehaviorRegistry;
  runs: DurabilityRunSource;
  stopRun?: DurabilityStopSeam;
  semanticModel: CompactionSemanticModel;
  readFingerprintAudit(
    sandboxRoot: string,
    childRunId: string,
  ): TrustedDagFusionCompactionAudit;
  presetResolver?: DurabilityPresetResolver;
  now?: () => number;
  onError?(error: unknown): void;
}

export interface DurabilityWatchedRun {
  runId: string;
  status: WorkflowRunStatus;
  lastSeq: number;
  lastObservedAt: number;
  firedSignals: DurabilitySignalId[];
  stops: number;
}

export interface DurabilitySignalFire {
  runId: string;
  signal: DurabilitySignalId;
  action: DurabilityAction;
  /**
   * TRUE only when the action actually took effect: the run was restarted, the
   * run was stopped, a clean window was opened, or — for `escalate` — a repaired
   * workflow revision was deployed and a replacement run was created.
   *
   * It is deliberately NOT "a behavior handler resolved". `repairAndRedeploy`
   * resolves normally with `redeployed:false` and an unapplied proposal whenever
   * the run is not `interrupted`-and-recoverable, which is the COMMON case; round
   * 1 reported that as a success and told F6 the run had continued when no
   * revision and no replacement run existed. See `proposalId`.
   */
  dispatched: boolean;
  /** The unapplied rescue proposal, when an escalation deferred instead of repairing. */
  proposalId?: string;
  detail: string;
}

/** What `#dispatch` reports back to `#act`, so `ok` and `dispatched` can tell the truth. */
interface DurabilityDispatchOutcome {
  detail: string;
  /** Did the action actually change the run? See DurabilitySignalFire.dispatched. */
  effective: boolean;
  proposalId?: string;
}

/**
 * The failing run's context, carried to the rescue model so it repairs the DAG
 * with knowledge of what went wrong rather than from the graph alone. This is
 * row 24's "the larger model receives the context" and it now reaches the
 * provider call: `escalate-fix-redeploy` threads it into the repair input.
 */
export interface DurabilityCarriedContext {
  runId: string;
  signal: DurabilitySignalId;
  runStatus: string;
  goal: string;
  userPrompt: string;
  openTodos: string[];
  transcript: LateralPassMessage[];
}

export interface DurabilityObservation {
  runId: string;
  fires: DurabilitySignalFire[];
  suppressed: DurabilitySignalId[];
}

interface RunWatchState {
  cursor: number;
  counts: Map<DurabilitySignalId, number>;
  fired: Set<DurabilitySignalId>;
  stops: number;
  status: WorkflowRunStatus;
  lastSeq: number;
  unchangedSince: number;
  lastObservedAt: number;
}

/**
 * A deterministic identity for a non-compaction escalation, so a retried
 * escalation lands on the same durable watcher operation instead of
 * redeploying twice.
 */
function signalAuditIdentity(
  runId: string,
  signal: DurabilitySignalId,
  runLastSeq: number,
): string {
  return createHash("sha256")
    .update(runId, "utf8")
    .update("\0")
    .update(signal, "utf8")
    .update("\0")
    .update(String(runLastSeq), "utf8")
    .digest("hex");
}

/**
 * The reasoning-effort routing form OpenRouter actually accepts: the effort
 * rides the model id (`…-xhigh`), which is what reaches the provider call.
 * Without this, an "effort" setting would be accepted and then dropped.
 */
export function durabilityDispatchRef(
  model: { ref: string; effort?: string },
): string {
  return model.effort ? `${model.ref}-${model.effort}` : model.ref;
}

export class DurabilityWatcher {
  readonly #dependencies: DurabilityWatcherDependencies;
  readonly #runState = new Map<string, RunWatchState>();
  readonly #now: () => number;

  constructor(dependencies: DurabilityWatcherDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => Date.now());
  }

  resolution(): DurabilityResolutionReport {
    return resolveDurabilityModels(
      this.#dependencies.readSettings(),
      this.#dependencies.presetResolver,
    );
  }

  watchedRuns(): DurabilityWatchedRun[] {
    return [...this.#runState.entries()].map(([runId, state]) => ({
      runId,
      status: state.status,
      lastSeq: state.lastSeq,
      lastObservedAt: state.lastObservedAt,
      firedSignals: [...state.fired],
      stops: state.stops,
    }));
  }

  /** Forget a run. Called when a run reaches a terminal state, and on close. */
  forget(runId: string, detail: string): void {
    const state = this.#runState.get(runId);
    if (!state) return;
    this.#runState.delete(runId);
    this.#journal({
      name: "durability.watch.stopped",
      runId,
      runLastSeq: state.lastSeq,
      detail,
    });
  }

  /** Nothing survives the watcher: no timers here, and no per-run state either. */
  close(): void {
    for (const runId of [...this.#runState.keys()]) {
      this.forget(runId, "The durability watcher stopped observing this run.");
    }
  }

  #journal(
    event: Omit<DurabilityTimelineEvent, "seq" | "ts">,
  ): DurabilityTimelineEvent | undefined {
    try {
      return this.#dependencies.journal.append(this.#dependencies.projectId, event);
    } catch (error) {
      this.#dependencies.onError?.(error);
      return undefined;
    }
  }

  #stateFor(run: WorkflowRunRecord): RunWatchState {
    const existing = this.#runState.get(run.manifest.id);
    if (existing) return existing;
    const created: RunWatchState = {
      cursor: 0,
      counts: new Map(),
      fired: new Set(),
      stops: 0,
      status: run.state.status,
      lastSeq: run.state.lastSeq,
      unchangedSince: this.#now(),
      lastObservedAt: this.#now(),
    };
    this.#runState.set(run.manifest.id, created);
    this.#journal({
      name: "durability.watch.started",
      runId: run.manifest.id,
      runLastSeq: run.state.lastSeq,
      detail: `The durability watcher is observing this run (${run.state.status}).`,
    });
    return created;
  }

  /**
   * Observe every non-terminal run in the project once. This is called from the
   * existing background feed, so it inherits that lifecycle and adds no timer,
   * no process, and nothing that can outlive the server (#41).
   */
  async observeProject(): Promise<DurabilityObservation[]> {
    const settings = this.#dependencies.readSettings();
    if (!settings.enabled) return [];
    const observations: DurabilityObservation[] = [];
    const live = new Set<string>();
    for (const run of this.#dependencies.runs.listRuns(this.#dependencies.projectId, 200)) {
      if (TERMINAL_STATUSES.has(run.state.status)) continue;
      live.add(run.manifest.id);
      observations.push(await this.observeRun(run.manifest.id));
    }
    for (const runId of [...this.#runState.keys()]) {
      if (live.has(runId)) continue;
      this.forget(runId, "This run reached a terminal state; the durability watcher released it.");
    }
    return observations;
  }

  /** Observe one run against the run-state-derived signals. */
  async observeRun(runId: string): Promise<DurabilityObservation> {
    const settings = this.#dependencies.readSettings();
    const observation: DurabilityObservation = { runId, fires: [], suppressed: [] };
    if (!settings.enabled) return observation;
    const run = this.#dependencies.runs.readRun(this.#dependencies.projectId, runId);
    if (!run) return observation;
    const state = this.#stateFor(run);
    state.lastObservedAt = this.#now();

    const pending = new Map<DurabilitySignalId, number>();
    for (const event of this.#drainEvents(runId, state)) {
      const signal = this.#signalForEvent(event, run);
      if (!signal) continue;
      pending.set(signal, (pending.get(signal) ?? 0) + 1);
    }

    if (run.state.lastSeq !== state.lastSeq || run.state.status !== state.status) {
      state.lastSeq = run.state.lastSeq;
      state.status = run.state.status;
      state.unchangedSince = this.#now();
    } else if (
      STALLABLE_STATUSES.has(run.state.status) &&
      this.#now() - state.unchangedSince >= settings.stallMs
    ) {
      pending.set("paused-no-progress", (pending.get("paused-no-progress") ?? 0) + 1);
      // Restart the stall clock so one stall does not fire on every tick.
      state.unchangedSince = this.#now();
    }

    for (const [signal, increment] of pending) {
      const descriptor = durabilitySignalDescriptor(signal);
      const setting = settings.signals[signal];
      if (!setting.enabled || descriptor.observability === "none") {
        observation.suppressed.push(signal);
        this.#journal({
          name: "durability.signal.suppressed",
          runId,
          runLastSeq: run.state.lastSeq,
          signal,
          detail: `${descriptor.label} was observed but its toggle is off.`,
        });
        continue;
      }
      const total = (state.counts.get(signal) ?? 0) + increment;
      if (total < setting.threshold) {
        state.counts.set(signal, total);
        continue;
      }
      state.counts.set(signal, 0);
      state.fired.add(signal);
      this.#journal({
        name: "durability.signal.fired",
        runId,
        runLastSeq: run.state.lastSeq,
        signal,
        action: setting.action,
        detail: `${descriptor.label} fired: ${descriptor.firesWhen}.`,
      });
      observation.fires.push(
        await this.#act(run, state, signal, setting.action, settings),
      );
    }
    return observation;
  }

  #drainEvents(runId: string, state: RunWatchState): WorkflowRunEventV1[] {
    const drained: WorkflowRunEventV1[] = [];
    for (let pageIndex = 0; pageIndex < MAX_RUN_EVENT_PAGES; pageIndex += 1) {
      const page = this.#dependencies.runs.readRunEvents(this.#dependencies.projectId, runId, {
        after: state.cursor,
        limit: RUN_EVENT_PAGE,
      });
      if (page.events.length === 0) break;
      drained.push(...page.events);
      state.cursor = page.events.at(-1)!.seq;
      if (!page.hasMore) break;
    }
    return drained;
  }

  /**
   * The observable-state rule for every run-event-derived signal. A signal with
   * no source of truth in this build returns undefined here and can never fire,
   * which is why the API reports it as unobservable rather than pretending.
   */
  #signalForEvent(
    event: WorkflowRunEventV1,
    run: WorkflowRunRecord,
  ): DurabilitySignalId | undefined {
    if (
      (event.type === "evidence_checked" || event.type === "gate_evaluated") &&
      event.data?.supported === false
    ) {
      return "hallucination";
    }
    if (event.type === "node_failed" && event.nodeId) {
      const node = run.manifest.graph.nodes.find((candidate) => candidate.id === event.nodeId);
      if (node && PROCESS_EXECUTING_NODE_KINDS.has(node.kind)) return "failed-script-run";
    }
    return undefined;
  }

  async #act(
    run: WorkflowRunRecord,
    state: RunWatchState,
    signal: DurabilitySignalId,
    action: DurabilityAction,
    settings: DurabilitySettingsV1,
  ): Promise<DurabilitySignalFire> {
    const runId = run.manifest.id;
    const runLastSeq = run.state.lastSeq;
    if (action === "observe") {
      return { runId, signal, action, dispatched: false, detail: "Recorded, no action taken." };
    }

    this.#journal({
      name: "durability.action.dispatched",
      runId,
      runLastSeq,
      signal,
      action,
      detail: `Dispatching ${action} for ${durabilitySignalDescriptor(signal).label}.`,
    });

    try {
      const outcome = await this.#dispatch(run, state, signal, action, settings);
      this.#journal({
        name: "durability.action.completed",
        runId,
        runLastSeq,
        signal,
        action,
        // `ok` follows the EFFECT, not the fact that a handler resolved.
        ok: outcome.effective,
        ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}),
        detail: outcome.detail,
      });
      return {
        runId,
        signal,
        action,
        dispatched: outcome.effective,
        ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}),
        detail: outcome.detail,
      };
    } catch (error) {
      const failure = error instanceof DurabilityModelUnavailableError
        ? error
        : undefined;
      const detail = error instanceof Error ? error.message : "The durability action failed.";
      this.#journal({
        name: failure ? "durability.model.unresolved" : "durability.action.failed",
        runId,
        runLastSeq,
        signal,
        action,
        ok: false,
        detail,
      });
      this.#dependencies.onError?.(error);
      // The run is deliberately left exactly as it was: a watcher that cannot
      // act must not also damage what it was watching.
      return { runId, signal, action, dispatched: false, detail };
    }
  }

  async #dispatch(
    run: WorkflowRunRecord,
    state: RunWatchState,
    signal: DurabilitySignalId,
    action: DurabilityAction,
    settings: DurabilitySettingsV1,
  ): Promise<DurabilityDispatchOutcome> {
    const runId = run.manifest.id;
    if (action === "stop") return this.#stop(run, state, signal, settings);
    if (action === "restart") {
      const result = await this.#dependencies.registry.dispatch(COMPACTION_WATCHER_BEHAVIOR, {
        capability: "restart-workflow",
        runId,
        payload: { reason: `durability:${signal}` },
      }) as CompactionWatcherBehaviorResult;
      return {
        detail: result.detail ?? `Requested a restart of ${runId}.`,
        effective: result.resumed !== false,
      };
    }
    const rescue = this.#requireRescue();
    if (action === "lateral-pass") {
      return this.#lateralPass(run, signal, rescue);
    }
    return this.#escalate(run, signal, action, rescue);
  }

  /**
   * Row 24. The rescue model receives the failing run's context AND its graph,
   * repairs the DAG, and the run continues — through the SAME
   * `escalate-fix-redeploy` behavior the compaction watcher already registers.
   *
   * Round 1 also fired a separate `lateral-pass` here first. That bought a
   * second call at the same 1M-context model at xhigh whose summary was
   * concatenated into a detail string and never reached the repair, and each
   * one left a real chat session in the project that nobody opened (production's
   * `openCleanWindow` calls `createSession`). The context is now carried in the
   * escalate payload instead: one paid call, no orphaned session, and the thing
   * row 24 asks for actually reaches the provider. `lateral-pass` remains its
   * own action, where the clean session is the deliberate product.
   */
  async #escalate(
    run: WorkflowRunRecord,
    signal: DurabilitySignalId,
    action: DurabilityAction,
    rescue: { ref: string; effort?: DurabilityEffortValue },
  ): Promise<DurabilityDispatchOutcome> {
    const runId = run.manifest.id;
    this.#journal({
      name: "durability.escalation.started",
      runId,
      runLastSeq: run.state.lastSeq,
      signal,
      action,
      model: rescue.ref,
      ...(rescue.effort ? { effort: rescue.effort } : {}),
      detail: `Carrying this run's context to ${rescue.ref} to repair the workflow.`,
    });
    const result = await this.#dependencies.registry.dispatch(COMPACTION_WATCHER_BEHAVIOR, {
      capability: "escalate-fix-redeploy",
      runId,
      payload: {
        reason: `durability:${signal}`,
        auditIdentity: signalAuditIdentity(runId, signal, run.state.lastSeq),
        repairModel: durabilityDispatchRef(rescue),
        carriedContext: this.#carriedContext(run, signal),
      },
    }) as CompactionWatcherBehaviorResult;

    // THE distinction this whole branch exists for. `repairAndRedeploy` returns
    // `redeployed:false` with an unapplied proposal — a normal resolve, not a
    // throw — whenever the run is not `interrupted`-and-recoverable, which is
    // every escalation on a *running* run. No revision was created and no
    // replacement run exists, so nothing here may say the run continued.
    if (result.redeployed !== true) {
      const proposalId = result.proposal?.proposalId;
      const detail = proposalId
        ? `The rescue model did not repair this run. An unapplied rescue proposal (${proposalId}) ` +
          "is waiting for approval; the run was left exactly as it was."
        : "The rescue model did not repair this run, and no replacement run was created. " +
          "The run was left exactly as it was.";
      this.#journal({
        name: "durability.escalation.deferred",
        runId,
        runLastSeq: run.state.lastSeq,
        signal,
        action,
        model: rescue.ref,
        ...(rescue.effort ? { effort: rescue.effort } : {}),
        ...(proposalId ? { proposalId } : {}),
        ok: false,
        detail: result.detail ? `${detail} ${result.detail}` : detail,
      });
      return {
        detail: result.detail ? `${detail} ${result.detail}` : detail,
        effective: false,
        ...(proposalId ? { proposalId } : {}),
      };
    }

    const detail = result.detail ??
      `The rescue model repaired the workflow at revision ${String(result.workflowRevision)} and ` +
        "the run continued.";
    this.#journal({
      name: "durability.escalation.completed",
      runId,
      runLastSeq: run.state.lastSeq,
      signal,
      action,
      model: rescue.ref,
      ...(rescue.effort ? { effort: rescue.effort } : {}),
      ok: true,
      detail,
    });
    return { detail, effective: true };
  }

  #carriedContext(
    run: WorkflowRunRecord,
    signal: DurabilitySignalId,
  ): DurabilityCarriedContext {
    return {
      runId: run.manifest.id,
      signal,
      runStatus: run.state.status,
      goal: run.manifest.input.goal ?? `Complete workflow ${run.manifest.workflowId}.`,
      userPrompt: run.manifest.input.goal ?? `Continue workflow run ${run.manifest.id}.`,
      openTodos: this.#openTodos(run),
      transcript: this.#transcript(run, signal),
    };
  }

  #requireRescue(): { ref: string; effort?: DurabilityEffortValue } {
    const resolution = this.resolution().rescue;
    return requireDurabilityModel("rescue", resolution) as {
      ref: string;
      effort?: DurabilityEffortValue;
    };
  }

  async #lateralPass(
    run: WorkflowRunRecord,
    signal: DurabilitySignalId,
    rescue: { ref: string; effort?: DurabilityEffortValue },
  ): Promise<DurabilityDispatchOutcome> {
    const runId = run.manifest.id;
    // A lateral pass summarizes a CHAT SESSION into a new clean window. A run
    // id passes the behavior's session-id pattern, so round 1 substituted it
    // when a run had no session and the model was asked to summarize something
    // that is not a session. Fail closed instead.
    const sourceSessionId = run.manifest.sessionId;
    if (!sourceSessionId) {
      throw new Error(
        "This run has no chat session, so there is nothing for a lateral pass to carry into a " +
          "clean window. Choose Escalate for this signal in Pipeline options \u25b8 Durability.",
      );
    }
    this.#journal({
      name: "durability.escalation.started",
      runId,
      runLastSeq: run.state.lastSeq,
      signal,
      action: "lateral-pass",
      model: rescue.ref,
      ...(rescue.effort ? { effort: rescue.effort } : {}),
      detail: `Handing this run's session to ${rescue.ref} for a lateral pass.`,
    });
    const result = await this.#dependencies.registry.dispatch(LATERAL_PASS_BEHAVIOR, {
      capability: "lateral-pass",
      runId,
      payload: {
        sourceSessionId,
        userPrompt: run.manifest.input.goal ?? `Continue workflow run ${runId}.`,
        goal: run.manifest.input.goal ?? `Complete workflow ${run.manifest.workflowId}.`,
        openTodos: this.#openTodos(run),
        transcript: this.#transcript(run, signal),
        model: durabilityDispatchRef(rescue),
      },
    });
    const detail = result.detail ?? `Lateral pass to ${rescue.ref} completed.`;
    this.#journal({
      name: "durability.escalation.completed",
      runId,
      runLastSeq: run.state.lastSeq,
      signal,
      action: "lateral-pass",
      model: rescue.ref,
      ...(rescue.effort ? { effort: rescue.effort } : {}),
      ok: true,
      detail,
    });
    return { detail, effective: true };
  }

  #openTodos(run: WorkflowRunRecord): string[] {
    const todos = Object.values(run.state.executions)
      .filter((execution) => ["pending", "running", "failed", "interrupted"].includes(execution.status))
      .map((execution) => `Node ${execution.nodeId} is ${execution.status}.`);
    return todos.length > 0 ? todos : [`Workflow run ${run.manifest.id} has unfinished work.`];
  }

  #transcript(run: WorkflowRunRecord, signal: DurabilitySignalId): LateralPassMessage[] {
    const descriptor = durabilitySignalDescriptor(signal);
    const failures = Object.values(run.state.executions)
      .filter((execution) => execution.error)
      .map((execution) => `Node ${execution.nodeId}: ${execution.error!.message}`);
    return [
      {
        role: "user",
        content:
          `Workflow run ${run.manifest.id} is ${run.state.status}. The durability watcher ` +
          `fired ${descriptor.label} because ${descriptor.firesWhen}.`,
      },
      {
        role: "assistant",
        content: failures.length > 0
          ? `Unresolved node state:\n${failures.join("\n")}`
          : "No node reported an error; the run stopped making progress.",
      },
    ];
  }

  #stop(
    run: WorkflowRunRecord,
    state: RunWatchState,
    signal: DurabilitySignalId,
    settings: DurabilitySettingsV1,
  ): DurabilityDispatchOutcome {
    const runId = run.manifest.id;
    if (!settings.stopPolicy.allowStop) {
      throw new Error(
        "Stopping runs is switched off. Turn on Pipeline options ▸ Durability ▸ Allow stop to let the watcher stop a run.",
      );
    }
    if (state.stops >= settings.stopPolicy.maxStopsPerRun) {
      throw new Error(
        `This run has already been stopped ${state.stops} time(s), the configured maximum. ` +
          "Raise the stop limit in Pipeline options ▸ Durability to allow another stop.",
      );
    }
    if (!this.#dependencies.stopRun) {
      throw new Error(
        "Workflow execution is disabled in this build, so a run cannot be stopped.",
      );
    }
    const reason = `${durabilitySignalDescriptor(signal).label} fired`;
    this.#journal({
      name: "durability.stop.requested",
      runId,
      runLastSeq: run.state.lastSeq,
      signal,
      action: "stop",
      detail: `Requesting a stop of ${runId}: ${reason}.`,
    });
    const receipt = this.#dependencies.stopRun(runId, reason);
    state.stops += 1;
    this.#journal({
      name: "durability.stop.completed",
      runId,
      runLastSeq: run.state.lastSeq,
      signal,
      action: "stop",
      ok: receipt.stopped,
      detail:
        `Run stopped by the durability watcher; it is now ${receipt.terminalStatus}. ` +
        (receipt.distinguishedInRunEvents
          ? "The run timeline records this as a durability stop."
          : "The run timeline records this as a cancellation; this timeline records who stopped it."),
    });
    return { detail: receipt.detail, effective: receipt.stopped };
  }

  /**
   * The compaction and context-rot signals, which are observed from the
   * vendored compaction audit rather than from run events. Called by the
   * compaction event sink.
   */
  async watchCompaction(request: WatchCompactionRequest): Promise<{
    status: "disabled" | "suppressed" | "not-compacted" | "clean" | "fired";
    signal?: DurabilitySignalId;
    verdict?: CompactionSemanticVerdict;
    audit?: TrustedDagFusionCompactionAudit;
    detail?: string;
  }> {
    const settings = this.#dependencies.readSettings();
    if (!settings.enabled) return { status: "disabled" };
    const compaction = settings.signals.compaction;
    const contextRot = settings.signals["context-rot"];
    if (!compaction.enabled && !contextRot.enabled) return { status: "suppressed" };

    const audit = this.#dependencies.readFingerprintAudit(
      request.sandboxRoot,
      request.childRunId,
    );
    if (!audit.occurred) return { status: "not-compacted", audit };

    const run = this.#dependencies.runs.readRun(this.#dependencies.projectId, request.runId);
    const runLastSeq = run?.state.lastSeq ?? 0;
    const deterministic = fingerprintFailure(audit);
    if (deterministic) {
      if (!compaction.enabled) {
        this.#journal({
          name: "durability.signal.suppressed",
          runId: request.runId,
          runLastSeq,
          signal: "compaction",
          detail: "A compaction fingerprint check failed but the Compaction toggle is off.",
        });
        return { status: "suppressed", signal: "compaction", audit };
      }
      return {
        ...(await this.#fireCompactionSignal(
          request,
          "compaction",
          settings,
          compactionAuditIdentity(request, audit),
          runLastSeq,
        )),
        audit,
      };
    }

    if (!contextRot.enabled) {
      this.#journal({
        name: "durability.signal.suppressed",
        runId: request.runId,
        runLastSeq,
        signal: "context-rot",
        detail: "A compaction occurred but the Context rot toggle is off.",
      });
      return { status: "suppressed", signal: "context-rot", audit };
    }

    // The guard the path this replaces enforces (`compaction-watcher.ts:934`).
    // Without it an empty, malformed or over-bounds record goes straight to a
    // billed provider call whenever durability is switched on, which would make
    // a settings flag the difference between a validated and an unvalidated
    // audit. Throws CompactionWatcherError("INVALID_AUDIT_INPUT").
    validateSemanticRecord(request);
    const watcher = requireDurabilityModel("watcher", this.resolution().watcher);
    const verdict = parseCompactionSemanticVerdict(
      await this.#dependencies.semanticModel({
        model: durabilityDispatchRef(watcher),
        runId: request.runId,
        childRunId: request.childRunId,
        instruction:
          "Compare the compacted summary against the exact pre-compaction record and report " +
          "invented facts, missed open todos, and deviation from the user's prompt or goal.",
        preCompactionRecord: request.preCompactionRecord,
        compactedSummary: request.compactedSummary,
        userPrompt: request.userPrompt,
        goal: request.goal,
        openTodos: [...request.openTodos],
      }),
    );
    if (verdict.verdict === "clean") return { status: "clean", audit, verdict };
    const signal: DurabilitySignalId = verdict.hallucinations.length > 0 &&
        settings.signals.hallucination.enabled
      ? "hallucination"
      : "context-rot";
    return {
      ...(await this.#fireCompactionSignal(
        request,
        signal,
        settings,
        compactionAuditIdentity(request, audit),
        runLastSeq,
      )),
      audit,
      verdict,
    };
  }

  async #fireCompactionSignal(
    request: WatchCompactionRequest,
    signal: DurabilitySignalId,
    settings: DurabilitySettingsV1,
    auditIdentity: string,
    runLastSeq: number,
  ): Promise<{ status: "fired"; signal: DurabilitySignalId; detail: string }> {
    const descriptor = durabilitySignalDescriptor(signal);
    const action = settings.signals[signal].action;
    this.#journal({
      name: "durability.signal.fired",
      runId: request.runId,
      runLastSeq,
      signal,
      action,
      detail: `${descriptor.label} fired: ${descriptor.firesWhen}.`,
    });
    const run = this.#dependencies.runs.readRun(this.#dependencies.projectId, request.runId);
    if (run) {
      const state = this.#stateFor(run);
      state.fired.add(signal);
      const fire = await this.#act(run, state, signal, action, settings);
      return { status: "fired", signal, detail: fire.detail };
    }
    // The compaction audit can arrive for a child run whose owner is no longer
    // readable. Round 1 dispatched `escalate-fix-redeploy` here regardless of
    // the configured action AND with no repairModel, so the pre-existing
    // DEFAULT_COMPACTION_REPAIR_MODEL constant ran a DAG repair at a model the
    // operator never chose — while the rescue slot was deliberately unset. That
    // contradicted both of this lane's headline claims. Every action this
    // watcher can take (restart, stop, escalate, lateral pass) needs the run
    // record it no longer has, so the honest outcome is to record the failure
    // and change nothing.
    const detail =
      `${descriptor.label} fired for run ${request.runId}, but that run is no longer readable, ` +
      `so the configured ${action} action cannot be carried out. Nothing was changed. Reopen the ` +
      "run from the workflow list, or re-run the workflow.";
    this.#journal({
      name: "durability.action.failed",
      runId: request.runId,
      runLastSeq,
      signal,
      action,
      ok: false,
      detail,
    });
    // Referenced so the identity stays part of this branch's contract even
    // though nothing is dispatched with it.
    void auditIdentity;
    return { status: "fired", signal, detail };
  }
}

type DurabilityEffortValue = NonNullable<DurabilityModelResolution["effort"]>;
