import { createHash } from "node:crypto";
import type { WorkflowRunStatus } from "./run-state.ts";
// Lives in the durability module, not here: `workflows/index.ts` re-exports
// this file into a reviewed public export snapshot, and the stop code is
// durability's contract with the UI rather than the controller's.
import { DURABILITY_STOP_ERROR_CODE } from "./durability-settings.ts";
import {
  runWorkflowDag,
  WorkflowRunAbortError,
  type WorkflowNodeExecutor,
  type RunWorkflowDagOptions,
} from "./runner.ts";
import {
  WorkflowStore,
  WorkflowStoreError,
  workflowStore,
  type WorkflowRunRecord,
} from "./store.ts";

export const DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS = 8;
export const DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS_PER_PROJECT = 2;
export const DEFAULT_WORKFLOW_CONTROLLER_CLOSE_GRACE_MS = 5_000;
export const DEFAULT_WORKFLOW_RECOVERY_INTERVAL_MS = 5_000;

type WorkflowRunMode = "start" | "resume";

interface PendingWorkflowRun {
  projectId: string;
  runId: string;
  mode: WorkflowRunMode;
}

interface ActiveWorkflowRun extends PendingWorkflowRun {
  controller: AbortController;
  promise: Promise<void>;
}

export interface WorkflowRunControllerErrorInfo {
  projectId: string;
  runId: string;
  error: unknown;
}

export interface WorkflowRunControllerOptions {
  store?: WorkflowStore;
  createExecutor(
    projectId: string,
    runId: string,
  ): WorkflowNodeExecutor | Promise<WorkflowNodeExecutor>;
  runDag?: typeof runWorkflowDag;
  maxActiveRuns?: number;
  maxActiveRunsPerProject?: number;
  closeGraceMs?: number;
  onError?(info: WorkflowRunControllerErrorInfo): void;
  onRecoveryError?(error: unknown): void;
}

export interface WorkflowRunControllerSnapshot {
  pending: Array<Pick<PendingWorkflowRun, "projectId" | "runId" | "mode">>;
  active: Array<Pick<ActiveWorkflowRun, "projectId" | "runId" | "mode">>;
}

export interface WorkflowProjectRecoveryResult {
  projectId: string;
  interrupted: string[];
  active: string[];
  enqueued: string[];
  errors: Array<{ runId: string; message: string }>;
}

export interface WorkflowProjectQuiesceResult {
  projectId: string;
  cancellationRequested: string[];
  drained: boolean;
}

export type WorkflowRunStopActor = "durability-watcher" | "operator";

export interface WorkflowRunStopRequest {
  reason: string;
  stoppedBy: WorkflowRunStopActor;
}

export interface WorkflowRunStopReceipt {
  runId: string;
  stopped: boolean;
  /** A stop always lands on `cancelled`. Never `failed`. */
  terminalStatus: "cancelled";
  stoppedBy: WorkflowRunStopActor;
  reason: string;
  /**
   * False when the run held a live execution lease: the terminal event is then
   * written by the runner, which spells the code `USER_CANCELLED`. Callers must
   * fall back to the durability journal for attribution in that case.
   */
  distinguishedInRunEvents: boolean;
  detail: string;
}

export type WorkflowRunControllerErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_NOT_STARTABLE"
  | "RUN_NOT_RESUMABLE"
  | "RUN_NOT_CANCELLABLE"
  | "PROJECT_QUIESCING"
  | "CONTROLLER_CLOSED"
  | "INVALID_LIMIT";

export class WorkflowRunControllerError extends Error {
  constructor(
    readonly code: WorkflowRunControllerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRunControllerError";
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
    throw new WorkflowRunControllerError(
      "INVALID_LIMIT",
      `${label} must be an integer from 1 through 1024.`,
    );
  }
  return value;
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60_000) {
    throw new WorkflowRunControllerError(
      "INVALID_LIMIT",
      `${label} must be an integer from 1 through 86400000 milliseconds.`,
    );
  }
  return value;
}

function runKey(projectId: string, runId: string): string {
  return `${projectId}\0${runId}`;
}

function controllerEventId(
  label: string,
  projectId: string,
  runId: string,
  sequence: number,
): string {
  const digest = createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(label)
    .update("\0")
    .update(String(sequence))
    .digest("hex")
    .slice(0, 32);
  return `controller_${label}_${digest}`;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length <= 2_048 ? raw : `${raw.slice(0, 2_047)}…`;
}

function isInterruptibleStatus(
  status: WorkflowRunStatus,
): status is "running" | "waiting" | "blocked" | "paused" {
  return ["running", "waiting", "blocked", "paused"].includes(status);
}

/**
 * Process-local scheduler around the durable, lease-fenced DAG runner.
 *
 * The queue is only an optimization: queued run manifests remain the source
 * of truth, while every active run acquires its durable store lease inside
 * runWorkflowDag. A second backend therefore loses admission visibly instead
 * of executing the same run twice.
 */
export class WorkflowRunController {
  private readonly store: WorkflowStore;
  private readonly createExecutor: WorkflowRunControllerOptions["createExecutor"];
  private readonly runDag: typeof runWorkflowDag;
  private readonly maxActiveRuns: number;
  private readonly maxActiveRunsPerProject: number;
  private readonly closeGraceMs: number;
  private readonly onError: WorkflowRunControllerOptions["onError"];
  private readonly onRecoveryError: WorkflowRunControllerOptions["onRecoveryError"];
  private readonly pending: PendingWorkflowRun[] = [];
  private readonly pendingKeys = new Set<string>();
  private readonly active = new Map<string, ActiveWorkflowRun>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly quiescingProjects = new Set<string>();
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: WorkflowRunControllerOptions) {
    if (!options || typeof options.createExecutor !== "function") {
      throw new WorkflowRunControllerError(
        "INVALID_LIMIT",
        "A workflow node-executor factory is required.",
      );
    }
    this.store = options.store ?? workflowStore;
    this.createExecutor = options.createExecutor;
    this.runDag = options.runDag ?? runWorkflowDag;
    this.maxActiveRuns = positiveInteger(
      options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
      "maxActiveRuns",
    );
    this.maxActiveRunsPerProject = positiveInteger(
      options.maxActiveRunsPerProject ??
        DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS_PER_PROJECT,
      "maxActiveRunsPerProject",
    );
    this.closeGraceMs = boundedDuration(
      options.closeGraceMs ?? DEFAULT_WORKFLOW_CONTROLLER_CLOSE_GRACE_MS,
      "closeGraceMs",
    );
    this.onError = options.onError;
    this.onRecoveryError = options.onRecoveryError;
  }

  snapshot(): WorkflowRunControllerSnapshot {
    return {
      pending: this.pending.map(({ projectId, runId, mode }) => ({
        projectId,
        runId,
        mode,
      })),
      active: [...this.active.values()].map(({ projectId, runId, mode }) => ({
        projectId,
        runId,
        mode,
      })),
    };
  }

  start(projectId: string, runId: string): WorkflowRunRecord {
    return this.enqueue(projectId, runId, "start");
  }

  resume(projectId: string, runId: string): WorkflowRunRecord {
    return this.enqueue(projectId, runId, "resume");
  }

  private enqueue(
    projectId: string,
    runId: string,
    mode: WorkflowRunMode,
  ): WorkflowRunRecord {
    if (this.closed) {
      throw new WorkflowRunControllerError(
        "CONTROLLER_CLOSED",
        "The workflow run controller is closed.",
      );
    }
    const run = this.store.readRun(projectId, runId);
    if (!run) {
      throw new WorkflowRunControllerError(
        "RUN_NOT_FOUND",
        `No such workflow run: ${runId}`,
      );
    }
    if (this.quiescingProjects.has(projectId)) {
      if (mode === "start" && run.state.status === "queued") {
        this.store.requestRunCancellation(projectId, runId);
      }
      throw new WorkflowRunControllerError(
        "PROJECT_QUIESCING",
        `Workflow admissions are quiesced for project ${projectId}.`,
      );
    }
    const key = runKey(projectId, runId);
    if (this.pendingKeys.has(key) || this.active.has(key)) return run;
    const expectedStatus = mode === "start" ? "queued" : "interrupted";
    if (run.state.status !== expectedStatus) {
      // Starting is coupled to idempotent run creation. A retried create call
      // must return the already-running or terminal record without relaunching
      // it; interrupted work still requires the explicit resume control.
      if (mode === "start") return run;
      throw new WorkflowRunControllerError(
        "RUN_NOT_RESUMABLE",
        `Workflow run ${runId} is ${run.state.status}, not ${expectedStatus}.`,
      );
    }
    this.pending.push({ projectId, runId, mode });
    this.pendingKeys.add(key);
    this.pump();
    return run;
  }

  /** User-requested cancellation. Shutdown does not call this implicitly. */
  cancel(projectId: string, runId: string): WorkflowRunRecord {
    const run = this.store.readRun(projectId, runId);
    if (!run) {
      throw new WorkflowRunControllerError(
        "RUN_NOT_FOUND",
        `No such workflow run: ${runId}`,
      );
    }
    if (run.state.status === "cancelled") return run;
    if (
      run.state.status === "succeeded" ||
      run.state.status === "failed" ||
      run.state.status === "interrupted"
    ) {
      throw new WorkflowRunControllerError(
        "RUN_NOT_CANCELLABLE",
        `Workflow run ${runId} cannot be cancelled from ${run.state.status}.`,
      );
    }

    const key = runKey(projectId, runId);
    let cancellation: WorkflowRunRecord;
    try {
      cancellation = this.store.requestRunCancellation(projectId, runId);
    } catch (error) {
      if (error instanceof WorkflowStoreError && error.code === "CONFLICT") {
        throw new WorkflowRunControllerError(
          "RUN_NOT_CANCELLABLE",
          error.message,
        );
      }
      throw error;
    }
    const active = this.active.get(key);
    if (active) {
      active.controller.abort(new WorkflowRunAbortError(
        "USER_CANCELLED",
        "Workflow execution was cancelled by the user.",
      ));
      return cancellation;
    }

    const pendingIndex = this.pending.findIndex(
      (item) => item.projectId === projectId && item.runId === runId,
    );
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      this.pendingKeys.delete(key);
    }
    this.resolveIdleIfNeeded();
    return cancellation;
  }

  /**
   * Stop authority (#39 / N-A1). The durability watcher can end a run, not only
   * restart or redeploy it.
   *
   * This does not invent a second termination path: it reuses the cancellation
   * the controller already owns, so in-flight node executions are settled by
   * the run-state reducer exactly as they are for a user cancel, and the run's
   * terminal status is `cancelled`. The only thing added is attribution — when
   * no runner holds the lease, the terminal event carries
   * `DURABILITY_STOP_ERROR_CODE` instead of `USER_CANCELLED`.
   */
  stopRun(
    projectId: string,
    runId: string,
    request: WorkflowRunStopRequest,
  ): WorkflowRunStopReceipt {
    const reason = request.reason.trim();
    if (!reason) {
      throw new WorkflowRunControllerError(
        "INVALID_LIMIT",
        "A workflow stop requires a reason.",
      );
    }
    const run = this.store.readRun(projectId, runId);
    if (!run) {
      throw new WorkflowRunControllerError(
        "RUN_NOT_FOUND",
        `No such workflow run: ${runId}`,
      );
    }
    if (run.state.status === "cancelled") {
      return {
        runId,
        stopped: true,
        terminalStatus: "cancelled",
        stoppedBy: request.stoppedBy,
        reason,
        distinguishedInRunEvents:
          run.state.lastError?.code === DURABILITY_STOP_ERROR_CODE,
        detail: `Workflow run ${runId} was already stopped.`,
      };
    }
    if (
      run.state.status === "succeeded" ||
      run.state.status === "failed" ||
      run.state.status === "interrupted"
    ) {
      throw new WorkflowRunControllerError(
        "RUN_NOT_CANCELLABLE",
        `Workflow run ${runId} cannot be stopped from ${run.state.status}.`,
      );
    }

    const key = runKey(projectId, runId);
    // An unleased run has no runner to write its terminal event, so this
    // controller writes it — and can therefore attribute it. A leased run's
    // event belongs to whoever holds the lease.
    if (!this.store.hasLiveRunLease(projectId, runId)) {
      try {
        this.store.appendRunEvent(
          projectId,
          runId,
          {
            eventId: controllerEventId(
              `durability-stop-${request.stoppedBy}`,
              projectId,
              runId,
              run.state.lastSeq,
            ),
            type: "run_cancelled",
            data: {
              error: {
                code: DURABILITY_STOP_ERROR_CODE,
                message: `Stopped by the durability watcher: ${reason}`,
                retryable: false,
              },
            },
          },
          run.state.lastSeq,
        );
        this.dropPending(projectId, runId);
        this.active.get(key)?.controller.abort(new WorkflowRunAbortError(
          "USER_CANCELLED",
          "Workflow execution was stopped by the durability watcher.",
        ));
        this.resolveIdleIfNeeded();
        return {
          runId,
          stopped: true,
          terminalStatus: "cancelled",
          stoppedBy: request.stoppedBy,
          reason,
          distinguishedInRunEvents: true,
          detail: `Workflow run ${runId} was stopped and recorded as a durability stop.`,
        };
      } catch (error) {
        // A lease or a concurrent terminal transition won between the read and
        // the append. Fall through to the durable cancellation path, which is
        // safe from any of those states.
        if (!(error instanceof WorkflowStoreError)) throw error;
      }
    }

    this.cancel(projectId, runId);
    return {
      runId,
      stopped: true,
      terminalStatus: "cancelled",
      stoppedBy: request.stoppedBy,
      reason,
      distinguishedInRunEvents: false,
      detail:
        `Workflow run ${runId} is executing, so its stop was requested through the runner. ` +
        "The run timeline records the stop as a cancellation; the durability timeline records who stopped it.",
    };
  }

  private dropPending(projectId: string, runId: string): void {
    const index = this.pending.findIndex(
      (item) => item.projectId === projectId && item.runId === runId,
    );
    if (index >= 0) {
      this.pending.splice(index, 1);
      this.pendingKeys.delete(runKey(projectId, runId));
    }
  }

  waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.active.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  recoverProjects(projectIds: Iterable<string>): WorkflowProjectRecoveryResult[] {
    if (this.closed) {
      throw new WorkflowRunControllerError(
        "CONTROLLER_CLOSED",
        "The workflow run controller is closed.",
      );
    }
    const results: WorkflowProjectRecoveryResult[] = [];
    for (const projectId of new Set(projectIds)) {
      const result: WorkflowProjectRecoveryResult = {
        projectId,
        interrupted: [],
        active: [],
        enqueued: [],
        errors: [],
      };
      try {
        const recovery = this.store.reconcileInterruptedRuns(projectId);
        result.interrupted.push(...recovery.interrupted);
        result.active.push(...recovery.active);
        result.errors.push(...recovery.errors);
        if (!this.quiescingProjects.has(projectId)) {
          for (const run of this.store.listQueuedRuns(projectId)) {
            if (this.store.hasLiveRunLease(projectId, run.manifest.id)) {
              if (!result.active.includes(run.manifest.id)) {
                result.active.push(run.manifest.id);
              }
              continue;
            }
            try {
              this.enqueue(projectId, run.manifest.id, "start");
              result.enqueued.push(run.manifest.id);
            } catch (error) {
              result.errors.push({
                runId: run.manifest.id,
                message: errorMessage(error),
              });
            }
          }
        }
      } catch (error) {
        result.errors.push({ runId: "", message: errorMessage(error) });
      }
      results.push(result);
    }
    return results;
  }

  /** Run recovery now, then periodically while this controller is open. */
  startRecoveryLoop(
    listProjectIds: () => Iterable<string>,
    intervalMs = DEFAULT_WORKFLOW_RECOVERY_INTERVAL_MS,
  ): WorkflowProjectRecoveryResult[] {
    if (typeof listProjectIds !== "function") {
      throw new WorkflowRunControllerError(
        "INVALID_LIMIT",
        "A workflow recovery project supplier is required.",
      );
    }
    const checkedIntervalMs = boundedDuration(intervalMs, "recoveryIntervalMs");
    this.stopRecoveryLoop();
    const initial = this.recoverProjects(listProjectIds());
    this.recoveryTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this.recoverProjects(listProjectIds());
      } catch (error) {
        this.onRecoveryError?.(error);
      }
    }, checkedIntervalMs);
    this.recoveryTimer.unref();
    return initial;
  }

  stopRecoveryLoop(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  isProjectQuiescing(projectId: string): boolean {
    return this.quiescingProjects.has(projectId);
  }

  /** Re-open admissions only when the caller has abandoned project deletion. */
  releaseProjectQuiesce(projectId: string): void {
    this.quiescingProjects.delete(projectId);
  }

  /**
   * Block local admissions, durably request cancellation for all runnable
   * project work (including work leased by another process), and wait only for
   * the requested grace period. Callers must check `drained` before deletion.
   */
  async quiesceProject(
    projectId: string,
    options: { graceMs?: number } = {},
  ): Promise<WorkflowProjectQuiesceResult> {
    if (this.closed) {
      throw new WorkflowRunControllerError(
        "CONTROLLER_CLOSED",
        "The workflow run controller is closed.",
      );
    }
    const graceMs = boundedDuration(
      options.graceMs ?? this.closeGraceMs,
      "graceMs",
    );
    this.quiescingProjects.add(projectId);

    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (entry.projectId !== projectId) continue;
      this.pending.splice(index, 1);
      this.pendingKeys.delete(runKey(entry.projectId, entry.runId));
    }

    const cancellationRequested = new Set<string>();
    const requestDurableCancellations = (): void => {
      for (const run of this.store.listCancellableRuns(projectId)) {
        try {
          this.store.requestRunCancellation(projectId, run.manifest.id);
          cancellationRequested.add(run.manifest.id);
        } catch (error) {
          const current = this.store.readRun(projectId, run.manifest.id);
          if (!current || !["succeeded", "failed", "cancelled", "interrupted"].includes(
            current.state.status,
          )) {
            throw error;
          }
        }
      }
    };
    requestDurableCancellations();
    for (const entry of this.active.values()) {
      if (entry.projectId !== projectId) continue;
      entry.controller.abort(new WorkflowRunAbortError(
        "USER_CANCELLED",
        "Workflow execution was cancelled while its project was quiesced.",
      ));
    }
    this.resolveIdleIfNeeded();

    const deadline = Date.now() + graceMs;
    for (;;) {
      requestDurableCancellations();
      const hasLocalActive = [...this.active.values()].some(
        (entry) => entry.projectId === projectId,
      );
      const hasDurableActive = this.store.listCancellableRuns(projectId).length > 0;
      if (!hasLocalActive && !hasDurableActive) {
        return {
          projectId,
          cancellationRequested: [...cancellationRequested],
          drained: true,
        };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          projectId,
          cancellationRequested: [...cancellationRequested],
          drained: false,
        };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(50, remainingMs));
      });
    }
  }

  /** Stop admission, interrupt active work, drop pending work, and return boundedly. */
  close(options: { graceMs?: number } = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const graceMs = boundedDuration(
      options.graceMs ?? this.closeGraceMs,
      "graceMs",
    );
    this.closed = true;
    this.stopRecoveryLoop();
    this.pending.length = 0;
    this.pendingKeys.clear();
    const activePromises = [...this.active.values()].map((entry) => {
      entry.controller.abort(new WorkflowRunAbortError(
        "CONTROLLER_SHUTDOWN",
        "Workflow execution was interrupted because the controller shut down.",
      ));
      return entry.promise;
    });
    this.resolveIdleIfNeeded();
    this.closePromise = new Promise<void>((resolve) => {
      if (activePromises.length === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, graceMs);
      void Promise.allSettled(activePromises).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.closePromise;
  }

  private activeCountForProject(projectId: string): number {
    let count = 0;
    for (const entry of this.active.values()) {
      if (entry.projectId === projectId) count += 1;
    }
    return count;
  }

  private nextAdmissiblePendingIndex(): number {
    if (this.active.size >= this.maxActiveRuns) return -1;
    return this.pending.findIndex(
      (item) =>
        !this.quiescingProjects.has(item.projectId) &&
        this.activeCountForProject(item.projectId) <
        this.maxActiveRunsPerProject,
    );
  }

  private pump(): void {
    if (this.closed) {
      this.resolveIdleIfNeeded();
      return;
    }
    for (;;) {
      const index = this.nextAdmissiblePendingIndex();
      if (index < 0) break;
      const [entry] = this.pending.splice(index, 1);
      const key = runKey(entry.projectId, entry.runId);
      this.pendingKeys.delete(key);

      const controller = new AbortController();
      const activeEntry: ActiveWorkflowRun = {
        ...entry,
        controller,
        promise: Promise.resolve(),
      };
      this.active.set(key, activeEntry);
      activeEntry.promise = this.execute(activeEntry)
        .catch((error) => {
          this.onError?.({
            projectId: entry.projectId,
            runId: entry.runId,
            error,
          });
        })
        .finally(() => {
          if (this.active.get(key) === activeEntry) this.active.delete(key);
          this.pump();
          this.resolveIdleIfNeeded();
        });
    }
    this.resolveIdleIfNeeded();
  }

  private async execute(entry: ActiveWorkflowRun): Promise<void> {
    try {
      const executeNode = await this.createExecutor(entry.projectId, entry.runId);
      if (entry.controller.signal.aborted) {
        await this.persistControllerAbort(entry);
        return;
      }
      await this.runDag({
        projectId: entry.projectId,
        runId: entry.runId,
        executeNode,
        signal: entry.controller.signal,
      } satisfies RunWorkflowDagOptions);
    } catch (error) {
      if (entry.controller.signal.aborted) {
        await this.persistControllerAbort(entry);
        return;
      }
      await this.persistUnexpectedFailure(entry, error);
      throw error;
    }
  }

  private async persistControllerAbort(entry: ActiveWorkflowRun): Promise<void> {
    const reason = entry.controller.signal.reason;
    if (reason instanceof WorkflowRunAbortError && reason.code === "USER_CANCELLED") {
      try {
        this.store.requestRunCancellation(entry.projectId, entry.runId);
      } catch (error) {
        const current = this.store.readRun(entry.projectId, entry.runId);
        if (!current || !["succeeded", "failed", "cancelled"].includes(current.state.status)) {
          throw error;
        }
      }
      return;
    }

    let run = this.store.readRun(entry.projectId, entry.runId);
    if (
      !run ||
      ["succeeded", "failed", "cancelled", "interrupted"].includes(run.state.status) ||
      this.store.hasLiveRunLease(entry.projectId, entry.runId)
    ) {
      return;
    }
    const interruptionError = {
      code: reason instanceof WorkflowRunAbortError
        ? reason.code
        : "RUN_INTERRUPTED",
      message: reason instanceof WorkflowRunAbortError
        ? errorMessage(reason)
        : "Workflow execution was interrupted before its runner started.",
      retryable: true,
    };
    try {
      if (run.state.status === "queued") {
        this.store.appendRunEvent(
          entry.projectId,
          entry.runId,
          {
            eventId: controllerEventId(
              "interrupted-start",
              entry.projectId,
              entry.runId,
              run.state.lastSeq,
            ),
            type: "run_started",
          },
          run.state.lastSeq,
        );
        run = this.store.readRun(entry.projectId, entry.runId)!;
      }
      if (isInterruptibleStatus(run.state.status)) {
        this.store.appendRunEvent(
          entry.projectId,
          entry.runId,
          {
            eventId: controllerEventId(
              "interrupted",
              entry.projectId,
              entry.runId,
              run.state.lastSeq,
            ),
            type: "run_interrupted",
            data: {
              previousStatus: run.state.status,
              error: interruptionError,
            },
          },
          run.state.lastSeq,
        );
      }
    } catch (error) {
      if (!(error instanceof WorkflowStoreError) || error.code !== "CONFLICT") {
        throw error;
      }
    }
  }

  private async persistUnexpectedFailure(
    entry: ActiveWorkflowRun,
    error: unknown,
  ): Promise<void> {
    const run = this.store.readRun(entry.projectId, entry.runId);
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.state.status)) {
      return;
    }
    // Another process may have won the durable lease while our scheduler saw
    // the record as queued. Its event stream remains authoritative.
    if (this.store.hasLiveRunLease(entry.projectId, entry.runId)) return;

    const controllerError = {
      code: "WORKFLOW_CONTROLLER_FAILURE",
      message: errorMessage(error),
      retryable: true,
    };
    try {
      if (isInterruptibleStatus(run.state.status)) {
        this.store.appendRunEvent(
          entry.projectId,
          entry.runId,
          {
            eventId: controllerEventId(
              "interrupt",
              entry.projectId,
              entry.runId,
              run.state.lastSeq,
            ),
            type: "run_interrupted",
            data: {
              previousStatus: run.state.status,
              error: controllerError,
            },
          },
          run.state.lastSeq,
        );
        return;
      }

      let current = run;
      if (current.state.status === "queued") {
        this.store.appendRunEvent(
          entry.projectId,
          entry.runId,
          {
            eventId: controllerEventId(
              "failed-start",
              entry.projectId,
              entry.runId,
              current.state.lastSeq,
            ),
            type: "run_started",
          },
          current.state.lastSeq,
        );
        current = this.store.readRun(entry.projectId, entry.runId)!;
      } else if (current.state.status === "interrupted") {
        let after = 0;
        let resumeNumber = 1;
        for (;;) {
          const page = this.store.readRunEvents(entry.projectId, entry.runId, {
            after,
            limit: 500,
          });
          resumeNumber += page.events.filter(
            (event) => event.type === "run_resumed",
          ).length;
          if (!page.hasMore || page.events.length === 0) break;
          after = page.events.at(-1)!.seq;
        }
        this.store.appendRunEvent(
          entry.projectId,
          entry.runId,
          {
            eventId: controllerEventId(
              "failed-resume",
              entry.projectId,
              entry.runId,
              current.state.lastSeq,
            ),
            type: "run_resumed",
            data: { resumeNumber },
          },
          current.state.lastSeq,
        );
        current = this.store.readRun(entry.projectId, entry.runId)!;
      }
      if (current.state.status === "running") {
        this.store.appendRunEvent(
          entry.projectId,
          entry.runId,
          {
            eventId: controllerEventId(
              "failed",
              entry.projectId,
              entry.runId,
              current.state.lastSeq,
            ),
            type: "run_failed",
            data: { error: controllerError },
          },
          current.state.lastSeq,
        );
      }
    } catch (persistenceError) {
      // A concurrent owner or terminal transition won after our read. Preserve
      // that authoritative event stream; report only genuinely unexpected
      // persistence failures to the controller observer.
      if (
        !(persistenceError instanceof WorkflowStoreError) ||
        persistenceError.code !== "CONFLICT"
      ) {
        this.onError?.({
          projectId: entry.projectId,
          runId: entry.runId,
          error: persistenceError,
        });
      }
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.pending.length > 0 || this.active.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
