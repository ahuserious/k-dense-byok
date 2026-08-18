// danbot-byok — web/src/components/console/live-graph-console.tsx
//
// The Console's live-graph surface: "console should be able to view running DAG
// workflows visually, whichever projects or chats someone has open in running
// should display here with their respective graphs, even if not a DAG
// initially, the LLM's logs should be able to turn into a DAG here & be viewed
// live."
//
// Round 1 delivers the session half plus the shell:
//   left rail   — every DAG run and chat session this browser can see running
//   main        — a chat session's LLM logs folded into a live graph
//                 (lib/session-dag-projection.ts), or the typed run console
//                 when nothing is selected
//   right drawer— the ordered events behind the selected node
//
// The DAG-run *graph* is round 2: it needs the executed-document snapshot from
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
import { LiveSourceRail } from "@/components/console/live-source-rail";
import {
  assignPollRanks,
  deepLinkSearch,
  describeEmptyState,
  filterLiveSources,
  matchDeepLink,
  parseDeepLink,
  useOpenWork,
  useSessionGraph,
  type LiveSource,
} from "@/lib/console-live-sources";
import { pageDagWorkflowRunEvents, type WorkflowRunEvent } from "@/lib/dag-workflows";
import { getActiveProjectId } from "@/lib/projects";
import {
  childrenOf,
  projectionNotices,
  sessionRootId,
  type SessionGraphNode,
  type SessionGraphNodeStatus,
  type SessionGraphProjection,
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
 * engine is not what round 1 owes: the shape (root → turn chain → tools →
 * subagents) is what has to be legible and live.
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
  onSelectNode: (nodeId: string) => void;
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
        onSelect={() => onSelectNode(node.id)}
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

/** Frames behind one projected node, normalized for the drawer. */
function sessionDrawerEvents(
  projection: SessionGraphProjection,
  nodeId: string | null,
): LiveDrawerEvent[] {
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
    ...(event.executionId !== undefined ? { detail: `execution ${event.executionId}` } : {}),
    ts: event.ts,
  }));
}

/** Ordered events for a selected typed run, polled with the list cadence. */
function useRunEvents(source: LiveSource | null): WorkflowRunEvent[] {
  // Keyed by run id so switching runs discards the previous run's page during
  // render rather than through a clearing effect.
  const [page, setPage] = useState<{ runId: string | null; events: WorkflowRunEvent[] }>({
    runId: null,
    events: [],
  });
  const runId = source?.kind === "dag-run" ? source.id : null;
  const projectId = source?.projectId ?? "";
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(() => void tick(), 5_000);
        return;
      }
      try {
        const next = await pageDagWorkflowRunEvents(projectId, runId, {
          after: cursor,
          limit: 200,
        });
        if (cancelled) return;
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
        // Backoff is the poller's; a transient failure just retries.
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 3_000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, runId]);
  return page.runId === runId ? page.events : [];
}

export function LiveGraphConsole({
  projectId,
  active = true,
  runsConsole,
}: {
  projectId?: string;
  /** The Console tab is mounted-but-hidden when the user is elsewhere. */
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

  const { sources, error } = useOpenWork({
    projectId: resolvedProjectId,
    enabled: active,
    allProjects,
  });

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);

  const visible = useMemo(() => filterLiveSources(sources, query), [query, sources]);
  const linked = useMemo(() => matchDeepLink(sources, initialLink), [initialLink, sources]);
  const selectedKey = chosen ? chosen.key : linked?.key ?? null;
  const drawerOpen = chosen ? chosen.drawer : linked !== null;
  const selected = useMemo(
    () => sources.find((source) => source.key === selectedKey) ?? null,
    [selectedKey, sources],
  );
  const ranks = useMemo(() => assignPollRanks(sources, selectedKey), [selectedKey, sources]);

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

  const runEvents = useRunEvents(selected);
  const [sessionProjection, setSessionProjection] = useState<SessionGraphProjection | null>(null);

  const drawerEvents = selected?.kind === "dag-run"
    ? runDrawerEvents(runEvents)
    : sessionProjection
      ? sessionDrawerEvents(sessionProjection, selectedNodeId)
      : [];

  const emptyMessage = describeEmptyState(allProjects ? null : resolvedProjectId);

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
            selectedNodeId={selectedNodeId}
            onSelectNode={(nodeId) => {
              setSelectedNodeId(nodeId);
              setChosen({ key: selected.key, drawer: true });
            }}
            onProjection={setSessionProjection}
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
              : "No projected nodes behind this selection yet."
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
 * A chat session's LLM logs, folded and rendered live. It lifts the projection
 * to the shell so the drawer reads exactly what the canvas draws.
 */
function SessionGraphView({
  source,
  rank,
  selectedNodeId,
  onSelectNode,
  onProjection,
}: {
  source: LiveSource;
  rank: number;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onProjection: (projection: SessionGraphProjection) => void;
}) {
  const { projection, runStatus, error } = useSessionGraph({
    projectId: source.projectId,
    sessionId: source.id,
    selected: true,
    rank,
    enabled: true,
  });
  useEffect(() => {
    onProjection(projection);
  }, [onProjection, projection]);
  const notices = projectionNotices(projection);
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
      </header>

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
            onSelectNode={onSelectNode}
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
