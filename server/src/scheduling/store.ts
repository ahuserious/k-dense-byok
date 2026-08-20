/**
 * Durable, project-scoped storage for schedules and their fire audit trail.
 *
 * Layout — derived from the existing project paths, so no shared path table is
 * touched (ProjectPaths has no schedules entry and projects.ts is not this
 * lane's to edit):
 *
 *   projects/<id>/sandbox/.kady/schedules/<scheduleId>.json   one mutable doc
 *   projects/<id>/sandbox/.kady/schedules/fires.jsonl         append-only audit
 *
 * The idiom is deliberately the one already in the tree rather than a new one:
 * schedule docs are written the way workflows/store.ts writes a manifest
 * (temp file → fsync → rename → fsync directory, so a crash mid-write can never
 * leave a half-parsed schedule), and the fire log is append-only JSONL folded
 * newest-last the way agent/runs-index.ts does it.
 *
 * NOT stored here: the OUTCOME of a fire. A fire record carries the run id; the
 * run's status is read back from the workflow store when the audit trail is
 * listed, so the trail can never disagree with the run it points at and no
 * background poller is needed to keep it fresh.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";

export const SCHEDULE_STORAGE_VERSION = 1 as const;

/** Why a firing opportunity did not produce a run. */
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

export type ScheduleOverlapPolicy = "skip" | "allow";

export interface ScheduleRecord {
  storageVersion: typeof SCHEDULE_STORAGE_VERSION;
  id: string;
  projectId: string;
  workflowId: string;
  name: string;
  expression: string;
  timezone: string;
  enabled: boolean;
  overlapPolicy: ScheduleOverlapPolicy;
  input: { goal?: string; variables?: Record<string, unknown> };
  createdAt: number;
  updatedAt: number;
  /**
   * Every firing opportunity at or before this instant has been considered.
   * Persisting it is what makes a restart able to tell "missed" from "not yet".
   */
  cursorMs: number;
  lastFiredWindowKey: string | null;
  lastFireAt: number | null;
  lastFireReason: ScheduleFireReason | null;
  lastRunId: string | null;
}

export interface ScheduleFireRecord {
  storageVersion: typeof SCHEDULE_STORAGE_VERSION;
  fireId: string;
  scheduleId: string;
  /** The window the fire was FOR (see expression.ts on window keys). */
  windowKey: string;
  /** The instant the window became due. */
  windowAt: number;
  /** The instant the scheduler actually acted. */
  firedAt: number;
  requestId: string | null;
  runId: string | null;
  reason: ScheduleFireReason;
  /** One path-free sentence a Console reader can act on. */
  detail: string;
}

export class ScheduleStoreError extends Error {
  constructor(
    readonly code: "INVALID_ID" | "NOT_FOUND" | "INVALID_INPUT" | "CORRUPT" | "TOO_MANY",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleStoreError";
  }
}

const SCHEDULE_ID_RE = /^sched_[a-f0-9]{32}$/;
const MAX_SCHEDULES_PER_PROJECT = 200;
const MAX_SCHEDULE_DOC_BYTES = 64 * 1_024;
const MAX_FIRE_RECORD_BYTES = 4 * 1_024;
/** How many trailing fire records a read returns; the log itself is not pruned. */
export const DEFAULT_FIRE_HISTORY_LIMIT = 100;
export const MAX_FIRE_HISTORY_LIMIT = 1_000;
/**
 * Fire records read per listing. The log is append-only, so a long-lived
 * project accumulates lines; only the tail is ever parsed.
 */
const MAX_FIRE_LOG_SCAN_BYTES = 4 * 1_024 * 1_024;

function schedulesDirectory(projectId: string): string {
  return path.join(resolvePaths(projectId).kadyDir, "schedules");
}

function scheduleFile(projectId: string, scheduleId: string): string {
  assertScheduleId(scheduleId);
  return path.join(schedulesDirectory(projectId), `${scheduleId}.json`);
}

function fireLogFile(projectId: string): string {
  return path.join(schedulesDirectory(projectId), "fires.jsonl");
}

export function assertScheduleId(scheduleId: string): void {
  if (typeof scheduleId !== "string" || !SCHEDULE_ID_RE.test(scheduleId)) {
    throw new ScheduleStoreError("INVALID_ID", "That schedule id is not a valid id.");
  }
}

export function newScheduleId(): string {
  return `sched_${crypto.randomBytes(16).toString("hex")}`;
}

function atomicWriteJson(file: string, value: unknown, maximumBytes: number): void {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
  if (bytes.byteLength > maximumBytes) {
    throw new ScheduleStoreError("INVALID_INPUT", "That schedule is too large to store.");
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reject anything that is not a well-formed schedule doc. A corrupt or
 * hand-edited file is skipped by the listing rather than crashing the ticker —
 * one unreadable schedule must not stop the other schedules from firing.
 */
function parseScheduleRecord(raw: string): ScheduleRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.storageVersion !== SCHEDULE_STORAGE_VERSION) return null;
  const stringFields = ["id", "projectId", "workflowId", "name", "expression", "timezone"] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== "string") return null;
  }
  if (!SCHEDULE_ID_RE.test(value.id as string)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (value.overlapPolicy !== "skip" && value.overlapPolicy !== "allow") return null;
  if (!isRecord(value.input)) return null;
  for (const field of ["createdAt", "updatedAt", "cursorMs"] as const) {
    if (!Number.isFinite(value[field])) return null;
  }
  return value as unknown as ScheduleRecord;
}

export function readSchedule(projectId: string, scheduleId: string): ScheduleRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(scheduleFile(projectId, scheduleId), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseScheduleRecord(raw);
}

/** Every readable schedule in a project, newest-created first. */
export function listSchedules(projectId: string): ScheduleRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(schedulesDirectory(projectId), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const schedules: ScheduleRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const scheduleId = entry.name.slice(0, -".json".length);
    if (!SCHEDULE_ID_RE.test(scheduleId)) continue;
    const record = readSchedule(projectId, scheduleId);
    if (record) schedules.push(record);
  }
  return schedules.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

export function writeSchedule(record: ScheduleRecord): void {
  atomicWriteJson(scheduleFile(record.projectId, record.id), record, MAX_SCHEDULE_DOC_BYTES);
}

export function assertScheduleCapacity(projectId: string): void {
  if (listSchedules(projectId).length >= MAX_SCHEDULES_PER_PROJECT) {
    throw new ScheduleStoreError(
      "TOO_MANY",
      `A project can hold at most ${MAX_SCHEDULES_PER_PROJECT} schedules. Delete one first.`,
    );
  }
}

export function deleteSchedule(projectId: string, scheduleId: string): boolean {
  try {
    fs.rmSync(scheduleFile(projectId, scheduleId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Append one fire record. Append-only and line-atomic: a reader never sees a
 * partial record and a writer never rewrites a line another writer owns.
 */
export function appendFireRecord(
  projectId: string,
  record: Omit<ScheduleFireRecord, "storageVersion" | "fireId">,
): ScheduleFireRecord {
  const complete: ScheduleFireRecord = {
    storageVersion: SCHEDULE_STORAGE_VERSION,
    fireId: `sfire_${crypto.randomBytes(12).toString("hex")}`,
    ...record,
  };
  if (Buffer.byteLength(JSON.stringify(complete), "utf-8") > MAX_FIRE_RECORD_BYTES) {
    complete.detail = `${complete.detail.slice(0, 200)}…`;
  }
  const directory = schedulesDirectory(projectId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.appendFileSync(fireLogFile(projectId), `${JSON.stringify(complete)}\n`, { mode: 0o600 });
  return complete;
}

/**
 * The most recent fire records, newest first. `scheduleId` filters to one
 * schedule. Unparseable lines are skipped, never thrown: a corrupt audit line
 * must not make the Console unable to show the rest of the trail.
 */
export function readFireRecords(
  projectId: string,
  options: { scheduleId?: string; limit?: number } = {},
): ScheduleFireRecord[] {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? DEFAULT_FIRE_HISTORY_LIMIT)),
    MAX_FIRE_HISTORY_LIMIT,
  );
  const file = fireLogFile(projectId);
  let raw: string;
  try {
    const stats = fs.statSync(file);
    if (stats.size > MAX_FIRE_LOG_SCAN_BYTES) {
      const handle = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(MAX_FIRE_LOG_SCAN_BYTES);
        fs.readSync(handle, buffer, 0, MAX_FIRE_LOG_SCAN_BYTES, stats.size - MAX_FIRE_LOG_SCAN_BYTES);
        raw = buffer.toString("utf-8");
      } finally {
        fs.closeSync(handle);
      }
    } else {
      raw = fs.readFileSync(file, "utf-8");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ScheduleFireRecord[] = [];
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.storageVersion !== SCHEDULE_STORAGE_VERSION) continue;
    if (typeof value.scheduleId !== "string" || typeof value.windowKey !== "string") continue;
    if (options.scheduleId && value.scheduleId !== options.scheduleId) continue;
    records.push(value as unknown as ScheduleFireRecord);
  }
  return records;
}
