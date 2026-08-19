/**
 * The schedule ticker: the only thing in this subsystem that decides WHEN.
 *
 * What it deliberately does NOT do — because the tree already does it, and a
 * second copy would be the worst outcome available to this wave:
 *
 *   - it does not create runs. It dispatches an in-process request to the
 *     existing `POST /dag-workflows/:workflowId/runs` route, so a scheduled run
 *     is created by the same handler, with the same validation, the same
 *     `effectiveLimits` inheritance (workflows/store.ts:2427) and the same
 *     `controller.start()` call as a run a user fires by hand.
 *   - it does not dedupe. `requestId = schedule:<id>:<windowKey>` and the store
 *     derives the run id from the requestId (workflows/store.ts:1265), so the
 *     same window fired twice returns the SAME manifest — idempotency is a
 *     property of the id, not of a table this module keeps.
 *   - it does not cancel runs itself. Stopping goes through the existing
 *     `POST /dag-workflow-runs/:runId/cancel`.
 *   - it does not track outcomes. A fire record points at a run; the run's own
 *     state is the outcome.
 *
 * Lifecycle (defect #41): ONE `setInterval`, `.unref()`ed so a pending tick can
 * never be the reason a process refuses to exit, and cleared from the owning
 * app's `onClose` hook. Nothing this module starts survives `app.close()`.
 */
import type { FastifyInstance } from "fastify";
import { listProjects } from "../projects.ts";
import { isTerminalWorkflowRunStatus, workflowStore } from "../workflows/index.ts";
import {
  NEXT_FIRE_HORIZON_DAYS,
  parseScheduleExpression,
  nextFire,
  windowsBetween,
  type NextFire,
} from "./expression.ts";
import {
  appendFireRecord,
  listSchedules,
  readFireRecords,
  readSchedule,
  writeSchedule,
  type ScheduleFireReason,
  type ScheduleFireRecord,
  type ScheduleRecord,
} from "./store.ts";

/** How often the ticker wakes. One second is the resolution of `every:1s`. */
export const DEFAULT_TICK_INTERVAL_MS = 1_000;
/**
 * A window missed while the process was down is only caught up if it became
 * due within this long. Anything older is recorded as `catchup-expired` and
 * never fired: a schedule that was down for a week must not wake up firing.
 */
export const DEFAULT_CATCH_UP_GRACE_MS = 15 * 60_000;
/** At most this many schedules dispatch in one tick; the rest defer, safely. */
export const DEFAULT_MAX_CONCURRENT_FIRES = 4;
/** Missed windows enumerated per schedule per tick before the record says so. */
const MAX_ENUMERATED_MISSED_WINDOWS = 50;

const NON_EXISTENT_RUN_ID = "wrun_00000000000000000000000000000000";

export interface SchedulerOptions {
  tickIntervalMs?: number;
  catchUpGraceMs?: number;
  maxConcurrentFires?: number;
  /** Injected in tests so a fire can be observed without waiting on a clock. */
  now?: () => number;
}

export interface TickSummary {
  evaluatedSchedules: number;
  dispatched: number;
  skipped: number;
}

interface DispatchOutcome {
  reason: ScheduleFireReason;
  detail: string;
  runId: string | null;
}

/**
 * Is workflow EXECUTION enabled in this process?
 *
 * The run-creation route does not fail closed — `options.controller?.start(…)`
 * (api/dag-workflows.ts:493) is optional chaining, so with no controller it
 * returns 202 with a run nothing will ever execute. The cancel route DOES fail
 * closed, and checks the controller BEFORE it looks the run up
 * (api/dag-workflows.ts:596-602), so cancelling a run id that cannot exist is a
 * side-effect-free probe: 503 means execution is off, 404 means it is on.
 */
async function executionEnabled(app: FastifyInstance, projectId: string): Promise<boolean> {
  const response = await app.inject({
    method: "POST",
    url: `/dag-workflow-runs/${NON_EXISTENT_RUN_ID}/cancel`,
    headers: { "X-Project-Id": projectId },
  });
  return response.statusCode !== 503;
}

export class Scheduler {
  readonly #app: FastifyInstance;
  readonly #tickIntervalMs: number;
  readonly #catchUpGraceMs: number;
  readonly #maxConcurrentFires: number;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(app: FastifyInstance, options: SchedulerOptions = {}) {
    this.#app = app;
    this.#tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.#catchUpGraceMs = options.catchUpGraceMs ?? DEFAULT_CATCH_UP_GRACE_MS;
    this.#maxConcurrentFires = options.maxConcurrentFires ?? DEFAULT_MAX_CONCURRENT_FIRES;
    this.#now = options.now ?? Date.now;
  }

  isRunning(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.#app.log.error({ err: error }, "schedule tick failed");
      });
    }, this.#tickIntervalMs);
    // Deliberate: an unref'd interval keeps no event-loop reference, so a
    // scheduler tick can never hold a backend process open after its work is
    // done. This is the shape agent/skills-sync.ts already uses, and it is the
    // direct answer to the orphaned-supervisor history in defect #41.
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Evaluate every schedule in every project once. Safe to call directly (the
   * tests do); re-entrant calls are dropped rather than queued, so a slow tick
   * cannot pile up behind itself.
   */
  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { evaluatedSchedules: 0, dispatched: 0, skipped: 0 };
    if (this.#ticking) return summary;
    this.#ticking = true;
    try {
      let remainingFireBudget = this.#maxConcurrentFires;
      for (const project of listProjects()) {
        for (const stored of listSchedules(project.id)) {
          summary.evaluatedSchedules += 1;
          const result = await this.#evaluate(stored, remainingFireBudget);
          remainingFireBudget -= result.dispatched;
          summary.dispatched += result.dispatched;
          summary.skipped += result.skipped;
        }
      }
    } finally {
      this.#ticking = false;
    }
    return summary;
  }

  async #evaluate(
    stored: ScheduleRecord,
    remainingFireBudget: number,
  ): Promise<{ dispatched: number; skipped: number }> {
    const now = this.#now();
    let expression;
    try {
      expression = parseScheduleExpression(stored.expression);
    } catch (error) {
      // A schedule whose expression stopped parsing (hand-edited file, or a
      // format this build no longer accepts) is recorded once, not once per
      // tick, and then left alone by advancing its cursor past now.
      if (stored.lastFireReason !== "error") {
        this.#record(stored, { windowKey: "unreadable-expression", windowAt: now }, {
          reason: "error",
          detail: `This schedule's expression cannot be read: ${(error as Error).message}`,
          runId: null,
        }, now);
      }
      this.#advance(stored, now, "error", null);
      return { dispatched: 0, skipped: 1 };
    }

    if (!stored.enabled) {
      // A paused schedule accrues NO windows: its cursor follows the clock, so
      // resuming it cannot trigger a catch-up storm for the paused period. The
      // pause is recorded once, the first time a window is passed over.
      const passedOver = nextFire(expression, stored.timezone, stored.cursorMs);
      if (!passedOver || passedOver.instantMs > now) return { dispatched: 0, skipped: 0 };
      if (stored.lastFireReason !== "disabled") {
        this.#record(stored, { windowKey: passedOver.windowKey, windowAt: passedOver.instantMs }, {
          reason: "disabled",
          detail:
            "The schedule is paused. Its windows are passed over without running, and they " +
            "are not caught up when it is resumed.",
          runId: null,
        }, now);
      }
      this.#advance(stored, now, "disabled", null);
      return { dispatched: 0, skipped: 1 };
    }

    const { windows, truncated } = windowsBetween(
      expression,
      stored.timezone,
      stored.cursorMs,
      now,
      MAX_ENUMERATED_MISSED_WINDOWS,
    );
    if (windows.length === 0) return { dispatched: 0, skipped: 0 };

    if (truncated) {
      this.#record(stored, { windowKey: windows[0].windowKey, windowAt: windows[0].instantMs }, {
        reason: "catchup-truncated",
        detail:
          `More than ${MAX_ENUMERATED_MISSED_WINDOWS} windows came due while this schedule was ` +
          "not being evaluated; only the most recent is considered for catch-up.",
        runId: null,
      }, now);
    }

    // Catch-up policy: AT MOST ONE fire per schedule per tick, for the most
    // recent due window. Every older window is recorded as deliberately
    // skipped — a stampede and a silent skip are both failures.
    const target = windows[windows.length - 1];
    let skipped = 0;
    for (const missed of windows.slice(0, -1)) {
      this.#record(stored, { windowKey: missed.windowKey, windowAt: missed.instantMs }, {
        reason: "catchup-skipped",
        detail:
          "This window came due while the scheduler was not running. Only the most recent " +
          "missed window is caught up, so this one was skipped deliberately.",
        runId: null,
      }, now);
      skipped += 1;
    }

    const outcome = await this.#decide(stored, expression.kind, target, now, remainingFireBudget);
    this.#record(stored, { windowKey: target.windowKey, windowAt: target.instantMs }, outcome, now);
    const dispatched = outcome.reason === "dispatched" ? 1 : 0;
    // A capacity-deferred window keeps its cursor so the next tick reconsiders
    // it; the requestId is unchanged, so catching up cannot double-fire.
    if (outcome.reason !== "capacity-deferred") {
      this.#advance(
        stored,
        target.instantMs,
        outcome.reason,
        dispatched ? { windowKey: target.windowKey, runId: outcome.runId } : null,
      );
    }
    return { dispatched, skipped: skipped + (dispatched ? 0 : 1) };
  }

  async #decide(
    stored: ScheduleRecord,
    expressionKind: "cron" | "every",
    target: NextFire,
    now: number,
    remainingFireBudget: number,
  ): Promise<DispatchOutcome> {
    if (!stored.enabled) {
      return {
        reason: "disabled",
        detail: "The schedule is paused, so this window did not start a run.",
        runId: null,
      };
    }
    if (expressionKind === "cron" && stored.lastFiredWindowKey === target.windowKey) {
      return {
        reason: "duplicate-window",
        detail:
          "This local time happened twice (a daylight-saving fall-back), and the schedule " +
          "already fired for it. It runs once per local wall-clock time.",
        runId: null,
      };
    }
    if (now - target.instantMs > this.#catchUpGraceMs) {
      return {
        reason: "catchup-expired",
        detail:
          `This window came due more than ${Math.round(this.#catchUpGraceMs / 60_000)} minutes ` +
          "ago, past the catch-up grace period, so it was not run.",
        runId: null,
      };
    }
    if (remainingFireBudget <= 0) {
      return {
        reason: "capacity-deferred",
        detail:
          `At most ${this.#maxConcurrentFires} schedules start a run in one tick. This window ` +
          "is still due and will be reconsidered on the next tick.",
        runId: null,
      };
    }
    if (stored.overlapPolicy === "skip") {
      const active = this.#activeRunId(stored);
      if (active) {
        return {
          reason: "overlap-skipped",
          detail:
            "The previous run of this schedule is still going and the overlap policy is " +
            '"skip", so this window did not start a second run.',
          runId: null,
        };
      }
    }
    return this.#dispatch(stored, target);
  }

  /** The schedule's last dispatched run, if it is still not in a terminal state. */
  #activeRunId(stored: ScheduleRecord): string | null {
    if (!stored.lastRunId) return null;
    const run = workflowStore.readRun(stored.projectId, stored.lastRunId);
    if (!run) return null;
    return isTerminalWorkflowRunStatus(run.state.status) ? null : stored.lastRunId;
  }

  async #dispatch(stored: ScheduleRecord, target: NextFire): Promise<DispatchOutcome> {
    const requestId = `schedule:${stored.id}:${target.windowKey}`;
    if (!(await executionEnabled(this.#app, stored.projectId))) {
      return {
        reason: "controller-absent",
        detail:
          "Workflow execution is not enabled in this server process, so no run was created " +
          "for this window. Start the backend with execution enabled and re-enable the schedule.",
        runId: null,
      };
    }
    let response;
    try {
      response = await this.#app.inject({
        method: "POST",
        url: `/dag-workflows/${encodeURIComponent(stored.workflowId)}/runs`,
        headers: { "X-Project-Id": stored.projectId, "Content-Type": "application/json" },
        payload: {
          requestId,
          ...(Object.keys(stored.input).length > 0 ? { input: stored.input } : {}),
        },
      });
    } catch (error) {
      return {
        reason: "error",
        detail: `This window could not start a run: ${(error as Error).message}`,
        runId: null,
      };
    }
    if (response.statusCode === 202 || response.statusCode === 200) {
      const body = response.json() as { manifest?: { id?: unknown } };
      const runId = typeof body.manifest?.id === "string" ? body.manifest.id : null;
      return runId
        ? { reason: "dispatched", detail: "The schedule started a run for this window.", runId }
        : {
            reason: "error",
            detail: "The run was accepted but reported no run id.",
            runId: null,
          };
    }
    if (response.statusCode === 404) {
      return {
        reason: "definition-missing",
        detail:
          `Workflow "${stored.workflowId}" no longer exists in this project, so this window ` +
          "did not run. Point the schedule at an existing workflow.",
        runId: null,
      };
    }
    if (response.statusCode === 409) {
      return {
        reason: "conflict",
        detail:
          "This window was already used for a run with different settings, so it was not run " +
          "again. Editing a schedule's input changes future windows, not past ones.",
        runId: null,
      };
    }
    return {
      reason: "error",
      detail: `The run request was refused with status ${response.statusCode}.`,
      runId: null,
    };
  }

  /**
   * Fire one window immediately, outside the clock. The window key carries the
   * whole second it was asked for, so a double-clicked "Run now" inside the
   * same second is idempotency-collapsed exactly like a duplicated tick.
   */
  async runNow(stored: ScheduleRecord): Promise<ScheduleFireRecord> {
    const now = this.#now();
    const windowKey = `manual-${new Date(Math.floor(now / 1_000) * 1_000).toISOString()}`;
    const outcome = await this.#dispatch(stored, { instantMs: now, windowKey });
    const record = this.#record(stored, { windowKey, windowAt: now }, outcome, now);
    if (outcome.reason === "dispatched") {
      this.#advance(stored, stored.cursorMs, "dispatched", { windowKey, runId: outcome.runId });
    }
    return record;
  }

  /**
   * Cancel every run this schedule started that is not already in a terminal
   * state. This is the SECOND meaning of "stop": disabling a schedule stops
   * future windows, and a runaway run that is already burning budget has to be
   * cancelled separately, through the run controller's own cancel route.
   */
  async cancelActiveRuns(stored: ScheduleRecord): Promise<{
    cancelled: string[];
    refused: Array<{ runId: string; status: number }>;
  }> {
    const cancelled: string[] = [];
    const refused: Array<{ runId: string; status: number }> = [];
    const seen = new Set<string>();
    for (const fire of readFireRecords(stored.projectId, { scheduleId: stored.id, limit: 200 })) {
      if (!fire.runId || seen.has(fire.runId)) continue;
      seen.add(fire.runId);
      const run = workflowStore.readRun(stored.projectId, fire.runId);
      if (!run || isTerminalWorkflowRunStatus(run.state.status)) continue;
      const response = await this.#app.inject({
        method: "POST",
        url: `/dag-workflow-runs/${encodeURIComponent(fire.runId)}/cancel`,
        headers: { "X-Project-Id": stored.projectId },
      });
      if (response.statusCode === 200 || response.statusCode === 202) cancelled.push(fire.runId);
      else refused.push({ runId: fire.runId, status: response.statusCode });
    }
    return { cancelled, refused };
  }

  #record(
    stored: ScheduleRecord,
    target: { windowKey: string; windowAt: number },
    outcome: DispatchOutcome,
    now: number,
  ): ScheduleFireRecord {
    return appendFireRecord(stored.projectId, {
      scheduleId: stored.id,
      windowKey: target.windowKey,
      windowAt: target.windowAt,
      firedAt: now,
      requestId: outcome.reason === "dispatched"
        ? `schedule:${stored.id}:${target.windowKey}`
        : null,
      runId: outcome.runId,
      reason: outcome.reason,
      detail: outcome.detail,
    });
  }

  /**
   * Persist the cursor. Re-reads the schedule first so a concurrent API edit
   * (rename, pause, expression change) made between the tick's read and this
   * write is not clobbered by a stale in-memory copy.
   */
  #advance(
    stored: ScheduleRecord,
    cursorMs: number,
    reason: ScheduleFireReason,
    fired: { windowKey: string; runId: string | null } | null,
  ): void {
    const current = readSchedule(stored.projectId, stored.id);
    if (!current) return;
    writeSchedule({
      ...current,
      cursorMs: Math.max(current.cursorMs, cursorMs),
      lastFireAt: this.#now(),
      lastFireReason: reason,
      ...(fired ? { lastFiredWindowKey: fired.windowKey, lastRunId: fired.runId } : {}),
    });
  }
}

/** The next-fire instant the API reports, computed by the ticker's own code. */
export function scheduleNextFireAt(stored: ScheduleRecord, fromMs: number): number | null {
  let expression;
  try {
    expression = parseScheduleExpression(stored.expression);
  } catch {
    return null;
  }
  const next = nextFire(expression, stored.timezone, Math.max(stored.cursorMs, fromMs));
  return next ? next.instantMs : null;
}

export { NEXT_FIRE_HORIZON_DAYS };
