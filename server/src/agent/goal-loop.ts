/**
 * Goal-loop engine — port of agent-control-plane's loop orchestrator
 * (backend/src/loop.ts) driving Kady's IN-PROCESS Pi instead of a `pi` CLI
 * subprocess.
 *
 * Two modes (verbatim from ACP):
 *
 *  - "orchestrated" (default): genuine agents-prompting-agents. Each round an
 *    LLM ORCHESTRATOR agent inspects progress (read-only tools) and decides
 *    either that the goal is done, or what the next task(s) are. It then writes
 *    the prompt(s) that WORKER agents execute (with full tools). Independent
 *    tasks fan out and run in parallel. The orchestrator is a real agent making
 *    the continue/done call, not a regex.
 *
 *  - "ralph": the classic single-agent loop. A fixed prompt re-runs one worker
 *    agent each iteration; a regex on its output decides continue/done.
 *
 * What is ported VERBATIM from ACP (these are pure, no I/O):
 *   - the prompt builders buildRalphPrompt / buildOrchestratorPrompt / buildWorkerPrompt
 *   - the decision parser parseDecision / extractJsonObjects / coerceDecision
 *   - recentWorkerSummary
 *   - the Control map + runLoop / ralphIteration / orchestratedIteration / runWorker
 *     state machine, ORCHESTRATOR_TOOLS, MAX_FANOUT
 *
 * What is REPLACED for Kady:
 *   - ACP's Neon db.ts → runs-index.ts (file-backed run/loop metadata).
 *   - ACP's runPiTask (spawns the `pi` CLI) → runIterationPi: a fresh in-process
 *     AgentSession per iteration, driven exactly like the sessions.ts /run handler
 *     (subscribe → tally turn_end usage via addTurnUsage → await session.prompt),
 *     then ledgered with recordRun(role 'agent') for budget AND finishRun
 *     (role 'orchestrator'|'worker') for lineage.
 *   - a per-iteration budget gate (isBudgetExceeded) that ACP did not have.
 *   - the workspace is the project sandbox; PROGRESS.md lives under
 *     sandbox/.kady/loops/<loopId>/.
 *   - a KADY_FAKE_LOOP test hook (mirrors ACP_FAKE_PI) that returns a canned
 *     PiResult WITHOUT calling session.prompt, preserving the [steps=N]/[fanout=K]
 *     control-token contract so the state machine is deterministically testable.
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import {
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  recordRun,
} from "../cost/ledger.ts";
import {
  createLoop,
  finishRun,
  getLoop,
  listRunsForLoop,
  startRun,
  updateLoop,
  type LoopMode,
  type LoopRecord,
  type RunRecord,
} from "./runs-index.ts";
import { createSession, getModelRegistry } from "./session-registry.ts";
import { resolveModel } from "./models.ts";
import { DEFAULT_MODEL_ID } from "../config.ts";

const ORCHESTRATOR_TOOLS = ["read", "ls", "find", "grep"]; // read-only: it decides, it does not build
const MAX_FANOUT = 4; // most parallel worker agents the orchestrator may spawn per round

// Kady tool ids for ACP's read-only ORCHESTRATOR_TOOLS. ACP's pi exposed a
// "read" tool; Kady's builtin set (tools.ts BUILTIN_TOOLS) uses the same names
// for ls/find/grep but the file-read tool is exposed under its own id. This map
// is the single place that bridges the two vocabularies; if Kady renames a
// builtin, only this line changes.
const ORCHESTRATOR_TOOLS_KADY: Record<string, string> = {
  read: "read",
  ls: "ls",
  find: "find",
  grep: "grep",
};
const ORCHESTRATOR_TOOL_IDS = ORCHESTRATOR_TOOLS.map((t) => ORCHESTRATOR_TOOLS_KADY[t]!);

// In-process control flags, keyed by loop id. The on-disk loop doc is the source
// of truth for status; this just lets a running loop notice a pause/stop request
// between rounds. Mirrors ACP's `controls` map exactly.
interface Control {
  pauseRequested: boolean;
  stopRequested: boolean;
  running: boolean;
}
const controls = new Map<string, Control>();

interface Decision {
  status: "continue" | "done";
  reasoning: string;
  tasks: string[];
}

type IterationOutcome =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "failed"; error: string };

// PiResult mirrors ACP's pi.ts PiResult: the normalized result of one agent run.
// In Kady it is assembled from getSessionStats() + the per-turn usage tally
// rather than parsed off a CLI event stream.
interface PiResult {
  output: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number;
  sessionId: string | null;
  isError: boolean;
  errorDetail: string;
}

// A loop always runs against a fixed project, so the project id rides alongside
// the loop id through the state machine (ACP's loop was implicitly single-tenant).
interface LoopContext {
  projectId: string;
  loop: LoopRecord;
}

// ---- Prompts (PORTED VERBATIM from ACP loop.ts) ---------------------------

function buildRalphPrompt(loop: LoopRecord, iteration: number): string {
  return `You are an autonomous build agent running in a loop. Each iteration you make ONE small, verifiable increment of progress toward the goal, then stop.

GOAL:
${loop.goal}

Your working directory is this folder. State persists between iterations on disk, NOT in your memory, so every iteration you must:
1. Read PROGRESS.md to see what is already done and what comes next.
2. Do the single next increment of real work (create/edit files, run commands to verify).
3. Update PROGRESS.md: check off what you finished and write the next concrete step.
4. End your final message with exactly one of these lines, on its own line:
   LOOP_STATUS: CONTINUE   (more work remains)
   LOOP_STATUS: DONE       (the goal is fully met and verified)

This is iteration ${iteration} of up to ${loop.maxIterations}. Keep the increment small.`;
}

function buildOrchestratorPrompt(loop: LoopRecord, iteration: number, recent: string): string {
  return `You are the orchestrator agent driving a team of worker agents toward a goal. You do NOT write code or run build commands yourself. Each round you look at what has been done and decide what the workers should do next, or whether the goal is fully met.

GOAL:
${loop.goal}

You may inspect the working directory with your read-only tools (read, ls, find, grep) to see what has actually been built. PROGRESS.md tracks state.

What the worker agents did most recently:
${recent}

Decide ONE of:
- The goal is fully met and verified  ->  status "done".
- There is more to do  ->  status "continue", with 1 to ${MAX_FANOUT} concrete next tasks.

How to break the work down:
- A substantial goal is built over SEVERAL rounds, layer by layer; that is expected and good. Each round, advance the next layer of work, then let the following round build on what now exists. Do NOT try to finish everything in one round.
- Maximize parallelism within a round: when the work in front of you has multiple INDEPENDENT pieces that do not touch the same files (for example separate modules, or one test file per module), give EACH piece its own task so the workers run in parallel. Do NOT bundle independent pieces into a single task.
- Build in dependency order across rounds: do not dispatch a task whose prerequisites do not exist yet; wait for the round after they are built (e.g. build the modules first, then the CLI that imports them, then the tests, then the docs).
- Keep each task small and self-contained. Do not redo finished work.
- Only call "done" once the code exists, runs, and is tested and documented as the goal requires.

This is round ${iteration} of at most ${loop.maxIterations}.

End your reply with a single JSON object on its own line, inside a fenced code block, exactly in this shape:
\`\`\`json
{"status": "continue", "reasoning": "<one short sentence>", "tasks": ["<task>", "<task>"]}
\`\`\`
For "done", use an empty tasks array.`;
}

function buildWorkerPrompt(loop: LoopRecord, task: string): string {
  return `You are a worker agent on a team building toward a larger goal. Do exactly the task you are given, fully and verified, then stop. Other agents may be handling other tasks in parallel, so stay strictly within yours.

OVERALL GOAL (for context only):
${loop.goal}

YOUR TASK THIS ROUND:
${task}

Work in the current directory using your tools (read, bash, edit, write). Verify your work by running or testing it. When finished, briefly note what you did in PROGRESS.md. Keep your final message short: what you did and whether it worked.`;
}

// ---- Decision parsing (PORTED VERBATIM from ACP loop.ts) ------------------

function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function coerceDecision(raw: string): Decision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== "continue" && status !== "done") return null;
  const tasks = Array.isArray(obj.tasks)
    ? obj.tasks.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
  return { status, reasoning, tasks };
}

// Pull the orchestrator's decision out of its free-text reply. Prefers a fenced
// ```json block, falls back to any balanced {...}, tries newest first.
export function parseDecision(text: string): Decision | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) candidates.push(m[1]!);
  candidates.push(...extractJsonObjects(text));
  for (let i = candidates.length - 1; i >= 0; i--) {
    const d = coerceDecision(candidates[i]!);
    if (d) return d;
  }
  return null;
}

// ---- Workspace (ported from ACP ensureWorkspace, retargeted to .kady) ------

// ACP wrote PROGRESS.md into a per-loop workspace dir. Kady runs the loop inside
// the project sandbox (so the agent's tools see the real project), and parks
// loop-private state under sandbox/.kady/loops/<loopId>/ — a sibling of the
// runs/ and loops/ trees that runs-index.ts already owns. Returns the cwd the
// iteration agents run in (the sandbox itself).
function ensureWorkspace(projectId: string, loop: LoopRecord): { cwd: string; loopDir: string } {
  const sandbox = resolvePaths(projectId).sandbox;
  const kadyDir = path.join(sandbox, ".kady");
  const loopDir = path.join(kadyDir, "loops", loop.id);
  fs.mkdirSync(loopDir, { recursive: true });
  const progress = path.join(loopDir, "PROGRESS.md");
  if (!fs.existsSync(progress)) {
    fs.writeFileSync(
      progress,
      `# Progress\n\nGoal: ${loop.goal}\n\n## Done\n\n## Next\n- [ ] Get started on the goal.\n`,
      "utf-8",
    );
  }
  return { cwd: sandbox, loopDir };
}

// ---- Recent worker summary (PORTED VERBATIM, RunRecord field names) --------

function recentWorkerSummary(runs: RunRecord[]): string {
  // listRunsForLoop returns newest-first; ACP's listRunsForLoop returned
  // oldest-first and sliced the last 6. Reverse to oldest-first, then take the
  // last 6 so the summary reads chronologically as it did in ACP.
  const workers = runs.filter((r) => r.role === "worker").reverse().slice(-6);
  if (workers.length === 0) return "Nothing yet. This is the first round.";
  return workers
    .map((r) => {
      const out = (r.output ?? "").replace(/\s+/g, " ").slice(0, 240);
      return `- [round ${r.iteration}] (${r.status}) ${r.task}: ${out}`;
    })
    .join("\n");
}

// ---- In-process Pi: one agent run per iteration ---------------------------

/**
 * Run ONE agent turn in a fresh in-process Pi session and return a PiResult.
 *
 * This is the Kady replacement for ACP's runPiTask. It drives the session the
 * same way the sessions.ts /run handler does:
 *   1. createSession(projectId, paths) — a brand-new session per iteration, so
 *      state lives on disk (PROGRESS.md), never in a model's context.
 *   2. subscribe() and tally each turn_end's usage with addTurnUsage (immune to
 *      mid-run compaction shrinking getSessionStats()).
 *   3. optionally restrict the live tool set (orchestrator = read-only), restoring
 *      it after — exactly the setActiveToolsByName save/restore the /run handler
 *      uses for a fusion turn.
 *   4. await session.prompt(builtPrompt).
 *   5. ledger: recordRun(role 'agent') against the session's costs.jsonl so the
 *      project budget sees this spend. (finishRun for lineage is the caller's job,
 *      so role 'orchestrator'|'worker' is recorded distinctly from the budget row.)
 *
 * PiResult is mapped from getSessionStats() + the turn tally: output is the final
 * assistant text, cost/tokens come from the tally (cumulative, restart-proof),
 * sessionId is the live session's id.
 *
 * KADY_FAKE_LOOP short-circuits before any of this and returns a canned result
 * (see fakeIterationPi) so the state machine is testable without a model call.
 */
async function runIterationPi(
  projectId: string,
  prompt: string,
  opts: { restrictTools?: string[] },
): Promise<PiResult> {
  if (process.env.KADY_FAKE_LOOP === "1") {
    return fakeIterationPi(projectId, prompt);
  }

  const paths = resolvePaths(projectId);
  const session = await createSession(projectId, paths);

  // Pin a valid, current model on the fresh session instead of inheriting the
  // project's saved default — that default can be a stale/deprecated ref (e.g. a
  // removed model id) that 400s at OpenRouter and silently fails the whole loop.
  // Mirrors how the /run handler sets the per-run model. (A future per-loop model
  // would override DEFAULT_MODEL_ID here.)
  try {
    await session.setModel(resolveModel(DEFAULT_MODEL_ID, getModelRegistry()));
  } catch (err) {
    // If resolution fails, fall back to the session's own default rather than abort.
    void err;
  }

  // Restrict to read-only tools for the orchestrator, like the /run handler's
  // fusion path. Save the real set and restore it in the finally so nothing
  // leaks across iterations (each iteration is a fresh session anyway, but the
  // restore keeps the contract explicit and matches sessions.ts).
  let savedToolNames: string[] | null = null;
  if (opts.restrictTools) {
    savedToolNames = session.getActiveToolNames();
    session.setActiveToolsByName(opts.restrictTools);
  }

  // Usage tallied straight from turn_end events (sessions.ts explains why the
  // per-turn tally is preferred over a getSessionStats() before/after delta:
  // mid-run compaction can make the delta lie low).
  const turnTally = emptySnapshot();
  const unsub = session.subscribe((ev) => {
    if (ev.type === "turn_end") {
      const usage = (ev.message as { usage?: Parameters<typeof addTurnUsage>[1] }).usage;
      if (usage) addTurnUsage(turnTally, usage);
    }
  });

  const result: PiResult = {
    output: "",
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 0,
    sessionId: session.sessionId,
    isError: false,
    errorDetail: "",
  };

  // errorMessage is sticky on the session; only report one THIS run set.
  const priorError = session.state.errorMessage;
  try {
    await session.prompt(prompt);
    const errorMessage = session.state.errorMessage;
    if (errorMessage && errorMessage !== priorError) {
      result.isError = true;
      result.errorDetail = errorMessage;
    }
  } catch (err) {
    result.isError = true;
    result.errorDetail = err instanceof Error ? err.message : String(err);
  } finally {
    unsub();
    if (savedToolNames !== null) session.setActiveToolsByName(savedToolNames);
  }

  // Map getSessionStats() + the turn tally onto the PiResult shape.
  const stats = session.getSessionStats();
  result.output = session.getLastAssistantText() ?? "";
  result.costUsd = turnTally.costUsd;
  result.inputTokens = turnTally.input;
  result.outputTokens = turnTally.output;
  result.numTurns = stats.assistantMessages;

  // Budget ledger row (role 'agent'): this is what isBudgetExceeded sums. We
  // ledger the per-turn tally (not a 0→stats delta) so a session that compacted
  // mid-run is still charged for what it actually spent.
  recordRun({
    sessionId: session.sessionId,
    projectId,
    model: session.model?.id ?? "unknown",
    role: "agent",
    before: emptySnapshot(),
    after: {
      costUsd: turnTally.costUsd,
      input: turnTally.input,
      output: turnTally.output,
      cacheRead: turnTally.cacheRead,
      total: turnTally.total,
    },
  });

  return result;
}

/**
 * Deterministic stand-in for a real iteration agent run (KADY_FAKE_LOOP=1).
 *
 * Mirrors ACP's fakePiRun: it reads control tokens out of the prompt and keeps a
 * counter on disk (proving cross-iteration state lives on disk, not in context).
 * Tokens, set in the loop goal:
 *   [steps=N]    finish (ralph DONE / orchestrator "done") after N rounds
 *   [fanout=K]   orchestrator emits K parallel worker tasks per continuing round
 *   [fail]       ralph-level Pi failure
 *   [orchfail]   orchestrator-level Pi failure
 *   [workerfail] worker errors (non-fatal — surfaced, loop continues)
 * It detects which role it is playing from the prompt (the verbatim prompt
 * preambles), so orchestrated and ralph loops both work. Crucially it does NOT
 * call session.prompt, so the test makes no live model call.
 */
function fakeIterationPi(projectId: string, prompt: string): PiResult {
  if (/^You are the orchestrator agent/.test(prompt)) return fakeOrchestrator(projectId, prompt);
  if (/^You are a worker agent/.test(prompt)) return fakeWorker(prompt);
  return fakeRalph(projectId, prompt);
}

// The fake counters live alongside the loop's PROGRESS.md so they are wiped with
// the rest of the loop's scratch state. The sandbox root is stable per project,
// so a single counter dir under .kady is enough for the test.
function fakeCounterPath(projectId: string, file: string): string {
  const dir = path.join(resolvePaths(projectId).sandbox, ".kady", "loops", "_fake");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, file);
}

function bumpCounter(projectId: string, file: string): number {
  const p = fakeCounterPath(projectId, file);
  let count = 0;
  try {
    count = Number(fs.readFileSync(p, "utf-8").trim()) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  fs.writeFileSync(p, String(count), "utf-8");
  return count;
}

function fakeResult(output: string, n: number, isError = false, errorDetail = ""): PiResult {
  return {
    output,
    costUsd: 0,
    inputTokens: 100 + n,
    outputTokens: 20,
    numTurns: 1,
    sessionId: `fake-${n}`,
    isError,
    errorDetail,
  };
}

function fakeRalph(projectId: string, prompt: string): PiResult {
  const count = bumpCounter(projectId, "_fake_count.txt");
  if (/\[fail\]/.test(prompt)) return fakeResult("", count, true, "simulated Pi failure");
  const steps = Number(prompt.match(/\[steps=(\d+)\]/)?.[1] ?? 1);
  const done = count >= steps;
  const output = `Fake increment ${count} of ${steps}. LOOP_STATUS: ${done ? "DONE" : "CONTINUE"}`;
  return fakeResult(output, count);
}

function fakeOrchestrator(projectId: string, prompt: string): PiResult {
  const round = bumpCounter(projectId, "_orch_count.txt");
  if (/\[orchfail\]/.test(prompt)) return fakeResult("", round, true, "simulated orchestrator failure");
  const steps = Number(prompt.match(/\[steps=(\d+)\]/)?.[1] ?? 1);
  const fanout = Math.max(1, Number(prompt.match(/\[fanout=(\d+)\]/)?.[1] ?? 1));
  let decision: string;
  if (round >= steps) {
    decision = `{"status": "done", "reasoning": "fake: goal met after ${round} rounds", "tasks": []}`;
  } else {
    const tasks = Array.from({ length: fanout }, (_, i) => `fake task ${round}.${i + 1}`);
    decision = `{"status": "continue", "reasoning": "fake round ${round}", "tasks": ${JSON.stringify(tasks)}}`;
  }
  const output = `Round ${round} decision.\n\`\`\`json\n${decision}\n\`\`\``;
  return fakeResult(output, round);
}

function fakeWorker(prompt: string): PiResult {
  // Workers share a counter only for an error-count effect; the orchestrator's
  // round counter already proves cross-round state, so a fresh-ish n is fine.
  const n = 1;
  if (/\[workerfail\]/.test(prompt)) return fakeResult("", n, true, "simulated worker failure");
  return fakeResult(`Worker completed its task (#${n}).`, n);
}

// ---- Shared lineage helper -------------------------------------------------

// finishRun fields for a run, derived from a PiResult. Mirrors ACP's runFields.
function finishFields(result: PiResult): {
  status: "completed" | "failed";
  output?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  numTurns: number;
} {
  return {
    status: result.isError ? "failed" : "completed",
    output: result.output || result.errorDetail || undefined,
    costUsd: result.costUsd ?? undefined,
    tokensIn: result.inputTokens ?? undefined,
    tokensOut: result.outputTokens ?? undefined,
    numTurns: result.numTurns,
  };
}

// ---- Ralph mode (single agent, regex decides) -----------------------------

async function ralphIteration(
  ctx: LoopContext,
  iteration: number,
): Promise<IterationOutcome> {
  const { projectId, loop } = ctx;
  // A run row needs a sessionId before the session exists (startRun is keyed by
  // it). We mint the loop-scoped session id here and reconcile lineage via the
  // PiResult's real sessionId on finishRun. ACP had no such split because its DB
  // run row carried session_id only after the CLI returned it; in Kady the run
  // log is keyed by sessionId on disk, so we record under the real session.
  const result = await runIterationPi(projectId, buildRalphPrompt(loop, iteration), {});
  const sessionId = result.sessionId ?? `loop-${loop.id}-i${iteration}`;
  const runId = startRun(projectId, {
    sessionId,
    loopId: loop.id,
    iteration,
    task: `Iteration ${iteration}: increment toward goal`,
    role: "worker",
  });
  finishRun(projectId, sessionId, runId, finishFields(result));

  if (result.isError) return { kind: "failed", error: result.errorDetail || "agent run failed" };
  if (/LOOP_STATUS:\s*DONE/i.test(result.output)) return { kind: "done" };
  return { kind: "continue" };
}

// ---- Orchestrated mode (agents prompting agents) --------------------------

async function orchestratedIteration(
  ctx: LoopContext,
  iteration: number,
  control: Control,
): Promise<IterationOutcome> {
  const { projectId, loop } = ctx;

  // 1. The orchestrator agent inspects state and decides (read-only tools).
  const recent = recentWorkerSummary(listRunsForLoop(projectId, loop.id));
  const orchResult = await runIterationPi(
    projectId,
    buildOrchestratorPrompt(loop, iteration, recent),
    { restrictTools: ORCHESTRATOR_TOOL_IDS },
  );
  const orchSessionId = orchResult.sessionId ?? `loop-${loop.id}-orch${iteration}`;
  const decision = parseDecision(orchResult.output);
  const orchRunId = startRun(projectId, {
    sessionId: orchSessionId,
    loopId: loop.id,
    iteration,
    task: `Round ${iteration}: orchestrator decides next step`,
    role: "orchestrator",
  });
  finishRun(projectId, orchSessionId, orchRunId, {
    ...finishFields(orchResult),
    status: orchResult.isError || !decision ? "failed" : "completed",
    reasoning: decision?.reasoning ?? undefined,
  });

  if (orchResult.isError) {
    return { kind: "failed", error: `orchestrator agent failed: ${orchResult.errorDetail}` };
  }
  if (!decision) {
    return { kind: "failed", error: "could not parse the orchestrator's decision (no valid JSON)" };
  }
  if (decision.status === "done") return { kind: "done" };

  const tasks = decision.tasks.slice(0, MAX_FANOUT);
  if (tasks.length === 0) {
    return { kind: "failed", error: "orchestrator said continue but gave no tasks" };
  }
  if (control.stopRequested) return { kind: "continue" };

  // 2. Worker agents execute the decided tasks (fan out in parallel). A worker
  //    failure is recorded but NOT fatal: the orchestrator sees it next round
  //    and can adjust. The iteration cap bounds any retrying.
  await Promise.all(tasks.map((task) => runWorker(ctx, iteration, orchRunId, task)));

  return { kind: "continue" };
}

async function runWorker(
  ctx: LoopContext,
  iteration: number,
  parentRunId: string,
  task: string,
): Promise<void> {
  const { projectId, loop } = ctx;
  const result = await runIterationPi(projectId, buildWorkerPrompt(loop, task), {});
  const sessionId = result.sessionId ?? `loop-${loop.id}-w${iteration}`;
  const runId = startRun(projectId, {
    sessionId,
    loopId: loop.id,
    iteration,
    task,
    role: "worker",
    parentRunId,
  });
  finishRun(projectId, sessionId, runId, finishFields(result));
}

// ---- The loop (PORTED from ACP runLoop, with a Kady budget gate) ----------

async function runLoop(projectId: string, id: string): Promise<void> {
  const control: Control = { pauseRequested: false, stopRequested: false, running: true };
  controls.set(id, control);
  try {
    updateLoop(projectId, id, { status: "running" });

    while (true) {
      const loop = getLoop(projectId, id);
      if (!loop) break;
      if (loop.status === "stopped" || control.stopRequested) break;

      if (control.pauseRequested) {
        updateLoop(projectId, id, { status: "paused" });
        break;
      }

      // Kady-only gate (ACP had none): refuse to start another round once the
      // project's spend cap is hit. The loop parks 'paused' so a raised limit +
      // resume picks it back up, the same wait state a pause uses.
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        updateLoop(projectId, id, {
          status: "paused",
          lastError:
            `project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}) — raise the limit and resume`,
        });
        break;
      }

      if (loop.iteration >= loop.maxIterations) {
        // ACP parked at 'awaiting_approval'. Kady's LoopStatus has no such state;
        // 'paused' is the equivalent human gate (resume bumps maxIterations).
        updateLoop(projectId, id, { status: "paused" });
        break;
      }

      const iteration = loop.iteration + 1;
      ensureWorkspace(projectId, loop); // PROGRESS.md under .kady/loops/<id>/

      const ctx: LoopContext = { projectId, loop };
      let outcome: IterationOutcome;
      try {
        outcome =
          loop.mode === "ralph"
            ? await ralphIteration(ctx, iteration)
            : await orchestratedIteration(ctx, iteration, control);
      } catch (err) {
        outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      }

      updateLoop(projectId, id, { iteration });

      // A stop issued mid-round wins over this round's outcome (keeps a user
      // stop from being clobbered into completed/failed).
      if (control.stopRequested) break;
      if (outcome.kind === "failed") {
        updateLoop(projectId, id, { status: "failed", lastError: outcome.error });
        break;
      }
      if (outcome.kind === "done") {
        updateLoop(projectId, id, { status: "completed" });
        break;
      }
      if (control.pauseRequested) {
        updateLoop(projectId, id, { status: "paused" });
        break;
      }
      // continue -> next round
    }
  } catch (err) {
    try {
      updateLoop(projectId, id, {
        status: "failed",
        lastError: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* best-effort */
    }
  } finally {
    control.running = false;
    controls.delete(id);
  }
}

// ---- Lifecycle / public engine API ----------------------------------------

/**
 * Create a loop and kick its runner off asynchronously (fire-and-forget, like
 * ACP's startLoop). Returns the freshly-created loop doc immediately so the
 * caller can hand back a loop id without waiting for the first round.
 */
export function startLoop(input: {
  projectId: string;
  goal: string;
  mode: LoopMode;
  maxIterations: number;
}): LoopRecord {
  const loop = createLoop(input.projectId, {
    goal: input.goal,
    mode: input.mode,
    maxIterations: input.maxIterations,
  });
  void runLoop(input.projectId, loop.id);
  return loop;
}

/**
 * Resume a parked loop (paused/awaiting-cap), granting extra iterations. No-op
 * (returns the loop) if it is already running. Mirrors ACP's resumeLoop.
 */
export function resumeLoop(
  projectId: string,
  id: string,
  extraIterations: number,
): LoopRecord | null {
  const loop = getLoop(projectId, id);
  if (!loop) return null;
  if (controls.get(id)?.running) return loop; // already going
  const newCap = loop.maxIterations + Math.max(1, extraIterations);
  // maxIterations is fixed-at-creation in runs-index.updateLoop, so resume needs
  // its own raise. We rewrite the doc directly (single mutable file) — the loop
  // is not running here (guarded above), so no concurrent writer races us.
  raiseMaxIterations(projectId, id, newCap);
  updateLoop(projectId, id, { status: "running" });
  void runLoop(projectId, id);
  return getLoop(projectId, id);
}

/**
 * Request a pause. If the loop is running, it stops after the current round
 * (the runner notices control.pauseRequested between rounds). If it is not
 * running, the doc is parked 'paused' directly. Mirrors ACP's pauseLoop.
 */
export function pauseLoop(projectId: string, id: string): LoopRecord | null {
  const control = controls.get(id);
  if (control?.running) {
    control.pauseRequested = true; // loop stops after the current round finishes
  } else {
    updateLoop(projectId, id, { status: "paused" });
  }
  return getLoop(projectId, id);
}

/**
 * Request a stop. Sets the in-process flag (so a running loop bails out and a
 * mid-round stop wins over the round's outcome) AND parks the doc 'stopped'.
 * Mirrors ACP's stopLoop.
 */
export function stopLoop(projectId: string, id: string): LoopRecord | null {
  const control = controls.get(id);
  if (control) control.stopRequested = true;
  updateLoop(projectId, id, { status: "stopped" });
  return getLoop(projectId, id);
}

// maxIterations is fixed at creation in runs-index (mirrors db.ts's column set),
// so resume reaches under it to raise the cap. Read-modify-write the single doc.
// Caller (resumeLoop) guarantees the loop is not running, so this does not race.
function raiseMaxIterations(projectId: string, id: string, value: number): void {
  const loop = getLoop(projectId, id);
  if (!loop) return;
  const file = path.join(
    resolvePaths(projectId).sandbox,
    ".kady",
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

// Exported for tests / callers that want to await a loop's terminal state rather
// than poll. Not part of ACP; Kady's fake mode runs synchronously enough that a
// short poll suffices, but this keeps the test from sleeping on a magic number.
export function isLoopRunning(id: string): boolean {
  return controls.get(id)?.running ?? false;
}

// Re-exported so callers (e.g. an Agent Console route) can render the same
// vocabulary the engine uses without re-importing runs-index.
export type { LoopMode, LoopRecord } from "./runs-index.ts";
export { ORCHESTRATOR_TOOLS, MAX_FANOUT };
