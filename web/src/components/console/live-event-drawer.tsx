// danbot-byok — web/src/components/console/live-event-drawer.tsx
//
// The Console's right drawer: the ordered event list behind whatever node is
// selected in the live graph, plus the Workflow Rescue entry point for typed
// runs.
//
// The row semantics are deliberately the ones dag-workflow-console.tsx already
// uses for persisted workflow events (sequence, type, node id, attempt,
// timestamp, collapsible data) so a reader moving between the two surfaces
// reads the same thing. The list is windowed with the same range helper the
// sandbox file tree uses, because a long run can carry thousands of events.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVerticalIcon, XIcon } from "lucide-react";

import { HelperAgentChat } from "@/components/helper-agent-chat";
import { virtualTreeRange } from "@/lib/file-tree-virtualization";
import { cn } from "@/lib/utils";

export const DRAWER_ROW_HEIGHT = 56;
/** Fallback height until the drawer has been measured (jsdom has no layout). */
const DEFAULT_VIEWPORT_HEIGHT = 480;
export const MIN_DRAWER_WIDTH = 280;
export const MAX_DRAWER_WIDTH = 720;

/** One drawer row. Session frames and workflow-run events both normalize here. */
export interface LiveDrawerEvent {
  key: string;
  seq: number;
  type: string;
  /** Node/tool/execution the event belongs to, when it has one. */
  subject?: string;
  detail?: string;
  attempt?: number;
  ts?: number;
  data?: Record<string, unknown>;
}

function formatTimestamp(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return "";
  const date = new Date(ts);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "";
}

function EventRow({ event }: { event: LiveDrawerEvent }) {
  return (
    <li
      className="flex flex-col justify-center gap-0.5 border-b border-border/60 px-3"
      style={{ height: DRAWER_ROW_HEIGHT }}
      data-event-seq={event.seq}
    >
      <div className="flex min-w-0 items-center gap-2">
        <code className="shrink-0 font-mono text-[10px] text-muted-foreground">
          #{event.seq}
        </code>
        <span className="truncate text-[11px] font-semibold">{event.type}</span>
        {event.subject ? (
          <code className="shrink-0 truncate rounded bg-muted px-1 font-mono text-[10px]">
            {event.subject}
          </code>
        ) : null}
        {event.attempt ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            attempt {event.attempt}
          </span>
        ) : null}
        <time className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatTimestamp(event.ts)}
        </time>
      </div>
      {event.detail ? (
        <p className="truncate font-mono text-[10px] text-muted-foreground" title={event.detail}>
          {event.detail}
        </p>
      ) : null}
    </li>
  );
}

function VirtualizedEvents({ events }: { events: LiveDrawerEvent[] }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    // ResizeObserver delivers an initial entry on observe(), so the first
    // measurement arrives from the callback rather than synchronously here.
    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const range = virtualTreeRange(
    events.length,
    scrollTop,
    viewportHeight,
    DRAWER_ROW_HEIGHT,
    4,
  );
  const window = events.slice(range.start, range.end);

  return (
    <div
      ref={viewportRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto"
      aria-label="Ordered events"
    >
      <div style={{ height: range.totalHeight, position: "relative" }}>
        <ul style={{ transform: `translateY(${range.offsetTop}px)` }}>
          {window.map((event) => (
            <EventRow key={event.key} event={event} />
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LiveEventDrawer({
  title,
  subtitle,
  events,
  emptyMessage,
  width,
  onWidthChange,
  onClose,
  rescue,
}: {
  title: string;
  subtitle?: string;
  events: LiveDrawerEvent[];
  emptyMessage: string;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  /** Typed runs only: the proposal-only Workflow Rescue helper entry point. */
  rescue?: { projectId: string; runId: string } | null;
}) {
  // Keyed by run id so switching runs closes the panel without an effect.
  const [rescuePanel, setRescuePanel] = useState<{ runId: string | null; open: boolean }>({
    runId: null,
    open: false,
  });
  const rescueOpen = rescuePanel.runId === (rescue?.runId ?? null) && rescuePanel.open;

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (move: PointerEvent) => {
        const next = Math.min(
          MAX_DRAWER_WIDTH,
          Math.max(MIN_DRAWER_WIDTH, startWidth + (startX - move.clientX)),
        );
        onWidthChange(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onWidthChange, width],
  );

  return (
    <aside
      className="flex shrink-0 border-l border-border/60"
      style={{ width }}
      aria-label="Event drawer"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize event drawer"
        onPointerDown={startResize}
        className="flex w-2 cursor-col-resize items-center justify-center bg-transparent hover:bg-foreground/5"
      >
        <GripVerticalIcon className="size-3 text-muted-foreground/50" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold" title={title}>
              {title}
            </p>
            {subtitle ? (
              <p className="truncate font-mono text-[10px] text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close event drawer"
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </header>

        {rescue ? (
          <div className="shrink-0 border-b border-border/60 px-3 py-1.5">
            <button
              type="button"
              onClick={() =>
                setRescuePanel({ runId: rescue.runId, open: !rescueOpen })
              }
              aria-pressed={rescueOpen}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors",
                rescueOpen
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-border/70 text-muted-foreground hover:text-foreground",
              )}
            >
              Workflow Rescue
            </button>
          </div>
        ) : null}

        {rescue && rescueOpen ? (
          <div className="flex min-h-0 flex-1 flex-col" aria-label="Proposal-only workflow rescue">
            <p className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              Diagnosis only. Runner auto-rescue and persisted events remain authoritative;
              this helper cannot apply, retry, or control anything.
            </p>
            <div className="min-h-0 flex-1">
              <HelperAgentChat
                projectId={rescue.projectId}
                profile="workflow-rescue"
                contextReference={{ kind: "run", id: rescue.runId }}
              />
            </div>
          </div>
        ) : events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          <VirtualizedEvents events={events} />
        )}
      </div>
    </aside>
  );
}
