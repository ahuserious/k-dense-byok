// danbot-byok — web/src/components/console/console-panel.tsx
//
// The "Console" view host: two sub-feeds behind a toggle.
//
//   - "DAG Runs"       : the live-graph console (live-graph-console.tsx) — the
//                        left rail of everything running (typed DAG runs and
//                        chat sessions, across projects), the selected source's
//                        live graph, and the event drawer. The target-native
//                        typed-engine run console (dag-workflow-console.tsx) is
//                        unchanged and remains this surface's main area until a
//                        source is selected, so the authoritative run list,
//                        controls, and diagnostics stay exactly one click from
//                        where they have always been.
//   - "Agents & Loops" : the ported Agent Console (kady-console.tsx) — KADY's
//                        own run + goal-loop feed read from /console/runs +
//                        /console/loops (file-backed runs-index), where e.g.
//                        the /pipelines proxy's workflow rows land.
//
// Mirrors the reference's console-panel.tsx role (the Console tab's root) but
// is a real merge, not a copy: the reference had only the Agent Console; here
// it must live ALONGSIDE the native DAG-runs console (additive mandate). The
// Agent Console mounts on first visit and then stays mounted (display toggled)
// so its polling feed keeps warm across sub-tab flips.

"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { KadyConsole } from "@/components/console/kady-console";
import { LiveGraphConsole } from "@/components/console/live-graph-console";

type ConsoleFeed = "dag-runs" | "agents";

const FEED_SEGMENTS: { id: ConsoleFeed; label: string }[] = [
  { id: "dag-runs", label: "DAG Runs" },
  { id: "agents", label: "Agents & Loops" },
];

export function ConsolePanel({
  dagConsole,
}: {
  /** The native typed-engine console, rendered by the parent with its own props. */
  dagConsole: ReactNode;
}) {
  const [feed, setFeed] = useState<ConsoleFeed>("dag-runs");
  // Mount the Agent Console lazily, then keep it mounted across toggles.
  const [agentsVisited, setAgentsVisited] = useState(false);
  const selectFeed = (nextFeed: ConsoleFeed) => {
    setFeed(nextFeed);
    if (nextFeed === "agents") setAgentsVisited(true);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1 font-mono">
        {FEED_SEGMENTS.map((segment) => (
          <button
            key={segment.id}
            type="button"
            onClick={() => selectFeed(segment.id)}
            aria-pressed={feed === segment.id}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
              feed === segment.id
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {segment.label}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 flex-col overflow-hidden",
          feed === "dag-runs" ? "flex" : "hidden",
        )}
      >
        <LiveGraphConsole active={feed === "dag-runs"} runsConsole={dagConsole} />
      </div>
      {agentsVisited && (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col overflow-hidden",
            feed === "agents" ? "flex" : "hidden",
          )}
        >
          <KadyConsole />
        </div>
      )}
    </div>
  );
}
