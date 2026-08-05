"use client";

import {
  BracesIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { HelperAgentChat } from "@/components/helper-agent-chat";
import {
  listDagWorkflowRuns,
  type WorkflowRunSummary,
} from "@/lib/dag-workflows";
import {
  isRaindropReference,
  listRaindropChatSessions,
  loadRaindropContext,
  raindropReferenceKey,
  type RaindropChatSessionSummary,
  type RaindropOpenChatSession,
  type RaindropReference,
} from "@/lib/raindrop";
import { cn } from "@/lib/utils";

const RAINDROP_STATE_VERSION = 2;
const MAX_SAVED_REFERENCES_PER_KIND = 50;
const EMPTY_OPEN_CHAT_SESSIONS: RaindropOpenChatSession[] = [];

export interface SavedRaindropState {
  version: typeof RAINDROP_STATE_VERSION;
  references: RaindropReference[];
  selectedReference: RaindropReference | null;
}

function storageKey(projectId: string): string {
  return `kady:raindrop:${projectId}:v2`;
}

function legacyStorageKey(projectId: string): string {
  return `kady:raindrop:${projectId}:v1`;
}

function emptySavedState(): SavedRaindropState {
  return { version: 2, references: [], selectedReference: null };
}

function boundedUniqueReferences(references: readonly RaindropReference[]): RaindropReference[] {
  const seen = new Set<string>();
  const counts = { run: 0, session: 0 };
  const output: RaindropReference[] = [];
  for (const reference of references) {
    const key = raindropReferenceKey(reference);
    if (seen.has(key) || counts[reference.kind] >= MAX_SAVED_REFERENCES_PER_KIND) continue;
    seen.add(key);
    counts[reference.kind] += 1;
    output.push({ ...reference });
  }
  return output;
}

export function parseSavedRaindropState(value: string | null): SavedRaindropState {
  if (!value) return emptySavedState();
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    // Migrate the original run-only sidecar without losing its selected run.
    if (parsed.version === 1 && Array.isArray(parsed.runIds)) {
      const references = boundedUniqueReferences(parsed.runIds.flatMap((id): RaindropReference[] => {
        const reference = { kind: "run" as const, id };
        return isRaindropReference(reference) ? [reference] : [];
      }));
      const selectedCandidate = { kind: "run" as const, id: parsed.selectedRunId };
      const selectedReference = isRaindropReference(selectedCandidate) && references.some(
          (reference) => raindropReferenceKey(reference) === raindropReferenceKey(selectedCandidate),
        )
        ? selectedCandidate
        : references[0] ?? null;
      return { version: 2, references, selectedReference };
    }
    if (parsed.version !== RAINDROP_STATE_VERSION || !Array.isArray(parsed.references)) {
      return emptySavedState();
    }
    const references = boundedUniqueReferences(parsed.references.filter(isRaindropReference));
    const selectedReference = isRaindropReference(parsed.selectedReference) && references.some(
        (reference) => raindropReferenceKey(reference) === raindropReferenceKey(parsed.selectedReference as RaindropReference),
      )
      ? { ...parsed.selectedReference }
      : references[0] ?? null;
    return { version: 2, references, selectedReference };
  } catch {
    return emptySavedState();
  }
}

function runStatusClass(status: WorkflowRunSummary["status"]): string {
  if (status === "succeeded") return "text-emerald-600 dark:text-emerald-300";
  if (status === "failed" || status === "cancelled") return "text-destructive";
  if (status === "running") return "text-blue-600 dark:text-blue-300";
  return "text-amber-700 dark:text-amber-300";
}

interface DisplaySession extends RaindropChatSessionSummary {
  active: boolean;
}

export function RaindropPanel({
  projectId,
  active,
  openChatSessions = EMPTY_OPEN_CHAT_SESSIONS,
}: {
  projectId: string;
  active: boolean;
  openChatSessions?: RaindropOpenChatSession[];
}) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [sessions, setSessions] = useState<RaindropChatSessionSummary[]>([]);
  const [savedReferences, setSavedReferences] = useState<RaindropReference[]>([]);
  const [selectedReference, setSelectedReference] = useState<RaindropReference | null>(null);
  const [contextValidated, setContextValidated] = useState(false);
  const [contextTruncated, setContextTruncated] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const validOpenChatSessions = useMemo(() => {
    const seen = new Set<string>();
    return openChatSessions.filter((session) => {
      const reference = { kind: "session" as const, id: session.id };
      if (!isRaindropReference(reference) || seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
  }, [openChatSessions]);
  const activeChatReference = useMemo<RaindropReference | null>(() => {
    const activeSession = validOpenChatSessions.find((session) => session.active);
    return activeSession ? { kind: "session", id: activeSession.id } : null;
  }, [validOpenChatSessions]);

  useEffect(() => {
    setHydrated(false);
    const saved = parseSavedRaindropState(
      window.localStorage.getItem(storageKey(projectId)) ??
        window.localStorage.getItem(legacyStorageKey(projectId)),
    );
    setSavedReferences(saved.references);
    setSelectedReference(saved.selectedReference);
    setHydrated(true);
  }, [projectId]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [latestRuns, latestSessions] = await Promise.all([
          listDagWorkflowRuns(projectId, 200),
          listRaindropChatSessions(projectId),
        ]);
        if (cancelled) return;
        setRuns(latestRuns);
        setSessions(latestSessions);
        const discovered: RaindropReference[] = [
          ...validOpenChatSessions.filter((session) => session.active).map(
            (session): RaindropReference => ({ kind: "session", id: session.id }),
          ),
          ...latestSessions.map((session): RaindropReference => ({
            kind: "session",
            id: session.id,
          })),
          ...validOpenChatSessions.filter((session) => !session.active).map(
            (session): RaindropReference => ({ kind: "session", id: session.id }),
          ),
          ...latestRuns.map((run): RaindropReference => ({ kind: "run", id: run.id })),
        ];
        setSavedReferences((current) => boundedUniqueReferences([...discovered, ...current]));
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to read Raindrop logs.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void refresh();
    const interval = active ? window.setInterval(() => void refresh(), 5_000) : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [active, hydrated, projectId, refreshVersion, validOpenChatSessions]);

  useEffect(() => {
    if (!hydrated || savedReferences.length === 0) return;
    setSelectedReference((current) => {
      if (current && savedReferences.some(
        (reference) => raindropReferenceKey(reference) === raindropReferenceKey(current),
      )) return current;
      if (activeChatReference && savedReferences.some(
        (reference) => raindropReferenceKey(reference) === raindropReferenceKey(activeChatReference),
      )) return activeChatReference;
      return savedReferences[0] ?? null;
    });
  }, [activeChatReference, hydrated, savedReferences]);

  useEffect(() => {
    if (!hydrated) return;
    const state: SavedRaindropState = {
      version: 2,
      references: savedReferences,
      selectedReference,
    };
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(state));
  }, [hydrated, projectId, savedReferences, selectedReference]);

  useEffect(() => {
    const controller = new AbortController();
    setContextValidated(false);
    setContextTruncated(false);
    setContextError(null);
    setContextLoading(Boolean(selectedReference));
    if (!selectedReference) return () => controller.abort();
    void loadRaindropContext(projectId, selectedReference, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        // The projection bytes are deliberately not sent back through the chat
        // prompt. The helper run reconstructs them server-side from this source.
        setContextValidated(true);
        setContextTruncated(result.truncated);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setContextError(caught instanceof Error ? caught.message : "Unable to read the selected log.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setContextLoading(false);
      });
    return () => controller.abort();
  }, [projectId, selectedReference]);

  const runById = useMemo(
    () => new Map(runs.map((run) => [run.id, run])),
    [runs],
  );
  const sessionById = useMemo(() => {
    const mapped = new Map<string, DisplaySession>();
    for (const session of sessions) mapped.set(session.id, { ...session, active: false });
    for (const openSession of validOpenChatSessions) {
      const existing = mapped.get(openSession.id);
      mapped.set(openSession.id, {
        id: openSession.id,
        title: openSession.title,
        active: openSession.active,
        created: existing?.created ?? 0,
        modified: existing?.modified ?? 0,
        messageCount: existing?.messageCount ?? 0,
      });
    }
    return mapped;
  }, [sessions, validOpenChatSessions]);
  const selectedKey = selectedReference ? raindropReferenceKey(selectedReference) : null;
  const sessionReferences = savedReferences.filter((reference) => reference.kind === "session");
  const runReferences = savedReferences.filter((reference) => reference.kind === "run");

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="raindrop-title">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <BracesIcon className="size-4 text-primary" />
            <h1 id="raindrop-title" className="text-sm font-semibold">Raindrop</h1>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Autosaved DAG runs and chat sessions with a separate no-tools Pi log analyst.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-[10px] font-medium hover:bg-muted disabled:opacity-40"
          disabled={loading}
          onClick={() => setRefreshVersion((current) => current + 1)}
        >
          {loading ? <LoaderCircleIcon className="size-3 animate-spin" /> : <RefreshCwIcon className="size-3" />}
          Refresh
        </button>
      </header>

      {error ? <p role="alert" className="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</p> : null}
      {contextError ? <p role="alert" className="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{contextError}</p> : null}

      <div className="grid min-h-0 flex-1 grid-cols-[290px_minmax(0,1fr)] overflow-hidden">
        <aside className="min-h-0 overflow-auto border-r" aria-label="Autosaved Raindrop logs">
          <div className="sticky top-0 z-10 border-b bg-background px-3 py-2 text-[10px] text-muted-foreground">
            {sessionReferences.length} chat session{sessionReferences.length === 1 ? "" : "s"} · {runReferences.length} DAG run{runReferences.length === 1 ? "" : "s"}
          </div>
          {savedReferences.length === 0 && !loading ? (
            <p className="p-5 text-center text-xs text-muted-foreground">No ordinary chat sessions or native DAG runs yet.</p>
          ) : null}

          {sessionReferences.length > 0 ? (
            <div>
              <h2 className="border-b bg-muted/20 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Chat sessions</h2>
              {sessionReferences.map((reference) => {
                const session = sessionById.get(reference.id);
                const key = raindropReferenceKey(reference);
                return (
                  <button
                    key={key}
                    type="button"
                    title={reference.id}
                    aria-current={key === selectedKey ? "true" : undefined}
                    className={cn(
                      "block w-full border-b px-3 py-2.5 text-left hover:bg-muted/40",
                      key === selectedKey && "bg-muted/60",
                    )}
                    onClick={() => setSelectedReference(reference)}
                  >
                    <span className="flex items-center gap-1.5 text-[10px] font-semibold">
                      <MessageSquareTextIcon className="size-3 shrink-0" />
                      <span className="truncate">{session?.title ?? "Chat record unavailable"}</span>
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <code className="truncate">{reference.id}</code>
                      <span>{session?.active ? "active" : session ? `${session.messageCount} msgs` : "missing"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {runReferences.length > 0 ? (
            <div>
              <h2 className="border-b bg-muted/20 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">DAG runs</h2>
              {runReferences.map((reference) => {
                const run = runById.get(reference.id);
                const key = raindropReferenceKey(reference);
                return (
                  <button
                    key={key}
                    type="button"
                    title={reference.id}
                    aria-current={key === selectedKey ? "true" : undefined}
                    className={cn(
                      "block w-full border-b px-3 py-2.5 text-left hover:bg-muted/40",
                      key === selectedKey && "bg-muted/60",
                    )}
                    onClick={() => setSelectedReference(reference)}
                  >
                    <span className="flex items-center gap-1.5 text-[10px] font-semibold">
                      <NetworkIcon className="size-3 shrink-0" />
                      <code className="truncate">{reference.id}</code>
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                      <span className="truncate text-muted-foreground">{run?.workflowId ?? "Run record unavailable"}</span>
                      <span className={run ? runStatusClass(run.status) : "text-muted-foreground"}>{run?.status ?? "missing"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="shrink-0 border-b bg-muted/10 px-3 py-1.5 text-[10px] text-muted-foreground">
            {!selectedReference
              ? "Select a saved chat session or DAG run."
              : contextLoading
                ? "Validating and bounding the selected project log…"
                : contextTruncated
                  ? "Selected log projection is bounded and visibly truncated."
                  : "Selected log projection is validated and complete within its recorded bounds."}
          </div>
          <div className="min-h-0 flex-1">
            <HelperAgentChat
              key={`${projectId}:raindrop:${selectedReference ? raindropReferenceKey(selectedReference) : "none"}`}
              projectId={projectId}
              profile="raindrop"
              contextReference={contextValidated ? selectedReference ?? undefined : undefined}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
