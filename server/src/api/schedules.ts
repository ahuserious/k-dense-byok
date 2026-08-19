/**
 * Schedules HTTP API — CRUD, enable/disable, run-now, stop, and the fire audit
 * trail, plus ownership of the ticker's lifecycle.
 *
 * Validation follows the idiom of api/dag-workflows.ts and api/mcp.ts: explicit
 * validators, `reply.code(...)`, `{ detail, code }` bodies. Error text names the
 * caller's next action and never contains a filesystem path (defect #71) — the
 * store's own errors are already written that way, and nothing from `fs` is
 * forwarded.
 *
 * LIFECYCLE (defect #41): the ticker is started here and cleared from this
 * module's `onClose` hook, so closing the Fastify app stops every timer this
 * lane starts, with no line in server/src/index.ts beyond the registration.
 *
 * NEXT-FIRE: computed here, server-side, by the ticker's own
 * `scheduleNextFireAt`. The browser never derives a fire time, so a displayed
 * next-fire cannot disagree with the instant the scheduler acts on.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { currentProjectId } from "../scope.ts";
import { workflowStore } from "../workflows/index.ts";
import {
  DEFAULT_FIRE_HISTORY_LIMIT,
  MAX_FIRE_HISTORY_LIMIT,
  SCHEDULE_STORAGE_VERSION,
  ScheduleStoreError,
  Scheduler,
  ScheduleExpressionError,
  assertScheduleCapacity,
  assertScheduleId,
  deleteSchedule,
  isSupportedTimeZone,
  listSchedules,
  newScheduleId,
  parseScheduleExpression,
  readFireRecords,
  readSchedule,
  scheduleNextFireAt,
  writeSchedule,
  type ScheduleOverlapPolicy,
  type ScheduleRecord,
  type SchedulerOptions,
} from "../scheduling/index.ts";

const MAX_NAME_LENGTH = 120;
const MAX_GOAL_LENGTH = 4_000;
const MAX_WORKFLOW_ID_LENGTH = 128;

export interface ScheduleRoutesOptions extends SchedulerOptions {
  /**
   * Whether the ticker starts with the routes. Defaults to on, and to off when
   * `KADY_SCHEDULER_AUTOSTART=0` — which is how a test drives `tick()` by hand
   * against a real app without a background ticker racing its assertions.
   */
  autoStart?: boolean;
}

function autoStartDefault(): boolean {
  return process.env.KADY_SCHEDULER_AUTOSTART !== "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class ScheduleRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ScheduleRequestError";
  }
}

function errorResponse(reply: FastifyReply, error: unknown) {
  if (error instanceof ScheduleRequestError) {
    reply.code(error.status);
    return { detail: error.message, code: error.code };
  }
  if (error instanceof ScheduleExpressionError) {
    reply.code(400);
    return { detail: error.message, code: "INVALID_EXPRESSION" };
  }
  if (error instanceof ScheduleStoreError) {
    const status = {
      INVALID_ID: 400,
      INVALID_INPUT: 400,
      NOT_FOUND: 404,
      TOO_MANY: 409,
      CORRUPT: 500,
    }[error.code];
    reply.code(status);
    return { detail: error.message, code: error.code };
  }
  // Anything unexpected is reported without its message: an fs error message
  // carries a path, and a path must never reach a response body (#71).
  reply.code(500);
  return { detail: "The schedule operation failed.", code: "SCHEDULE_FAILED" };
}

function requireString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScheduleRequestError(400, "INVALID_INPUT", `${field} is required.`);
  }
  if (value.length > maximum) {
    throw new ScheduleRequestError(
      400,
      "INVALID_INPUT",
      `${field} must be ${maximum} characters or fewer.`,
    );
  }
  return value.trim();
}

function readOverlapPolicy(value: unknown): ScheduleOverlapPolicy {
  if (value === undefined) return "skip";
  if (value !== "skip" && value !== "allow") {
    throw new ScheduleRequestError(
      400,
      "INVALID_INPUT",
      'overlapPolicy must be "skip" or "allow".',
    );
  }
  return value;
}

function readTimeZone(value: unknown): string {
  const timezone = value === undefined ? "UTC" : value;
  if (typeof timezone !== "string" || !isSupportedTimeZone(timezone)) {
    throw new ScheduleRequestError(
      400,
      "INVALID_INPUT",
      'timezone must be an IANA time zone name, for example "Australia/Sydney".',
    );
  }
  return timezone;
}

function readScheduleInput(value: unknown): { goal?: string; variables?: Record<string, unknown> } {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ScheduleRequestError(400, "INVALID_INPUT", "input must be an object.");
  }
  const result: { goal?: string; variables?: Record<string, unknown> } = {};
  if (value.goal !== undefined) {
    if (typeof value.goal !== "string" || value.goal.length > MAX_GOAL_LENGTH) {
      throw new ScheduleRequestError(
        400,
        "INVALID_INPUT",
        `input.goal must be a string of ${MAX_GOAL_LENGTH} characters or fewer.`,
      );
    }
    result.goal = value.goal;
  }
  if (value.variables !== undefined) {
    if (!isRecord(value.variables)) {
      throw new ScheduleRequestError(400, "INVALID_INPUT", "input.variables must be an object.");
    }
    result.variables = value.variables as Record<string, unknown>;
  }
  return result;
}

function requireSchedule(projectId: string, scheduleId: string): ScheduleRecord {
  assertScheduleId(scheduleId);
  const stored = readSchedule(projectId, scheduleId);
  if (!stored) {
    throw new ScheduleRequestError(404, "NOT_FOUND", "That schedule no longer exists.");
  }
  return stored;
}

/** The wire shape the Console renders. Every field is present on every row. */
function toWire(stored: ScheduleRecord, nowMs: number) {
  const lastRunStatus = stored.lastRunId
    ? workflowStore.readRun(stored.projectId, stored.lastRunId)?.state.status ?? null
    : null;
  return {
    id: stored.id,
    workflow_id: stored.workflowId,
    name: stored.name,
    expression: stored.expression,
    timezone: stored.timezone,
    enabled: stored.enabled,
    overlap_policy: stored.overlapPolicy,
    input: stored.input,
    created_at: new Date(stored.createdAt).toISOString(),
    updated_at: new Date(stored.updatedAt).toISOString(),
    next_fire_at: (() => {
      const next = scheduleNextFireAt(stored, nowMs);
      return next === null ? null : new Date(next).toISOString();
    })(),
    last_fire_at: stored.lastFireAt === null ? null : new Date(stored.lastFireAt).toISOString(),
    last_fire_reason: stored.lastFireReason,
    last_run_id: stored.lastRunId,
    last_run_status: lastRunStatus,
  };
}

function fireToWire(fire: {
  fireId: string;
  scheduleId: string;
  windowKey: string;
  windowAt: number;
  firedAt: number;
  requestId: string | null;
  runId: string | null;
  reason: string;
  detail: string;
}, projectId: string) {
  return {
    fire_id: fire.fireId,
    schedule_id: fire.scheduleId,
    window_key: fire.windowKey,
    window_at: new Date(fire.windowAt).toISOString(),
    fired_at: new Date(fire.firedAt).toISOString(),
    request_id: fire.requestId,
    run_id: fire.runId,
    reason: fire.reason,
    detail: fire.detail,
    // Derived, never stored: the outcome is the run's own current status, so
    // the audit trail can never disagree with the run it points at.
    run_status: fire.runId
      ? workflowStore.readRun(projectId, fire.runId)?.state.status ?? null
      : null,
  };
}

export async function registerScheduleRoutes(
  app: FastifyInstance,
  options: ScheduleRoutesOptions = {},
): Promise<Scheduler> {
  const { autoStart = autoStartDefault(), ...schedulerOptions } = options;
  const scheduler = new Scheduler(app, schedulerOptions);

  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  app.get("/schedules", async (request, reply) => {
    try {
      const projectId = currentProjectId();
      const now = Date.now();
      reply.header("Cache-Control", "no-store");
      return {
        storage_version: SCHEDULE_STORAGE_VERSION,
        scheduler_running: scheduler.isRunning(),
        schedules: listSchedules(projectId).map((stored) => toWire(stored, now)),
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post<{ Body: Record<string, unknown> | null }>("/schedules", async (request, reply) => {
    try {
      const projectId = currentProjectId();
      const body = isRecord(request.body) ? request.body : {};
      const workflowId = requireString(body.workflowId, "workflowId", MAX_WORKFLOW_ID_LENGTH);
      const name = requireString(body.name, "name", MAX_NAME_LENGTH);
      const expression = requireString(body.expression, "expression", 128);
      parseScheduleExpression(expression);
      const timezone = readTimeZone(body.timezone);
      const overlapPolicy = readOverlapPolicy(body.overlapPolicy);
      const input = readScheduleInput(body.input);
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new ScheduleRequestError(400, "INVALID_INPUT", "enabled must be true or false.");
      }
      assertScheduleCapacity(projectId);
      const now = Date.now();
      const stored: ScheduleRecord = {
        storageVersion: SCHEDULE_STORAGE_VERSION,
        id: newScheduleId(),
        projectId,
        workflowId,
        name,
        expression,
        timezone,
        enabled: body.enabled === undefined ? true : (body.enabled as boolean),
        overlapPolicy,
        input,
        createdAt: now,
        updatedAt: now,
        // A new schedule starts from NOW, never from the epoch: creating one
        // must not look like a year of missed windows.
        cursorMs: now,
        lastFiredWindowKey: null,
        lastFireAt: null,
        lastFireReason: null,
        lastRunId: null,
      };
      writeSchedule(stored);
      reply.code(201);
      reply.header("Cache-Control", "no-store");
      reply.header("Location", `/schedules/${stored.id}`);
      return { schedule: toWire(stored, now) };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get<{ Params: { scheduleId: string } }>("/schedules/:scheduleId", async (request, reply) => {
    try {
      const projectId = currentProjectId();
      const stored = requireSchedule(projectId, request.params.scheduleId);
      reply.header("Cache-Control", "no-store");
      return { schedule: toWire(stored, Date.now()) };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.patch<{ Params: { scheduleId: string }; Body: Record<string, unknown> | null }>(
    "/schedules/:scheduleId",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const stored = requireSchedule(projectId, request.params.scheduleId);
        const body = isRecord(request.body) ? request.body : {};
        const updated: ScheduleRecord = { ...stored, updatedAt: Date.now() };
        if (body.name !== undefined) updated.name = requireString(body.name, "name", MAX_NAME_LENGTH);
        if (body.workflowId !== undefined) {
          updated.workflowId = requireString(body.workflowId, "workflowId", MAX_WORKFLOW_ID_LENGTH);
        }
        if (body.expression !== undefined) {
          updated.expression = requireString(body.expression, "expression", 128);
          parseScheduleExpression(updated.expression);
          // A changed expression re-anchors the cursor: windows of the OLD
          // expression that have not been evaluated yet are not inherited.
          updated.cursorMs = Date.now();
        }
        if (body.timezone !== undefined) updated.timezone = readTimeZone(body.timezone);
        if (body.overlapPolicy !== undefined) {
          updated.overlapPolicy = readOverlapPolicy(body.overlapPolicy);
        }
        if (body.input !== undefined) updated.input = readScheduleInput(body.input);
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") {
            throw new ScheduleRequestError(400, "INVALID_INPUT", "enabled must be true or false.");
          }
          updated.enabled = body.enabled;
        }
        writeSchedule(updated);
        reply.header("Cache-Control", "no-store");
        return { schedule: toWire(updated, Date.now()) };
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  for (const [suffix, enabled] of [["enable", true], ["disable", false]] as const) {
    app.post<{ Params: { scheduleId: string } }>(
      `/schedules/:scheduleId/${suffix}`,
      async (request, reply) => {
        try {
          const projectId = currentProjectId();
          const stored = requireSchedule(projectId, request.params.scheduleId);
          const now = Date.now();
          // Re-enabling re-anchors the cursor to now: a schedule that was
          // paused for a week must not resume by firing a week of windows.
          const updated: ScheduleRecord = {
            ...stored,
            enabled,
            updatedAt: now,
            ...(enabled ? { cursorMs: now } : {}),
          };
          writeSchedule(updated);
          reply.header("Cache-Control", "no-store");
          return { schedule: toWire(updated, now) };
        } catch (error) {
          return errorResponse(reply, error);
        }
      },
    );
  }

  app.delete<{ Params: { scheduleId: string } }>(
    "/schedules/:scheduleId",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const stored = requireSchedule(projectId, request.params.scheduleId);
        deleteSchedule(projectId, stored.id);
        reply.code(204);
        reply.header("Cache-Control", "no-store");
        return null;
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.post<{ Params: { scheduleId: string } }>(
    "/schedules/:scheduleId/run-now",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const stored = requireSchedule(projectId, request.params.scheduleId);
        const fire = await scheduler.runNow(stored);
        // 202 when a run was started; 200 when the fire was evaluated and
        // deliberately did not run. A refusal is not an HTTP error — the
        // request succeeded and produced an audit record saying what happened —
        // and `dispatched` makes the distinction unmissable for a caller that
        // only looks at the status line.
        reply.code(fire.reason === "dispatched" ? 202 : 200);
        reply.header("Cache-Control", "no-store");
        return { dispatched: fire.reason === "dispatched", fire: fireToWire(fire, projectId) };
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  /**
   * The second meaning of "stop" (see the ADR): disabling a schedule stops
   * future windows; a run that is already going has to be cancelled. This route
   * does BOTH, so a runaway schedule is genuinely stoppable from the Console
   * rather than only appearing to be.
   */
  app.post<{ Params: { scheduleId: string } }>(
    "/schedules/:scheduleId/stop",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const stored = requireSchedule(projectId, request.params.scheduleId);
        const now = Date.now();
        const paused: ScheduleRecord = { ...stored, enabled: false, updatedAt: now };
        writeSchedule(paused);
        const { cancelled, refused } = await scheduler.cancelActiveRuns(paused);
        reply.header("Cache-Control", "no-store");
        return {
          schedule: toWire(paused, now),
          cancelled_run_ids: cancelled,
          refused_run_ids: refused.map((entry) => entry.runId),
        };
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  app.get<{ Params: { scheduleId: string }; Querystring: { limit?: string } }>(
    "/schedules/:scheduleId/fires",
    async (request, reply) => {
      try {
        const projectId = currentProjectId();
        const stored = requireSchedule(projectId, request.params.scheduleId);
        let limit = DEFAULT_FIRE_HISTORY_LIMIT;
        if (request.query.limit !== undefined) {
          if (!/^\d+$/.test(request.query.limit)) {
            throw new ScheduleRequestError(400, "INVALID_INPUT", "limit must be a whole number.");
          }
          limit = Math.min(Math.max(1, Number(request.query.limit)), MAX_FIRE_HISTORY_LIMIT);
        }
        reply.header("Cache-Control", "no-store");
        return {
          fires: readFireRecords(projectId, { scheduleId: stored.id, limit })
            .map((fire) => fireToWire(fire, projectId)),
        };
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );

  if (autoStart) scheduler.start();
  return scheduler;
}
