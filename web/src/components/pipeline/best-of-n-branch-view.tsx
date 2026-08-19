// danbot-byok — web/src/components/pipeline/best-of-n-branch-view.tsx
//
// Row 33: render a real `best-of-n` run as n branches, each carrying its OWN
// candidate's live state.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO, both stated in the evidence file:
//
// 1. It is NOT React Flow. Row 33 asks for the split to be depicted "in the
//    React Flow dashboard". `@xyflow/react` is a dependency of the VENDORED
//    engine package only — `grep -n xyflow web/package.json` returns nothing —
//    and `web/package.json` is not this lane's file. The one React Flow surface
//    that exists (`WorkflowDagViewer.tsx`) renders the vendored engine's own
//    runs, whose model has no `modelCallSlots`, and the host->canvas bridge
//    vocabulary is a closed seven-message list in `HostBridge.ts`, which is
//    also not this lane's file. Requested in W/requests/c-f6-3.md.
// 2. It does NOT imply concurrency. The executor runs candidates in a
//    sequential `for` loop with `await` inside (kady-node-executor.ts:2862).
//    So the branches light up one at a time and the view SAYS so, rather than
//    drawing a fan-out that promises something the runtime does not do.
//
// #62: the run body is validated before it is rendered. `state.executions` is
// `Record<string, unknown>` on the wire, and a malformed-but-200 response
// yields an empty projection rather than throwing in render phase.
//
// §6.6: state is never carried by colour alone — every branch prints its state
// as a word, and the winner is named in text, not just tinted.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  SEQUENTIAL_CANDIDATES_NOTICE,
  projectBestOfNRuns,
  type BestOfNBranchState,
  type BestOfNProjection,
} from "@/lib/best-of-n-branches";
import {
  pageDagWorkflowRunEvents,
  readDagWorkflowRun,
  type WorkflowRunEvent,
} from "@/lib/dag-workflows";

const POLL_INTERVAL_MS = 2_000;

const BRANCH_STATE_LABEL: Record<BestOfNBranchState, string> = {
  "not-started": "not started",
  "in-flight": "running",
  resolved: "resolved",
};

/**
 * Deliberately a border weight and a word, not a hue. A dimmed or tinted row
 * is an invisible row for anyone who cannot pick the tint out, and §6.6 bans
 * expressing state through opacity.
 */
const BRANCH_STATE_BORDER: Record<BestOfNBranchState, string> = {
  "not-started": "border-l-2 border-l-border",
  "in-flight": "border-l-2 border-l-foreground",
  resolved: "border-l-2 border-l-primary",
};

export function BestOfNBranchView({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const [projections, setProjections] = useState<BestOfNProjection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const record = await readDagWorkflowRun(projectId, runId);
      let events: WorkflowRunEvent[] = [];
      try {
        const page = await pageDagWorkflowRunEvents(projectId, runId, { limit: 500 });
        events = page.events;
      } catch {
        // The winner rides on the event log; the BRANCHES do not need it. A
        // failed event page therefore degrades to "no verdict yet" rather than
        // blanking the branches the run-state call already answered for.
        events = [];
      }
      setProjections(projectBestOfNRuns(record, events));
      setError(null);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? `Could not read this run: ${caught.message}`
          : "Could not read this run.",
      );
    } finally {
      setLoaded(true);
    }
  }, [projectId, runId]);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    const timer = setInterval(() => {
      if (!stopped.current) void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, [refresh]);

  if (!loaded) {
    return (
      <p className="px-4 py-2 text-[11px] text-muted-foreground">Reading candidate state…</p>
    );
  }

  if (error !== null) {
    return (
      <p role="alert" className="px-4 py-2 text-[11px] text-destructive">
        {error} Reopen the run from Console to try again.
      </p>
    );
  }

  if (projections.length === 0) {
    // An honest empty state: this run simply has no best-of-n node, which is
    // not an error and must not read like one.
    return null;
  }

  return (
    <section
      aria-label="Best-of-n candidate branches"
      data-testid="best-of-n-branches"
      className="border-t px-4 py-2"
    >
      {projections.map((projection) => (
        <div key={projection.nodeId} className="mb-2 last:mb-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h4 className="font-mono text-[11px] font-medium">{projection.nodeName}</h4>
            <span className="text-[11px] text-muted-foreground">
              {projection.candidateCount} candidate
              {projection.candidateCount === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              · evaluator {BRANCH_STATE_LABEL[projection.evaluator.state]}
            </span>
          </div>

          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {SEQUENTIAL_CANDIDATES_NOTICE}
          </p>

          <ul className="mt-1.5 flex flex-col gap-1">
            {projection.branches.map((branch) => (
              <li
                key={branch.slotId}
                data-testid={`best-of-n-branch-${String(branch.index)}`}
                data-branch-state={branch.state}
                className={`flex flex-wrap items-baseline gap-x-2 rounded-sm bg-muted/30 py-1 pl-2 pr-2 text-[11px] ${BRANCH_STATE_BORDER[branch.state]}`}
              >
                <span className="font-mono font-medium">Candidate {branch.index}</span>
                <span className="font-mono text-muted-foreground">{branch.slotId}</span>
                <span className="text-muted-foreground">{BRANCH_STATE_LABEL[branch.state]}</span>
                {branch.score !== undefined && (
                  <span className="text-muted-foreground">score {branch.score}</span>
                )}
                {branch.winner && (
                  // Named in words, not encoded in a colour (§6.6).
                  <span className="ml-auto rounded border px-1 font-medium">★ winner</span>
                )}
              </li>
            ))}
          </ul>

          {projection.winnerIndex === undefined ? (
            <p className="mt-1 text-[10px] text-muted-foreground">
              No candidate has been chosen yet.
            </p>
          ) : (
            projection.rationale !== undefined && (
              <p className="mt-1 text-[10px] text-muted-foreground">{projection.rationale}</p>
            )
          )}
        </div>
      ))}
    </section>
  );
}
