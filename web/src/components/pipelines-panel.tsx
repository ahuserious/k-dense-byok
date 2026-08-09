// danbot-byok — web/src/components/pipelines-panel.tsx
//
// The "Pipelines" view: a native list of workflows, an engine-health indicator
// that degrades gracefully, and a link to the embedded visual workflow builder.
// Per-pipeline actions: Run opens a fresh Kady chat and drives the pipeline there; Edit
// opens the pipeline in the embedded Pipeline Builder canvas. Both are handled by the
// page shell (page.tsx) so they can touch chat-tab + view state.

"use client";

import { useCallback, useEffect, useState } from "react";
import { listPipelines, pipelineHealth, type PipelineSummary } from "@/lib/pipelines";
import { PIPELINE_ENGINE_URL } from "@/lib/embed-config";

// The visual builder lives under the engine's legacy workflows route. Linking at the bare root
// would land on the redesigned console, not the builder,
// so we point at the explicit builder path.
const BUILDER_URL = `${PIPELINE_ENGINE_URL}/legacy/workflows/builder`;

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
    try {
      const ok = await pipelineHealth();
      setHealthy(ok);
      setPipelines(ok ? await listPipelines() : []);
    } catch {
      setHealthy(false);
      setPipelines([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">DAG Pipelines</h2>
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
          The Scientific DAG Workflow Designer isn&apos;t reachable. Start the workflow-engine sidecar, then Refresh.
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading pipelines…</p>
      ) : pipelines.length === 0 && healthy ? (
        <p className="text-xs text-muted-foreground">
          No pipelines yet. Use “Open builder” to create one.
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
