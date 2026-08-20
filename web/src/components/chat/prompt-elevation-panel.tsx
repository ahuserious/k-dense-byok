// danbot-byok — web/src/components/chat/prompt-elevation-panel.tsx
//
// Master-brief row 17: the Chat entry point into F5's ONE elevate-to-DAG
// engine/API. The F5 interface is not published in this checkout, so this
// surface is intentionally disabled with the reason on screen.
//
// Do not import the Console session-promotion helper here. It emits a lossy
// agent-only graph and is not the shared row 17/26/43 elevator.
//
// §6.4: one slim, information-bearing row. §6.5: no transition or animation.
// §6.7: native disabled state plus a visible aria-describedby reason; no state
// is expressed through opacity.

"use client";

import { useId, useState } from "react";

import { PipelineMark } from "@/components/chat/pipeline-mark";
import {
  assessElevationReadiness,
  ELEVATION_QUESTION,
} from "@/lib/prompt-elevation";

export function PromptElevationPanel({ sessionId }: { sessionId: string | null }) {
  const [declined, setDeclined] = useState(false);
  const reasonId = useId();
  const readiness = assessElevationReadiness(sessionId);

  if (declined) {
    return (
      <section
        aria-label="Prompt elevation"
        className="shrink-0 border-t border-border/60 px-4 py-1.5"
      >
        <button
          type="button"
          disabled
          aria-describedby={reasonId}
          className="flex cursor-not-allowed items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          <PipelineMark className="size-4" />
          Elevate this chat to a DAG pipeline
        </button>
        <p id={reasonId} className="mt-1 text-[11px] text-muted-foreground">
          {readiness.reason}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Prompt elevation"
      className="flex shrink-0 items-start gap-2.5 border-t border-border/60 px-4 py-2"
    >
      <PipelineMark className="mt-0.5 size-5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{ELEVATION_QUESTION}</p>
        <p id={reasonId} className="mt-0.5 text-[11px] text-muted-foreground">
          {readiness.reason}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled
          aria-describedby={reasonId}
          className="cursor-not-allowed rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          Elevate
        </button>
        <button
          type="button"
          onClick={() => setDeclined(true)}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
