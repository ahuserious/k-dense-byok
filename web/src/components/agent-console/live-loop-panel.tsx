// danbot-byok — web/src/components/agent-console/live-loop-panel.tsx
//
// Ported from agent-control-plane's LiveLoopPanel.tsx. Shows the currently-active
// goal loop: its status, the rounds it has run, and pause/resume/stop controls.
// React-19 port: "use client", named imports from the same-origin console client
// (no import.meta.env), @/ aliased types, and the raw .panel/.pill/.badge/.banner
// CSS rebuilt with Tailwind + the ui/ Card, Badge, and Button primitives.

"use client";

import { useState } from "react";
import { pauseLoop, resumeLoop, stopLoop } from "@/lib/console";
import type { Loop, Run } from "@/lib/console-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function LiveLoopPanel({
  loop,
  runs,
  onAction,
}: {
  loop: Loop;
  runs: Run[];
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await fn();
      onAction();
    } finally {
      setBusy(false);
    }
  };

  // Kimi is flat-rate (cost is always 0), so the loop summary surfaces tokens.
  const loopTokens = runs.reduce(
    (s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );
  const canResume = ["awaiting_approval", "paused"].includes(loop.status);
  const canPause = loop.status === "running";

  return (
    <Card className="gap-4 py-4">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium">{loop.goal}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <StatusPill status={loop.status} />
              <span>·</span>
              <Badge variant="outline">{loop.mode}</Badge>
              <span>·</span>
              <span>
                round {loop.iterations}/{loop.max_iterations}
              </span>
              <span>·</span>
              <span>{loop.model}</span>
              <span>·</span>
              <span>{loopTokens.toLocaleString()} tokens</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canPause && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(() => pauseLoop(loop.id))}
              >
                Pause
              </Button>
            )}
            {canResume && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => resumeLoop(loop.id, 5),
                    "Resume this loop? It will run more paid agent rounds.",
                  )
                }
              >
                Approve &amp; resume
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              disabled={
                busy || ["completed", "stopped", "failed"].includes(loop.status)
              }
              onClick={() => act(() => stopLoop(loop.id), "Stop this loop?")}
            >
              Stop
            </Button>
          </div>
        </div>

        {loop.last_error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loop.last_error}
          </div>
        )}

        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Waiting for the first round…
          </p>
        ) : loop.mode === "orchestrated" ? (
          <OrchestratedView runs={runs} />
        ) : (
          <FlatView runs={runs} />
        )}
      </CardContent>
    </Card>
  );
}

// Orchestrated: each orchestrator decision, then the workers it spawned.
function OrchestratedView({ runs }: { runs: Run[] }) {
  const orchestrators = runs.filter((r) => r.role === "orchestrator");
  const workersByParent = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.role === "worker" && r.parent_run_id) {
      const list = workersByParent.get(r.parent_run_id) ?? [];
      list.push(r);
      workersByParent.set(r.parent_run_id, list);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {orchestrators.map((orch) => {
        const workers = workersByParent.get(orch.id) ?? [];
        return (
          <div key={orch.id} className="rounded-md border p-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="default">orchestrator</Badge>
              <span className="text-muted-foreground">round {orch.iteration}</span>
              <span className="min-w-0 flex-1">
                {orch.reasoning ||
                  (orch.status === "running"
                    ? "(deciding…)"
                    : "(no decision parsed)")}
              </span>
            </div>
            {workers.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {workers.map((w) => (
                  <li
                    key={w.id}
                    className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs"
                  >
                    <Badge variant="secondary">worker</Badge>
                    <span className="min-w-0 flex-1">{w.task}</span>
                    <span className="text-muted-foreground">{tokens(w)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Ralph: a flat list of single-agent iterations.
function FlatView({ runs }: { runs: Run[] }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {runs.map((r) => (
        <li
          key={r.id}
          className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-xs"
        >
          <span className="text-muted-foreground">#{r.iteration}</span>
          <span className="min-w-0 flex-1">
            {(r.output ?? "")
              .replace(/LOOP_STATUS:.*/i, "")
              .trim()
              .slice(0, 220) || "(running…)"}
          </span>
          <span className="text-muted-foreground">{tokens(r)}</span>
        </li>
      ))}
    </ol>
  );
}

function tokens(r: Run): string {
  if (r.input_tokens == null && r.output_tokens == null) return "-";
  return `${r.input_tokens ?? 0}/${r.output_tokens ?? 0} tok`;
}

function StatusPill({ status }: { status: Loop["status"] }) {
  const variant =
    status === "failed"
      ? "destructive"
      : status === "running"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{status.replace("_", " ")}</Badge>;
}
