// danbot-byok — web/src/lib/console-live-sources.ts
//
// Discovery + transport for the Console's live-graph surface: "whichever
// projects or chats someone has open in running should display here with their
// respective graphs".
//
// Four discovery inputs are merged into one ordered work list:
//   (a) typed DAG workflow runs that are queued or running (GET /dag-workflow-runs)
//   (b) sessions in OTHER projects that have activity — the project set comes
//       from GET /projects/activity (one request, already project-wide) and
//       only projects it reports as busy are swept, bounded to
//       MAX_SWEPT_PROJECTS and cached for PROJECT_SWEEP_CACHE_MS. "Busy" means
//       running or needing input RIGHT NOW: the summary's `errors` and
//       `blocked` counts are historical/budget state (a chat that failed days
//       ago, or a project merely over its spend limit) and would pin a dead
//       project to a sweep slot forever.
//   (c) sessions this browser has open in chat tabs, read from the persisted
//       workspace snapshot (kady:workspace:v1), even when idle
//   (d) sessions touched in the last 30 minutes (GET /sessions `modified`)
//
// Transport is POLLING ONLY — the codebase has no SSE for this data and the
// plan of record forbids adding any. Everything sits behind small pure helpers
// so the cadence rules (interval by role, ×2 backoff, visibility pause,
// 8-poller cap) are unit-tested without a browser.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listDagWorkflowRuns,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
} from "@/lib/dag-workflows";
import type { ProjectActivitySummary } from "@/lib/project-activity";
import { apiFetch, listProjectActivities, listProjects } from "@/lib/projects";
import {
  emptySessionGraph,
  projectSessionGraph,
  type SessionFrame,
  type SessionGraphProjection,
  type SessionRunStatus,
  type SessionWorkflowRunLink,
} from "@/lib/session-dag-projection";
import {
  parseWorkspaceMetadata,
  WORKSPACE_STORAGE_KEY,
} from "@/lib/workspace-persistence";

// --- cadence constants (W4.4) ---------------------------------------------

/** Discovery (list) poll. */
export const LIST_POLL_MS = 3_000;
/** Selected source, actively running. */
export const SELECTED_RUNNING_POLL_MS = 1_000;
/** Selected source, idle. */
export const SELECTED_IDLE_POLL_MS = 5_000;
/** Unselected but inside the concurrency cap, running. */
export const ACTIVE_RUNNING_POLL_MS = 1_500;
/** Unselected but inside the concurrency cap, idle. */
export const ACTIVE_IDLE_POLL_MS = 10_000;
/** Outside the concurrency cap. */
export const BACKGROUND_POLL_MS = 10_000;
/** Backoff ceiling after repeated errors. */
export const MAX_BACKOFF_MS = 15_000;
/** Consecutive errors tolerated before the ×2 backoff engages. */
export const ERROR_BACKOFF_THRESHOLD = 3;
/** Max session detail pollers running at the fast cadence. */
export const MAX_CONCURRENT_SESSION_POLLERS = 8;
/** "Recently active" window for discovery input (d). */
export const RECENT_ACTIVITY_WINDOW_MS = 30 * 60 * 1_000;
/** Projects swept for cross-project sessions in one discovery tick. */
export const MAX_SWEPT_PROJECTS = 20;
/** How long a per-project session list is reused before refetching. */
export const PROJECT_SWEEP_CACHE_MS = 5_000;
/** How long the project roster itself is reused. */
export const PROJECT_ROSTER_CACHE_MS = 60_000;
/** Ring buffer applied to a session's retained frames before folding. */
export const SOURCE_FRAME_RING = 500;
/** How often the selected session re-reads its typed workflow-run link. */
export const SESSION_WORKFLOW_LINK_POLL_MS = 5_000;

// --- source model ----------------------------------------------------------

export type LiveSourceKind = "dag-run" | "session";

/** Why a source is in the list; a source can have more than one reason. */
export type LiveSourceOrigin = "dag-run" | "open-tab" | "recent" | "active-run";

export type LiveSourceStatus =
  /** Never probed. NOT a claim: the rail must not say "idle" about a chat it never asked about. */
  | "unknown"
  | "queued"
  | "running"
  | "idle"
  | "ok"
  | "error"
  | "cancelled";

/**
 * How much a status claims, so a merge of two discovery inputs keeps the
 * strongest one. `unknown` is weakest by construction: it is the absence of an
 * observation, and any real observation must win over it.
 */
const STATUS_STRENGTH: Record<LiveSourceStatus, number> = {
  unknown: 0,
  idle: 1,
  queued: 2,
  ok: 2,
  error: 2,
  cancelled: 2,
  running: 3,
};

export interface LiveSource {
  /** `${kind}:${projectId}:${id}` — stable across polls and projects. */
  key: string;
  kind: LiveSourceKind;
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: LiveSourceStatus;
  /** Rendered as the "live" badge in the rail. */
  live: boolean;
  lastActivityAt: number;
  origins: LiveSourceOrigin[];
  /**
   * The owning project's live counts from GET /projects/activity, when the
   * sweep saw them. Discovery already knows which projects are working; the
   * rail needs it to rank rows and to explain why a project is being polled.
   */
  projectActivity: LiveProjectActivity | null;
}

/**
 * The live half of a project's activity summary. Deliberately narrower than
 * `ProjectActivitySummary`: those are the only two counts that describe work
 * happening NOW (see `isProjectBusy`).
 */
export interface LiveProjectActivity {
  running: number;
  needsInput: number;
}

/**
 * Busy RIGHT NOW. `errors` and `blocked` are deliberately excluded: the server
 * reconstructs `errors` from the newest persisted transcript's outcome
 * (a project that failed a chat days ago stays "errored"), and forces
 * `blocked >= 1` for any project over its spend limit.
 */
export function isProjectBusy(
  activity: LiveProjectActivity | undefined | null,
): boolean {
  if (!activity) return false;
  return activity.running > 0 || activity.needsInput > 0;
}

function projectActivityOf(
  activity: ProjectActivitySummary | undefined | null,
): LiveProjectActivity | null {
  return activity
    ? { running: activity.running, needsInput: activity.needsInput }
    : null;
}

export function liveSourceKey(
  kind: LiveSourceKind,
  projectId: string,
  id: string,
): string {
  return `${kind}:${projectId}:${id}`;
}

const LIVE_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "waiting",
  "blocked",
  "paused",
]);

function runStatusToSourceStatus(status: WorkflowRunStatus): LiveSourceStatus {
  if (status === "queued") return "queued";
  if (status === "succeeded") return "ok";
  if (status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  if (LIVE_RUN_STATUSES.has(status)) return "running";
  return "idle";
}

/**
 * Wire timestamps arrive as epoch milliseconds from the mocked tier and as ISO
 * strings from Fastify's Date serialization; accept both rather than guessing.
 */
export function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** One row of GET /sessions, as loosely as the wire actually delivers it. */
export interface SessionListRow {
  id: string;
  name?: string | null;
  created?: unknown;
  modified?: unknown;
  messageCount?: number;
  firstMessage?: string | null;
}

export function sessionTitle(row: SessionListRow): string {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name) return name;
  const first = typeof row.firstMessage === "string" ? row.firstMessage.trim() : "";
  if (first) return first.split("\n", 1)[0].slice(0, 80);
  return row.id;
}

export function isRecentlyActive(
  lastActivityAt: number,
  now: number,
  windowMs = RECENT_ACTIVITY_WINDOW_MS,
): boolean {
  return lastActivityAt > 0 && now - lastActivityAt <= windowMs;
}

// --- (a) DAG runs ----------------------------------------------------------

export function dagRunSources(
  runs: readonly WorkflowRunSummary[],
  projectId: string,
  projectName: string,
): LiveSource[] {
  return runs
    .filter((run) => LIVE_RUN_STATUSES.has(run.status))
    .map((run) => ({
      key: liveSourceKey("dag-run", projectId, run.id),
      kind: "dag-run" as const,
      id: run.id,
      projectId,
      projectName,
      title: run.workflowId,
      status: runStatusToSourceStatus(run.status),
      live: run.status === "running",
      lastActivityAt: run.startedAt ?? run.createdAt,
      origins: ["dag-run" as LiveSourceOrigin],
      projectActivity: null,
    }));
}

// --- (c)/(d) session sources ----------------------------------------------

export function sessionSources(
  rows: readonly SessionListRow[],
  projectId: string,
  projectName: string,
  now: number,
  projectActivity: ProjectActivitySummary | null = null,
): LiveSource[] {
  const sources: LiveSource[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    const lastActivityAt = toEpochMs(row.modified) || toEpochMs(row.created);
    if (!isRecentlyActive(lastActivityAt, now)) continue;
    sources.push({
      key: liveSourceKey("session", projectId, row.id),
      kind: "session",
      id: row.id,
      projectId,
      projectName,
      title: sessionTitle(row),
      // Discovery only knows this chat EXISTS and when it was last touched.
      // Whether it is running right now lives on GET /sessions/:id/run/state,
      // which only the ranked-in sessions are probed for, so a row starts out
      // saying nothing rather than claiming to be idle.
      status: "unknown",
      live: false,
      lastActivityAt,
      origins: isProjectBusy(projectActivity) ? ["recent", "active-run"] : ["recent"],
      projectActivity: projectActivityOf(projectActivity),
    });
  }
  return sources;
}

export interface OpenChatTab {
  projectId: string;
  sessionId: string;
  title: string;
}

/** Chat tabs this browser has open, from the persisted workspace snapshot. */
export function openChatTabsFromStorage(serialized: string | null): OpenChatTab[] {
  const metadata = parseWorkspaceMetadata(serialized);
  const tabs: OpenChatTab[] = [];
  for (const [projectId, project] of Object.entries(metadata.projects)) {
    for (const tab of project.tabs) {
      if (!tab.sessionId) continue;
      tabs.push({ projectId, sessionId: tab.sessionId, title: tab.title });
    }
  }
  return tabs;
}

export function openTabSources(
  tabs: readonly OpenChatTab[],
  projectNames: ReadonlyMap<string, string>,
  now: number,
  activities: Readonly<Record<string, ProjectActivitySummary>> = {},
): LiveSource[] {
  return tabs.map((tab) => ({
    key: liveSourceKey("session", tab.projectId, tab.sessionId),
    kind: "session" as const,
    id: tab.sessionId,
    projectId: tab.projectId,
    projectName: projectNames.get(tab.projectId) ?? tab.projectId,
    title: tab.title || tab.sessionId,
    // Same as `sessionSources`: an open tab is a reason to LIST the chat, not
    // an observation of whether it is running.
    status: "unknown" as LiveSourceStatus,
    live: false,
    // An open tab is "here now" even when its transcript is old, so it sorts
    // with the freshest work rather than falling off the 30-minute window.
    lastActivityAt: now,
    origins: isProjectBusy(activities[tab.projectId])
      ? (["open-tab", "active-run"] as LiveSourceOrigin[])
      : (["open-tab"] as LiveSourceOrigin[]),
    projectActivity: projectActivityOf(activities[tab.projectId]),
  }));
}

// --- merge -----------------------------------------------------------------

const ORIGIN_ORDER: LiveSourceOrigin[] = ["dag-run", "active-run", "open-tab", "recent"];

/**
 * Union the discovery inputs. Later groups only enrich earlier ones (origins
 * merge, the freshest activity wins, a real title beats an id) so the caller
 * can pass the groups in whatever order is cheapest.
 */
export function mergeLiveSources(groups: readonly (readonly LiveSource[])[]): LiveSource[] {
  const merged = new Map<string, LiveSource>();
  for (const group of groups) {
    for (const source of group) {
      const existing = merged.get(source.key);
      if (!existing) {
        merged.set(source.key, { ...source, origins: [...source.origins] });
        continue;
      }
      for (const origin of source.origins) {
        if (!existing.origins.includes(origin)) existing.origins.push(origin);
      }
      existing.lastActivityAt = Math.max(existing.lastActivityAt, source.lastActivityAt);
      existing.live = existing.live || source.live;
      if (existing.title === existing.id && source.title !== source.id) {
        existing.title = source.title;
      }
      if (STATUS_STRENGTH[source.status] > STATUS_STRENGTH[existing.status]) {
        existing.status = source.status;
      }
      if (existing.projectName === existing.projectId) {
        existing.projectName = source.projectName;
      }
      if (existing.projectActivity === null && source.projectActivity !== null) {
        existing.projectActivity = source.projectActivity;
      }
    }
  }
  for (const source of merged.values()) {
    source.origins.sort(
      (left, right) => ORIGIN_ORDER.indexOf(left) - ORIGIN_ORDER.indexOf(right),
    );
  }
  return [...merged.values()].sort(compareLiveSources);
}

/**
 * Rail order: live work first, then work whose project reports activity, then
 * by recency. Exported so a later status upgrade (a run-state probe promoting a
 * session to `running`) re-orders exactly the way discovery did.
 */
export function compareLiveSources(left: LiveSource, right: LiveSource): number {
  return (
    Number(right.live) - Number(left.live) ||
    Number(isProjectBusy(right.projectActivity)) -
      Number(isProjectBusy(left.projectActivity)) ||
    right.lastActivityAt - left.lastActivityAt ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
}

export function filterLiveSources(sources: readonly LiveSource[], query: string): LiveSource[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sources];
  return sources.filter((source) =>
    source.title.toLowerCase().includes(needle) ||
    source.id.toLowerCase().includes(needle) ||
    source.projectName.toLowerCase().includes(needle),
  );
}

/**
 * Empty state that names the reason, never a bare spinner. It is a statement
 * about what discovery LOOKED AT — both arms, and the exact session predicate —
 * rather than a claim that the machine is idle. A chat tab whose session has no
 * saved transcript yet is invisible to `GET /sessions`, so the copy says so.
 */
export function describeEmptyState(projectFilter: string | null): string {
  const scope = projectFilter === null ? "" : ` in ${projectFilter}`;
  return `Nothing is running${scope}: no queued or running DAG workflow runs, and no chat session with a saved transcript open or active in the last 30 minutes.`;
}

/**
 * A `?run=`/`?session=` deep link discovery cannot see. Silence here read as
 * "nothing is running" even when the URL named a real, just-finished run.
 */
export function describeUnresolvedDeepLink(link: LiveDeepLink | null): string | null {
  if (!link) return null;
  return link.kind === "dag-run"
    ? `Run ${link.id} is not live work — it has finished, or it was never queued. Open it in the run console below.`
    : `Session ${link.id} is not live work — it has no saved transcript, or no activity in the last 30 minutes.`;
}

/**
 * Chips above the rail: what discovery could NOT do this tick. Silent
 * truncation and silently-dropped projects both read as "we looked everywhere".
 */
export function discoveryNotices(input: {
  failedProjectIds: readonly string[];
  busyProjectCount: number;
  sweptBusyProjectCount: number;
  activitySweepFailed: boolean;
}): string[] {
  const notices: string[] = [];
  if (input.failedProjectIds.length > 0) {
    notices.push(
      `couldn't read ${input.failedProjectIds.length} project` +
        `${input.failedProjectIds.length === 1 ? "" : "s"}`,
    );
  }
  if (input.busyProjectCount > input.sweptBusyProjectCount) {
    notices.push(
      `showing ${input.sweptBusyProjectCount} of ${input.busyProjectCount} busy projects`,
    );
  }
  if (input.activitySweepFailed) notices.push("cross-project sweep unavailable");
  return notices;
}

// --- cadence ---------------------------------------------------------------

export interface PollDecisionInput {
  selected: boolean;
  running: boolean;
  /** Position among session pollers, 0-based; the selected source is always 0. */
  rank: number;
  consecutiveErrors: number;
  documentHidden: boolean;
}

/**
 * Delay before the next detail poll, or null when polling is paused. Paused
 * means `document.hidden` — the console resumes on focus rather than burning
 * requests behind a background tab.
 */
export function nextPollDelayMs(input: PollDecisionInput): number | null {
  if (input.documentHidden) return null;
  const base = input.selected
    ? (input.running ? SELECTED_RUNNING_POLL_MS : SELECTED_IDLE_POLL_MS)
    : input.rank < MAX_CONCURRENT_SESSION_POLLERS
      ? (input.running ? ACTIVE_RUNNING_POLL_MS : ACTIVE_IDLE_POLL_MS)
      : BACKGROUND_POLL_MS;
  if (input.consecutiveErrors < ERROR_BACKOFF_THRESHOLD) return base;
  const doublings = input.consecutiveErrors - ERROR_BACKOFF_THRESHOLD + 1;
  return Math.min(base * 2 ** doublings, MAX_BACKOFF_MS);
}

/**
 * Poller order: the selected source first, then live work, then the rest by
 * recency. Only the first MAX_CONCURRENT_SESSION_POLLERS get the fast cadence.
 */
export function assignPollRanks(
  sources: readonly LiveSource[],
  selectedKey: string | null,
): Map<string, number> {
  const sessions = sources.filter((source) => source.kind === "session");
  const ordered = [...sessions].sort((left, right) => {
    const leftSelected = left.key === selectedKey ? 0 : 1;
    const rightSelected = right.key === selectedKey ? 0 : 1;
    return leftSelected - rightSelected || compareLiveSources(left, right);
  });
  return new Map(ordered.map((source, index) => [source.key, index]));
}

/** Append-only merge of a session's retained frames, bounded by the ring. */
export function appendFrames(
  previous: readonly SessionFrame[],
  incoming: readonly SessionFrame[],
  limit = SOURCE_FRAME_RING,
): SessionFrame[] {
  const bySeq = new Map<number, SessionFrame>();
  for (const frame of previous) bySeq.set(frame.seq, frame);
  for (const frame of incoming) {
    if (Number.isSafeInteger(frame.seq)) bySeq.set(frame.seq, frame);
  }
  const ordered = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  return ordered.length > limit ? ordered.slice(ordered.length - limit) : ordered;
}

// --- deep links ------------------------------------------------------------

export interface LiveDeepLink {
  kind: LiveSourceKind;
  id: string;
}

/** `?run=<id>` / `?session=<id>`; `run` wins when both are present. */
export function parseDeepLink(search: string): LiveDeepLink | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const run = params.get("run");
  if (run) return { kind: "dag-run", id: run };
  const session = params.get("session");
  if (session) return { kind: "session", id: session };
  return null;
}

/** The query string a selection should leave in the address bar. */
export function deepLinkSearch(search: string, source: LiveSource | null): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete("run");
  params.delete("session");
  if (source) params.set(source.kind === "dag-run" ? "run" : "session", source.id);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function matchDeepLink(
  sources: readonly LiveSource[],
  link: LiveDeepLink | null,
): LiveSource | null {
  if (!link) return null;
  return sources.find((source) => source.kind === link.kind && source.id === link.id) ?? null;
}

// --- run-state transport ---------------------------------------------------

export interface SessionRunSnapshot {
  status: SessionRunStatus;
  runId: string | null;
  frames: SessionFrame[];
  lastSeq: number;
}

/** Fail-closed read of GET /sessions/:id/run/state (see run-broker's RunState). */
export function parseSessionRunSnapshot(body: unknown): SessionRunSnapshot {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = record.status === "running" || record.status === "complete"
    ? record.status
    : "none";
  const run = record.run && typeof record.run === "object"
    ? (record.run as Record<string, unknown>)
    : null;
  const rawFrames = Array.isArray(run?.frames) ? run.frames : [];
  const frames: SessionFrame[] = [];
  for (const candidate of rawFrames) {
    if (!candidate || typeof candidate !== "object") continue;
    const frame = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(frame.seq) || typeof frame.type !== "string") continue;
    frames.push(frame as unknown as SessionFrame);
  }
  const lastSeq = Number.isSafeInteger(run?.lastSeq)
    ? Number(run?.lastSeq)
    : frames.at(-1)?.seq ?? 0;
  return {
    status,
    runId: typeof run?.runId === "string" ? run.runId : null,
    frames,
    lastSeq,
  };
}

export async function fetchSessionRunSnapshot(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionRunSnapshot> {
  const response = await apiFetch(
    `/sessions/${encodeURIComponent(sessionId)}/run/state`,
    signal ? { signal } : {},
    projectId,
  );
  if (!response.ok) throw new Error(`run state failed: ${response.status}`);
  return parseSessionRunSnapshot(await response.json());
}

/**
 * The typed workflow run a chat session delegated to, from
 * GET /sessions/:id/workflow-run-state. Only the three fields the projection's
 * `dag` node needs are read; the full RunState v1 projection belongs to
 * chat-live-graph.tsx, which renders it properly.
 */
export function parseSessionWorkflowRunLink(body: unknown): SessionWorkflowRunLink | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const state = record.state && typeof record.state === "object"
    ? (record.state as Record<string, unknown>)
    : null;
  if (!state) return null;
  const runId = typeof state.runId === "string" ? state.runId : "";
  const workflowId = typeof state.workflowId === "string" ? state.workflowId : "";
  const status = typeof state.status === "string" ? state.status : "";
  if (runId === "" || workflowId === "" || status === "") return null;
  return { runId, workflowId, status };
}

export async function fetchSessionWorkflowRunLink(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionWorkflowRunLink | null> {
  const response = await apiFetch(
    `/sessions/${encodeURIComponent(sessionId)}/workflow-run-state`,
    signal ? { signal } : {},
    projectId,
  );
  if (!response.ok) throw new Error(`workflow run state failed: ${response.status}`);
  return parseSessionWorkflowRunLink(await response.json());
}

async function fetchSessionList(
  projectId: string,
  signal?: AbortSignal,
): Promise<SessionListRow[]> {
  const response = await apiFetch("/sessions", signal ? { signal } : {}, projectId);
  if (!response.ok) throw new Error(`session list failed: ${response.status}`);
  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as SessionListRow[]) : [];
}

// --- discovery hook --------------------------------------------------------

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface OpenWorkState {
  sources: LiveSource[];
  loading: boolean;
  error: string | null;
  /** What discovery could not do this tick, as short rail chips. */
  notices: string[];
  /** Display name of the active project, for scoped empty-state copy. */
  activeProjectName: string;
  /** Rises on every completed discovery tick; useful as a test/render key. */
  tick: number;
}

interface DiscoveryResult {
  sources: LiveSource[];
  notices: string[];
  activeProjectName: string;
}

/**
 * Discovery. One tick reads the DAG run list for the active project, the
 * project-wide activity summary, the session list of every busy project (plus
 * the active one), and the browser's own open chat tabs.
 *
 * Cross-project sweeping (input (b)) uses GET /projects/activity rather than a
 * new server route: it is one request, it already reports which projects have
 * running work, and it keeps this lane's server surface at zero. The trade-off
 * is that the sweep sees a project's sessions only through that project's
 * GET /sessions, so it is bounded (MAX_SWEPT_PROJECTS) and cached
 * (PROJECT_SWEEP_CACHE_MS).
 *
 * Every remote read that concerns ONE project is isolated: a project whose
 * /sessions returns 500 must not discard the projects that answered, and the
 * activity sweep failing must not hide the active project's own work.
 */
export function useOpenWork(options: {
  projectId: string;
  enabled: boolean;
  allProjects: boolean;
  now?: () => number;
}): OpenWorkState {
  const { projectId, enabled, allProjects } = options;
  const nowFn = options.now ?? Date.now;
  const [state, setState] = useState<OpenWorkState>({
    sources: [],
    loading: true,
    error: null,
    notices: [],
    activeProjectName: projectId,
    tick: 0,
  });
  const rosterCache = useRef<CacheEntry<{ id: string; name: string }[]> | null>(null);
  const sessionCache = useRef(new Map<string, CacheEntry<SessionListRow[]>>());
  const errorRun = useRef(0);

  const discover = useCallback(
    async (signal: AbortSignal): Promise<DiscoveryResult> => {
      const now = nowFn();
      if (!rosterCache.current || now - rosterCache.current.at > PROJECT_ROSTER_CACHE_MS) {
        const projects = await listProjects();
        rosterCache.current = {
          at: now,
          value: projects.map((project) => ({ id: project.id, name: project.name })),
        };
      }
      const roster = rosterCache.current.value;
      const projectNames = new Map(roster.map((project) => [project.id, project.name]));
      const activeName = projectNames.get(projectId) ?? projectId;

      const runs = await listDagWorkflowRuns(projectId, 100);
      const groups: LiveSource[][] = [dagRunSources(runs, projectId, activeName)];

      let activities: Record<string, ProjectActivitySummary> = {};
      let activitySweepFailed = false;
      let busyProjectIds: string[] = [];
      if (allProjects) {
        try {
          activities = await listProjectActivities();
          busyProjectIds = roster
            .filter(
              (project) =>
                project.id !== projectId && isProjectBusy(activities[project.id]),
            )
            .map((project) => project.id);
        } catch {
          // The sweep is an enrichment, not the surface: losing it must not
          // lose the active project's own runs and sessions.
          activitySweepFailed = true;
        }
      }

      const sweepIds = [projectId];
      for (const id of busyProjectIds) {
        if (sweepIds.length >= MAX_SWEPT_PROJECTS) break;
        sweepIds.push(id);
      }

      const failedProjectIds: string[] = [];
      for (const sweptId of sweepIds) {
        const cached = sessionCache.current.get(sweptId);
        let rows = cached && now - cached.at <= PROJECT_SWEEP_CACHE_MS ? cached.value : null;
        if (!rows) {
          try {
            rows = await fetchSessionList(sweptId, signal);
            sessionCache.current.set(sweptId, { at: now, value: rows });
          } catch (error) {
            // One project's list failing used to reject the whole tick, so the
            // rail lost every healthy project AND then asserted that nothing
            // was running. Keep the projects that answered and count this one.
            if (signal.aborted) throw error;
            failedProjectIds.push(sweptId);
            continue;
          }
        }
        groups.push(
          sessionSources(
            rows,
            sweptId,
            projectNames.get(sweptId) ?? sweptId,
            now,
            activities[sweptId] ?? null,
          ),
        );
      }

      const tabs = openChatTabsFromStorage(
        typeof window === "undefined"
          ? null
          : window.localStorage.getItem(WORKSPACE_STORAGE_KEY),
      ).filter((tab) => allProjects || tab.projectId === projectId);
      groups.push(openTabSources(tabs, projectNames, now, activities));

      return {
        sources: mergeLiveSources(groups),
        notices: discoveryNotices({
          failedProjectIds,
          busyProjectCount: busyProjectIds.length,
          sweptBusyProjectCount: sweepIds.length - 1,
          activitySweepFailed,
        }),
        activeProjectName: activeName,
      };
    },
    [allProjects, nowFn, projectId],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void tickOnce(), delay);
    };

    const tickOnce = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        schedule(LIST_POLL_MS);
        return;
      }
      try {
        const result = await discover(controller.signal);
        if (cancelled) return;
        errorRun.current = 0;
        setState((previous) => ({
          sources: result.sources,
          loading: false,
          error: null,
          notices: result.notices,
          activeProjectName: result.activeProjectName,
          tick: previous.tick + 1,
        }));
        schedule(LIST_POLL_MS);
      } catch (error) {
        if (cancelled) return;
        errorRun.current += 1;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : "Discovery failed.",
        }));
        schedule(
          nextPollDelayMs({
            selected: false,
            running: false,
            rank: 0,
            consecutiveErrors: errorRun.current,
            documentHidden: false,
          }) ?? LIST_POLL_MS,
        );
      }
    };

    void tickOnce();
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        if (timer) clearTimeout(timer);
        void tickOnce();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [discover, enabled]);

  return state;
}

// --- rail run-state probes -------------------------------------------------

/** What a cheap run-state probe tells the rail about one session. */
export interface SessionRunProbe {
  status: SessionRunStatus;
  runId: string | null;
}

/**
 * Which sessions the rail probes for run state. Discovery can only say a
 * session exists and when it was last touched — the answer to "is this chat
 * running RIGHT NOW" lives on GET /sessions/:id/run/state. The selected source
 * is excluded because `useSessionGraph` already polls it (and reports its
 * status back), so the probes stay inside the poller budget.
 */
export function sessionsToProbe(
  sources: readonly LiveSource[],
  ranks: ReadonlyMap<string, number>,
  selectedKey: string | null,
  cap = MAX_CONCURRENT_SESSION_POLLERS,
): LiveSource[] {
  return sources.filter(
    (source) =>
      source.kind === "session" &&
      source.key !== selectedKey &&
      (ranks.get(source.key) ?? cap) < cap,
  );
}

/**
 * Fold probe results back into the rail's rows. A session the server reports as
 * running is `running` with the live badge and an `active-run` origin, and it
 * re-sorts to the top exactly the way discovery would have ordered it. A
 * session the server answered for and reported NOT running becomes `idle` —
 * that is a real observation. A session with no probe at all stays `unknown`,
 * because the rail never asked: `idle` there is a false statement about the 9th
 * open chat, which is exactly what a reader is looking for.
 */
export function applySessionRunStates(
  sources: readonly LiveSource[],
  probes: ReadonlyMap<string, SessionRunProbe>,
): LiveSource[] {
  const applied = sources.map((source) => {
    if (source.kind !== "session") return source;
    const probe = probes.get(source.key);
    if (!probe) return source;
    if (probe.status !== "running") {
      return { ...source, status: "idle" as LiveSourceStatus, live: false };
    }
    return {
      ...source,
      status: "running" as LiveSourceStatus,
      live: true,
      origins: source.origins.includes("active-run")
        ? source.origins
        : [...source.origins, "active-run" as LiveSourceOrigin],
    };
  });
  return applied.sort(compareLiveSources);
}

/**
 * How many of the rail's chats are actually being watched for run state, and
 * how many exist. The probe budget (MAX_CONCURRENT_SESSION_POLLERS) is a real
 * bound on what the console knows, and round 1's M5 already established that a
 * bound this surface applies must be stated ("showing 19 of 30 busy projects")
 * rather than left silent.
 *
 * The selected session counts as watched: it is excluded from `sessionsToProbe`
 * precisely because `useSessionGraph` polls it directly.
 */
export function sessionProbeCoverage(
  sources: readonly LiveSource[],
  ranks: ReadonlyMap<string, number>,
  selectedKey: string | null,
  cap = MAX_CONCURRENT_SESSION_POLLERS,
): { watched: number; total: number } {
  const sessions = sources.filter((source) => source.kind === "session");
  const watched = sessions.filter(
    (source) => source.key === selectedKey || (ranks.get(source.key) ?? cap) < cap,
  ).length;
  return { watched, total: sessions.length };
}

/**
 * The rail chip for that bound, or null when every chat is watched. Kept beside
 * `discoveryNotices` in wording and shape; it lives apart only because the
 * probe plan is decided after discovery, from the ranks.
 */
export function sessionProbeNotice(
  coverage: { watched: number; total: number },
): string | null {
  if (coverage.total <= coverage.watched) return null;
  return `checking ${coverage.watched} of ${coverage.total} chats for live status`;
}

/**
 * Poll run state for the ranked-in sessions. Each session gets its own poller
 * at the cadence `nextPollDelayMs` assigns to its rank, its own error counter
 * for the ×2 backoff, and the same `document.hidden` pause as everything else.
 */
export function useSessionRunStates(options: {
  sessions: readonly LiveSource[];
  ranks: ReadonlyMap<string, number>;
  enabled: boolean;
}): ReadonlyMap<string, SessionRunProbe> {
  const { enabled, ranks, sessions } = options;
  const [probes, setProbes] = useState<ReadonlyMap<string, SessionRunProbe>>(new Map());
  // Discovery hands over a fresh `sessions` array every 3s tick, so the poll
  // plan is carried as a string: identical work produces an identical string
  // and the pollers are left alone, while a genuine change (a session appears,
  // a rank moves) restarts exactly the affected effect.
  const planJson = useMemo(
    () =>
      JSON.stringify(
        sessions.map((source) => ({
          key: source.key,
          projectId: source.projectId,
          id: source.id,
          rank: ranks.get(source.key) ?? MAX_CONCURRENT_SESSION_POLLERS,
        })),
      ),
    [ranks, sessions],
  );

  useEffect(() => {
    const plan = JSON.parse(planJson) as Array<{
      key: string;
      projectId: string;
      id: string;
      rank: number;
    }>;
    if (!enabled || plan.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const stops: Array<() => void> = [];

    for (const target of plan) {
      const rank = target.rank;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let consecutiveErrors = 0;
      let running = false;

      const schedule = () => {
        if (cancelled) return;
        const delay = nextPollDelayMs({
          selected: false,
          running,
          rank,
          consecutiveErrors,
          documentHidden: typeof document !== "undefined" && document.hidden,
        });
        timer = setTimeout(() => void probeOnce(), delay ?? BACKGROUND_POLL_MS);
      };

      const probeOnce = async () => {
        if (cancelled) return;
        if (typeof document !== "undefined" && document.hidden) {
          schedule();
          return;
        }
        try {
          const snapshot = await fetchSessionRunSnapshot(
            target.projectId,
            target.id,
            controller.signal,
          );
          if (cancelled) return;
          consecutiveErrors = 0;
          running = snapshot.status === "running";
          setProbes((previous) => {
            const existing = previous.get(target.key);
            if (
              existing &&
              existing.status === snapshot.status &&
              existing.runId === snapshot.runId
            ) {
              return previous;
            }
            const next = new Map(previous);
            next.set(target.key, { status: snapshot.status, runId: snapshot.runId });
            return next;
          });
        } catch {
          if (cancelled) return;
          consecutiveErrors += 1;
        }
        schedule();
      };

      void probeOnce();
      stops.push(() => {
        if (timer) clearTimeout(timer);
      });
    }

    return () => {
      cancelled = true;
      controller.abort();
      for (const stop of stops) stop();
    };
  }, [enabled, planJson]);

  return probes;
}

// --- session detail hook ---------------------------------------------------

export interface SessionGraphState {
  projection: SessionGraphProjection;
  /**
   * The retained frames the projection was folded from. The drawer lists these
   * — the session's real events — rather than restating projected nodes.
   */
  frames: SessionFrame[];
  runStatus: SessionRunStatus;
  /**
   * True once a run-state read for THIS session has actually succeeded. Until
   * then `runStatus` is the initial `"none"`, which the rail must not publish
   * as `idle` — same rule as an unprobed row.
   */
  observed: boolean;
  error: string | null;
  loading: boolean;
}

/**
 * Poll one session's retained run frames and fold them into a graph. The whole
 * retained buffer is re-read each tick and the fold discards sequences it has
 * already seen, which is the append-only cursor behaviour without a
 * server-side cursor (GET /sessions/:id/run/events is an SSE stream, not a
 * pollable page).
 *
 * The session's typed workflow-run link (GET /sessions/:id/workflow-run-state)
 * is read on a slower fixed cadence and passed into the fold, which is what
 * puts the `dag` node in the graph for a chat that delegated to a pipeline.
 */
export function useSessionGraph(options: {
  projectId: string;
  sessionId: string | null;
  selected: boolean;
  rank: number;
  enabled: boolean;
}): SessionGraphState {
  const { enabled, projectId, rank, selected, sessionId } = options;
  const [state, setState] = useState<SessionGraphState>(() => ({
    projection: emptySessionGraph(sessionId ?? ""),
    frames: [],
    runStatus: "none",
    observed: false,
    error: null,
    loading: true,
  }));
  const framesRef = useRef<SessionFrame[]>([]);
  const projectionRef = useRef<SessionGraphProjection>(emptySessionGraph(sessionId ?? ""));

  useEffect(() => {
    framesRef.current = [];
    projectionRef.current = emptySessionGraph(sessionId ?? "");
    setState({
      projection: projectionRef.current,
      frames: [],
      runStatus: "none",
      observed: false,
      error: null,
      loading: Boolean(sessionId),
    });
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;
    let running = false;
    let workflowRun: SessionWorkflowRunLink | null = null;
    let workflowRunReadAt = 0;
    const controller = new AbortController();

    const schedule = () => {
      if (cancelled) return;
      const delay = nextPollDelayMs({
        selected,
        running,
        rank,
        consecutiveErrors,
        documentHidden: typeof document !== "undefined" && document.hidden,
      });
      // Paused (hidden tab): re-check at the slow cadence rather than dropping
      // the poller, so focus returns to a warm graph.
      timer = setTimeout(() => void tickOnce(), delay ?? BACKGROUND_POLL_MS);
    };

    const readWorkflowLink = async () => {
      const now = Date.now();
      if (workflowRunReadAt !== 0 && now - workflowRunReadAt < SESSION_WORKFLOW_LINK_POLL_MS) {
        return;
      }
      workflowRunReadAt = now;
      try {
        workflowRun = await fetchSessionWorkflowRunLink(
          projectId,
          sessionId,
          controller.signal,
        );
      } catch {
        // A session with no delegated run answers `{state:null}`; a failure
        // here must not blank the graph the frames already produced.
      }
    };

    const tickOnce = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      try {
        const snapshot = await fetchSessionRunSnapshot(projectId, sessionId, controller.signal);
        if (cancelled) return;
        await readWorkflowLink();
        if (cancelled) return;
        consecutiveErrors = 0;
        running = snapshot.status === "running";
        framesRef.current = appendFrames(framesRef.current, snapshot.frames);
        projectionRef.current = projectSessionGraph(
          projectionRef.current,
          framesRef.current,
          { runStatus: snapshot.status, workflowRun },
        );
        setState({
          projection: projectionRef.current,
          frames: framesRef.current,
          runStatus: snapshot.status,
          observed: true,
          error: null,
          loading: false,
        });
      } catch (error) {
        if (cancelled) return;
        consecutiveErrors += 1;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : "Run state failed.",
        }));
      }
      schedule();
    };

    void tickOnce();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, projectId, rank, selected, sessionId]);

  return state;
}

/** Stable rail sections: DAG runs first, then sessions. */
export function railSections(sources: readonly LiveSource[]): {
  runs: LiveSource[];
  sessions: LiveSource[];
} {
  return {
    runs: sources.filter((source) => source.kind === "dag-run"),
    sessions: sources.filter((source) => source.kind === "session"),
  };
}

export function formatElapsed(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "—";
  const seconds = Math.floor(deltaMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
