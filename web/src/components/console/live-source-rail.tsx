// danbot-byok — web/src/components/console/live-source-rail.tsx
//
// The Console's left rail: every piece of work this browser can see running,
// in two sections (DAG runs / Sessions). Slim Raindrop-style chrome — hairline
// borders, small mono labels, no card shadows.
//
// The rail is presentational: discovery, polling, and ordering live in
// lib/console-live-sources.ts. It renders whatever it is handed, and when that
// is nothing it says *why* rather than spinning forever.

"use client";

import { SearchIcon } from "lucide-react";

import {
  formatElapsed,
  railSections,
  type LiveSource,
  type LiveSourceOrigin,
  type LiveSourceStatus,
} from "@/lib/console-live-sources";
import { cn } from "@/lib/utils";

const STATUS_DOT: Record<LiveSourceStatus, string> = {
  unknown: "bg-transparent ring-1 ring-inset ring-zinc-500",
  queued: "bg-amber-500",
  running: "bg-cyan-500",
  idle: "bg-zinc-500",
  ok: "bg-emerald-500",
  error: "bg-destructive",
  cancelled: "bg-zinc-600",
};

/**
 * What the row SAYS. Every other status is an observation and reads as itself;
 * `unknown` is the absence of one, so it must not be spelled with a word that
 * asserts something. "idle" here was a positive false statement about the 9th
 * open chat — it sat outside the run-state probe cap and was never asked.
 */
const STATUS_LABEL: Record<LiveSourceStatus, string> = {
  unknown: "not checked",
  queued: "queued",
  running: "running",
  idle: "idle",
  ok: "ok",
  error: "error",
  cancelled: "cancelled",
};

const STATUS_TITLE: Partial<Record<LiveSourceStatus, string>> = {
  unknown:
    "Outside the run-state probe budget, so the Console has not asked whether this chat is running. Select it to watch it live.",
};

const ORIGIN_LABEL: Record<LiveSourceOrigin, string> = {
  "dag-run": "run",
  "active-run": "active",
  "open-tab": "open tab",
  recent: "recent",
};

function SourceRow({
  source,
  selected,
  now,
  onSelect,
}: {
  source: LiveSource;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        data-source-key={source.key}
        className={cn(
          "flex w-full flex-col gap-1 border-b border-border/60 px-3 py-2 text-left transition-colors",
          selected ? "bg-foreground/10" : "hover:bg-foreground/5",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_DOT[source.status],
              source.live && "animate-pulse",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={source.title}>
            {source.title}
          </span>
          {source.live && (
            <span className="shrink-0 rounded border border-cyan-500/40 px-1 font-mono text-[9px] uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
              live
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <span className="truncate rounded border border-border/70 px-1" title={source.projectName}>
            {source.projectName}
          </span>
          <span
            data-status={source.status}
            {...(STATUS_TITLE[source.status] ? { title: STATUS_TITLE[source.status] } : {})}
          >
            {STATUS_LABEL[source.status]}
          </span>
          <span className="ml-auto shrink-0">
            {formatElapsed(now - source.lastActivityAt)}
          </span>
        </span>
        <span className="flex flex-wrap gap-1 font-mono text-[9px] text-muted-foreground/80">
          {source.origins.map((origin) => (
            <span key={origin}>{ORIGIN_LABEL[origin]}</span>
          ))}
        </span>
      </button>
    </li>
  );
}

function Section({
  label,
  sources,
  selectedKey,
  now,
  onSelect,
}: {
  label: string;
  sources: LiveSource[];
  selectedKey: string | null;
  now: number;
  onSelect: (source: LiveSource) => void;
}) {
  return (
    <section aria-label={label}>
      <h3 className="sticky top-0 border-b border-border/60 bg-background px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
        <span className="ml-1.5 text-muted-foreground/70">{sources.length}</span>
      </h3>
      {sources.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">None.</p>
      ) : (
        <ul>
          {sources.map((source) => (
            <SourceRow
              key={source.key}
              source={source}
              selected={source.key === selectedKey}
              now={now}
              onSelect={() => onSelect(source)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function LiveSourceRail({
  sources,
  selectedKey,
  onSelect,
  query,
  onQueryChange,
  allProjects,
  onAllProjectsChange,
  error,
  notices,
  deepLinkNotice,
  emptyMessage,
  now,
}: {
  sources: LiveSource[];
  selectedKey: string | null;
  onSelect: (source: LiveSource) => void;
  query: string;
  onQueryChange: (query: string) => void;
  allProjects: boolean;
  onAllProjectsChange: (allProjects: boolean) => void;
  error: string | null;
  /** What discovery could not do this tick ("couldn't read 2 projects"). */
  notices: string[];
  /** A `?run=`/`?session=` link discovery could not resolve, if any. */
  deepLinkNotice: string | null;
  emptyMessage: string;
  now: number;
}) {
  const { runs, sessions } = railSections(sources);
  return (
    <aside
      className="flex w-[280px] shrink-0 flex-col border-r border-border/60"
      aria-label="Live work"
    >
      <div className="shrink-0 space-y-2 border-b border-border/60 p-2">
        <label className="flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1">
          <SearchIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search runs and sessions"
            aria-label="Search live work"
            className="w-full bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        <button
          type="button"
          onClick={() => onAllProjectsChange(!allProjects)}
          aria-pressed={allProjects}
          className={cn(
            "rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors",
            allProjects
              ? "border-foreground/30 bg-foreground/10 text-foreground"
              : "border-border/70 text-muted-foreground hover:text-foreground",
          )}
        >
          {allProjects ? "All projects" : "This project"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p role="alert" className="border-b border-border/60 px-3 py-2 text-[11px] text-destructive">
            Discovery failed: {error}
          </p>
        )}
        {notices.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-1.5">
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
        {deepLinkNotice && (
          <p className="border-b border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {deepLinkNotice}
          </p>
        )}
        {sources.length === 0 ? (
          // "Nothing is running" is a claim about the whole workspace, so it
          // must never be printed on top of a failed discovery tick — the honest
          // statement there is that we could not look.
          <p className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
            {error === null
              ? emptyMessage
              : "Discovery failed, so this list is not a statement about what is running. Retrying with backoff."}
          </p>
        ) : (
          <>
            <Section
              label="DAG runs"
              sources={runs}
              selectedKey={selectedKey}
              now={now}
              onSelect={onSelect}
            />
            <Section
              label="Sessions"
              sources={sessions}
              selectedKey={selectedKey}
              now={now}
              onSelect={onSelect}
            />
          </>
        )}
      </div>
    </aside>
  );
}
