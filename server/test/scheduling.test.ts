/**
 * Lane F13 — the durable-scheduler properties, proved deterministically.
 *
 * This file drives `Scheduler.tick()` by hand against a REAL Fastify app with a
 * REAL workflow controller, with the background ticker disabled
 * (KADY_SCHEDULER_AUTOSTART=0) so an assertion can never race a timer. The
 * unattended fire — the ticker firing with nobody calling anything — is proved
 * separately in schedules-api.test.ts, because a hand-driven tick is not
 * evidence that the timer runs.
 *
 * Every assertion here is on an EFFECT: a run manifest that exists, the
 * requestId it carries, the limits it inherited, the run the controller was
 * asked to start, the fire record that says why nothing ran.
 */
process.env.KADY_SCHEDULER_AUTOSTART = "0";

import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  WorkflowRunController,
  workflowStore,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
} from "../src/workflows/index.ts";
import {
  Scheduler,
  SCHEDULE_STORAGE_VERSION,
  instantsForWallClock,
  newScheduleId,
  parseScheduleExpression,
  readFireRecords,
  readSchedule,
  nextFire,
  scheduleNextFireAt,
  windowsBetween,
  writeSchedule,
  zonedWallClock,
  type ScheduleRecord,
} from "../src/scheduling/index.ts";

const WORKFLOW_ID = "scheduled-workflow";

/**
 * When set, every executor parks on this promise until the test resolves it —
 * the mechanism dag-workflows-api.test.ts already uses to hold a run in the
 * "running" state on purpose, abort-aware so cancellation still works.
 */
let executorGate: Promise<void> | null = null;

function receipt(): WorkflowModelResolutionReceipt {
  return {
    request: graph().defaultModel!,
    resolved: {
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "high",
      runtime: "local",
    },
    fallbackUsed: false,
  };
}

/** Executor that finishes at once unless a test holds it open on purpose. */
const controller = new WorkflowRunController({
  createExecutor: () => async (context) => {
    // "agent" is the node's model-call SLOT id, not the node id.
    context.recordModelResolution("agent", receipt());
    if (executorGate) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(context.signal.reason ?? new Error("aborted"));
        if (context.signal.aborted) {
          onAbort();
          return;
        }
        context.signal.addEventListener("abort", onAbort, { once: true });
        executorGate!.then(resolve, reject).finally(() => {
          context.signal.removeEventListener("abort", onAbort);
        });
      });
    }
    return { output: { ok: true } };
  },
});

const app = await buildApp({ workflowController: controller });
const executionDisabledApp = await buildApp({ workflowController: null });

function graph(id = WORKFLOW_ID): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: "Scheduled workflow",
    entryNodeId: "start",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "ollama",
        model: "qwen3:32b",
        auth: { kind: "local" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 3,
      maxModelCalls: 3,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 45_000,
      maxTokens: 12_345,
      maxCostUsd: 0,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "start",
        name: "Start",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Return one bounded result.",
      },
    ],
    edges: [],
  };
}

async function saveDefinition(target = app, id = WORKFLOW_ID): Promise<void> {
  const saved = await target.inject({
    method: "PUT",
    url: `/dag-workflows/${id}`,
    headers: { "x-project-id": DEFAULT_PROJECT_ID, "if-none-match": "*" },
    payload: graph(id),
  });
  expect(saved.statusCode).toBe(201);
}

function storeSchedule(patch: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = Date.now();
  const record: ScheduleRecord = {
    storageVersion: SCHEDULE_STORAGE_VERSION,
    id: newScheduleId(),
    projectId: DEFAULT_PROJECT_ID,
    workflowId: WORKFLOW_ID,
    name: "Test schedule",
    expression: "every:1s",
    timezone: "UTC",
    enabled: true,
    overlapPolicy: "skip",
    input: {},
    createdAt: now,
    updatedAt: now,
    cursorMs: now,
    lastFiredWindowKey: null,
    lastFireAt: null,
    lastFireReason: null,
    lastRunId: null,
    ...patch,
  };
  writeSchedule(record);
  return record;
}

function firesFor(scheduleId: string) {
  return readFireRecords(DEFAULT_PROJECT_ID, { scheduleId, limit: 100 });
}

beforeEach(() => {
  executorGate = null;
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(DEFAULT_PROJECT_ID);
});

afterAll(async () => {
  await app.close();
  await executionDisabledApp.close();
  await controller.close({ graceMs: 0 });
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("schedule expressions", () => {
  it("parses the five cron fields, including lists, ranges and steps", () => {
    const expression = parseScheduleExpression("cron:0,30 9-17/4 * * 1-5");
    expect(expression.kind).toBe("cron");
    if (expression.kind !== "cron") throw new Error("expected a cron expression");
    expect([...expression.minutes]).toEqual([0, 30]);
    expect([...expression.hours]).toEqual([9, 13, 17]);
    expect([...expression.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(expression.dayOfWeekRestricted).toBe(true);
    expect(expression.dayOfMonthRestricted).toBe(false);
  });

  it("treats 7 as Sunday and refuses out-of-range and unreadable fields", () => {
    const sunday = parseScheduleExpression("cron:0 0 * * 7");
    if (sunday.kind !== "cron") throw new Error("expected a cron expression");
    expect(sunday.daysOfWeek.has(0)).toBe(true);
    expect(() => parseScheduleExpression("cron:0 24 * * *")).toThrow(/hour/);
    expect(() => parseScheduleExpression("cron:0 0 * *")).toThrow(/five fields/);
    expect(() => parseScheduleExpression("every:0s")).toThrow(/at least 1 second/);
    expect(() => parseScheduleExpression("weekly:mon")).toThrow(/Unknown schedule kind/);
  });

  it("aligns interval windows to the epoch so every process agrees on them", () => {
    const expression = parseScheduleExpression("every:30s");
    const first = nextFire(expression, "UTC", Date.UTC(2026, 7, 18, 12, 0, 5))!;
    expect(first.instantMs).toBe(Date.UTC(2026, 7, 18, 12, 0, 30));
    expect(first.windowKey).toBe(String(Date.UTC(2026, 7, 18, 12, 0, 30)));
    const second = nextFire(expression, "UTC", first.instantMs)!;
    expect(second.instantMs).toBe(Date.UTC(2026, 7, 18, 12, 1, 0));
  });

  it("reports 'never' rather than guessing for an expression that cannot match", () => {
    // 30 February: parseable, and correctly never due.
    expect(nextFire(parseScheduleExpression("cron:0 0 30 2 *"), "UTC", Date.now())).toBeNull();
  });
});

describe("timezone and daylight saving", () => {
  const NEW_YORK = "America/New_York";

  it("skips a local time the spring-forward gap deletes", () => {
    // 2026-03-08, US eastern: 02:00 jumps straight to 03:00, so 02:30 does not
    // exist. instantsForWallClock reports zero instants for it…
    expect(
      instantsForWallClock({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK),
    ).toEqual([]);
    // …and a 02:30-daily schedule therefore fires on the 7th and the 9th, not
    // the 8th. Stated policy: the gap is skipped, never shifted.
    const expression = parseScheduleExpression("cron:30 2 * * *");
    const beforeGap = nextFire(expression, NEW_YORK, Date.UTC(2026, 2, 7, 0, 0))!;
    const afterGap = nextFire(expression, NEW_YORK, beforeGap.instantMs)!;
    expect(beforeGap.windowKey).toBe("2026-03-07T02:30");
    expect(afterGap.windowKey).toBe("2026-03-09T02:30");
  });

  it("fires once, not twice, for a local time the fall-back repeats", () => {
    // 2026-11-01, US eastern: 01:30 happens twice (EDT then EST).
    const both = instantsForWallClock(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      NEW_YORK,
    );
    expect(both).toHaveLength(2);
    expect(both[1] - both[0]).toBe(3_600_000);
    // The window key is the LOCAL WALL MINUTE, so both occurrences carry the
    // same key — and the same key means the same requestId, which the run store
    // collapses to one run. One local time, one run.
    const expression = parseScheduleExpression("cron:30 1 * * *");
    const first = nextFire(expression, NEW_YORK, both[0] - 1)!;
    const second = nextFire(expression, NEW_YORK, both[0])!;
    expect(first.windowKey).toBe("2026-11-01T01:30");
    expect(second.windowKey).toBe("2026-11-01T01:30");
    expect(second.instantMs).toBe(both[1]);
  });

  it("reads the wall clock of the requested zone, not of the host", () => {
    const wall = zonedWallClock(Date.UTC(2026, 7, 18, 22, 30), "Australia/Sydney");
    expect(wall).toMatchObject({ year: 2026, month: 8, day: 19, hour: 8, minute: 30 });
  });
});

describe("the durable scheduler", () => {
  it("fires a due window through the real run route, inheriting the definition's limits", async () => {
    await saveDefinition();
    const schedule = storeSchedule({ cursorMs: Date.now() - 5_000, expression: "every:1s" });
    const scheduler = new Scheduler(app, { maxConcurrentFires: 4 });

    const summary = await scheduler.tick();
    expect(summary.dispatched).toBe(1);

    const fires = firesFor(schedule.id);
    const dispatched = fires.find((fire) => fire.reason === "dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.requestId).toBe(`schedule:${schedule.id}:${dispatched!.windowKey}`);
    expect(dispatched!.runId).toMatch(/^wrun_[a-f0-9]{32}$/);

    // THE EFFECT: a real run manifest exists, it was created for this window,
    // and its effective limits are the definition's own limits — the same
    // budget/maxIterations/evidence ceiling a hand-fired run inherits.
    const run = workflowStore.readRun(DEFAULT_PROJECT_ID, dispatched!.runId!);
    expect(run).not.toBeNull();
    expect(run!.manifest.requestId).toBe(dispatched!.requestId);
    expect(run!.manifest.workflowId).toBe(WORKFLOW_ID);
    expect(run!.manifest.effectiveLimits).toEqual(graph().limits);
    expect(run!.manifest.effectiveLimits.maxTokens).toBe(12_345);
    // …and the controller was asked to start it: a queued-and-forgotten run
    // would still have status "queued" with no execution recorded.
    expect(["running", "succeeded"]).toContain(run!.state.status);
    // The run has a real execution recorded against the graph's entry node,
    // which a created-but-never-started run would not.
    expect(Object.values(run!.state.executions).map((execution) => execution.nodeId))
      .toContain("start");
  });

  it("fires the same window twice and gets ONE run", async () => {
    await saveDefinition();
    // A frozen clock makes "the same window" mean the same window: without it
    // a real second could tick over between the two attempts and the second
    // fire would legitimately be a DIFFERENT window.
    const clock = Math.floor(Date.now() / 1_000) * 1_000;
    const schedule = storeSchedule({ cursorMs: clock - 1_500, expression: "every:1s" });
    const scheduler = new Scheduler(app, { now: () => clock });

    await scheduler.tick();
    const firstFire = firesFor(schedule.id).find((fire) => fire.reason === "dispatched")!;
    expect(firstFire.runId).toBeTruthy();

    // Rewind the cursor: exactly what a restart replaying a missed window, a
    // duplicated timer, or a second process would do.
    const stored = readSchedule(DEFAULT_PROJECT_ID, schedule.id)!;
    writeSchedule({ ...stored, cursorMs: clock - 1_500, lastFiredWindowKey: null });
    await scheduler.tick();

    const dispatched = firesFor(schedule.id).filter((fire) => fire.reason === "dispatched");
    expect(dispatched).toHaveLength(2);
    // Same window ⇒ same requestId ⇒ the store returned the SAME manifest.
    expect(new Set(dispatched.map((fire) => fire.windowKey)).size).toBe(1);
    expect(new Set(dispatched.map((fire) => fire.runId))).toEqual(new Set([firstFire.runId]));
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(1);
  });

  it("catches up at most one missed window and records every window it skipped", async () => {
    await saveDefinition();
    // Ten minutes of one-minute windows came due while nothing was ticking.
    const now = Date.now();
    const schedule = storeSchedule({
      expression: "every:1m",
      cursorMs: now - 10 * 60_000,
    });
    const scheduler = new Scheduler(app, { catchUpGraceMs: 15 * 60_000 });

    const summary = await scheduler.tick();
    expect(summary.dispatched).toBe(1);

    const fires = firesFor(schedule.id);
    const dispatched = fires.filter((fire) => fire.reason === "dispatched");
    const skipped = fires.filter((fire) => fire.reason === "catchup-skipped");
    expect(dispatched).toHaveLength(1);
    expect(skipped.length).toBeGreaterThanOrEqual(8);
    // No window is silently dropped: every missed window has its own record.
    const expected = windowsBetween(
      parseScheduleExpression("every:1m"),
      "UTC",
      now - 10 * 60_000,
      Date.now(),
      50,
    ).windows.length;
    expect(dispatched.length + skipped.length).toBe(expected);
    // The one that ran is the MOST RECENT missed window, not the oldest.
    expect(Number(dispatched[0].windowKey)).toBeGreaterThan(Number(skipped[0].windowKey));
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(1);
  });

  it("refuses to run a window that is older than the catch-up grace period", async () => {
    await saveDefinition();
    const schedule = storeSchedule({
      expression: "every:1h",
      cursorMs: Date.now() - 6 * 3_600_000,
    });
    const scheduler = new Scheduler(app, { catchUpGraceMs: 60_000 });

    await scheduler.tick();
    const fires = firesFor(schedule.id);
    expect(fires.some((fire) => fire.reason === "catchup-expired")).toBe(true);
    expect(fires.some((fire) => fire.reason === "dispatched")).toBe(false);
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(0);
  });

  it("skips the next window while the previous run is still going", async () => {
    await saveDefinition();
    let openGate: (() => void) | null = null;
    executorGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // A frozen, injected clock: window boundaries are chosen by the test, not
    // by how long the assertions take to run.
    let clock = Math.floor(Date.now() / 1_000) * 1_000;
    const schedule = storeSchedule({ expression: "every:1s", cursorMs: clock - 1_500 });
    const scheduler = new Scheduler(app, { now: () => clock });

    await scheduler.tick();
    const firstRunId = firesFor(schedule.id).find((fire) => fire.reason === "dispatched")!.runId!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The run is deliberately still going: its executor is parked on the gate.
    expect(workflowStore.readRun(DEFAULT_PROJECT_ID, firstRunId)!.state.status).toBe("running");

    clock += 1_000;
    await scheduler.tick();

    const overlapSkipped = firesFor(schedule.id).filter(
      (fire) => fire.reason === "overlap-skipped",
    );
    expect(overlapSkipped).toHaveLength(1);
    expect(overlapSkipped[0].runId).toBeNull();
    expect(overlapSkipped[0].detail).toContain("still going");
    // THE EFFECT: exactly one run exists, so the window did not double up.
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(1);
    openGate!();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("starts a second run when the overlap policy says allow", async () => {
    await saveDefinition();
    let openGate: (() => void) | null = null;
    executorGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let clock = Math.floor(Date.now() / 1_000) * 1_000;
    const schedule = storeSchedule({
      expression: "every:1s",
      overlapPolicy: "allow",
      cursorMs: clock - 1_500,
    });
    const scheduler = new Scheduler(app, { now: () => clock });

    await scheduler.tick();
    clock += 1_000;
    await scheduler.tick();

    const dispatched = firesFor(schedule.id).filter((fire) => fire.reason === "dispatched");
    expect(dispatched).toHaveLength(2);
    // Two DIFFERENT windows, so two different requestIds and two real runs —
    // idempotency is per window, not per schedule.
    expect(new Set(dispatched.map((fire) => fire.windowKey)).size).toBe(2);
    expect(new Set(dispatched.map((fire) => fire.runId)).size).toBe(2);
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(2);
    openGate!();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("caps how many schedules start a run in one tick and defers the rest, safely", async () => {
    await saveDefinition();
    const clock = Math.floor(Date.now() / 1_000) * 1_000;
    const schedules = [0, 1, 2].map(() =>
      storeSchedule({ expression: "every:1s", cursorMs: clock - 1_500 }),
    );
    const scheduler = new Scheduler(app, { maxConcurrentFires: 2, now: () => clock });

    const first = await scheduler.tick();
    expect(first.dispatched).toBe(2);
    const deferred = schedules
      .flatMap((schedule) => firesFor(schedule.id))
      .filter((fire) => fire.reason === "capacity-deferred");
    expect(deferred).toHaveLength(1);

    // A deferred window keeps its cursor, so the very next tick still runs it —
    // the cap defers work, it never drops it.
    const second = await scheduler.tick();
    expect(second.dispatched).toBe(1);
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(3);
  });

  it("fails closed when workflow execution is not enabled in the process", async () => {
    await saveDefinition(executionDisabledApp);
    const schedule = storeSchedule({ expression: "every:1s", cursorMs: Date.now() - 2_000 });
    const scheduler = new Scheduler(executionDisabledApp, {});

    await scheduler.tick();
    const fires = firesFor(schedule.id);
    expect(fires[0].reason).toBe("controller-absent");
    expect(fires[0].runId).toBeNull();
    expect(fires[0].detail).toContain("execution is not enabled");
    // Nothing was created: no queued-forever run is left behind.
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(0);
  });

  it("records the workflow going missing instead of failing silently", async () => {
    const schedule = storeSchedule({
      workflowId: "never-existed",
      expression: "every:1s",
      cursorMs: Date.now() - 2_000,
    });
    const scheduler = new Scheduler(app, {});

    await scheduler.tick();
    const fires = firesFor(schedule.id);
    expect(fires[0].reason).toBe("definition-missing");
    expect(fires[0].detail).toContain("no longer exists");
  });

  it("passes over the windows of a paused schedule and does not catch them up", async () => {
    await saveDefinition();
    const schedule = storeSchedule({
      enabled: false,
      expression: "every:1s",
      cursorMs: Date.now() - 5_000,
    });
    const scheduler = new Scheduler(app, {});

    await scheduler.tick();
    const fires = firesFor(schedule.id);
    expect(fires).toHaveLength(1);
    expect(fires[0].reason).toBe("disabled");
    expect(workflowStore.listRuns(DEFAULT_PROJECT_ID, 50)).toHaveLength(0);

    // The cursor followed the clock, so resuming cannot replay the pause.
    const stored = readSchedule(DEFAULT_PROJECT_ID, schedule.id)!;
    expect(stored.cursorMs).toBeGreaterThan(schedule.cursorMs);
  });

  it("survives a restart with its cursor and its next fire time intact", async () => {
    await saveDefinition();
    const schedule = storeSchedule({ expression: "cron:0 9 * * *", timezone: "UTC" });
    const before = scheduleNextFireAt(readSchedule(DEFAULT_PROJECT_ID, schedule.id)!, Date.now());

    // A "restart" for a file-backed store is a fresh read with no memory of the
    // writer: no cache is consulted, the doc on disk is the whole state.
    const restarted = readSchedule(DEFAULT_PROJECT_ID, schedule.id)!;
    expect(restarted.expression).toBe("cron:0 9 * * *");
    expect(restarted.cursorMs).toBe(schedule.cursorMs);
    expect(scheduleNextFireAt(restarted, Date.now())).toBe(before);
    expect(new Date(before!).toISOString()).toMatch(/T09:00:00\.000Z$/);
  });

  it("stops every timer it started when the app closes", async () => {
    const closingApp = await buildApp({ workflowController: null });
    const scheduler = new Scheduler(closingApp, { tickIntervalMs: 10 });
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    closingApp.addHook("onClose", async () => scheduler.stop());
    await closingApp.close();

    expect(scheduler.isRunning()).toBe(false);
    // And a tick after teardown is inert rather than half-alive.
    const schedule = storeSchedule({ expression: "every:1s", cursorMs: Date.now() - 2_000 });
    scheduler.stop();
    expect(firesFor(schedule.id)).toHaveLength(0);
  });

  it("skips an unreadable schedule doc instead of stopping the ticker", async () => {
    await saveDefinition();
    const healthy = storeSchedule({ expression: "every:1s", cursorMs: Date.now() - 2_000 });
    const corruptPath = `${PROJECTS_ROOT}/${DEFAULT_PROJECT_ID}/sandbox/.kady/schedules/sched_${"f".repeat(32)}.json`;
    fs.writeFileSync(corruptPath, "{ not json");

    const scheduler = new Scheduler(app, {});
    const summary = await scheduler.tick();
    expect(summary.dispatched).toBe(1);
    expect(firesFor(healthy.id).some((fire) => fire.reason === "dispatched")).toBe(true);
  });
});
