// danbot-byok — web/src/components/pipeline-builder-panel.tsx
//
// The "Pipeline Builder" view: surfaces Archon's own visual workflow builder inside Kady
// via a full-height iframe, rather than rebuilding it. danbot owns the chat + cost UI;
// Archon owns workflow execution and the visual builder. When the Archon sidecar is down
// the iframe would just show a connection error, so we health-gate it (matching the
// Pipelines panel) and offer a link-out + reload instead.

"use client";

import { useCallback, useEffect, useState } from "react";
import { pipelineHealth } from "@/lib/pipelines";

// Where Archon's web UI (incl. its workflow builder) is served. Overridable so the embed
// works regardless of the port the sidecar was pinned to.
const ARCHON_URL = process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

// Archon's visual builder lives under its legacy workflows route.
const BUILDER_URL = `${ARCHON_URL}/legacy/workflows/builder`;

// Build the builder src, optionally deep-linking a specific workflow so the canvas opens
// with it loaded. Archon's builder reads the workflow to open from the `?edit=` query param
// (WorkflowBuilder.tsx auto-loads it on mount); the name is URL-encoded to mirror Archon's
// own WorkflowCard deep-link.
function builderSrc(workflowName?: string): string {
  if (!workflowName) return BUILDER_URL;
  return `${BUILDER_URL}?edit=${encodeURIComponent(workflowName)}`;
}

export function PipelineBuilderPanel({ workflowName }: { workflowName?: string } = {}) {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  // Bumping this key remounts the iframe, which is how you force-reload an embedded
  // cross-origin frame in React (we can't read/poke its contentWindow across origins).
  const [reloadKey, setReloadKey] = useState(0);

  const checkHealth = useCallback(async () => {
    setHealthy(null);
    setHealthy(await pipelineHealth());
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // Re-check health and remount the iframe so the builder reloads from a clean state.
  const reload = useCallback(() => {
    setReloadKey((previous) => previous + 1);
    void checkHealth();
  }, [checkHealth]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Pipeline Builder</h2>
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
          href={builderSrc(workflowName)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
        >
          Open in new tab ↗
        </a>
        <button
          type="button"
          onClick={reload}
          className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
        >
          Reload
        </button>
      </div>

      {healthy === false ? (
        <p className="text-xs text-muted-foreground">
          The Pipelines engine (Archon) isn&apos;t reachable, so the builder can&apos;t load.
          Start the Archon sidecar, then Reload — or use “Open in new tab” to reach it directly.
        </p>
      ) : (
        <iframe
          // Include workflowName in the remount key so switching which pipeline is being
          // edited reloads the canvas with the new ?edit= target.
          key={`${reloadKey}:${workflowName ?? ""}`}
          src={builderSrc(workflowName)}
          title="Pipeline Builder"
          className="min-h-0 w-full flex-1 rounded-md border"
        />
      )}
    </div>
  );
}
