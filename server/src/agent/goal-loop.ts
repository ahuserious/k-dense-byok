/**
 * Goal-loop lifecycle — the persisted-doc slice of the reference tree's
 * goal-loop engine, WITHOUT the execution engine.
 *
 * The reference drives loops with an in-process orchestrator built on its
 * pre-0.42 agent internals; per the E1 port plan that engine is deliberately
 * NOT ported (the target's typed dag-workflows engine is this tree's execution
 * story, and reference protocol code must never be copied). What IS ported is
 * the lifecycle contract the Agent Console API (api/console.ts) needs:
 * create / pause / resume / stop operate on the persisted loop doc
 * (runs-index.ts) — status transitions plus the resume-time iteration-cap
 * raise ("approve N more rounds").
 *
 * Consequently a created or resumed loop is parked "pending": recorded and
 * observable in the Console, but no agent runs are dispatched for it. When a
 * loop engine lands it should take over startLoop/resumeLoop and flip these
 * to "running" (the reference's shape for that is goal-loop.ts's runLoop /
 * Control map).
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import {
  createLoop,
  getLoop,
  updateLoop,
  type LoopMode,
  type LoopRecord,
} from "./runs-index.ts";

/**
 * Create a goal-loop doc. Status stays "pending" — see the header: without an
 * execution engine nothing dispatches, and "pending" is the honest state.
 */
export function startLoop(input: {
  projectId: string;
  goal: string;
  mode: LoopMode;
  maxIterations: number;
}): LoopRecord {
  return createLoop(input.projectId, {
    goal: input.goal,
    mode: input.mode,
    maxIterations: input.maxIterations,
  });
}

/**
 * Resume a parked loop (paused/stopped), granting extra iterations. Preserves
 * ACP's "approve N more rounds" semantics by raising the iteration cap; the
 * doc is parked back to "pending" (not "running") because there is no engine
 * to re-kick yet.
 */
export function resumeLoop(
  projectId: string,
  id: string,
  extraIterations: number,
): LoopRecord | null {
  const loop = getLoop(projectId, id);
  if (!loop) return null;
  const newCap = loop.maxIterations + Math.max(1, extraIterations);
  raiseMaxIterations(projectId, id, newCap);
  updateLoop(projectId, id, { status: "pending" });
  return getLoop(projectId, id);
}

/** Park the doc "paused". (With no engine there is no in-flight round to drain.) */
export function pauseLoop(projectId: string, id: string): LoopRecord | null {
  updateLoop(projectId, id, { status: "paused" });
  return getLoop(projectId, id);
}

/** Park the doc "stopped" for good. */
export function stopLoop(projectId: string, id: string): LoopRecord | null {
  updateLoop(projectId, id, { status: "stopped" });
  return getLoop(projectId, id);
}

// maxIterations is fixed at creation in runs-index.updateLoop (mirrors the
// upstream db.ts column set), so resume reaches under it to raise the cap.
// Read-modify-write of the single mutable doc, temp-file + rename like
// runs-index's own writeLoop. No engine runs here, so nothing races us.
function raiseMaxIterations(projectId: string, id: string, value: number): void {
  const loop = getLoop(projectId, id);
  if (!loop) return;
  const file = path.join(
    path.dirname(resolvePaths(projectId).runsDir),
    "loops",
    id,
    "loop.json",
  );
  loop.maxIterations = value;
  loop.updatedAt = new Date().toISOString();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(loop, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}
