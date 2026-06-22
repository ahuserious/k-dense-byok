/**
 * Background-rescue watchdog — detects a diverged Archon workflow run and re-grounds it.
 *
 * WHY POLL, NOT THE SSE (verified against Archon v0.4.1):
 *   Archon's dashboard SSE (/api/stream/__dashboard__) is NOTIFICATION-ONLY: it
 *   carries `workflow_status` + `dag_node` transitions and NOTHING about cost,
 *   token usage, or node output — and on the SQLite backend it lags ~10s with no
 *   per-run stream. The TRUTH about a run lives in
 *       GET /api/workflows/runs/:runId  ->  { run, events }
 *   where per-node status/output/tokens are in `events[].data` (node_started /
 *   node_completed / node_failed, each carrying cost_usd / num_turns / node_output).
 *   So this watchdog POLLS `getRun` directly (more timely than the SSE on SQLite)
 *   and never depends on the SSE for data.
 *
 * WHY A RESCUE RESTART IS A *NEW* RUN, NOT A RESUME (verified):
 *   Archon's resume replays the run's ORIGINAL user_message and offers no seam to
 *   inject a fresh prompt. So a re-grounding restart must either (a) start a NEW
 *   run via runWorkflow({ message: synthesizedPrompt }) for a failed/stuck node,
 *   or (b) when the run is PAUSED at a gate, feed the synthesized text through the
 *   gate via rejectRun(reason) (which becomes $REJECTION_REASON for the on_reject
 *   retry). Both seams are exercised by the default restart() below.
 *
 * The detector (detectDivergence) is a PURE function of the events array + a clock,
 * so it is fully unit-testable with no live calls. getRun / rescue / restart / now
 * are all injectable on watchRun for the same reason.
 */
import { chat } from "./council.ts";
import { getRun, runWorkflow, rejectRun } from "./archon/client.ts";
import { KDENSE_AGENTS, type KDenseAgent } from "./kdense-agents.ts";
import { startRun, finishRun } from "./runs-index.ts";

// The /background-rescue persona (model openrouter/x-ai/grok-4.20) the default
// rescue() invokes. Looked up by name from the exported registry rather than
// importing a private const, so kdense-agents.ts keeps its single-export surface.
const BACKGROUND_RESCUE: KDenseAgent =
  KDENSE_AGENTS.find((agent) => agent.name === "background-rescue") ??
  (() => {
    throw new Error("background-rescue agent persona is missing from KDENSE_AGENTS");
  })();

// ---- Archon run/event shapes (the subset the watchdog reads) ---------------
//
// We keep these permissive: Archon reports fields in snake_case, occasionally
// camelCase, and nests node data under `data`. The detector reads through helper
// accessors so a missing/renamed field degrades to "unknown" rather than throwing.

export interface RunEvent {
  /** node lifecycle / activity type, e.g. node_started | node_completed | node_failed | tool_call | command */
  type?: string;
  event_type?: string;
  /** which DAG node this event belongs to */
  node_id?: string;
  nodeId?: string;
  node?: string;
  /** event timestamp; Archon uses any of these */
  ts?: number | string;
  timestamp?: number | string;
  created_at?: number | string;
  /** per-node payload: cost_usd, num_turns, node_output live here on completion */
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunSnapshot {
  run?: Record<string, unknown>;
  events?: RunEvent[];
  [key: string]: unknown;
}

export type DivergenceKind = "stall" | "loop-stuck" | "rot" | "hallucination";

export interface Divergence {
  kind: DivergenceKind | null;
  nodeId?: string;
  reason: string;
}

export interface DetectOptions {
  /** no new event for the active node within this window => stall. Default 180000ms. */
  stallMs?: number;
  /** N node_started/turn events for one node with no node_completed => loop-stuck. Default 4. */
  maxRepeats?: number;
  /** [0..1] consecutive-output similarity at/above which two outputs are "near-duplicate". Default 0.9. */
  rotSimilarity?: number;
  /** clock for the stall window. Default Date.now. */
  now?: () => number;
}

// ---- Event field accessors (tolerant of snake/camel + nesting) -------------

const STARTED = new Set(["node_started", "node_start", "started"]);
const COMPLETED = new Set(["node_completed", "node_complete", "completed"]);
const FAILED = new Set(["node_failed", "node_error", "failed"]);
// Activity inside a node that proves real work happened (used by the hallucination heuristic).
const TOOL_OR_COMMAND = new Set([
  "tool_call",
  "tool_result",
  "command",
  "command_run",
  "bash",
  "turn",
  "assistant_turn",
]);

function eventType(ev: RunEvent): string {
  return String(ev.type ?? ev.event_type ?? "").toLowerCase();
}

function eventNodeId(ev: RunEvent): string | undefined {
  const id = ev.node_id ?? ev.nodeId ?? ev.node ?? (ev.data?.node_id as string | undefined);
  return id !== undefined && id !== null ? String(id) : undefined;
}

/**
 * Event time as epoch ms. Accepts a number (already ms or seconds) or an ISO
 * string. Numbers below 1e12 are treated as seconds (Archon stores some ts in
 * seconds, like the runs-index ledger) and scaled up; everything else is ms.
 * Returns NaN when no usable timestamp is present so callers can skip it.
 */
function eventTimeMs(ev: RunEvent): number {
  const raw = ev.ts ?? ev.timestamp ?? ev.created_at;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/** The node-output text an event asserts, if any (node_completed payloads). */
function eventOutputText(ev: RunEvent): string | undefined {
  const d = ev.data ?? {};
  const candidate = d.node_output ?? d.output ?? d.text ?? d.result ?? (ev as Record<string, unknown>).output;
  if (typeof candidate === "string") return candidate;
  return undefined;
}

// ---- Text similarity (cheap token-Jaccard, used by the 'rot' heuristic) ----
//
// Deliberately simple: lowercase, split on non-word chars, compare the two token
// SETS by Jaccard overlap. This catches "the node re-emitted essentially the same
// paragraph" without pulling in an embedding model. It is a heuristic signal, not
// a proof — like the hallucination signal it should be confirmed by the rescue
// agent, never acted on blindly.

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---- The PURE detector -----------------------------------------------------

/**
 * Inspect a run's event stream and decide whether the active node has diverged.
 * Pure: depends only on `events`, the options, and the injected `now()` clock.
 * Returns the FIRST signal found, in priority order
 *   loop-stuck > stall > rot > hallucination
 * (terminal/structural failures before advisory content heuristics), or
 * `{ kind: null }` when the run looks healthy.
 *
 * Signals:
 *  - stall:        the most-recent activity for the still-open node is older than
 *                  stallMs relative to now() (the run stopped making progress).
 *  - loop-stuck:   one node accumulated > maxRepeats node_started/turn events with
 *                  no node_completed (cycling the same failing step).
 *  - rot:          two CONSECUTIVE node outputs are near-duplicates (similarity >=
 *                  rotSimilarity) — the node is re-emitting the same thing.
 *  - hallucination:a node_completed asserts an output, but that node logged NO
 *                  preceding tool/command/turn event — it claims a result it never
 *                  did the work for. ADVISORY: confirm via the rescue agent.
 */
export function detectDivergence(events: RunEvent[], opts: DetectOptions = {}): Divergence {
  const stallMs = opts.stallMs ?? 180_000;
  const maxRepeats = opts.maxRepeats ?? 4;
  const rotSimilarity = opts.rotSimilarity ?? 0.9;
  const now = opts.now ?? Date.now;

  if (!Array.isArray(events) || events.length === 0) {
    return { kind: null, reason: "no events yet" };
  }

  // Per-node tally: starts/turns seen, whether it completed, and its outputs in order.
  interface NodeState {
    starts: number;
    completed: boolean;
    failed: boolean;
    lastActivityMs: number;
    sawToolOrCommand: boolean;
  }
  const byNode = new Map<string, NodeState>();
  const ensure = (id: string): NodeState => {
    let state = byNode.get(id);
    if (!state) {
      state = { starts: 0, completed: false, failed: false, lastActivityMs: NaN, sawToolOrCommand: false };
      byNode.set(id, state);
    }
    return state;
  };

  for (const ev of events) {
    const id = eventNodeId(ev);
    if (!id) continue;
    const state = ensure(id);
    const type = eventType(ev);
    const t = eventTimeMs(ev);
    if (Number.isFinite(t)) {
      // last activity = max timestamp seen on this node
      state.lastActivityMs = Number.isNaN(state.lastActivityMs) ? t : Math.max(state.lastActivityMs, t);
    }
    if (STARTED.has(type)) state.starts += 1;
    if (COMPLETED.has(type)) state.completed = true;
    if (FAILED.has(type)) state.failed = true;
    if (TOOL_OR_COMMAND.has(type)) state.sawToolOrCommand = true;
  }

  // --- loop-stuck: a node started past the repeat ceiling without ever completing.
  for (const [id, state] of byNode) {
    if (!state.completed && state.starts > maxRepeats) {
      return {
        kind: "loop-stuck",
        nodeId: id,
        reason: `node ${id} started ${state.starts}x (> ${maxRepeats}) without completing — cycling the same step`,
      };
    }
  }

  // --- stall: the latest OPEN node has gone quiet past the stall window.
  // "Open" = started but neither completed nor failed. We pick the open node with
  // the most recent activity (the one the run is presumably waiting on).
  let stalledNode: { id: string; lastActivityMs: number } | null = null;
  for (const [id, state] of byNode) {
    const open = !state.completed && !state.failed;
    if (!open || !Number.isFinite(state.lastActivityMs)) continue;
    if (!stalledNode || state.lastActivityMs > stalledNode.lastActivityMs) {
      stalledNode = { id, lastActivityMs: state.lastActivityMs };
    }
  }
  if (stalledNode) {
    const idleMs = now() - stalledNode.lastActivityMs;
    if (idleMs >= stallMs) {
      return {
        kind: "stall",
        nodeId: stalledNode.id,
        reason: `node ${stalledNode.id} produced no new event for ${Math.round(idleMs / 1000)}s (>= ${Math.round(
          stallMs / 1000,
        )}s) — stalled`,
      };
    }
  }

  // --- rot: two CONSECUTIVE node outputs are near-duplicates.
  // We scan outputs in event order; consecutive here means "the next output event",
  // which is the realistic rot signature (a node re-emitting the same paragraph).
  let previousOutput: { nodeId: string | undefined; text: string } | null = null;
  for (const ev of events) {
    const text = eventOutputText(ev);
    if (text === undefined || text.trim().length === 0) continue;
    if (previousOutput) {
      const similarity = jaccardSimilarity(previousOutput.text, text);
      if (similarity >= rotSimilarity) {
        return {
          kind: "rot",
          nodeId: eventNodeId(ev) ?? previousOutput.nodeId,
          reason: `consecutive node outputs are ${(similarity * 100).toFixed(
            0,
          )}% similar (>= ${(rotSimilarity * 100).toFixed(0)}%) — context rot / repeated output`,
        };
      }
    }
    previousOutput = { nodeId: eventNodeId(ev), text };
  }

  // --- hallucination (ADVISORY): a node_completed asserts an output, but that node
  // logged no preceding tool/command/turn event. It claims a result without doing
  // the work. Never act on this blindly — the rescue agent must confirm.
  for (const [id, state] of byNode) {
    if (!state.completed || state.sawToolOrCommand) continue;
    const assertedOutput = events.some(
      (ev) => eventNodeId(ev) === id && COMPLETED.has(eventType(ev)) && (eventOutputText(ev)?.trim().length ?? 0) > 0,
    );
    if (assertedOutput) {
      return {
        kind: "hallucination",
        nodeId: id,
        reason: `node ${id} completed asserting an output with no preceding tool/command event — possible hallucination (ADVISORY: confirm via rescue agent)`,
      };
    }
  }

  return { kind: null, reason: "run healthy — no divergence signal" };
}

// ---- watchRun: poll, detect, rescue, restart -------------------------------

/** Lifecycle tags surfaced to a caller-supplied callback (mirrored to SSE upstream). */
export type RescueTag = "rescue_detected" | "synthesizing" | "restart" | "done" | "error";

export interface RescueEvent {
  tag: RescueTag;
  runId: string;
  divergence?: Divergence;
  synthesizedPrompt?: string;
  restartResult?: unknown;
  error?: string;
}

export interface RescueContext {
  runId: string;
  projectId: string;
  divergence: Divergence;
  snapshot: RunSnapshot;
  signal?: AbortSignal;
}

export interface RestartContext extends RescueContext {
  synthesizedPrompt: string;
  /** Forwarded from watchRun so the default restart can start a NEW run. */
  workflowName?: string;
}

export interface WatchRunArgs {
  runId: string;
  projectId: string;
  /** Optional: the workflow this run belongs to. Needed by the default restart()
   *  to start a NEW run (runWorkflow). If omitted, restart falls back to the
   *  paused-gate seam (rejectRun) which needs only the runId. */
  workflowName?: string;
  /** Injectable poller. Default: archon getRun. */
  getRun?: (runId: string) => Promise<unknown>;
  /** Injectable rescue: read the diverged node + goal, return a re-grounding prompt.
   *  Default: invoke /background-rescue via chat() to its configured model. */
  rescue?: (ctx: RescueContext) => Promise<string>;
  /** Injectable restart: act on the synthesized prompt. Default: runWorkflow (new
   *  run) for a failed/stuck node, or rejectRun(reason) when paused at a gate. */
  restart?: (ctx: RestartContext) => Promise<unknown>;
  /** Poll period. Default 15000ms. */
  pollMs?: number;
  /** Stall window forwarded to the detector. Default 180000ms. */
  stallMs?: number;
  /** Max repeats forwarded to the detector. Default 4. */
  maxRepeats?: number;
  /** Clock, forwarded to the detector AND used for poll scheduling. Default Date.now. */
  now?: () => number;
  /** Abort the watch loop (and forwarded to rescue/restart/getRun where supported). */
  signal?: AbortSignal;
  /** Lifecycle callback for SSE tagging. */
  onEvent?: (event: RescueEvent) => void;
  /** Sleeper, injectable so tests don't wait real time. Default setTimeout-based. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Safety cap on poll iterations (prevents an unbounded loop if a run never terminates). */
  maxPolls?: number;
}

export interface WatchRunResult {
  /** True if a divergence was detected and a rescue+restart was attempted. */
  rescued: boolean;
  divergence?: Divergence;
  synthesizedPrompt?: string;
  restartResult?: unknown;
  /** Why the watch loop ended: 'rescued' | 'terminal' | 'aborted' | 'max-polls'. */
  stoppedReason: "rescued" | "terminal" | "aborted" | "max-polls";
  polls: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function normalizeSnapshot(raw: unknown): RunSnapshot {
  if (raw && typeof raw === "object") {
    const obj = raw as RunSnapshot;
    return { run: obj.run, events: Array.isArray(obj.events) ? obj.events : [] };
  }
  return { run: undefined, events: [] };
}

/** A run is terminal when its top-level status is a finished state. */
function isTerminalStatus(snapshot: RunSnapshot): boolean {
  const status = String((snapshot.run?.status ?? snapshot.run?.state ?? "") as string).toLowerCase();
  return ["completed", "succeeded", "success", "failed", "cancelled", "canceled", "abandoned"].includes(status);
}

/** True when the run is paused at a gate (so the rescue seam is rejectRun, not a new run). */
function isPausedAtGate(snapshot: RunSnapshot): boolean {
  const status = String((snapshot.run?.status ?? snapshot.run?.state ?? "") as string).toLowerCase();
  return ["paused", "awaiting_approval", "awaiting_input", "waiting", "gate"].includes(status);
}

/**
 * Find the original goal/user_message the run was given, so the rescue agent can
 * anchor to it rather than to the node's drifted-into objective.
 */
function originalGoal(snapshot: RunSnapshot): string {
  const run = snapshot.run ?? {};
  const candidate = run.user_message ?? run.userMessage ?? run.message ?? run.goal ?? run.input;
  return typeof candidate === "string" ? candidate : "";
}

/**
 * Default rescue: invoke the /background-rescue persona on its configured model
 * (openrouter/x-ai/grok-4.20). We hand it the original goal + the diverged node's
 * events and its own system prompt, and it returns ONE self-contained re-grounding
 * prompt. We do NOT act on the hallucination/rot heuristics blindly — the agent
 * reads the transcript and decides; the watchdog only flags.
 */
async function defaultRescue(ctx: RescueContext): Promise<string> {
  const nodeId = ctx.divergence.nodeId;
  const nodeEvents = (ctx.snapshot.events ?? []).filter((ev) => !nodeId || eventNodeId(ev) === nodeId);
  const goal = originalGoal(ctx.snapshot);

  const userMessage = [
    `A background watchdog flagged a workflow node as diverged.`,
    `Divergence signal (heuristic — confirm it yourself before trusting it): ${ctx.divergence.kind} — ${ctx.divergence.reason}`,
    nodeId ? `Diverged node id: ${nodeId}` : `Diverged node id: (unknown)`,
    ``,
    `ORIGINAL GOAL the run was given:`,
    goal || "(not recorded on the run; infer it from the node's events)",
    ``,
    `The diverged node's events (chronological JSON):`,
    JSON.stringify(nodeEvents, null, 2),
    ``,
    `Follow your procedure and emit ONE self-contained re-grounding prompt for the original agent.`,
  ].join("\n");

  // BACKGROUND_RESCUE.model is statically optional on AgentFile but is always set
  // on this persona (openrouter/x-ai/grok-4.20); fall back defensively.
  const rescueModel = BACKGROUND_RESCUE.model ?? "openrouter/x-ai/grok-4.20";
  const reply = await chat(
    rescueModel,
    [
      { role: "system", content: BACKGROUND_RESCUE.systemPrompt },
      { role: "user", content: userMessage },
    ],
    ctx.signal,
  );
  return reply.text.trim();
}

/**
 * Default restart: act on the synthesized prompt using the only seams Archon
 * actually offers.
 *   - paused at a gate  -> rejectRun(reason) feeds the prompt into the on_reject
 *                          retry ($REJECTION_REASON) without losing the run.
 *   - otherwise (failed / stuck node) -> runWorkflow({ message }) starts a NEW run
 *                          with the synthesized prompt as the user_message, because
 *                          resume cannot inject a new prompt (it replays the old one).
 */
async function defaultRestart(ctx: RestartContext): Promise<unknown> {
  if (isPausedAtGate(ctx.snapshot)) {
    return rejectRun(ctx.runId, ctx.synthesizedPrompt);
  }
  if (!ctx.workflowName) {
    // No workflow name and not at a gate: we cannot start a new run nor feed a
    // gate. Surface this rather than silently no-op — the caller must thread the
    // workflow name for the new-run seam.
    throw new Error(
      `rescue restart needs a workflowName to start a new run for run ${ctx.runId} (run is not paused at a gate)`,
    );
  }
  return runWorkflow(ctx.workflowName, { message: ctx.synthesizedPrompt });
}

/**
 * Poll a run, detect divergence, and on a non-null signal run rescue() then
 * restart(). Logs the rescue lifecycle to the runs-index and emits SSE-tagged
 * lifecycle events. Returns once it rescues, the run goes terminal, the signal
 * aborts, or maxPolls is hit.
 *
 * Edge cases handled:
 *  - getRun transient failure: a single failed poll is logged via onEvent('error')
 *    and the loop continues to the next tick (Archon on SQLite is flaky; one bad
 *    read shouldn't abort the watch). An ABORT during getRun ends the loop.
 *  - run already terminal on the first poll: returns immediately, no rescue.
 *  - hallucination/rot are advisory: they still trigger the rescue AGENT (which
 *    confirms), never a blind restart — the restart only runs after the agent
 *    returns a non-empty prompt.
 */
export async function watchRun(args: WatchRunArgs): Promise<WatchRunResult> {
  const {
    runId,
    projectId,
    workflowName,
    getRun: getRunFn = getRun,
    rescue = defaultRescue,
    restart = defaultRestart,
    pollMs = 15_000,
    stallMs = 180_000,
    maxRepeats = 4,
    now = Date.now,
    signal,
    onEvent,
    sleep = defaultSleep,
    maxPolls = 10_000,
  } = args;

  const emit = (event: RescueEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // A throwing callback must not break the watch loop.
    }
  };

  let polls = 0;
  while (polls < maxPolls) {
    if (signal?.aborted) return { rescued: false, stoppedReason: "aborted", polls };
    polls += 1;

    let snapshot: RunSnapshot;
    try {
      snapshot = normalizeSnapshot(await getRunFn(runId));
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === "AbortError") {
        return { rescued: false, stoppedReason: "aborted", polls };
      }
      emit({ tag: "error", runId, error: `getRun failed: ${(err as Error).message}` });
      // Back off one poll period and retry — a single flaky read is not fatal.
      try {
        await sleep(pollMs, signal);
      } catch {
        return { rescued: false, stoppedReason: "aborted", polls };
      }
      continue;
    }

    if (isTerminalStatus(snapshot)) {
      return { rescued: false, stoppedReason: "terminal", polls };
    }

    const divergence = detectDivergence(snapshot.events ?? [], { stallMs, maxRepeats, now });
    if (divergence.kind) {
      return runRescue({ runId, projectId, workflowName, divergence, snapshot, rescue, restart, signal, emit, polls });
    }

    try {
      await sleep(pollMs, signal);
    } catch {
      return { rescued: false, stoppedReason: "aborted", polls };
    }
  }
  return { rescued: false, stoppedReason: "max-polls", polls };
}

/**
 * Run the rescue lifecycle for one detected divergence: log a 'worker' run row,
 * call rescue() to synthesize a re-grounding prompt, call restart() to act on it,
 * and finish the run row with the outcome. Factored out of watchRun so the loop
 * body stays readable.
 */
async function runRescue(p: {
  runId: string;
  projectId: string;
  workflowName?: string;
  divergence: Divergence;
  snapshot: RunSnapshot;
  rescue: (ctx: RescueContext) => Promise<string>;
  restart: (ctx: RestartContext) => Promise<unknown>;
  signal?: AbortSignal;
  emit: (event: RescueEvent) => void;
  polls: number;
}): Promise<WatchRunResult> {
  const { runId, projectId, workflowName, divergence, snapshot, rescue, restart, signal, emit, polls } = p;

  emit({ tag: "rescue_detected", runId, divergence });

  // Log the rescue as its own run row so the console shows the intervention. The
  // sessionId is derived from the rescued run so the rows cluster together.
  const sessionId = `rescue-${runId}`;
  const indexRunId = startRun(projectId, {
    sessionId,
    loopId: null,
    iteration: 0,
    task: `background-rescue: ${divergence.kind} on node ${divergence.nodeId ?? "?"} of run ${runId}`,
    role: "worker",
    model: BACKGROUND_RESCUE.model,
  });

  try {
    emit({ tag: "synthesizing", runId, divergence });
    const rescueCtx: RescueContext = { runId, projectId, divergence, snapshot, signal };
    const synthesizedPrompt = await rescue(rescueCtx);

    // An empty prompt means the rescue agent could NOT confirm the divergence
    // (this is the guardrail for the advisory hallucination/rot signals): do not
    // restart on an unconfirmed signal.
    if (!synthesizedPrompt || synthesizedPrompt.trim().length === 0) {
      finishRun(projectId, sessionId, indexRunId, {
        status: "completed",
        output: `rescue agent returned no re-grounding prompt — divergence (${divergence.kind}) not confirmed; no restart`,
      });
      emit({ tag: "done", runId, divergence });
      return { rescued: false, divergence, stoppedReason: "rescued", polls };
    }

    emit({ tag: "restart", runId, divergence, synthesizedPrompt });
    const restartResult = await restart({ ...rescueCtx, workflowName, synthesizedPrompt });

    finishRun(projectId, sessionId, indexRunId, {
      status: "completed",
      output: synthesizedPrompt,
    });
    emit({ tag: "done", runId, divergence, synthesizedPrompt, restartResult });
    return { rescued: true, divergence, synthesizedPrompt, restartResult, stoppedReason: "rescued", polls };
  } catch (err) {
    finishRun(projectId, sessionId, indexRunId, {
      status: "failed",
      output: `rescue failed: ${(err as Error).message}`,
    });
    emit({ tag: "error", runId, divergence, error: (err as Error).message });
    return { rescued: false, divergence, stoppedReason: "rescued", polls };
  }
}
