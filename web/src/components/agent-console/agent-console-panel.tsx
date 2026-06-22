// danbot-byok — web/src/components/agent-console/agent-console-panel.tsx
//
// The "Agent Console" shell, ported from agent-control-plane's App.tsx. Polls the
// same-origin console API for loops + runs every ~2s, surfaces the active loop in a
// LiveLoopPanel, exposes a StartLoopForm, and shows the flat run history.
// React-19 port: "use client", the same-origin console client (no import.meta.env),
// @/ aliased imports, and the raw .app/.header/.stats/.banner CSS rebuilt with
// Tailwind + the ui/ Card primitives.
//
// Not wired into the app nav yet — that's a later phase. This just renders standalone.

"use client";

import { useCallback, useEffect, useState } from "react";
import { listLoops, listRuns } from "@/lib/console";
import type { Loop, Run } from "@/lib/console-types";
import { LiveLoopPanel } from "@/components/agent-console/live-loop-panel";
import { RunHistoryTable } from "@/components/agent-console/run-history-table";
import { StartLoopForm } from "@/components/agent-console/start-loop-form";

const POLL_MS = 2000;

export function AgentConsolePanel() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([listLoops(), listRuns()]);
      setLoops(l);
      setRuns(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // The "live" loop is the first active one, else the most recently updated.
  const active =
    loops.find((l) =>
      ["running", "awaiting_approval", "paused", "pending"].includes(l.status),
    ) ?? loops[0];
  const activeRuns = active
    ? runs
        .filter((r) => r.loop_id === active.id)
        .sort((a, b) => a.iteration - b.iteration)
    : [];

  // Pi on a Kimi subscription is flat-rate, so cost.total is always 0.
  // Tokens are the real usage signal, so that's what the dashboard surfaces.
  const totalTokens = runs.reduce(
    (sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Agent Console</h2>
          <p className="text-xs text-muted-foreground">
            Long-running Pi loops, observed. Every run stored in the console index.
          </p>
        </div>
        <div className="flex gap-4">
          <Stat label="Loops" value={String(loops.length)} />
          <Stat label="Runs" value={String(runs.length)} />
          <Stat label="Total tokens" value={totalTokens.toLocaleString()} />
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          API error: {error}
        </div>
      )}

      <StartLoopForm onStarted={refresh} />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Live loop</h3>
        {active ? (
          <LiveLoopPanel loop={active} runs={activeRuns} onAction={refresh} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No loops yet. Start one above.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Run history</h3>
        <RunHistoryTable runs={runs} />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-base font-semibold tabular-nums">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}
