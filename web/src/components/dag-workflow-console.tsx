"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  Clock3Icon,
  LoaderCircleIcon,
  PauseCircleIcon,
  PlayIcon,
  RefreshCwIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ModelReceiptCard,
  parseModelReceipt,
} from "@/components/console/live-model-receipt";
import { HelperAgentChat } from "@/components/helper-agent-chat";
import { PromptOptimizationConsoleSurface } from "@/components/prompt-opt-console";
import {
  cancelDagWorkflowRun,
  DagWorkflowApiError,
  listDagWorkflowRuns,
  pageDagWorkflowRunEvents,
  readDagWorkflowRun,
  readDagWorkflowRunBudget,
  rescueDagWorkflowRun,
  resumeDagWorkflowRun,
  type WorkflowRunBudgetSummary,
  type WorkflowRunDiagnostic,
  type WorkflowRunEvent,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
} from "@/lib/dag-workflows";
import { cn } from "@/lib/utils";

const RUN_POLL_INTERVAL_MS = 2_000;
const CANCELLABLE_STATUSES = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "waiting",
  "blocked",
  "paused",
]);
const POLLED_STATUSES = CANCELLABLE_STATUSES;
const RESCUE_HELPER_STATUSES = new Set<WorkflowRunStatus>([
  "blocked",
  "interrupted",
  "failed",
]);

type RunControlAction = "cancel" | "resume" | "rescue";

const STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  paused: "Paused",
  interrupted: "Interrupted",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

function errorMessage(error: unknown): string {
  if (error instanceof DagWorkflowApiError) {
    return error.code ? `${error.code}: ${error.detail}` : error.detail;
  }
  return error instanceof Error ? error.message : "Unable to load workflow runs.";
}

function formatTimestamp(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return "—";
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Invalid timestamp";
}

function StatusBadge({ status }: { status: WorkflowRunStatus }) {
  const className = cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
    status === "succeeded" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
    status === "running" && "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    status === "queued" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    (status === "blocked" || status === "interrupted") && "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    (status === "waiting" || status === "paused") && "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    status === "cancelled" && "border-muted-foreground/30 bg-muted text-muted-foreground",
  );

  const Icon = status === "succeeded"
    ? CheckCircle2Icon
    : status === "failed" || status === "cancelled"
      ? XCircleIcon
      : status === "running"
        ? LoaderCircleIcon
        : status === "waiting" || status === "paused"
          ? PauseCircleIcon
          : status === "queued"
            ? Clock3Icon
            : CircleDashedIcon;

  return (
    <span className={className}>
      <Icon className={cn("size-3", status === "running" && "animate-spin")} />
      {STATUS_LABELS[status]}
    </span>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: WorkflowRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40",
        selected && "bg-muted/60",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-[11px] font-semibold" title={run.id}>
          {run.id}
        </code>
        <StatusBadge status={run.status} />
      </span>
      <span className="mt-1.5 block truncate text-[11px] text-muted-foreground">
        {run.workflowId} · revision {run.workflowRevision} · {formatTimestamp(run.createdAt)}
      </span>
      {run.lastError ? (
        <span className="mt-1 block truncate text-[11px] text-destructive" title={run.lastError.message}>
          {run.lastError.code}: {run.lastError.message}
        </span>
      ) : null}
    </button>
  );
}

function diagnosticKey(diagnostic: WorkflowRunDiagnostic): string {
  return `${diagnostic.code}\0${diagnostic.message}\0${diagnostic.line ?? ""}`;
}

function mergeDiagnostics(
  current: WorkflowRunDiagnostic[],
  incoming: WorkflowRunDiagnostic[],
): WorkflowRunDiagnostic[] {
  const unique = new Map(current.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
  for (const diagnostic of incoming) {
    unique.set(diagnosticKey(diagnostic), diagnostic);
  }
  return [...unique.values()];
}

function mergeEvents(
  current: WorkflowRunEvent[],
  incoming: WorkflowRunEvent[],
): WorkflowRunEvent[] {
  const bySequence = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

function RunDiagnostics({ diagnostics }: { diagnostics: WorkflowRunDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <section className="border-b bg-amber-500/5 px-4 py-3" aria-label="Run diagnostics">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <AlertTriangleIcon className="size-3.5 text-amber-600" />
        Diagnostics
      </h3>
      <ul className="mt-2 space-y-1.5">
        {diagnostics.map((diagnostic) => (
          <li key={diagnosticKey(diagnostic)} className="text-[11px] text-muted-foreground">
            <code className={diagnostic.fatal ? "text-destructive" : "text-amber-700 dark:text-amber-300"}>
              {diagnostic.code}
            </code>
            {diagnostic.line ? ` (line ${diagnostic.line})` : ""}: {diagnostic.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

const BUDGET_INTEGER_FORMAT = new Intl.NumberFormat("en-US");

function formatBudgetUsd(value: number): string {
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function RunBudgetStrip({ budget }: { budget: WorkflowRunBudgetSummary }) {
  if (!budget.ceilings) {
    return (
      <section
        className="shrink-0 border-b bg-muted/10 px-4 py-2 text-[11px] text-muted-foreground"
        aria-label="Run budget commitments"
      >
        No model-call budget reservations yet.
      </section>
    );
  }

  const missingUsageWarning = budget.fullChargeReservationCount > 0;
  return (
    <section
      className="shrink-0 border-b bg-muted/10 px-4 py-2"
      aria-label="Run budget commitments"
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span>
          Ceiling {formatBudgetUsd(budget.ceilings.maxCostUsd)} · {BUDGET_INTEGER_FORMAT.format(budget.ceilings.maxTokens)} tokens
        </span>
        <span>
          Model calls {BUDGET_INTEGER_FORMAT.format(budget.modelCallCount)} / {BUDGET_INTEGER_FORMAT.format(budget.ceilings.maxModelCalls)}
        </span>
        <span>
          Active max {formatBudgetUsd(budget.activeReservedMaximumUsd)} · {BUDGET_INTEGER_FORMAT.format(budget.activeReservedMaximumTokens)} tokens ({budget.activeReservationCount})
        </span>
        <span>Settled {formatBudgetUsd(budget.settledChargedUsd)}</span>
        <span>
          Tokens {BUDGET_INTEGER_FORMAT.format(budget.observedUsageTokens)} observed
          {budget.missingUsageMaximumTokens > 0
            ? ` · ≤${BUDGET_INTEGER_FORMAT.format(budget.missingUsageMaximumTokens)} missing-usage envelope`
            : ""}
        </span>
      </div>
      {missingUsageWarning ? (
        <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-700 dark:text-amber-300">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          <span>
            {budget.fullChargeReservationCount} settlement{budget.fullChargeReservationCount === 1 ? "" : "s"} reported no terminal usage and charged the full reserved maximum.
            {budget.staleReservationCount > 0
              ? ` ${budget.staleReservationCount} ${budget.staleReservationCount === 1 ? "was" : "were"} stale.`
              : ""}
          </span>
        </p>
      ) : null}
    </section>
  );
}

function EventRow({ event }: { event: WorkflowRunEvent }) {
  const receipt = parseModelReceipt(event.data);
  return (
    <li className="border-b px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <code className="text-[10px] text-muted-foreground">#{event.seq}</code>
        <span className="text-xs font-semibold">{event.type}</span>
        {event.nodeId ? (
          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{event.nodeId}</code>
        ) : null}
        {event.attempt ? <span className="text-[10px] text-muted-foreground">attempt {event.attempt}</span> : null}
        <time className="ml-auto text-[10px] text-muted-foreground" dateTime={new Date(event.ts).toISOString()}>
          {formatTimestamp(event.ts)}
        </time>
      </div>
      {event.executionId ? (
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={event.executionId}>
          execution {event.executionId}
        </div>
      ) : null}
      {/* The requested-vs-resolved receipt, read rather than dumped. The raw
          payload stays behind the disclosure below for anyone who wants it. */}
      {receipt ? <ModelReceiptCard receipt={receipt} className="mt-2" /> : null}
      {event.data && Object.keys(event.data).length > 0 ? (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">Event data</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-[10px] leading-relaxed">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

export function DagWorkflowConsole({
  projectId,
  active = true,
}: {
  projectId: string;
  /** Re-fetch durable state whenever a previously mounted Console is reopened. */
  active?: boolean;
}) {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunRecord | null>(null);
  const [selectedRunBudget, setSelectedRunBudget] = useState<WorkflowRunBudgetSummary | null>(null);
  const [events, setEvents] = useState<WorkflowRunEvent[]>([]);
  const [eventDiagnostics, setEventDiagnostics] = useState<WorkflowRunDiagnostic[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [controlAction, setControlAction] = useState<RunControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const eventCursorRef = useRef(0);
  const detailRequestVersionRef = useRef(0);

  selectedRunIdRef.current = selectedRunId;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    detailRequestVersionRef.current += 1;
    eventCursorRef.current = 0;
    setRuns(null);
    setSelectedRunId(null);
    setSelectedRun(null);
    setSelectedRunBudget(null);
    setEvents([]);
    setEventDiagnostics([]);
    setHasMore(false);
    setError(null);
    setNotice(null);
    void listDagWorkflowRuns(projectId, 200)
      .then((items) => {
        if (cancelled) return;
        setRuns(items);
        setSelectedRunId((current) => (
          current && items.some((run) => run.id === current) ? current : items[0]?.id ?? null
        ));
      })
      .catch((caught) => {
        if (!cancelled) {
          setRuns([]);
          setError(errorMessage(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, projectId]);

  useEffect(() => {
    if (!selectedRunId) {
      eventCursorRef.current = 0;
      setSelectedRun(null);
      setSelectedRunBudget(null);
      setEvents([]);
      setEventDiagnostics([]);
      setHasMore(false);
      return;
    }
    let cancelled = false;
    const requestVersion = ++detailRequestVersionRef.current;
    eventCursorRef.current = 0;
    setLoadingDetail(true);
    setSelectedRun(null);
    setSelectedRunBudget(null);
    setEvents([]);
    setEventDiagnostics([]);
    setHasMore(false);
    setError(null);
    void Promise.all([
      readDagWorkflowRun(projectId, selectedRunId),
      pageDagWorkflowRunEvents(projectId, selectedRunId, { after: 0, limit: 200 }),
      readDagWorkflowRunBudget(projectId, selectedRunId),
    ])
      .then(([run, page, budget]) => {
        if (cancelled || requestVersion !== detailRequestVersionRef.current) return;
        const orderedEvents = [...page.events].sort((left, right) => left.seq - right.seq);
        eventCursorRef.current = orderedEvents.at(-1)?.seq ?? 0;
        setSelectedRun(run);
        setSelectedRunBudget(budget);
        setEvents(orderedEvents);
        setEventDiagnostics(page.diagnostics);
        setHasMore(page.hasMore);
      })
      .catch((caught) => {
        if (!cancelled && requestVersion === detailRequestVersionRef.current) {
          setSelectedRun(null);
          setSelectedRunBudget(null);
          setEvents([]);
          setEventDiagnostics([]);
          setHasMore(false);
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (!cancelled && requestVersion === detailRequestVersionRef.current) {
          setLoadingDetail(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedRunId]);

  const hasActiveRuns = runs?.some((run) => POLLED_STATUSES.has(run.status)) ?? false;

  useEffect(() => {
    if (!hasActiveRuns) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(() => void poll(), RUN_POLL_INTERVAL_MS);
    };
    const poll = async () => {
      try {
        const items = await listDagWorkflowRuns(projectId, 200);
        if (cancelled) return;
        setRuns(items);

        const currentRunId = selectedRunIdRef.current;
        if (currentRunId) {
          const requestVersion = ++detailRequestVersionRef.current;
          const cursor = eventCursorRef.current;
          const [run, page, budget] = await Promise.all([
            readDagWorkflowRun(projectId, currentRunId),
            pageDagWorkflowRunEvents(projectId, currentRunId, {
              after: cursor,
              limit: 200,
            }),
            readDagWorkflowRunBudget(projectId, currentRunId),
          ]);
          if (
            cancelled ||
            currentRunId !== selectedRunIdRef.current ||
            requestVersion !== detailRequestVersionRef.current
          ) {
            return;
          }
          setSelectedRun(run);
          setSelectedRunBudget(budget);
          setEvents((current) => {
            const merged = mergeEvents(current, page.events);
            eventCursorRef.current = merged.at(-1)?.seq ?? cursor;
            return merged;
          });
          setEventDiagnostics((current) => mergeDiagnostics(current, page.diagnostics));
          setHasMore(page.hasMore);
        }
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [hasActiveRuns, projectId]);

  const diagnostics = useMemo(() => {
    const unique = new Map<string, WorkflowRunDiagnostic>();
    for (const diagnostic of selectedRun?.state.diagnostics ?? []) {
      unique.set(diagnosticKey(diagnostic), diagnostic);
    }
    for (const diagnostic of eventDiagnostics) {
      unique.set(diagnosticKey(diagnostic), diagnostic);
    }
    return [...unique.values()];
  }, [eventDiagnostics, selectedRun?.state.diagnostics]);
  const rescueHelperReference = useMemo(() => (
    selectedRun && RESCUE_HELPER_STATUSES.has(selectedRun.state.status)
      ? { kind: "run" as const, id: selectedRun.manifest.id }
      : null
  ), [selectedRun]);

  const loadMoreEvents = async () => {
    if (!selectedRunId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const cursor = eventCursorRef.current;
      const page = await pageDagWorkflowRunEvents(projectId, selectedRunId, {
        after: cursor,
        limit: 200,
      });
      setEvents((current) => {
        const merged = mergeEvents(current, page.events);
        eventCursorRef.current = merged.at(-1)?.seq ?? cursor;
        return merged;
      });
      setEventDiagnostics((current) => mergeDiagnostics(current, page.diagnostics));
      setHasMore(page.hasMore);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  const controlRun = async (action: RunControlAction) => {
    if (!selectedRun || controlAction) return;
    const sourceRunId = selectedRun.manifest.id;
    setControlAction(action);
    setError(null);
    setNotice(null);

    let controlledRun: WorkflowRunRecord;
    try {
      controlledRun = action === "cancel"
        ? await cancelDagWorkflowRun(projectId, sourceRunId)
        : action === "resume"
          ? await resumeDagWorkflowRun(projectId, sourceRunId)
          : await rescueDagWorkflowRun(projectId, sourceRunId, {
              requestId: crypto.randomUUID(),
            });
    } catch (caught) {
      setError(errorMessage(caught));
      setControlAction(null);
      return;
    }

    const targetRunId = controlledRun.manifest.id;
    const isNewRun = targetRunId !== sourceRunId;
    selectedRunIdRef.current = targetRunId;
    setSelectedRunId(targetRunId);
    setSelectedRun(controlledRun);
    if (isNewRun) {
      eventCursorRef.current = 0;
      setSelectedRunBudget(null);
      setEvents([]);
      setEventDiagnostics([]);
      setHasMore(false);
    }
    setNotice(
      action === "rescue"
        ? `Created rescue run ${targetRunId} with status ${controlledRun.state.status}.`
        : `${action === "cancel" ? "Cancel" : "Resume"} requested for ${targetRunId}; current status is ${controlledRun.state.status}.`,
    );

    try {
      const cursor = isNewRun ? 0 : eventCursorRef.current;
      const requestVersion = ++detailRequestVersionRef.current;
      const [items, freshRun, page, budget] = await Promise.all([
        listDagWorkflowRuns(projectId, 200),
        readDagWorkflowRun(projectId, targetRunId),
        pageDagWorkflowRunEvents(projectId, targetRunId, { after: cursor, limit: 200 }),
        readDagWorkflowRunBudget(projectId, targetRunId),
      ]);
      if (targetRunId === selectedRunIdRef.current) setRuns(items);
      if (
        targetRunId === selectedRunIdRef.current &&
        requestVersion === detailRequestVersionRef.current
      ) {
        setSelectedRun(freshRun);
        setSelectedRunBudget(budget);
        setEvents((current) => {
          const merged = isNewRun
            ? [...page.events].sort((left, right) => left.seq - right.seq)
            : mergeEvents(current, page.events);
          eventCursorRef.current = merged.at(-1)?.seq ?? cursor;
          return merged;
        });
        setEventDiagnostics((current) => (
          isNewRun ? page.diagnostics : mergeDiagnostics(current, page.diagnostics)
        ));
        setHasMore(page.hasMore);
      }
    } catch (caught) {
      setError(`The control request succeeded, but refresh failed: ${errorMessage(caught)}`);
    } finally {
      setControlAction(null);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="workflow-console-title">
      <header className="shrink-0 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-primary" />
          <h1 id="workflow-console-title" className="text-sm font-semibold">Console</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Durable run records and the runner-owned authoritative event stream. A queued record is not reported as executing.
        </p>
      </header>

      {error ? (
        <div role="alert" className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mx-4 mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,32%)_minmax(0,1fr)] overflow-hidden">
        <aside className="min-h-0 overflow-auto border-r" aria-label="Workflow runs">
          {runs === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Loading runs…
            </div>
          ) : runs.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No durable workflow runs yet.</div>
          ) : (
            runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                selected={run.id === selectedRunId}
                onSelect={() => setSelectedRunId(run.id)}
              />
            ))
          )}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {loadingDetail ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Reading durable run…
            </div>
          ) : selectedRun ? (
            <>
              <div className="shrink-0 border-b px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-xs font-semibold" title={selectedRun.manifest.id}>
                    {selectedRun.manifest.id}
                  </code>
                  <StatusBadge status={selectedRun.state.status} />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{selectedRun.manifest.workflowId} · revision {selectedRun.manifest.workflowRevision}</span>
                  <span>{selectedRun.state.lastSeq} persisted event{selectedRun.state.lastSeq === 1 ? "" : "s"}</span>
                  <span>Created {formatTimestamp(selectedRun.manifest.createdAt)}</span>
                </div>
                {CANCELLABLE_STATUSES.has(selectedRun.state.status) ||
                selectedRun.state.status === "interrupted" ||
                selectedRun.state.status === "failed" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Run controls">
                    {CANCELLABLE_STATUSES.has(selectedRun.state.status) ? (
                      <button
                        type="button"
                        onClick={() => void controlRun("cancel")}
                        disabled={controlAction !== null}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/5 disabled:cursor-wait disabled:opacity-50"
                      >
                        {controlAction === "cancel"
                          ? <LoaderCircleIcon className="size-3 animate-spin" />
                          : <XCircleIcon className="size-3" />}
                        Cancel
                      </button>
                    ) : null}
                    {selectedRun.state.status === "interrupted" ? (
                      <button
                        type="button"
                        onClick={() => void controlRun("resume")}
                        disabled={controlAction !== null}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:cursor-wait disabled:opacity-50"
                      >
                        {controlAction === "resume"
                          ? <LoaderCircleIcon className="size-3 animate-spin" />
                          : <PlayIcon className="size-3" />}
                        Resume
                      </button>
                    ) : null}
                    {selectedRun.state.status === "failed" ? (
                      <button
                        type="button"
                        onClick={() => void controlRun("rescue")}
                        disabled={controlAction !== null}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:cursor-wait disabled:opacity-50"
                      >
                        {controlAction === "rescue"
                          ? <LoaderCircleIcon className="size-3 animate-spin" />
                          : <RefreshCwIcon className="size-3" />}
                        Rescue as new run
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {selectedRun.state.lastError ? (
                  <div className="mt-2 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
                    {selectedRun.state.lastError.code}: {selectedRun.state.lastError.message}
                  </div>
                ) : null}
              </div>
              {selectedRunBudget ? <RunBudgetStrip budget={selectedRunBudget} /> : null}
              <RunDiagnostics diagnostics={diagnostics} />
              <PromptOptimizationConsoleSurface projectId={projectId} runId={selectedRun.manifest.id} nodes={selectedRun.manifest.graph.nodes} runStatus={selectedRun.state.status} />
              <div className={cn(
                "grid min-h-0 flex-1 overflow-hidden",
                rescueHelperReference && "grid-cols-[minmax(0,1fr)_minmax(300px,40%)]",
              )}>
                <div className="min-h-0 overflow-auto" aria-label="Authoritative workflow events">
                  {events.length === 0 ? (
                    <p className="p-6 text-center text-xs text-muted-foreground">No persisted events for this run.</p>
                  ) : (
                    <ol>
                      {events.map((event) => <EventRow key={`${event.seq}:${event.eventId}`} event={event} />)}
                    </ol>
                  )}
                  {hasMore ? (
                    <div className="border-t p-3 text-center">
                      <button
                        type="button"
                        onClick={() => void loadMoreEvents()}
                        disabled={loadingMore}
                        className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                      >
                        {loadingMore ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                        Load more events
                      </button>
                    </div>
                  ) : null}
                </div>
                {rescueHelperReference ? (
                  <aside className="flex min-h-0 flex-col border-l" aria-label="Proposal-only workflow rescue">
                    <p className="shrink-0 border-b bg-amber-500/5 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
                      Diagnosis only. Runner auto-rescue and persisted events remain authoritative;
                      this helper cannot apply, retry, or control anything.
                    </p>
                    <div className="min-h-0 flex-1">
                      <HelperAgentChat
                        projectId={projectId}
                        profile="workflow-rescue"
                        contextReference={rescueHelperReference}
                      />
                    </div>
                  </aside>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
              Select a durable run to inspect its status, diagnostics, and ordered events.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
