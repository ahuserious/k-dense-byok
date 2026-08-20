// danbot-byok — web/src/lib/schedules.ts
//
// Client for the schedules API (server/src/api/schedules.ts), served same-origin
// under /schedules/* and reached through the shared `apiFetch` wrapper, exactly
// like lib/console.ts.
//
// EVERY response is validated field by field before it is handed to React.
// Defect #62 is a malformed-but-200 body that threw in render phase and took the
// whole app down; the fix pattern the tree already applies is "validate, then
// degrade to an error state", so a body that does not match the contract raises
// a plain Error here and never reaches a component as a half-shaped object.
//
// There is deliberately NO next-fire calculation in this file. The server
// computes `next_fire_at` with the same code the ticker uses to decide when to
// fire, so a displayed time cannot disagree with the instant the scheduler acts
// on.

import { apiFetch } from "./projects";

export type ScheduleOverlapPolicy = "skip" | "allow";

export type ScheduleFireReason =
  | "dispatched"
  | "disabled"
  | "overlap-skipped"
  | "catchup-skipped"
  | "catchup-expired"
  | "catchup-truncated"
  | "capacity-deferred"
  | "duplicate-window"
  | "controller-absent"
  | "definition-missing"
  | "project-missing"
  | "shutdown"
  | "conflict"
  | "error";

export interface Schedule {
  id: string;
  workflow_id: string;
  name: string;
  expression: string;
  timezone: string;
  enabled: boolean;
  overlap_policy: ScheduleOverlapPolicy;
  created_at: string;
  updated_at: string;
  next_fire_at: string | null;
  last_fire_at: string | null;
  last_fire_reason: ScheduleFireReason | null;
  last_run_id: string | null;
  last_run_status: string | null;
  goal: string;
  variables: Record<string, unknown>;
}

export interface ScheduleFire {
  fire_id: string;
  schedule_id: string;
  window_key: string;
  window_at: string;
  fired_at: string;
  request_id: string | null;
  run_id: string | null;
  reason: ScheduleFireReason;
  detail: string;
  run_status: string | null;
}

export interface ScheduleListing {
  schedulerRunning: boolean;
  schedules: Schedule[];
}

const FIRE_REASONS = new Set<string>([
  "dispatched",
  "disabled",
  "overlap-skipped",
  "catchup-skipped",
  "catchup-expired",
  "catchup-truncated",
  "capacity-deferred",
  "duplicate-window",
  "controller-absent",
  "definition-missing",
  "project-missing",
  "shutdown",
  "conflict",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string") throw new Error(`The server sent a schedule without ${field}.`);
  return value;
}

function nullableString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`The server sent an unreadable ${field}.`);
  return value;
}

function parseSchedule(value: unknown): Schedule {
  if (!isRecord(value)) throw new Error("The server sent a schedule that is not an object.");
  const overlapPolicy = value.overlap_policy;
  if (overlapPolicy !== "skip" && overlapPolicy !== "allow") {
    throw new Error("The server sent a schedule with an unreadable overlap policy.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("The server sent a schedule without an enabled flag.");
  }
  const reason = nullableString(value, "last_fire_reason");
  if (reason !== null && !FIRE_REASONS.has(reason)) {
    throw new Error("The server sent a schedule with an unreadable last fire reason.");
  }
  if (!isRecord(value.input)) {
    throw new Error("The server sent a schedule with unreadable input.");
  }
  const goalSource = value.input.goal;
  if (goalSource !== undefined && typeof goalSource !== "string") {
    throw new Error("The server sent a schedule with an unreadable goal.");
  }
  const variablesSource = value.input.variables;
  if (variablesSource !== undefined && !isRecord(variablesSource)) {
    throw new Error("The server sent a schedule with unreadable variables.");
  }
  return {
    id: requiredString(value, "id"),
    workflow_id: requiredString(value, "workflow_id"),
    name: requiredString(value, "name"),
    expression: requiredString(value, "expression"),
    timezone: requiredString(value, "timezone"),
    enabled: value.enabled,
    overlap_policy: overlapPolicy,
    created_at: requiredString(value, "created_at"),
    updated_at: requiredString(value, "updated_at"),
    next_fire_at: nullableString(value, "next_fire_at"),
    last_fire_at: nullableString(value, "last_fire_at"),
    last_fire_reason: reason as ScheduleFireReason | null,
    last_run_id: nullableString(value, "last_run_id"),
    last_run_status: nullableString(value, "last_run_status"),
    goal: typeof goalSource === "string" ? goalSource : "",
    variables: variablesSource ?? {},
  };
}

function parseFire(value: unknown): ScheduleFire {
  if (!isRecord(value)) throw new Error("The server sent a fire record that is not an object.");
  const reason = requiredString(value, "reason");
  if (!FIRE_REASONS.has(reason)) {
    throw new Error("The server sent a fire record with an unreadable reason.");
  }
  return {
    fire_id: requiredString(value, "fire_id"),
    schedule_id: requiredString(value, "schedule_id"),
    window_key: requiredString(value, "window_key"),
    window_at: requiredString(value, "window_at"),
    fired_at: requiredString(value, "fired_at"),
    request_id: nullableString(value, "request_id"),
    run_id: nullableString(value, "run_id"),
    reason: reason as ScheduleFireReason,
    detail: requiredString(value, "detail"),
    run_status: nullableString(value, "run_status"),
  };
}

/**
 * Read a JSON body, turning a non-2xx into an Error carrying the server's own
 * `detail` sentence — which is written to name the user's next action and never
 * to contain a filesystem path (#71).
 */
async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${label} returned a response that is not JSON.`);
    }
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : null;
    throw new Error(detail ?? `${label} failed with status ${response.status}.`);
  }
  return body;
}

/**
 * A JSON request — and, when there is no body, NO content-type at all. Fastify
 * rejects an empty body with 400 when the request claims application/json, so
 * a bodyless POST (enable / disable / stop / run-now) must not claim it.
 */
function jsonRequest(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function listSchedules(): Promise<ScheduleListing> {
  const body = await readJson(await apiFetch("/schedules"), "listSchedules");
  if (
    !isRecord(body) ||
    body.storage_version !== 1 ||
    typeof body.scheduler_running !== "boolean" ||
    !Array.isArray(body.schedules)
  ) {
    throw new Error("The server sent a schedule list in an unexpected shape.");
  }
  return {
    schedulerRunning: body.scheduler_running,
    schedules: body.schedules.map(parseSchedule),
  };
}

export interface CreateScheduleInput {
  workflowId: string;
  name: string;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  goal?: string;
  variables?: Record<string, unknown>;
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  const body = await readJson(
    await apiFetch(
      "/schedules",
      jsonRequest("POST", {
        workflowId: input.workflowId,
        name: input.name,
        expression: input.expression,
        timezone: input.timezone,
        overlapPolicy: input.overlapPolicy,
        ...(input.goal || input.variables
          ? {
              input: {
                ...(input.goal ? { goal: input.goal } : {}),
                ...(input.variables ? { variables: input.variables } : {}),
              },
            }
          : {}),
      }),
    ),
    "createSchedule",
  );
  if (!isRecord(body)) throw new Error("The server sent an unreadable schedule.");
  return parseSchedule(body.schedule);
}

export async function updateSchedule(
  scheduleId: string,
  patch: Partial<CreateScheduleInput>,
): Promise<Schedule> {
  const body = await readJson(
    await apiFetch(
      `/schedules/${encodeURIComponent(scheduleId)}`,
      jsonRequest("PATCH", {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.workflowId === undefined ? {} : { workflowId: patch.workflowId }),
        ...(patch.expression === undefined ? {} : { expression: patch.expression }),
        ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
        ...(patch.overlapPolicy === undefined ? {} : { overlapPolicy: patch.overlapPolicy }),
        ...(patch.goal === undefined && patch.variables === undefined
          ? {}
          : {
              input: {
                ...(patch.goal === undefined ? {} : { goal: patch.goal }),
                ...(patch.variables === undefined ? {} : { variables: patch.variables }),
              },
            }),
      }),
    ),
    "updateSchedule",
  );
  if (!isRecord(body)) throw new Error("The server sent an unreadable schedule.");
  return parseSchedule(body.schedule);
}

export async function setScheduleEnabled(
  scheduleId: string,
  enabled: boolean,
): Promise<Schedule> {
  const body = await readJson(
    await apiFetch(
      `/schedules/${encodeURIComponent(scheduleId)}/${enabled ? "enable" : "disable"}`,
      jsonRequest("POST"),
    ),
    "setScheduleEnabled",
  );
  if (!isRecord(body)) throw new Error("The server sent an unreadable schedule.");
  return parseSchedule(body.schedule);
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  const response = await apiFetch(
    `/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" },
  );
  if (response.status === 204) return;
  await readJson(response, "deleteSchedule");
}

/** Pause the schedule AND cancel every run it started that is still going. */
export async function stopSchedule(scheduleId: string): Promise<{
  schedule: Schedule;
  cancelledRunIds: string[];
}> {
  const body = await readJson(
    await apiFetch(`/schedules/${encodeURIComponent(scheduleId)}/stop`, jsonRequest("POST")),
    "stopSchedule",
  );
  if (!isRecord(body)) throw new Error("The server sent an unreadable stop result.");
  const cancelled = Array.isArray(body.cancelled_run_ids)
    ? body.cancelled_run_ids.filter((value): value is string => typeof value === "string")
    : [];
  return { schedule: parseSchedule(body.schedule), cancelledRunIds: cancelled };
}

export async function runScheduleNow(scheduleId: string): Promise<ScheduleFire> {
  const response = await apiFetch(
    `/schedules/${encodeURIComponent(scheduleId)}/run-now`,
    jsonRequest("POST"),
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new Error("runScheduleNow returned a response that is not JSON.");
  }
  if (!isRecord(body)) {
    throw new Error("The server sent an unreadable result for this run.");
  }
  if (typeof body.detail === "string" && !isRecord(body.fire)) throw new Error(body.detail);
  // A refused fire is still a fire RECORD carrying the honest reason, so it is
  // surfaced rather than thrown away: "the schedule did not run, and why".
  return parseFire(body.fire);
}

export interface SchedulableWorkflow {
  id: string;
  name: string;
}

/**
 * The typed workflows a schedule can point at, read from the SAME registry the
 * run-creation route validates against — so the picker cannot offer a workflow
 * the scheduler would then fail to run. Defect #62: a malformed listing raises
 * here and the form degrades to its disabled-with-a-reason state.
 */
export async function listSchedulableWorkflows(): Promise<SchedulableWorkflow[]> {
  const body = await readJson(await apiFetch("/dag-workflows"), "listSchedulableWorkflows");
  if (!isRecord(body) || !Array.isArray(body.workflows)) {
    throw new Error("The server sent a workflow list in an unexpected shape.");
  }
  const workflows: SchedulableWorkflow[] = [];
  for (const entry of body.workflows) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    workflows.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
    });
  }
  return workflows;
}

export async function listScheduleFires(
  scheduleId: string,
  limit = 20,
): Promise<ScheduleFire[]> {
  const body = await readJson(
    await apiFetch(
      `/schedules/${encodeURIComponent(scheduleId)}/fires?limit=${encodeURIComponent(String(limit))}`,
    ),
    "listScheduleFires",
  );
  if (!isRecord(body) || !Array.isArray(body.fires)) {
    throw new Error("The server sent a fire history in an unexpected shape.");
  }
  return body.fires.map(parseFire);
}
