// danbot-byok — web/src/components/chat/baby-view-rail.tsx
//
// Master-brief row 18: a ~1 inch rail to the right of the main chat whose hover
// — and keyboard focus — opens a ~2in × 2in preview of the pipeline, as an
// overlay over the document area.
//
// SIZES, AND THE ASSUMPTION UNDER THEM. The CSS `in` unit is defined as exactly
// 96 CSS px, so "one inch" here means one inch AT THE 96 dpi CSS REFERENCE. The
// CSS pixel is a reference unit, not a physical one: on a HiDPI display the CSS
// size is unchanged while the physical size differs. The numbers:
//     ~1in  rail    = 96px  = 6rem   → `w-24`
//     ~2in² preview = 192px = 12rem  → `h-48 w-48`
// `rem`, not `px`, deliberately — a reader with a 20px root font gets a 120px
// rail and a 240px preview, which is the accessible behaviour. Tailwind's
// `w-24`/`w-48` ARE those rem values, so this is the repo's existing idiom
// rather than a hand-rolled dimension.
//
// WHAT IS LEGIBLE AT 192px, HONESTLY. The topology is: how many nodes, how they
// chain, which is terminal, whether it fans. Node NAMES are not — at 12rem a
// 7-node graph gives each node about 40px of width and a name would need type
// below this design's floor. So the drawing carries a 1-based index badge per
// node, the full names ride in `title` for the mouse and in a visually-hidden
// ordered list for assistive technology, and the counts are stated as TEXT in
// the footer so no numeric fact depends on reading the picture.
//
// §6.5 / §6.6. This hover is the master brief's one deliberate exception to the
// no-hover-expansion rule, and it is held to §6.6 in full:
//   - opens on pointer enter AND on keyboard focus (the row requires both);
//   - hover is non-modal and never steals focus; keyboard/click opening traps
//     focus between the trigger and the overlay's close control;
//   - Escape closes from either trapped control and restores the trigger;
//   - NO MOTION AT ALL. There is no `transition`, `animate`, `duration` or
//     `ease` class anywhere in this file, in any media state. That makes
//     `prefers-reduced-motion` compliance structural rather than conditional —
//     there is no animation to shorten — and it is checkable by grep. The only
//     movement is the appearance of the thing that was asked for.
//   - no state rides on `opacity`; the focus ring is a real 2px ring in
//     `--foreground`, measured at 19.80:1 (light) / 18.97:1 (dark) against the
//     rail. It is NOT `--ring`, which measures 2.48:1 against `--sidebar` in
//     light mode and would be the invisible ring §6.6 names by example.
//
// §6.8 / defect #62. Everything drawn here has been shape-checked in
// `@/lib/baby-view` before it reaches JSX, and every failure resolves to a
// designed error state whose text names the reader's next action and contains
// no filesystem path (#71).

"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { XIcon } from "lucide-react";

import { PipelineMark } from "@/components/chat/pipeline-mark";
import {
  previewSummaryLine,
  projectPipelinePreview,
  resolveCurrentPipeline,
  PIPELINE_SOURCE_LABEL,
  type CurrentPipelineResult,
} from "@/lib/baby-view";
import { cn } from "@/lib/utils";

/** How often the rail re-reads the current pipeline while its tab is visible. */
export const BABY_VIEW_POLL_MS = 10_000;

/** SVG user units. The square is drawn in a unit box and scaled by the viewBox. */
const CANVAS = 100;
const CANVAS_PADDING = 11;
const NODE_WIDTH = 17;
const NODE_HEIGHT = 12;

type PreviewOpenMode = "hover" | "keyboard" | "pointer";

function PreviewCanvas({ result }: { result: Extract<CurrentPipelineResult, { kind: "pipeline" }> }) {
  const preview = projectPipelinePreview(result.document);
  const arrowId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  if (preview.nodes.length === 0) {
    return (
      <p className="flex flex-1 items-center px-1 text-[11px] text-muted-foreground">
        This pipeline has no nodes yet.
      </p>
    );
  }

  const span = CANVAS - CANVAS_PADDING * 2;
  const toX = (unit: number) => CANVAS_PADDING + unit * span;
  const toY = (unit: number) => CANVAS_PADDING + unit * span;

  return (
    <svg
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      preserveAspectRatio="xMidYMid meet"
      className="min-h-0 flex-1 text-foreground"
      aria-hidden
      focusable="false"
    >
      <defs>
        <marker
          id={`baby-view-arrow-${arrowId}`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
        </marker>
      </defs>
      {preview.edges.map((edge) => (
        <line
          key={edge.id}
          x1={toX(edge.x1)}
          y1={toY(edge.y1)}
          x2={toX(edge.x2)}
          y2={toY(edge.y2)}
          stroke="currentColor"
          strokeWidth="1"
          strokeOpacity="1"
          markerEnd={`url(#baby-view-arrow-${arrowId})`}
        />
      ))}
      {preview.nodes.map((node) => (
        <g key={node.id}>
          <title>{`${node.index}. ${node.label} (${node.kind}${node.terminal ? ", terminal" : ""})`}</title>
          <rect
            x={toX(node.x) - NODE_WIDTH / 2}
            y={toY(node.y) - NODE_HEIGHT / 2}
            width={NODE_WIDTH}
            height={NODE_HEIGHT}
            rx="3"
            fill="currentColor"
            fillOpacity="0.08"
            stroke="currentColor"
            // Terminal is carried by outline WEIGHT, never by colour alone
            // (§6.6), and is restated in words in the hidden list below.
            strokeWidth={node.terminal ? 2 : 1}
          />
          <text
            x={toX(node.x)}
            y={toY(node.y)}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="7"
            fill="currentColor"
          >
            {node.index}
          </text>
        </g>
      ))}
    </svg>
  );
}

function PreviewBody({
  result,
  listId,
}: {
  result: CurrentPipelineResult | null;
  listId: string;
}) {
  if (result === null) {
    return (
      <p className="flex flex-1 items-center px-1 text-[11px] text-muted-foreground">
        Reading this project&rsquo;s pipelines…
      </p>
    );
  }
  if (result.kind === "error") {
    return (
      <p className="flex flex-1 items-center px-1 text-[11px] text-foreground">{result.message}</p>
    );
  }
  if (result.kind === "none") {
    return (
      <p className="flex flex-1 items-center px-1 text-[11px] text-muted-foreground">
        {result.reason}
      </p>
    );
  }

  const preview = projectPipelinePreview(result.document);
  return (
    <>
      <PreviewCanvas result={result} />
      {/* The content the pixels cannot carry at this size. `sr-only` keeps it
          out of the drawing without hiding it from assistive technology — this
          is the answer to "node names are not legible at 192px", not an
          apology for it. */}
      <ol id={listId} className="sr-only">
        {preview.nodes.map((node) => (
          <li key={node.id}>
            {`${node.index}. ${node.label} — ${node.kind}${node.terminal ? ", terminal" : ""}`}
          </li>
        ))}
      </ol>
      <p className="shrink-0 truncate pt-1 font-mono text-[10px] text-muted-foreground">
        {previewSummaryLine(preview, result.revision)}
      </p>
    </>
  );
}

export function ChatSideRail({
  projectId,
  sessionId,
  enabled,
}: {
  projectId: string;
  sessionId: string | null;
  /** False while the tab is hidden — a hidden tab must not poll. */
  enabled: boolean;
}) {
  const [result, setResult] = useState<CurrentPipelineResult | null>(null);
  const [openMode, setOpenMode] = useState<PreviewOpenMode | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const pointerDownRef = useRef(false);
  const restoringFocusRef = useRef(false);
  const overlayId = useId();
  const listId = `${overlayId}-nodes`;
  const summaryId = `${overlayId}-summary`;
  const open = openMode !== null;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const read = async () => {
      const next = await resolveCurrentPipeline(projectId, sessionId);
      if (!cancelled) setResult(next);
    };

    void read();
    const timer = setInterval(() => void read(), BABY_VIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, projectId, sessionId]);

  // Pointer and focus both leave through here. The containment check keeps the
  // preview open while the reader moves onto it — the overlay sits outside the
  // rail's box but inside its subtree, so `contains` is the right question and
  // the element's own bounds are not.
  const closeIfLeaving = useCallback((related: EventTarget | null) => {
    if (related instanceof Node && wrapperRef.current?.contains(related)) return;
    setOpenMode(null);
  }, []);

  const closeAndRestore = useCallback(() => {
    setOpenMode(null);
    // Focus after React commits the closed state. Keeping this out of render is
    // the same ref/effect boundary React documents for DOM focus management.
    if (document.activeElement === triggerRef.current) {
      restoringFocusRef.current = false;
      return;
    }
    restoringFocusRef.current = true;
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  /**
   * Keyboard and click-opened previews are modal to focus: Tab cycles between
   * the trigger and the overlay's close button. Hover remains non-modal and
   * never steals focus from the document beneath it.
   */
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (openMode === null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestore();
        return;
      }
      if (event.key !== "Tab" || openMode === "hover") return;

      const trigger = triggerRef.current;
      const closeButton = closeButtonRef.current;
      if (!trigger || !closeButton) return;

      if (event.shiftKey && document.activeElement === trigger) {
        event.preventDefault();
        closeButton.focus();
      } else if (!event.shiftKey && document.activeElement === closeButton) {
        event.preventDefault();
        trigger.focus();
      }
    },
    [closeAndRestore, openMode],
  );

  const pipelineName =
    result !== null && result.kind === "pipeline" ? result.document.name : "";
  const nodeCount =
    result !== null && result.kind === "pipeline" ? projectPipelinePreview(result.document).nodeCount : 0;
  const sourceLabel =
    result !== null && result.kind === "pipeline" ? PIPELINE_SOURCE_LABEL[result.source] : "";

  // The trigger's accessible description is a STATE, not the full sentence the
  // overlay carries. Repeating the reason here made a screen reader announce it
  // twice — once on focus and again when the overlay it opened was read — which
  // is noise, not access. The reason itself stays visible in the overlay, where
  // §6.7 requires it.
  const summary =
    result === null
      ? "Reading this project's pipelines."
      : result.kind === "pipeline"
        ? `${pipelineName}. ${sourceLabel}. ${nodeCount} node${nodeCount === 1 ? "" : "s"}.`
        : result.kind === "none"
          ? "No pipeline to preview yet."
          : "The pipeline preview is unavailable.";

  return (
    <div
      ref={wrapperRef}
      // `w-24` = 6rem = 96px = ~1in at the 96dpi CSS reference. See the header.
      className="relative flex w-24 shrink-0 flex-col border-l border-border/60 bg-sidebar"
      onPointerEnter={() => {
        if (openMode === null) setOpenMode("hover");
      }}
      onPointerLeave={(event) => {
        if (openMode === "hover") closeIfLeaving(event.relatedTarget);
      }}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={overlayId}
        aria-describedby={summaryId}
        onPointerDown={() => {
          pointerDownRef.current = true;
        }}
        onPointerCancel={() => {
          pointerDownRef.current = false;
        }}
        onFocus={() => {
          if (restoringFocusRef.current) {
            restoringFocusRef.current = false;
            return;
          }
          if (!pointerDownRef.current) setOpenMode("keyboard");
        }}
        onBlur={(event) => {
          if (openMode === "hover") closeIfLeaving(event.relatedTarget);
        }}
        onClick={() => {
          // A keyboard click follows focus, which already opened keyboard mode.
          // Only pointer activation toggles pointer-persistent mode.
          if (!pointerDownRef.current) return;
          pointerDownRef.current = false;
          setOpenMode((previous) => (previous === "pointer" ? null : "pointer"));
        }}
        className="flex flex-col items-center gap-1 px-1.5 py-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground"
      >
        <PipelineMark className="size-5 text-foreground" />
        <span className="font-mono text-sm leading-none text-foreground">
          {result !== null && result.kind === "pipeline" ? nodeCount : "—"}
        </span>
        <span className="text-[10px] leading-tight text-muted-foreground">Pipeline preview</span>
      </button>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>

      {open && (
        <div
          id={overlayId}
          role="dialog"
          aria-modal={openMode !== "hover"}
          aria-label="Pipeline preview"
          onFocusCapture={() => {
            if (openMode === "hover") setOpenMode("keyboard");
          }}
          // `right-full` puts the square over the document area to the LEFT of
          // the rail, which is what "an overlay over the document area" means
          // for a rail on the right. `h-48 w-48` = 12rem = 192px = ~2in² at the
          // 96dpi CSS reference.
          className={cn(
            "absolute right-full top-2 z-50 mr-1 flex h-48 w-48 flex-col",
            // `border-border` measures 1.26:1 against `--background` in light mode —
            // an invisible boundary for a surface that floats over content.
            // `--muted-foreground` measures 4.74:1 there and 7.66:1 dark.
            "rounded-lg border border-muted-foreground bg-popover p-2 text-popover-foreground shadow-md",
          )}
        >
          <div className="flex shrink-0 items-start gap-1">
            <p className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
              {result !== null && result.kind === "pipeline" ? pipelineName : "Pipeline preview"}
            </p>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close pipeline preview"
              onClick={closeAndRestore}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </div>
          {result !== null && result.kind === "pipeline" && (
            <p className="shrink-0 truncate text-[10px] text-muted-foreground">{sourceLabel}</p>
          )}
          <PreviewBody result={result} listId={listId} />
        </div>
      )}
    </div>
  );
}
