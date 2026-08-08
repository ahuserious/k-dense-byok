/**
 * File-backed run/loop metadata index — replaces agent-control-plane's Neon DB
 * (backend/src/db.ts) with pure file IO. This is a SEPARATE metadata store from
 * the cost ledger (cost/ledger.ts owns CostEntry); the two never share a file.
 *
 * Layout (mirrors the ledger's .kady/runs/<sessionId>/ convention):
 *   projects/<id>/sandbox/.kady/runs/<sessionId>/runs.jsonl   append-only run log
 *   projects/<id>/sandbox/.kady/loops/<loopId>/loop.json      single mutable doc
 *
 * Runs are append-only: startRun writes a 'running' row, finishRun appends a
 * terminal row with the SAME id. Readers fold to the LATEST row per id, so the
 * terminal write wins without ever rewriting an existing line (each append is
 * atomic at the line level via appendFileSync). This survives crashes mid-run —
 * a 'running' row with no terminal partner simply stays 'running'.
 *
 * Loops are a single mutable JSON doc (read-modify-write). Concurrent writers to
 * one loop must be serialized by the CALLER; this module does not lock.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";

// ---- Types (file-backed port of db.ts Run + Loop) -------------------------

export type RunStatus = "running" | "completed" | "failed";
export type RunRole =
  | "agent"
  | "subagent"
  | "council"
  | "workflow"
  | "orchestrator"
  | "worker";

export interface RunRecord {
  id: string;
  ts: number;
  sessionId: string;
  loopId: string | null;
  iteration: number;
  task: string;
  role: RunRole;
  parentRunId?: string;
  status: RunStatus;
  model?: string;
  output?: string;
  reasoning?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  numTurns?: number;
}

export type LoopMode = "orchestrated" | "ralph";
export type LoopStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "stopped";

export interface LoopRecord {
  id: string;
  goal: string;
  mode: LoopMode;
  status: LoopStatus;
  iteration: number;
  maxIterations: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Path resolution + sanitization ---------------------------------------

// Same guard the cost ledger uses for session ids (costsPath): the id becomes a
// path segment, arrives raw from the URL, so reject anything that could traverse
// (no leading dot, no slash, no '..'). loopId gets the same treatment.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeSegment(value: string, kind: "session id" | "loop id"): void {
  if (!SEGMENT_RE.test(value)) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
}

function runsJsonlPath(projectId: string, sessionId: string): string {
  assertSafeSegment(sessionId, "session id");
  return path.join(resolvePaths(projectId).runsDir, sessionId, "runs.jsonl");
}

function loopJsonPath(projectId: string, loopId: string): string {
  assertSafeSegment(loopId, "loop id");
  // Sibling of runs/ under .kady/, mirroring the ledger's layout.
  const kadyDir = path.dirname(resolvePaths(projectId).runsDir);
  return path.join(kadyDir, "loops", loopId, "loop.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- Runs (append-only; latest row per id wins) ---------------------------

/**
 * Append a 'running' RunRecord and return its id. The caller passes everything
 * except id/ts/status (which we own). The id is a fresh random hex so finishRun
 * can target this exact row later.
 */
export function startRun(
  projectId: string,
  partial: Omit<RunRecord, "id" | "ts" | "status"> & { status?: RunStatus },
): string {
  const id = crypto.randomBytes(16).toString("hex");
  const record: RunRecord = {
    ...partial,
    id,
    ts: Date.now() / 1000,
    status: partial.status ?? "running",
  };
  const file = runsJsonlPath(projectId, record.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  return id;
}

export interface FinishRunFields {
  status: Extract<RunStatus, "completed" | "failed">;
  output?: string;
  reasoning?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  numTurns?: number;
}

/**
 * Append a terminal row for an existing run. We don't rewrite the original
 * 'running' line — we append a second row with the same id carrying the final
 * status/output/cost, and readers (latestById) keep the LAST one. The terminal
 * row is reconstructed from the original row so it stays a complete RunRecord
 * (id, sessionId, loopId, iteration, task, role… all preserved).
 *
 * Returns true if the run id was found and a terminal row appended, false if no
 * matching 'running' row exists in this session's log.
 */
export function finishRun(
  projectId: string,
  sessionId: string,
  runId: string,
  fields: FinishRunFields,
): boolean {
  const file = runsJsonlPath(projectId, sessionId);
  const existing = latestById(readJsonl<RunRecord>(file)).get(runId);
  if (!existing) return false;

  const terminal: RunRecord = {
    ...existing,
    ts: Date.now() / 1000,
    status: fields.status,
    // Only overwrite fields the caller actually supplied; otherwise the original
    // value carries through (so e.g. model/task from startRun are never dropped).
    ...(fields.output !== undefined ? { output: fields.output } : {}),
    ...(fields.reasoning !== undefined ? { reasoning: fields.reasoning } : {}),
    ...(fields.costUsd !== undefined ? { costUsd: fields.costUsd } : {}),
    ...(fields.tokensIn !== undefined ? { tokensIn: fields.tokensIn } : {}),
    ...(fields.tokensOut !== undefined ? { tokensOut: fields.tokensOut } : {}),
    ...(fields.numTurns !== undefined ? { numTurns: fields.numTurns } : {}),
  };
  fs.appendFileSync(file, JSON.stringify(terminal) + "\n", "utf-8");
  return true;
}

function readJsonl<T>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    // Missing file or a torn final line → treat as empty. A partial last line
    // (crash mid-append) is the only realistic JSON.parse failure; dropping the
    // whole file on that is too aggressive, but appendFileSync writes one line
    // atomically per call, so a torn line is unlikely. We accept the simple path.
    return [];
  }
}

/** Fold rows to the latest occurrence per id, preserving first-seen order. */
function latestById(rows: RunRecord[]): Map<string, RunRecord> {
  const byId = new Map<string, RunRecord>();
  for (const row of rows) {
    byId.set(row.id, row); // later rows overwrite earlier ones
  }
  return byId;
}

/** All sessionId dirs under the project's runsDir (skips non-dirs / missing). */
function sessionDirs(projectId: string): string[] {
  const runsDir = resolvePaths(projectId).runsDir;
  try {
    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Latest row per run id across every session's runs.jsonl under the project,
 * newest first (by ts). Pass `limit` to cap the result after sorting.
 */
export function listRuns(projectId: string, limit?: number): RunRecord[] {
  const all: RunRecord[] = [];
  for (const sessionId of sessionDirs(projectId)) {
    const file = path.join(resolvePaths(projectId).runsDir, sessionId, "runs.jsonl");
    for (const record of latestById(readJsonl<RunRecord>(file)).values()) {
      all.push(record);
    }
  }
  // Newest first by ts. ts has only millisecond resolution (Date.now()/1000), so
  // a burst of runs in the same millisecond ties — break the tie deterministically
  // by id so the order is stable across calls rather than dependent on readdir.
  all.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return limit !== undefined ? all.slice(0, limit) : all;
}

/** Runs belonging to one loop, newest first. */
export function listRunsForLoop(projectId: string, loopId: string): RunRecord[] {
  return listRuns(projectId).filter((run) => run.loopId === loopId);
}

// ---- Loops (single mutable doc; read-modify-write, caller-serialized) ------

export interface CreateLoopInput {
  goal: string;
  mode: LoopMode;
  maxIterations: number;
  /** Pre-minted id (e.g. when the caller wants to know it up front). */
  id?: string;
  status?: LoopStatus;
}

/** Create a loop doc on disk and return it. Status defaults to 'pending'. */
export function createLoop(projectId: string, input: CreateLoopInput): LoopRecord {
  const id = input.id ?? crypto.randomBytes(16).toString("hex");
  const now = nowIso();
  const loop: LoopRecord = {
    id,
    goal: input.goal,
    mode: input.mode,
    status: input.status ?? "pending",
    iteration: 0,
    maxIterations: input.maxIterations,
    createdAt: now,
    updatedAt: now,
  };
  const file = loopJsonPath(projectId, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeLoop(file, loop);
  return loop;
}

export function getLoop(projectId: string, loopId: string): LoopRecord | null {
  const file = loopJsonPath(projectId, loopId);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as LoopRecord;
  } catch {
    return null;
  }
}

/**
 * Read-modify-write a subset of mutable fields. Only status, iteration, and
 * lastError are mutable (goal/mode/maxIterations are fixed at creation, like the
 * db.ts updateLoop column set). Returns the updated loop, or null if it's gone.
 *
 * NOTE: this is NOT concurrency-safe on its own — two simultaneous updates to
 * the same loop can lose a write. Callers must serialize updates per loop.
 */
export function updateLoop(
  projectId: string,
  loopId: string,
  fields: Partial<Pick<LoopRecord, "status" | "iteration" | "lastError">>,
): LoopRecord | null {
  const loop = getLoop(projectId, loopId);
  if (!loop) return null;
  if (fields.status !== undefined) loop.status = fields.status;
  if (fields.iteration !== undefined) loop.iteration = fields.iteration;
  if (fields.lastError !== undefined) loop.lastError = fields.lastError;
  loop.updatedAt = nowIso();
  writeLoop(loopJsonPath(projectId, loopId), loop);
  return loop;
}

// Write via a temp file + rename so a reader never sees a half-written loop.json
// (matches projects.ts writeProjectJson). The single-doc loop is small, so this
// full rewrite is cheap.
function writeLoop(file: string, loop: LoopRecord): void {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(loop, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** List every loop doc under the project, newest-updated first. */
export function listLoops(projectId: string): LoopRecord[] {
  const kadyDir = path.dirname(resolvePaths(projectId).runsDir);
  const loopsDir = path.join(kadyDir, "loops");
  const out: LoopRecord[] = [];
  try {
    for (const dirent of fs.readdirSync(loopsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const loop = getLoop(projectId, dirent.name);
      if (loop) out.push(loop);
    }
  } catch {
    /* no loops yet */
  }
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return out;
}

/**
 * On boot, no loop is actually executing (the in-process controllers don't
 * survive a restart). Any loop still 'running' or 'pending' was cut off mid-run,
 * so flag it failed instead of leaving a zombie. Intentional wait states
 * ('paused', 'stopped') are preserved so resume still works. Mirrors db.ts's
 * reconcileInterruptedLoops. Returns the ids that were reconciled.
 */
export function reconcileInterruptedLoops(projectId: string): string[] {
  const reconciled: string[] = [];
  for (const loop of listLoops(projectId)) {
    if (loop.status === "running" || loop.status === "pending") {
      updateLoop(projectId, loop.id, {
        status: "failed",
        lastError:
          "interrupted by a server restart (in-flight loop state does not survive a restart)",
      });
      reconciled.push(loop.id);
    }
  }
  return reconciled;
}
