/**
 * Lane F13 — the schedules API, and THE REAL UNATTENDED FIRE.
 *
 * The centrepiece of this file is "the ticker fires with nobody touching it":
 * the app is built normally, the schedule is created through the HTTP API the
 * Console uses, and then the test WAITS. No tick() is called, no timer is
 * advanced, no internal is poked. What is asserted afterwards is the effect — a
 * real workflow run manifest, created by the schedule, carrying the schedule's
 * requestId and the definition's own limits.
 *
 * A cron-parser test is not evidence that a job runs; this is.
 */
process.env.KADY_SCHEDULER_AUTOSTART = "1";

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
import { readFireRecords } from "../src/scheduling/index.ts";

const WORKFLOW_ID = "scheduled-workflow";
const HEADERS = { "x-project-id": DEFAULT_PROJECT_ID, "content-type": "application/json" };
/** Fastify 400s an empty body that claims application/json, so bodyless POSTs
 *  must not claim it — the web client (lib/schedules.ts) does the same. */
const BODYLESS = { "x-project-id": DEFAULT_PROJECT_ID };

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

const controller = new WorkflowRunController({
  createExecutor: () => async (context) => {
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

function graph(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: WORKFLOW_ID,
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

async function saveDefinition(target = app): Promise<void> {
  const saved = await target.inject({
    method: "PUT",
    url: `/dag-workflows/${WORKFLOW_ID}`,
    headers: { ...HEADERS, "if-none-match": "*" },
    payload: graph(),
  });
  // 409 means another app instance in this test file already wrote the same
  // definition into the shared projects root; either way it now exists.
  expect([201, 409]).toContain(saved.statusCode);
}

async function createSchedule(
  body: Record<string, unknown>,
  target = app,
): Promise<Record<string, any>> {
  const response = await target.inject({
    method: "POST",
    url: "/schedules",
    headers: HEADERS,
    payload: { workflowId: WORKFLOW_ID, name: "Test schedule", ...body },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { schedule: Record<string, any> }).schedule;
}

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs: number,
  label: string,
  diagnose?: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) {
      // A bare timeout says nothing about WHY nothing fired. The fire audit
      // exists precisely to answer that, so it goes into the failure message.
      throw new Error(`Timed out waiting for ${label}.${diagnose ? ` ${diagnose()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

describe("the schedules API", () => {
  it("creates, lists, edits, disables, enables and deletes a schedule", async () => {
    await saveDefinition();
    const created = await createSchedule({
      expression: "cron:0 9 * * 1-5",
      timezone: "Australia/Sydney",
      overlapPolicy: "skip",
      input: { goal: "Summarise yesterday" },
    });
    expect(created.id).toMatch(/^sched_[a-f0-9]{32}$/);
    expect(created.enabled).toBe(true);
    // The next fire time is computed SERVER-side, from the same code the ticker
    // uses to decide when to fire, so it cannot disagree with the fire.
    expect(typeof created.next_fire_at).toBe("string");

    const listed = await app.inject({ method: "GET", url: "/schedules", headers: HEADERS });
    expect(listed.statusCode).toBe(200);
    const listing = listed.json() as { scheduler_running: boolean; schedules: any[] };
    expect(listing.scheduler_running).toBe(true);
    expect(listing.schedules).toHaveLength(1);
    expect(listing.schedules[0].next_fire_at).toBe(created.next_fire_at);

    const edited = await app.inject({
      method: "PATCH",
      url: `/schedules/${created.id}`,
      headers: HEADERS,
      payload: { name: "Renamed", expression: "cron:30 6 * * *", overlapPolicy: "allow" },
    });
    expect(edited.statusCode).toBe(200);
    const editedSchedule = (edited.json() as { schedule: any }).schedule;
    expect(editedSchedule.name).toBe("Renamed");
    expect(editedSchedule.overlap_policy).toBe("allow");
    expect(editedSchedule.next_fire_at).not.toBe(created.next_fire_at);

    const disabled = await app.inject({
      method: "POST",
      url: `/schedules/${created.id}/disable`,
      headers: BODYLESS,
    });
    expect((disabled.json() as { schedule: any }).schedule.enabled).toBe(false);

    const enabled = await app.inject({
      method: "POST",
      url: `/schedules/${created.id}/enable`,
      headers: BODYLESS,
    });
    expect((enabled.json() as { schedule: any }).schedule.enabled).toBe(true);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/schedules/${created.id}`,
      headers: BODYLESS,
    });
    expect(deleted.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: "/schedules", headers: HEADERS });
    expect((afterDelete.json() as { schedules: any[] }).schedules).toHaveLength(0);
  });

  it("refuses bad input with a reason and no filesystem path", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ expression: "cron:99 * * * *" }, /minute/],
      [{ expression: "every:9y" }, /interval expression/],
      [{ expression: "every:1m", timezone: "Mars/Olympus" }, /IANA time zone/],
      [{ expression: "every:1m", overlapPolicy: "queue" }, /overlapPolicy/],
      [{ expression: "every:1m", name: "" }, /name is required/],
    ];
    for (const [payload, expected] of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/schedules",
        headers: HEADERS,
        payload: { workflowId: WORKFLOW_ID, name: "Test schedule", ...payload },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { detail: string };
      expect(body.detail).toMatch(expected);
      // #71: no filesystem path. A timezone name legitimately contains a
      // slash, so the assertion is against path-shaped text, not any slash.
      expect(body.detail).not.toMatch(/\/(?:Users|home|tmp|var|private)\//);
      expect(body.detail).not.toContain(PROJECTS_ROOT);
    }
    const missing = await app.inject({
      method: "GET",
      url: `/schedules/sched_${"a".repeat(32)}`,
      headers: HEADERS,
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { detail: string }).detail).toBe("That schedule no longer exists.");
  });

  // ---------------------------------------------------------------------
  // Row 52's acceptance evidence.
  // ---------------------------------------------------------------------
  it("FIRES UNATTENDED: a schedule created through the API starts a real run with nobody watching", async () => {
    await saveDefinition();
    const before = Date.now();
    const schedule = await createSchedule({ expression: "every:1s", timezone: "UTC" });

    // Nothing below touches the scheduler. The only thing that happens between
    // here and the assertion is time passing.
    const fire = await waitFor(
      () =>
        readFireRecords(DEFAULT_PROJECT_ID, { scheduleId: schedule.id, limit: 20 })
          .find((record) => record.reason === "dispatched"),
      60_000,
      "an unattended fire",
      () =>
        `Fire records so far: ${JSON.stringify(
          readFireRecords(DEFAULT_PROJECT_ID, { scheduleId: schedule.id, limit: 20 })
            .map((record) => ({ reason: record.reason, detail: record.detail })),
        )}`,
    );

    expect(fire.firedAt).toBeGreaterThanOrEqual(before);
    expect(fire.requestId).toBe(`schedule:${schedule.id}:${fire.windowKey}`);
    expect(fire.runId).toMatch(/^wrun_[a-f0-9]{32}$/);

    // THE EFFECT — a real run manifest the scheduler created:
    const run = workflowStore.readRun(DEFAULT_PROJECT_ID, fire.runId!)!;
    expect(run.manifest.requestId).toBe(fire.requestId);
    expect(run.manifest.workflowId).toBe(WORKFLOW_ID);
    // …with the DEFINITION's limits, inherited exactly as a hand-fired run does:
    expect(run.manifest.effectiveLimits).toEqual(graph().limits);
    // …and the controller really was asked to start it, so a node executed:
    await waitFor(
      () =>
        Object.values(workflowStore.readRun(DEFAULT_PROJECT_ID, fire.runId!)!.state.executions)
          .find((execution) => execution.nodeId === "start"),
      10_000,
      "the entry node to execute",
    );

    // The audit trail says the same thing the Console shows.
    const fires = await app.inject({
      method: "GET",
      url: `/schedules/${schedule.id}/fires`,
      headers: HEADERS,
    });
    expect(fires.statusCode).toBe(200);
    const history = (fires.json() as { fires: any[] }).fires;
    expect(history.some((entry) => entry.run_id === fire.runId)).toBe(true);
    expect(history[0].run_status).not.toBeUndefined();

    await app.inject({ method: "DELETE", url: `/schedules/${schedule.id}`, headers: BODYLESS });
  }, 90_000);

  it("survives a restart with its next fire time intact", async () => {
    await saveDefinition();
    const schedule = await createSchedule({
      expression: "cron:0 9 * * *",
      timezone: "Australia/Sydney",
    });

    // A second app instance is what a restarted backend is, for a file-backed
    // store: no shared memory, the doc on disk is the whole state.
    const restarted = await buildApp({ workflowController: null });
    try {
      const listed = await restarted.inject({ method: "GET", url: "/schedules", headers: HEADERS });
      const survivor = (listed.json() as { schedules: any[] }).schedules[0];
      expect(survivor.id).toBe(schedule.id);
      expect(survivor.expression).toBe("cron:0 9 * * *");
      expect(survivor.timezone).toBe("Australia/Sydney");
      expect(survivor.next_fire_at).toBe(schedule.next_fire_at);
    } finally {
      await restarted.close();
    }
  });

  it("runs on demand, and says honestly when a demanded run did not happen", async () => {
    await saveDefinition();
    const schedule = await createSchedule({ expression: "cron:0 9 * * *" });
    const ran = await app.inject({
      method: "POST",
      url: `/schedules/${schedule.id}/run-now`,
      headers: BODYLESS,
    });
    expect(ran.statusCode).toBe(202);
    const fire = (ran.json() as { fire: any }).fire;
    expect(fire.reason).toBe("dispatched");
    expect(fire.window_key).toMatch(/^manual-/);
    expect(workflowStore.readRun(DEFAULT_PROJECT_ID, fire.run_id)).not.toBeNull();

    // Against a process with execution disabled, the same call refuses rather
    // than minting a run nothing will ever execute.
    await saveDefinition(executionDisabledApp);
    const offline = await createSchedule({ expression: "cron:0 9 * * *" }, executionDisabledApp);
    const refused = await executionDisabledApp.inject({
      method: "POST",
      url: `/schedules/${offline.id}/run-now`,
      headers: BODYLESS,
    });
    // 200, not an HTTP error: the fire was evaluated and recorded, it just did
    // not run. The body says so in two independent ways.
    expect(refused.statusCode).toBe(200);
    expect((refused.json() as { dispatched: boolean }).dispatched).toBe(false);
    const refusedFire = (refused.json() as { fire: any }).fire;
    expect(refusedFire.reason).toBe("controller-absent");
    expect(refusedFire.run_id).toBeNull();
    expect(refusedFire.detail).toContain("execution is not enabled");
  });

  it("stops a runaway: pauses the schedule AND cancels the run it already started", async () => {
    await saveDefinition();
    let openGate: (() => void) | null = null;
    executorGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const schedule = await createSchedule({ expression: "cron:0 9 * * *" });
    const ran = await app.inject({
      method: "POST",
      url: `/schedules/${schedule.id}/run-now`,
      headers: BODYLESS,
    });
    const runId = (ran.json() as { fire: any }).fire.run_id as string;
    await waitFor(
      () =>
        workflowStore.readRun(DEFAULT_PROJECT_ID, runId)!.state.status === "running" ? true : null,
      5_000,
      "the run to start",
    );

    const stopped = await app.inject({
      method: "POST",
      url: `/schedules/${schedule.id}/stop`,
      headers: BODYLESS,
    });
    expect(stopped.statusCode).toBe(200);
    const body = stopped.json() as { schedule: any; cancelled_run_ids: string[] };
    // Meaning (i): no further window fires.
    expect(body.schedule.enabled).toBe(false);
    // Meaning (ii): the run that was already burning budget is cancelled.
    expect(body.cancelled_run_ids).toContain(runId);
    await waitFor(
      () =>
        ["cancelled", "failed"].includes(
          workflowStore.readRun(DEFAULT_PROJECT_ID, runId)!.state.status,
        )
          ? true
          : null,
      5_000,
      "the run to reach a terminal state",
    );
    if (openGate) (openGate as () => void)();
  }, 20_000);
});
