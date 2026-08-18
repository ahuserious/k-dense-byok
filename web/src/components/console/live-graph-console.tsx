// danbot-byok — web/src/components/console/live-graph-console.tsx
//
// The Console's live-graph surface: "console should be able to view running DAG
// workflows visually, whichever projects or chats someone has open in running
// should display here with their respective graphs, even if not a DAG
// initially, the LLM's logs should be able to turn into a DAG here & be viewed
// live."
//
// The surface:
//   left rail   — every DAG run and chat session this browser can see running
//   main        — a chat session's LLM logs folded into a live graph
//                 (lib/session-dag-projection.ts), or the typed run console
//                 when nothing is selected
//   right drawer— the ordered events behind the selected node, plus the
//                 requested-vs-resolved model receipts they carry
//
// Round 3 adds the VERB. "Turn into a DAG" on a session graph opens
// live-promote-dialog.tsx, which previews the typed document that
// lib/session-dag-projection-promote.ts derives and, only when the reader says
// so, creates it through PUT /dag-workflows/:id. Nothing about the session or
// its run is mutated by promoting it.
//
// The DAG-run *graph* still needs the executed-document snapshot from
// GET /dag-workflow-runs/:id, which is server data this lane cannot fabricate
// (a run of a since-edited workflow would render the wrong topology). Selecting
// a run therefore says so, in words, instead of showing a spinner or a guess.

"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { GitBranchIcon } from "lucide-react";

import {
  LiveEventDrawer,
  type LiveDrawerEvent,
} from "@/components/console/live-event-drawer";
import { LivePromoteDialog } from "@/components/console/live-promote-dialog";
import { LiveSourceRail } from "@/components/console/live-source-rail";
import {
  applySessionRunStates,
  assignPollRanks,
  deepLinkSearch,
  describeEmptyState,
  describeUnresolvedDeepLink,
  filterLiveSources,
  liveSourceKey,
  matchDeepLink,
  nextPollDelayMs,
  parseDeepLink,
  sessionProbeCoverage,
  sessionProbeNotice,
  sessionsToProbe,
  useOpenWork,
  useSessionGraph,
  useSessionRunStates,
  type LiveSource,
  type LiveSourceStatus,
  type SessionRunProbe,
} from "@/lib/console-live-sources";
import { pageDagWorkflowRunEvents, type WorkflowRunEvent } from "@/lib/dag-workflows";
import { getActiveProjectId } from "@/lib/projects";
import {
  childrenOf,
  describeSessionFrame,
  framesForNode,
  projectionNotices,
  sessionRootId,
  type SessionFrame,
  type SessionGraphNode,
  type SessionGraphNodeStatus,
  type SessionGraphProjection,
  type SessionRunStatus,
} from "@/lib/session-dag-projection";
import { cn } from "@/lib/utils";

const DEFAULT_DRAWER_WIDTH = 340;

// Both themes are painted explicitly: the light theme needs dark ink on these
// translucent fills, and the dark theme needs light ink on the same fills.
const NODE_STATUS_STYLE: Record<SessionGraphNodeStatus, string> = {
  pending: "border-border/70 bg-muted/40 text-foreground",
  running: "border-cyan-500/50 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
  ok: "border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
  cancelled: "border-border/70 bg-muted/40 text-muted-foreground",
};

const NODE_KIND_LABEL: Record<SessionGraphNode["kind"], string> = {
  session: "session",
  turn: "turn",
  tool: "tool",
  subagent: "subagent",
  dag: "dag run",
  group: "grouped",
  event: "event",
};

function GraphNodeCard({
  node,
  selected,
  onSelect,
}: {
  node: SessionGraphNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-node-status={node.status}
      className={cn(
        "w-full rounded-md border px-2.5 py-1.5 text-left transition-colors",
        NODE_STATUS_STYLE[node.status],
        selected && "ring-1 ring-foreground/40",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide opacity-80">
          {NODE_KIND_LABEL[node.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{node.label}</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide">
          {node.status}
        </span>
      </span>
      {node.detail ? (
        <span className="mt-0.5 block truncate font-mono text-[10px] opacity-90">
          {node.detail}
        </span>
      ) : null}
      <span className="mt-0.5 flex flex-wrap gap-1 font-mono text-[9px] opacity-80">
        {node.placeholder ? <span>awaiting start event</span> : null}
        {node.deeperCollapsed ? <span>deeper graph collapsed</span> : null}
        {node.cyclic ? <span>back-edge</span> : null}
        {node.collapsedCount ? <span>{node.collapsedCount} collapsed</span> : null}
      </span>
    </button>
  );
}

/**
 * Indented tree of the projection, walked from the session root. A layout
 * engine is not what this owes: the shape (root → turns → tools → subagents)
 * is what has to be legible and live.
 *
 * Indentation is the DELEGATION dimension only. Turns are siblings under the
 * session root (session-dag-projection.ts parents them there), so a 60-turn
 * session no longer walks ~1,440px off the right edge before reaching the turn
 * the reader is actually watching.
 */
function GraphBranch({
  projection,
  nodeId,
  selectedNodeId,
  onSelectNode,
  depth,
}: {
  projection: SessionGraphProjection;
  nodeId: string;
  selectedNodeId: string | null;
  onSelectNode: (node: SessionGraphNode) => void;
  depth: number;
}) {
  const node = projection.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  const children = childrenOf(projection, nodeId);
  return (
    <li style={{ marginLeft: depth === 0 ? 0 : 16 }}>
      <GraphNodeCard
        node={node}
        selected={node.id === selectedNodeId}
        onSelect={() => onSelectNode(node)}
      />
      {children.length > 0 ? (
        <ul className="mt-1 space-y-1 border-l border-border/60 pl-2">
          {children.map((child) => (
            <GraphBranch
              key={child.id}
              projection={projection}
              nodeId={child.id}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Round 2's placeholder. It names the missing input rather than pretending to
 * load, because the run document is server data this lane must not fabricate.
 */
function DagRunPlaceholder({ source }: { source: LiveSource }) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="DAG run graph"
      data-run-id={source.id}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <GitBranchIcon className="size-3.5 text-cyan-400" aria-hidden />
        <span className="truncate text-xs font-semibold">{source.title}</span>
        <span className="rounded border border-border/70 px-1 font-mono text-[10px] text-muted-foreground">
          {source.projectName}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {source.status}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="max-w-prose text-[11px] leading-relaxed text-muted-foreground">
          The run graph lands with the typed run-document snapshot. This run&apos;s topology
          has to come from the executed document stored with the run, not from the
          workflow&apos;s current definition — a run of a since-edited workflow would
          otherwise be drawn with the wrong nodes and edges. Its ordered events are already
          live in the drawer.
        </p>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">{source.id}</p>
      </div>
    </section>
  );
}

/**
 * The selected node's REAL events. The session half used to restate the
 * projected nodes back at the reader ("tool.running", "subagent.running"),
 * which meant every frame the fold models away — `text_delta`,
 * `thinking_delta`, `message_start/end`, `cost`, `context_usage`,
 * `queue_update`, `turn_end`, `done` — appeared nowhere in the console, and a
 * row mutated as its node's status changed instead of a new event arriving.
 * The run half has always shown genuine persisted events; this is the same
 * contract for sessions.
 *
 * Node rows remain the fallback for a node whose frames have aged out of the
 * 500-sequence ring, so an old node is never a blank drawer.
 */
function sessionDrawerEvents(
  projection: SessionGraphProjection,
  frames: readonly SessionFrame[],
  nodeId: string | null,
): LiveDrawerEvent[] {
  const selectedFrames = framesForNode(projection, frames, nodeId);
  if (selectedFrames.length > 0) {
    return selectedFrames.map((frame) => {
      const summary = describeSessionFrame(frame);
      return {
        key: `frame:${frame.seq}`,
        seq: frame.seq,
        type: frame.type,
        ...(summary.subject !== undefined ? { subject: summary.subject } : {}),
        ...(summary.detail !== undefined ? { detail: summary.detail } : {}),
        ...(typeof frame.ts === "number" ? { ts: frame.ts } : {}),
      };
    });
  }
  const nodes = nodeId === null
    ? projection.nodes
    : [
        ...projection.nodes.filter((node) => node.id === nodeId),
        ...childrenOf(projection, nodeId),
      ];
  return nodes
    .filter((node) => node.kind !== "session")
    .map((node) => ({
      key: node.id,
      seq: node.createdAtSeq,
      type: `${node.kind}.${node.status}`,
      subject: node.label,
      ...(node.detail !== undefined ? { detail: node.detail } : {}),
    }))
    .sort((left, right) => left.seq - right.seq);
}

function runDrawerEvents(events: WorkflowRunEvent[]): LiveDrawerEvent[] {
  return events.map((event) => ({
    key: `${event.seq}:${event.eventId}`,
    seq: event.seq,
    type: event.type,
    ...(event.nodeId !== undefined ? { subject: event.nodeId } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    // Hover-only: the execution id is a 32-hex opaque token, not something the
    // reader scans a list for.
    ...(event.executionId !== undefined ? { hint: `execution ${event.executionId}` } : {}),
    // Carried so the drawer can render the durable model-resolution receipts a
    // `model_resolved` event holds. It was declared on LiveDrawerEvent and never
    // populated, which made the live console strictly less informative about a
    // run than the durable one.
    ...(event.data !== undefined ? { data: event.data } : {}),
    ts: event.ts,
  }));
}

const DAG_NODE_STATUS_TO_SOURCE: Record<SessionGraphNodeStatus, LiveSourceStatus> = {
  pending: "queued",
  running: "running",
  ok: "ok",
  error: "error",
  cancelled: "cancelled",
};

/** Ordered events for a selected typed run, polled with the list cadence. */
function useRunEvents(source: LiveSource | null, active: boolean): WorkflowRunEvent[] {
  // Keyed by run id so switching runs discards the previous run's page during
  // render rather than through a clearing effect.
  const [page, setPage] = useState<{ runId: string | null; events: WorkflowRunEvent[] }>({
    runId: null,
    events: [],
  });
  const runId = source?.kind === "dag-run" ? source.id : null;
  const projectId = source?.projectId ?? "";
  useEffect(() => {
    if (!active || !runId) return;
    let cancelled = false;
    let cursor = 0;
    let consecutiveErrors = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // This poller owns its own backoff. It used to swallow errors with a
    // comment deferring to "the poller", which was itself — so a permanently
    // failing /dag-workflow-runs/:id/events was hit 20x a minute, silently,
    // for as long as the run stayed selected.
    const schedule = () => {
      if (cancelled) return;
      const delay = nextPollDelayMs({
        selected: true,
        running: true,
        rank: 0,
        consecutiveErrors,
        documentHidden: typeof document !== "undefined" && document.hidden,
      });
      timer = setTimeout(() => void tick(), delay ?? 5_000);
    };

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      try {
        const next = await pageDagWorkflowRunEvents(projectId, runId, {
          after: cursor,
          limit: 200,
        });
        if (cancelled) return;
        consecutiveErrors = 0;
        if (next.events.length > 0) {
          cursor = next.lastSeq;
          setPage((previous) => {
            const carried = previous.runId === runId ? previous.events : [];
            const bySeq = new Map(carried.map((event) => [event.seq, event]));
            for (const event of next.events) bySeq.set(event.seq, event);
            return {
              runId,
              events: [...bySeq.values()].sort((left, right) => left.seq - right.seq),
            };
          });
        }
      } catch {
        if (cancelled) return;
        consecutiveErrors += 1;
      }
      schedule();
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, projectId, runId]);
  return page.runId === runId ? page.events : [];
}

/** What the selected session's poller reports back to the shell. */
interface SessionGraphSnapshot {
  sourceKey: string;
  projection: SessionGraphProjection;
  frames: SessionFrame[];
  runStatus: SessionRunStatus;
  /** A run-state read for this session has succeeded at least once. */
  observed: boolean;
}

export function LiveGraphConsole({
  projectId,
  active = true,
  runsConsole,
}: {
  projectId?: string;
  /**
   * True only while this surface is genuinely on screen: the Console is the
   * workspace's visible view AND "DAG Runs" is the selected feed. Every poller
   * below is gated on it, because the Console stays mounted-but-hidden once it
   * has been visited and would otherwise sweep every project's sessions while
   * the reader is in Chat or Builder.
   */
  active?: boolean;
  /**
   * The durable typed-run console. It stays the main area's default so the
   * authoritative run list, controls, and diagnostics remain one click from
   * where they have always been.
   */
  runsConsole?: ReactNode;
}) {
  const resolvedProjectId = projectId ?? (typeof window === "undefined" ? "" : getActiveProjectId());
  const [query, setQuery] = useState("");
  const [allProjects, setAllProjects] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [now, setNow] = useState(() => Date.now());
  // The address bar seeds the selection until the reader picks something; after
  // that their choice wins. Deriving both avoids a URL-reading effect racing
  // discovery.
  const [initialLink] = useState(() =>
    typeof window === "undefined" ? null : parseDeepLink(window.location.search),
  );
  const [chosen, setChosen] = useState<{ key: string | null; drawer: boolean } | null>(null);
  const [sessionSnapshot, setSessionSnapshot] = useState<SessionGraphSnapshot | null>(null);
  // A typed run reached by clicking a `dag` node inside a session graph. It is
  // not part of the live list (a finished run never is), so the console carries
  // it itself rather than pretending discovery found it.
  const [linkedRun, setLinkedRun] = useState<LiveSource | null>(null);

  const { sources, error, notices, activeProjectName } = useOpenWork({
    projectId: resolvedProjectId,
    enabled: active,
    allProjects,
  });

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);

  const linked = useMemo(() => matchDeepLink(sources, initialLink), [initialLink, sources]);
  const selectedKey = chosen ? chosen.key : linked?.key ?? null;
  const drawerOpen = chosen ? chosen.drawer : linked !== null;

  // Discovery ranks the rail; the ranks decide which sessions get a run-state
  // probe, and the probes then say which of those are actually running. The
  // selected session is excluded from the probes because its own graph poller
  // already knows, and reports back through `sessionSnapshot`.
  const discoveredRanks = useMemo(
    () => assignPollRanks(sources, selectedKey),
    [selectedKey, sources],
  );
  const probeTargets = useMemo(
    () => sessionsToProbe(sources, discoveredRanks, selectedKey),
    [discoveredRanks, selectedKey, sources],
  );
  const probes = useSessionRunStates({
    sessions: probeTargets,
    ranks: discoveredRanks,
    enabled: active,
  });
  const runStates = useMemo<ReadonlyMap<string, SessionRunProbe>>(() => {
    // Only a snapshot that has genuinely read run state speaks for its row. A
    // freshly selected session sits at the initial `runStatus: "none"` until
    // its first poll returns, and publishing that would badge it `idle` on the
    // strength of a read that has not happened.
    if (!sessionSnapshot || !sessionSnapshot.observed) return probes;
    const merged = new Map(probes);
    merged.set(sessionSnapshot.sourceKey, {
      status: sessionSnapshot.runStatus,
      runId: null,
    });
    return merged;
  }, [probes, sessionSnapshot]);

  const liveSources = useMemo(
    () => applySessionRunStates(sources, runStates),
    [runStates, sources],
  );
  const visible = useMemo(() => filterLiveSources(liveSources, query), [liveSources, query]);
  const selected = useMemo(() => {
    const found = liveSources.find((source) => source.key === selectedKey) ?? null;
    if (found) return found;
    return linkedRun && linkedRun.key === selectedKey ? linkedRun : null;
  }, [linkedRun, liveSources, selectedKey]);
  const ranks = useMemo(
    () => assignPollRanks(liveSources, selectedKey),
    [liveSources, selectedKey],
  );

  // Deep link out: the address bar always names the current selection.
  const selectSource = useCallback((source: LiveSource | null) => {
    setChosen({ key: source ? source.key : null, drawer: Boolean(source) });
    setSelectedNodeId(null);
    if (typeof window !== "undefined") {
      const search = deepLinkSearch(window.location.search, source);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
    }
  }, []);

  /**
   * A node inside a session's graph. A `dag` node is a delegation to a typed
   * workflow run, so clicking it swaps the main area to that run — the run
   * placeholder plus its genuine persisted events in the drawer — exactly as
   * selecting the run in the rail would.
   */
  const selectGraphNode = useCallback(
    (node: SessionGraphNode, source: LiveSource) => {
      if (node.kind === "dag" && node.detail) {
        const runId = node.detail;
        const discovered = sources.find(
          (candidate) => candidate.kind === "dag-run" && candidate.id === runId,
        );
        const runSource: LiveSource = discovered ?? {
          key: liveSourceKey("dag-run", source.projectId, runId),
          kind: "dag-run",
          id: runId,
          projectId: source.projectId,
          projectName: source.projectName,
          title: node.label,
          status: DAG_NODE_STATUS_TO_SOURCE[node.status],
          live: node.status === "running",
          lastActivityAt: Date.now(),
          origins: ["dag-run"],
          projectActivity: null,
        };
        setLinkedRun(discovered ? null : runSource);
        selectSource(runSource);
        return;
      }
      setSelectedNodeId(node.id);
      setChosen({ key: source.key, drawer: true });
    },
    [selectSource, sources],
  );

  const runEvents = useRunEvents(selected, active);

  // A snapshot only describes the drawer while it still belongs to the current
  // selection; switching sources must not show the previous session's events.
  const activeSessionSnapshot =
    sessionSnapshot && selected && sessionSnapshot.sourceKey === selected.key
      ? sessionSnapshot
      : null;

  const drawerEvents = selected?.kind === "dag-run"
    ? runDrawerEvents(runEvents)
    : activeSessionSnapshot
      ? sessionDrawerEvents(
          activeSessionSnapshot.projection,
          activeSessionSnapshot.frames,
          selectedNodeId,
        )
      : [];

  // The probe budget is a real bound on what this surface knows, so it is
  // stated next to discovery's own truncation chips instead of being left to a
  // reader to infer from eight `running` rows and a tail of quiet ones.
  const railNotices = useMemo(() => {
    const probeNotice = sessionProbeNotice(
      sessionProbeCoverage(liveSources, ranks, selectedKey),
    );
    return probeNotice === null ? notices : [...notices, probeNotice];
  }, [liveSources, notices, ranks, selectedKey]);

  const emptyMessage = describeEmptyState(allProjects ? null : activeProjectName);
  // The URL named something discovery cannot see. Silence read as "nothing is
  // running" even when the link pointed at a real run that had just finished.
  const deepLinkNotice =
    chosen === null && initialLink !== null && linked === null
      ? describeUnresolvedDeepLink(initialLink)
      : null;

  return (
    <div className="flex h-full min-h-0 w-full">
      <LiveSourceRail
        sources={visible}
        selectedKey={selectedKey}
        onSelect={selectSource}
        query={query}
        onQueryChange={setQuery}
        allProjects={allProjects}
        onAllProjectsChange={setAllProjects}
        error={error}
        notices={railNotices}
        deepLinkNotice={deepLinkNotice}
        emptyMessage={emptyMessage}
        now={now}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected === null ? (
          runsConsole ?? (
            <p className="p-6 text-center text-[11px] text-muted-foreground">
              Select a run or a session to see its live graph.
            </p>
          )
        ) : selected.kind === "dag-run" ? (
          <DagRunPlaceholder source={selected} />
        ) : (
          <SessionGraphView
            source={selected}
            rank={ranks.get(selected.key) ?? 0}
            active={active}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectGraphNode}
            onSnapshot={setSessionSnapshot}
          />
        )}
      </div>

      {selected && drawerOpen ? (
        <LiveEventDrawer
          title={selected.title}
          subtitle={selected.id}
          events={drawerEvents}
          emptyMessage={
            selected.kind === "dag-run"
              ? "No persisted events for this run yet."
              : "No retained events behind this selection yet."
          }
          width={drawerWidth}
          onWidthChange={setDrawerWidth}
          onClose={() => setChosen({ key: selected.key, drawer: false })}
          rescue={
            selected.kind === "dag-run"
              ? { projectId: selected.projectId, runId: selected.id }
              : null
          }
        />
      ) : null}
    </div>
  );
}

/**
 * A chat session's LLM logs, folded and rendered live. It lifts the projection,
 * its retained frames, and the run status to the shell so the drawer reads
 * exactly what the canvas draws and the rail can badge the row honestly.
 */
function SessionGraphView({
  source,
  rank,
  active,
  selectedNodeId,
  onSelectNode,
  onSnapshot,
}: {
  source: LiveSource;
  rank: number;
  active: boolean;
  selectedNodeId: string | null;
  onSelectNode: (node: SessionGraphNode, source: LiveSource) => void;
  onSnapshot: (snapshot: SessionGraphSnapshot) => void;
}) {
  const { projection, frames, runStatus, observed, error } = useSessionGraph({
    projectId: source.projectId,
    sessionId: source.id,
    selected: true,
    rank,
    enabled: active,
  });
  const sourceKey = source.key;
  const [promoteOpen, setPromoteOpen] = useState(false);
  useEffect(() => {
    onSnapshot({ sourceKey, projection, frames, runStatus, observed });
  }, [frames, observed, onSnapshot, projection, runStatus, sourceKey]);
  const notices = projectionNotices(projection);
  // A chat with no turn folded yet has nothing to promote, and offering the
  // action anyway would open a dialog whose only content is a refusal.
  const promotable = projection.nodes.some((node) => node.kind === "turn");
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Session live graph"
      data-session-id={source.id}
      data-run-status={runStatus}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <GitBranchIcon className="size-3.5 text-cyan-400" aria-hidden />
        <span className="truncate text-xs font-semibold">{source.title}</span>
        <span className="rounded border border-border/70 px-1 font-mono text-[10px] text-muted-foreground">
          {source.projectName}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          run {runStatus}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {projection.nodes.length} nodes · cursor {projection.cursor}
        </span>
        {promotable ? (
          <button
            type="button"
            onClick={() => setPromoteOpen(true)}
            className="shrink-0 rounded-md border border-cyan-500/50 px-2 py-0.5 font-mono text-[10px] text-cyan-700 transition-colors hover:bg-cyan-500/10 dark:text-cyan-300"
          >
            Turn into a DAG
          </button>
        ) : null}
      </header>

      {promoteOpen ? (
        <LivePromoteDialog
          open={promoteOpen}
          onOpenChange={setPromoteOpen}
          projectId={source.projectId}
          projectName={source.projectName}
          sessionId={source.id}
          sessionTitle={source.title}
          projection={projection}
          frames={frames}
        />
      ) : null}

      {notices.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border/60 px-3 py-1">
          {notices.map((notice) => (
            <span
              key={notice}
              className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-700 dark:text-amber-300"
            >
              {notice}
            </span>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="shrink-0 px-3 py-1.5 text-[11px] text-destructive">
          Run state failed: {error}. Retrying with backoff.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ul className="space-y-1">
          <GraphBranch
            projection={projection}
            nodeId={sessionRootId(source.id)}
            selectedNodeId={selectedNodeId}
            onSelectNode={(node) => onSelectNode(node, source)}
            depth={0}
          />
        </ul>
        {runStatus === "none" && projection.nodes.length === 1 && (
          <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted-foreground">
            This session has no retained agent run right now, so the graph shows only its
            root. Send a turn in the chat tab and the turn, tool, and subagent nodes appear
            here as the logs arrive.
          </p>
        )}
      </div>
    </section>
  );
}
