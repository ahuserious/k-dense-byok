// danbot-byok — web/src/components/pipelines-panel.tsx
//
// The "Pipelines" view: a native list of the workflows the Archon engine knows about,
// an engine-health indicator that degrades gracefully when Archon is down, and a link
// out to Archon's own visual workflow builder (which Kady surfaces rather than rebuilds).
// Per-pipeline actions: Run opens a fresh Kady chat and drives the pipeline there; Edit
// opens the pipeline in the embedded Pipeline Builder canvas. Both are handled by the
// page shell (page.tsx) so they can touch chat-tab + view state.

"use client";

import { useCallback, useEffect, useState } from "react";
import { listPipelines, pipelineHealth, type PipelineSummary } from "@/lib/pipelines";

// Where Archon's web UI (incl. its workflow builder) is served. Overridable so the link
// works regardless of the port the sidecar was pinned to.
const ARCHON_URL = process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

// Archon's visual builder lives under its legacy workflows route. Linking at the bare root
// would land on the redesigned console (Archon redirects "/" → "/console"), NOT the builder,
// so we point at the explicit builder path.
const BUILDER_URL = `${ARCHON_URL}/legacy/workflows/builder`;

export function PipelinesPanel({
  onRunPipeline,
  onEditPipeline,
}: {
  /** Open a new Kady chat tab and run the named pipeline in it. */
  onRunPipeline: (name: string) => void;
  /** Switch to the Pipeline Builder view with the named pipeline loaded. */
  onEditPipeline: (name: string) => void;
}) {
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
          href={BUILDER_URL}
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
            <li key={pipeline.name} className="flex items-start gap-2 rounded-md border p-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs font-medium">{pipeline.name}</div>
                {pipeline.description && (
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                    {pipeline.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onEditPipeline(pipeline.name)}
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onRunPipeline(pipeline.name)}
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
              >
                Run
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
