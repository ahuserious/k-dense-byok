import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { PROJECTS_ROOT, DEFAULT_PROJECT_ID } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { finishRun, startRun } from "../src/agent/runs-index.ts";

/**
 * /console/* contract: the Agent Console reads runs + loops out of the
 * file-backed runs-index and the loop lifecycle routes operate on the
 * persisted loop doc only (no execution engine — see api/console.ts header).
 * Wire shape is the snake_case console-types contract the web client expects.
 */

const { buildApp } = await import("../src/index.ts");
const app = await buildApp({ workflowController: null });

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(DEFAULT_PROJECT_ID);
});

afterAll(async () => {
  await app.close();
});

describe("console runs feed", () => {
  it("returns recorded runs newest-first in wire shape", async () => {
    const runId = startRun(DEFAULT_PROJECT_ID, {
      sessionId: "sess-1",
      loopId: null,
      iteration: 0,
      task: "proxy an Pipeline engine workflow",
      role: "workflow",
      model: "openrouter/test-model",
    });
    finishRun(DEFAULT_PROJECT_ID, "sess-1", runId, {
      status: "completed",
      costUsd: 0.42,
      output: "done",
    });

    const res = await app.inject({ method: "GET", url: "/console/runs" });
    expect(res.statusCode).toBe(200);
    const runs = res.json() as Record<string, unknown>[];
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.id).toBe(runId);
    expect(run.role).toBe("workflow");
    expect(run.status).toBe("completed");
    expect(run.model).toBe("openrouter/test-model");
    expect(run.cost_usd).toBe(0.42);
    expect(run.session_id).toBe("sess-1");
    expect(typeof run.started_at).toBe("string");
    expect(run.completed_at).not.toBeNull();
  });

  it("returns an empty list when nothing has run", async () => {
    const res = await app.inject({ method: "GET", url: "/console/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("console loop lifecycle (persisted doc only)", () => {
  it("creates, lists, pauses, resumes (raising the cap), and stops a loop", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/console/loops",
      payload: { goal: "keep the docs fresh", mode: "orchestrated", maxIterations: 3 },
    });
    expect(created.statusCode).toBe(201);
    const loop = created.json() as Record<string, unknown>;
    // No execution engine is wired: a created loop is parked pending.
    expect(loop.status).toBe("pending");
    expect(loop.max_iterations).toBe(3);
    const id = String(loop.id);

    const listed = await app.inject({ method: "GET", url: "/console/loops" });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { id: string }[]).map((l) => l.id)).toContain(id);

    const paused = await app.inject({
      method: "POST",
      url: `/console/loops/${id}/pause`,
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { status: string }).status).toBe("paused");

    const resumed = await app.inject({
      method: "POST",
      url: `/console/loops/${id}/resume`,
      payload: { extraIterations: 4 },
    });
    expect(resumed.statusCode).toBe(200);
    const resumedLoop = resumed.json() as Record<string, unknown>;
    // "Approve N more rounds": the cap rises; the doc parks pending again.
    expect(resumedLoop.max_iterations).toBe(7);
    expect(resumedLoop.status).toBe("pending");

    const stopped = await app.inject({
      method: "POST",
      url: `/console/loops/${id}/stop`,
    });
    expect(stopped.statusCode).toBe(200);
    expect((stopped.json() as { status: string }).status).toBe("stopped");

    const detail = await app.inject({ method: "GET", url: `/console/loops/${id}` });
    expect(detail.statusCode).toBe(200);
    const detailLoop = detail.json() as Record<string, unknown>;
    expect(detailLoop.status).toBe("stopped");
    expect(detailLoop.runs).toEqual([]);
  });

  it("rejects a loop without a goal and 404s unknown loop ids", async () => {
    const noGoal = await app.inject({
      method: "POST",
      url: "/console/loops",
      payload: { mode: "ralph" },
    });
    expect(noGoal.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/console/loops/ffffffffffffffffffffffffffffffff",
    });
    expect(missing.statusCode).toBe(404);
  });
});
