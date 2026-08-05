import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { projectCostSummary, recordRun } from "../src/cost/ledger.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import {
  WorkflowBudgetError,
  WorkflowBudgetStore,
  reserveWorkflowBudget,
  workflowBudgetReservationId,
  workflowRunBudgetSummary,
  workflowBudgetSummary,
} from "../src/workflows/budget.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

beforeEach(reset);
afterAll(reset);

function reservationId(label: string): string {
  return workflowBudgetReservationId("test", label);
}

function usage(cost: number, total = 100) {
  return {
    input: Math.floor(total * 0.6),
    output: Math.floor(total * 0.2),
    total,
    cost,
    cacheRead: Math.floor(total * 0.1),
    cacheWrite: Math.floor(total * 0.1),
  };
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for budget race workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function budgetRaceWorker(args: {
  projectId: string;
  reservationId: string;
  runId: string;
  readyFile: string;
  barrierFile: string;
}): Promise<string> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "workflows", "budget.ts"),
  ).href;
  const script = `
    import fs from "node:fs";
    import { reserveWorkflowBudget } from ${JSON.stringify(moduleUrl)};
    fs.writeFileSync(${JSON.stringify(args.readyFile)}, "ready\\n");
    while (!fs.existsSync(${JSON.stringify(args.barrierFile)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      await reserveWorkflowBudget(${JSON.stringify({
        projectId: args.projectId,
        reservationId: args.reservationId,
        runId: args.runId,
        runMaxCostUsd: 10,
        runMaxTokens: 1_000,
        runMaxModelCalls: 100,
        modelCallCount: 1,
        maxCostUsd: 4,
        maxTokens: 100,
      })});
      process.stdout.write("reserved");
    } catch (error) {
      process.stdout.write(String(error?.code ?? error?.name ?? "error"));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Budget race worker exited ${String(code)}: ${stderr}`));
    });
  });
}

function mixedBudgetRaceWorker(args: {
  kind: "modal" | "workflow";
  projectId: string;
  readyFile: string;
  barrierFile: string;
}): Promise<string> {
  const budgetModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "workflows", "budget.ts"),
  ).href;
  const ledgerModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "cost", "ledger.ts"),
  ).href;
  const admission = args.kind === "modal"
    ? `reserveComputeBudget({
        projectId: ${JSON.stringify(args.projectId)},
        reservationId: "modal-race",
        sessionId: "modal-session",
        amountUsd: 4,
      })`
    : `await reserveWorkflowBudget({
        projectId: ${JSON.stringify(args.projectId)},
        reservationId: "wbres_11111111111111111111111111111111",
        runId: "run:mixed-race",
        runMaxCostUsd: 4,
        runMaxTokens: 100,
        runMaxModelCalls: 1,
        modelCallCount: 1,
        maxCostUsd: 4,
        maxTokens: 100,
      })`;
  const script = `
    import fs from "node:fs";
    import { reserveWorkflowBudget } from ${JSON.stringify(budgetModuleUrl)};
    import { reserveComputeBudget } from ${JSON.stringify(ledgerModuleUrl)};
    fs.writeFileSync(${JSON.stringify(args.readyFile)}, "ready\\n");
    while (!fs.existsSync(${JSON.stringify(args.barrierFile)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      ${admission};
      process.stdout.write(${JSON.stringify(`${args.kind}:reserved`)});
    } catch (error) {
      process.stdout.write(
        ${JSON.stringify(`${args.kind}:`)} + String(error?.code ?? error?.name ?? "error"),
      );
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Mixed budget race worker exited ${String(code)}: ${stderr}`));
    });
  });
}

describe("durable workflow budget reservations", () => {
  it("projects one run's ceilings and commitments without reasons or false token claims", async () => {
    createProject({ name: "Run projection", projectId: "run-projection", spendLimitUsd: 100 });
    let now = 1_000;
    const store = new WorkflowBudgetStore({ now: () => now });
    const common = {
      projectId: "run-projection",
      runId: "run:projected",
      runMaxCostUsd: 20,
      runMaxTokens: 1_000,
      runMaxModelCalls: 10,
    };

    const observed = await store.reserve({
      ...common,
      reservationId: reservationId("projection-observed"),
      modelCallCount: 1,
      maxCostUsd: 3,
      maxTokens: 100,
      initialUsage: usage(1, 20),
    });
    await observed.settle({ status: "completed", usage: usage(2.25, 70) });

    const missing = await store.reserve({
      ...common,
      reservationId: reservationId("projection-missing"),
      modelCallCount: 2,
      maxCostUsd: 4,
      maxTokens: 200,
    });
    await missing.settle({ status: "failed", reason: "provider credential vanished" });

    await store.reserve({
      ...common,
      reservationId: reservationId("projection-stale"),
      modelCallCount: 1,
      maxCostUsd: 2,
      maxTokens: 100,
      leaseDurationMs: 1_000,
    });
    await store.reserve({
      ...common,
      reservationId: reservationId("projection-active"),
      modelCallCount: 3,
      maxCostUsd: 5,
      maxTokens: 300,
      initialUsage: usage(1, 50),
    });
    now = 2_000;
    await store.reconcileStale("run-projection");

    const summary = workflowRunBudgetSummary("run-projection", "run:projected");
    expect(summary).toEqual({
      runId: "run:projected",
      reservationCount: 4,
      ceilings: { maxCostUsd: 20, maxTokens: 1_000, maxModelCalls: 10 },
      modelCallCount: 7,
      activeReservationCount: 1,
      activeReservedMaximumUsd: 4,
      activeReservedMaximumTokens: 300,
      settledReservationCount: 3,
      settledChargedUsd: 7.25,
      observedUsageTokens: 50,
      missingUsageMaximumTokens: 300,
      staleReservationCount: 1,
      fullChargeReservationCount: 2,
    });
    expect(JSON.stringify(summary)).not.toContain("credential");

    expect(workflowRunBudgetSummary("run-projection", "run:unseen")).toEqual({
      runId: "run:unseen",
      reservationCount: 0,
      ceilings: null,
      modelCallCount: 0,
      activeReservationCount: 0,
      activeReservedMaximumUsd: 0,
      activeReservedMaximumTokens: 0,
      settledReservationCount: 0,
      settledChargedUsd: 0,
      observedUsageTokens: 0,
      missingUsageMaximumTokens: 0,
      staleReservationCount: 0,
      fullChargeReservationCount: 0,
    });
  });

  it("reserves the maximum before work and includes it in the project commitment", async () => {
    createProject({ name: "Budget", projectId: "budget", spendLimitUsd: 10 });
    recordRun({
      projectId: "budget",
      sessionId: "prior",
      model: "openrouter/test/model",
      before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
      after: { costUsd: 2, input: 10, output: 2, cacheRead: 0, total: 12 },
    });

    const handle = await reserveWorkflowBudget({
      projectId: "budget",
      reservationId: reservationId("first"),
      runId: "run:first",
      runMaxCostUsd: 5,
      runMaxTokens: 1_000,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 5,
      maxTokens: 1_000,
    });

    expect(handle.record).toMatchObject({ status: "active", reservedCostUsd: 5 });
    const summary = projectCostSummary("budget");
    expect(summary.ledgerSpentUsd).toBeCloseTo(2, 8);
    expect(summary.workflowReservedUsd).toBeCloseTo(5, 8);
    expect(summary.reservedUsd).toBeCloseTo(5, 8);
    expect(summary.committedUsd).toBeCloseTo(7, 8);
    expect(summary.budget.totalUsd).toBeCloseTo(7, 8);
  });

  it("admits only one of two competing owners under the same project cap", async () => {
    createProject({ name: "Race", projectId: "race", spendLimitUsd: 5 });
    const firstStore = new WorkflowBudgetStore();
    const secondStore = new WorkflowBudgetStore();
    const results = await Promise.allSettled([
      firstStore.reserve({
        projectId: "race",
        reservationId: reservationId("race-a"),
        runId: "run:race-a",
        runMaxCostUsd: 4,
        runMaxTokens: 100,
        runMaxModelCalls: 100,
        modelCallCount: 1,
        maxCostUsd: 4,
        maxTokens: 100,
      }),
      secondStore.reserve({
        projectId: "race",
        reservationId: reservationId("race-b"),
        runId: "run:race-b",
        runMaxCostUsd: 4,
        runMaxTokens: 100,
        runMaxModelCalls: 100,
        modelCallCount: 1,
        maxCostUsd: 4,
        maxTokens: 100,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      name: "WorkflowBudgetError",
      code: "LIMIT_EXCEEDED",
    });
    expect(workflowBudgetSummary("race").activeReservedUsd).toBe(4);
  });

  it("serializes the cap check across independent Node processes", async () => {
    createProject({ name: "Processes", projectId: "processes", spendLimitUsd: 5 });
    const scratch = path.join(PROJECTS_ROOT, "process-race-signals");
    fs.mkdirSync(scratch, { recursive: true });
    const barrierFile = path.join(scratch, "go");
    const readyFiles = [path.join(scratch, "a.ready"), path.join(scratch, "b.ready")];
    const workers = [
      budgetRaceWorker({
        projectId: "processes",
        reservationId: reservationId("process-a"),
        runId: "run:process-a",
        readyFile: readyFiles[0],
        barrierFile,
      }),
      budgetRaceWorker({
        projectId: "processes",
        reservationId: reservationId("process-b"),
        runId: "run:process-b",
        readyFile: readyFiles[1],
        barrierFile,
      }),
    ];
    await waitForFiles(readyFiles);
    fs.writeFileSync(barrierFile, "go\n");
    const outcomes = await Promise.all(workers);

    expect(outcomes.sort()).toEqual(["LIMIT_EXCEEDED", "reserved"]);
    expect(workflowBudgetSummary("processes")).toMatchObject({
      activeCount: 1,
      activeReservedUsd: 4,
    });
  }, 20_000);

  it("serializes competing Modal and DAG admissions under one project cap", async () => {
    createProject({ name: "Mixed admissions", projectId: "mixed-admissions", spendLimitUsd: 5 });
    const scratch = path.join(PROJECTS_ROOT, "mixed-admission-race-signals");
    fs.mkdirSync(scratch, { recursive: true });
    const barrierFile = path.join(scratch, "go");
    const readyFiles = [path.join(scratch, "modal.ready"), path.join(scratch, "workflow.ready")];
    const workers = [
      mixedBudgetRaceWorker({
        kind: "modal",
        projectId: "mixed-admissions",
        readyFile: readyFiles[0],
        barrierFile,
      }),
      mixedBudgetRaceWorker({
        kind: "workflow",
        projectId: "mixed-admissions",
        readyFile: readyFiles[1],
        barrierFile,
      }),
    ];
    await waitForFiles(readyFiles);
    fs.writeFileSync(barrierFile, "go\n");
    const outcomes = await Promise.all(workers);

    expect(outcomes.filter((outcome) => outcome.endsWith(":reserved"))).toHaveLength(1);
    expect((
      outcomes.includes("modal:reserved") && outcomes.includes("workflow:LIMIT_EXCEEDED")
    ) || (
      outcomes.includes("workflow:reserved") && outcomes.includes("modal:BudgetReservationError")
    )).toBe(true);
    const summary = projectCostSummary("mixed-admissions");
    expect([summary.modalReservedUsd, summary.workflowReservedUsd].sort((a, b) => a - b))
      .toEqual([0, 4]);
    expect(summary.reservedUsd).toBe(4);
    expect(summary.committedUsd).toBe(4);
  }, 20_000);

  it("atomically enforces one run ceiling across independent store instances", async () => {
    createProject({ name: "Run ceiling", projectId: "run-ceiling", spendLimitUsd: 100 });
    const firstStore = new WorkflowBudgetStore();
    const secondStore = new WorkflowBudgetStore();
    const base = {
      projectId: "run-ceiling",
      runId: "run:shared",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 6,
      maxTokens: 60,
    };
    const outcomes = await Promise.allSettled([
      firstStore.reserve({ ...base, reservationId: reservationId("run-shared-a") }),
      secondStore.reserve({ ...base, reservationId: reservationId("run-shared-b") }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { name: "WorkflowBudgetError", code: "LIMIT_EXCEEDED" },
    });
    const active = new WorkflowBudgetStore().list("run-ceiling");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      runId: "run:shared",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
    });

    const admittedOutcome = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (!admittedOutcome || admittedOutcome.status !== "fulfilled") {
      throw new Error("Expected one admitted run reservation");
    }
    await admittedOutcome.value.settle({ status: "completed", usage: usage(4, 40) });
    await expect(firstStore.reserve({
      ...base,
      reservationId: reservationId("run-shared-after-actual"),
    })).resolves.toBeDefined();
  });

  it("atomically counts compound model calls and preserves the count after settlement", async () => {
    createProject({ name: "Run calls", projectId: "run-calls", spendLimitUsd: 100 });
    const firstStore = new WorkflowBudgetStore();
    const secondStore = new WorkflowBudgetStore();
    const base = {
      projectId: "run-calls",
      runId: "run:compound-calls",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
      runMaxModelCalls: 3,
      modelCallCount: 2,
      maxCostUsd: 1,
      maxTokens: 10,
    };
    const outcomes = await Promise.allSettled([
      firstStore.reserve({ ...base, reservationId: reservationId("compound-a") }),
      secondStore.reserve({ ...base, reservationId: reservationId("compound-b") }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "LIMIT_EXCEEDED" },
    });
    const admittedOutcome = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (!admittedOutcome || admittedOutcome.status !== "fulfilled") {
      throw new Error("Expected one admitted compound reservation");
    }
    expect(admittedOutcome.value.record).toMatchObject({
      runMaxModelCalls: 3,
      modelCallCount: 2,
    });
    await admittedOutcome.value.settle({ status: "completed", usage: usage(0.5, 5) });
    await expect(firstStore.reserve({
      ...base,
      reservationId: reservationId("compound-after-terminal"),
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(firstStore.reserve({
      ...base,
      reservationId: reservationId("compound-inconsistent-ceiling"),
      runMaxModelCalls: 4,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("charges missing terminal usage conservatively against later run admission", async () => {
    createProject({ name: "Unknown run use", projectId: "run-unknown", spendLimitUsd: 100 });
    const store = new WorkflowBudgetStore();
    const first = await store.reserve({
      projectId: "run-unknown",
      reservationId: reservationId("run-unknown-a"),
      runId: "run:unknown-aggregate",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 6,
      maxTokens: 60,
    });
    await first.settle({ status: "failed", reason: "usage unavailable" });

    await expect(store.reserve({
      projectId: "run-unknown",
      reservationId: reservationId("run-unknown-b"),
      runId: "run:unknown-aggregate",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 5,
      maxTokens: 50,
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("settles once, keeps the audit record, and counts observed incremental spend", async () => {
    createProject({ name: "Settle", projectId: "settle", spendLimitUsd: 10 });
    const input = {
      projectId: "settle",
      reservationId: reservationId("settle"),
      runId: "run:settle",
      runMaxCostUsd: 3,
      runMaxTokens: 1_000,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 3,
      maxTokens: 1_000,
      initialUsage: usage(1, 100),
    };
    const handle = await reserveWorkflowBudget(input);
    expect(handle.record.reservedCostUsd).toBeCloseTo(2, 8);

    const settlement = { status: "completed" as const, usage: usage(1.75, 180) };
    const settled = await handle.settle(settlement);
    const repeated = await handle.settle(settlement);
    expect(repeated).toEqual(settled);
    expect(settled).toMatchObject({
      status: "completed",
      settlement: {
        usageComplete: true,
        chargedCostUsd: 0.75,
        incrementalUsage: { total: 80, costUsd: 0.75 },
      },
    });
    await expect(handle.settle({ ...settlement, reason: "different" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await expect(reserveWorkflowBudget(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(new WorkflowBudgetStore().list("settle")[0].status).toBe("completed");
    const summary = projectCostSummary("settle");
    expect(summary.workflowReservedUsd).toBe(0);
    expect(summary.workflowSpentUsd).toBeCloseTo(0.75, 8);
    expect(summary.spentUsd).toBeCloseTo(0.75, 8);
    expect(summary.totalTokens).toBe(80);
  });

  it("charges the reserved maximum when terminal usage is unavailable", async () => {
    createProject({ name: "Unknown", projectId: "unknown", spendLimitUsd: 10 });
    const handle = await reserveWorkflowBudget({
      projectId: "unknown",
      reservationId: reservationId("unknown"),
      runId: "run:unknown",
      runMaxCostUsd: 2.5,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 2.5,
      maxTokens: 100,
    });
    const settled = await handle.settle({ status: "failed", reason: "worker vanished" });
    expect(settled.settlement).toMatchObject({
      usageComplete: false,
      chargedCostUsd: 2.5,
    });
    expect(projectCostSummary("unknown").workflowSpentUsd).toBeCloseTo(2.5, 8);
  });

  it("renews live work and fences late settlement after stale restart reconciliation", async () => {
    createProject({ name: "Restart", projectId: "restart", spendLimitUsd: 10 });
    let now = 1_000;
    const store = new WorkflowBudgetStore({ now: () => now });
    const handle = await store.reserve({
      projectId: "restart",
      reservationId: reservationId("restart"),
      runId: "run:restart",
      runMaxCostUsd: 2,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 2,
      maxTokens: 100,
      leaseDurationMs: 1_000,
    });
    now = 1_500;
    const renewed = await handle.renew();
    expect(renewed.leaseGeneration).toBe(2);
    expect(renewed.expiresAt).toBe(2_500);
    now = 2_499;
    expect(await store.reconcileStale("restart")).toEqual([]);
    now = 2_500;
    const reconciled = await store.reconcileStale("restart");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      status: "stale",
      settlement: { usageComplete: false, chargedCostUsd: 2 },
    });
    await expect(handle.settle({ status: "completed", usage: usage(1) })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(projectCostSummary("restart")).toMatchObject({
      workflowReservedUsd: 0,
      workflowSpentUsd: 2,
    });
  });

  it("reconciles expired active reservations inside the next admission lock", async () => {
    createProject({ name: "Admission reconciliation", projectId: "admission-reconcile", spendLimitUsd: 100 });
    let now = 1_000;
    const store = new WorkflowBudgetStore({ now: () => now });
    await store.reserve({
      projectId: "admission-reconcile",
      reservationId: reservationId("expired-before-admission"),
      runId: "run:admission-reconcile",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
      runMaxModelCalls: 2,
      modelCallCount: 1,
      maxCostUsd: 6,
      maxTokens: 60,
      initialUsage: usage(2, 20),
      leaseDurationMs: 1_000,
    });
    now = 2_000;

    await expect(store.reserve({
      projectId: "admission-reconcile",
      reservationId: reservationId("trigger-reconciliation"),
      runId: "run:admission-reconcile",
      runMaxCostUsd: 10,
      runMaxTokens: 100,
      runMaxModelCalls: 2,
      modelCallCount: 1,
      maxCostUsd: 6,
      maxTokens: 40,
    })).resolves.toBeDefined();
    expect(store.list("admission-reconcile").map((record) => record.status).sort()).toEqual([
      "active",
      "stale",
    ]);
  });

  it("fails project summary and new admission closed on malformed records", async () => {
    createProject({ name: "Malformed", projectId: "malformed", spendLimitUsd: 10 });
    const paths = resolvePaths("malformed");
    fs.mkdirSync(paths.workflowReservationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.workflowReservationsDir, `${reservationId("bad")}.json`),
      "{not-json\n",
      "utf-8",
    );

    expect(() => workflowBudgetSummary("malformed")).toThrowError(WorkflowBudgetError);
    expect(() => projectCostSummary("malformed")).toThrowError(/malformed JSON/);
    await expect(reserveWorkflowBudget({
      projectId: "malformed",
      reservationId: reservationId("new"),
      runId: "run:new",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "CORRUPT" });
  });

  it("keeps legacy crash temps from bricking listing and stages new writes elsewhere", async () => {
    createProject({ name: "Temp recovery", projectId: "temp-recovery", spendLimitUsd: 10 });
    const store = new WorkflowBudgetStore();
    const id = reservationId("temp-recovery-a");
    await store.reserve({
      projectId: "temp-recovery",
      reservationId: id,
      runId: "run:temp-recovery",
      runMaxCostUsd: 2,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 50,
    });
    const paths = resolvePaths("temp-recovery");
    const legacyName = `.${id}.999999.00000000-0000-4000-8000-000000000000.tmp`;
    fs.writeFileSync(path.join(paths.workflowReservationsDir, legacyName), "partial\n");

    expect(store.list("temp-recovery")).toHaveLength(1);
    await store.reserve({
      projectId: "temp-recovery",
      reservationId: reservationId("temp-recovery-b"),
      runId: "run:temp-recovery",
      runMaxCostUsd: 2,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 50,
    });
    expect(fs.readdirSync(paths.workflowReservationsDir).sort()).toEqual([
      legacyName,
      `${id}.json`,
      `${reservationId("temp-recovery-b")}.json`,
    ].sort());
    expect(fs.statSync(path.join(paths.workflowBudgetDir, ".reservation-write-tmp")).isDirectory()).toBe(true);
  });

  it("recovers dead primary and recovery locks but never steals an old live recovery lock", async () => {
    createProject({ name: "Lock recovery", projectId: "lock-recovery", spendLimitUsd: 10 });
    const paths = resolvePaths("lock-recovery");
    fs.mkdirSync(paths.workflowBudgetDir, { recursive: true });
    const lockFile = path.join(paths.workflowBudgetDir, ".mutation.lock");
    const recoveryFile = path.join(paths.workflowBudgetDir, ".mutation.recovery.lock");
    const old = Date.now() - 10_000;
    const deadOwner = (token: string) => ({
      version: 1,
      token,
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: old,
    });
    fs.writeFileSync(lockFile, `${JSON.stringify(deadOwner("a".repeat(64)))}\n`);
    fs.writeFileSync(recoveryFile, `${JSON.stringify(deadOwner("b".repeat(64)))}\n`);

    const store = new WorkflowBudgetStore({ lockStaleMs: 1_000, lockWaitMs: 100 });
    await expect(store.reserve({
      projectId: "lock-recovery",
      reservationId: reservationId("recovered-lock"),
      runId: "run:recovered-lock",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).resolves.toBeDefined();
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.existsSync(recoveryFile)).toBe(false);

    fs.writeFileSync(lockFile, `${JSON.stringify(deadOwner("c".repeat(64)))}\n`);
    const liveRecovery = {
      version: 1,
      token: "d".repeat(64),
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: old,
    };
    fs.writeFileSync(recoveryFile, `${JSON.stringify(liveRecovery)}\n`);
    const impatientStore = new WorkflowBudgetStore({ lockStaleMs: 1_000, lockWaitMs: 20 });
    await expect(impatientStore.reserve({
      projectId: "lock-recovery",
      reservationId: reservationId("must-not-steal"),
      runId: "run:must-not-steal",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(JSON.parse(fs.readFileSync(recoveryFile, "utf-8"))).toEqual(liveRecovery);
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("detects a hand-edited settlement that understates charged cost", async () => {
    createProject({ name: "Tampered", projectId: "tampered", spendLimitUsd: 10 });
    const id = reservationId("tampered");
    const handle = await reserveWorkflowBudget({
      projectId: "tampered",
      reservationId: id,
      runId: "run:tampered",
      runMaxCostUsd: 2,
      runMaxTokens: 100,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 2,
      maxTokens: 100,
    });
    await handle.settle({ status: "completed", usage: usage(1) });
    const file = path.join(resolvePaths("tampered").workflowReservationsDir, `${id}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
    record.settlement.chargedCostUsd = 0;
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

    expect(() => projectCostSummary("tampered")).toThrowError(/inconsistent charged usage/);
    await expect(reserveWorkflowBudget({
      projectId: "tampered",
      reservationId: reservationId("after-tamper"),
      runId: "run:after-tamper",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "CORRUPT" });
  });

  it("rejects symlinked reservation paths instead of following them", async () => {
    createProject({ name: "Symlink", projectId: "symlink", spendLimitUsd: 10 });
    const paths = resolvePaths("symlink");
    const outside = path.join(PROJECTS_ROOT, "outside-budget");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(paths.workflowsDir, { recursive: true });
    fs.symlinkSync(outside, paths.workflowBudgetDir, "dir");

    expect(() => workflowBudgetSummary("symlink")).toThrowError(/not a real directory/);
    await expect(reserveWorkflowBudget({
      projectId: "symlink",
      reservationId: reservationId("symlink"),
      runId: "run:symlink",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "CORRUPT" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects traversal-shaped identifiers and malformed lock ownership", async () => {
    createProject({ name: "Lock", projectId: "lock", spendLimitUsd: 10 });
    await expect(reserveWorkflowBudget({
      projectId: "../lock",
      reservationId: reservationId("escape"),
      runId: "run:escape",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(reserveWorkflowBudget({
      projectId: "lock",
      reservationId: "../../escape",
      runId: "run:escape",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const paths = resolvePaths("lock");
    fs.mkdirSync(paths.workflowBudgetDir, { recursive: true });
    fs.writeFileSync(path.join(paths.workflowBudgetDir, ".mutation.lock"), "not-json\n");
    await expect(reserveWorkflowBudget({
      projectId: "lock",
      reservationId: reservationId("lock"),
      runId: "run:lock",
      runMaxCostUsd: 1,
      runMaxTokens: 10,
      runMaxModelCalls: 100,
      modelCallCount: 1,
      maxCostUsd: 1,
      maxTokens: 10,
    })).rejects.toMatchObject({ code: "CORRUPT" });
  });
});
