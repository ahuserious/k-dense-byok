// danbot-byok — web/src/components/pipelines-panel.tsx
//
// The "Pipelines" view: a native list of the workflows the Archon engine knows about,
// an engine-health indicator that degrades gracefully when Archon is down, and a link
// out to Archon's own visual workflow builder (which Kady surfaces rather than rebuilds).
// Editing happens in Archon's builder; danbot lists + (later) runs/monitors them natively.

"use client";

import { useCallback, useEffect, useState } from "react";
import { listPipelines, pipelineHealth, type PipelineSummary } from "@/lib/pipelines";

// Where Archon's web UI (incl. its workflow builder) is served. Overridable so the link
// works regardless of the port the sidecar was pinned to.
const ARCHON_URL = process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

export function PipelinesPanel() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const ok = await pipelineHealth();
    setHealthy(ok);
    setPipelines(ok ? await listPipelines() : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Pipelines</h2>
        <span
          className={
            "rounded px-1.5 py-0.5 text-[11px] " +
            (healthy === null
              ? "bg-muted text-muted-foreground"
              : healthy
                ? "bg-emerald-500/15 text-emerald-600"
                : "bg-red-500/15 text-red-600")
          }
        >
          {healthy === null ? "checking…" : healthy ? "engine online" : "engine offline"}
        </span>
        <a
          href={ARCHON_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
        >
          Open builder ↗
        </a>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
        >
          Refresh
        </button>
      </div>

      {healthy === false && (
        <p className="text-xs text-muted-foreground">
          The Pipelines engine (Archon) isn&apos;t reachable. Start the Archon sidecar, then Refresh.
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading pipelines…</p>
      ) : pipelines.length === 0 && healthy ? (
        <p className="text-xs text-muted-foreground">
          No pipelines yet. Use “Open builder” to create one in Archon.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pipelines.map((pipeline) => (
            <li key={pipeline.name} className="rounded-md border p-2">
              <div className="font-mono text-xs font-medium">{pipeline.name}</div>
              {pipeline.description && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                  {pipeline.description}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
