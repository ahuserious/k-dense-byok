// danbot-byok — web/src/components/pipeline-builder-panel.tsx
//
// The "Pipeline Builder" view: surfaces Archon's own visual workflow builder inside Kady
// via a full-bleed iframe, rather than rebuilding it. danbot owns the chat + cost UI;
// Archon owns workflow execution and the visual builder. When the Archon sidecar is down
// the iframe would just show a connection error, so we health-gate it (matching the
// Pipelines panel) and show a small setup message instead.

"use client";

import { useCallback, useEffect, useState } from "react";
import { pipelineHealth } from "@/lib/pipelines";

// Where Archon's web UI (incl. its workflow builder) is served. Overridable so the embed
// works regardless of the port the sidecar was pinned to.
const ARCHON_URL = process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

// Archon's visual builder canvas / YAML editor — the default landing view (this is where
// Archon's "+ New pipeline" used to go).
const BUILDER_URL = `${ARCHON_URL}/legacy/workflows/builder`;

// Build the iframe src. With no workflowName we open the blank builder canvas. When a
// workflowName is passed (e.g. a future Edit affordance) we deep-link the canvas with it
// loaded — Archon's builder reads the workflow to open from the `?edit=` query param
// (WorkflowBuilder.tsx auto-loads it on mount); the name is URL-encoded to mirror Archon's
// own WorkflowCard deep-link.
function builderSrc(workflowName?: string): string {
  if (!workflowName) return BUILDER_URL;
  return `${BUILDER_URL}?edit=${encodeURIComponent(workflowName)}`;
}

export function PipelineBuilderPanel({ workflowName }: { workflowName?: string } = {}) {
  const [healthy, setHealthy] = useState<boolean | null>(null);

  const checkHealth = useCallback(async () => {
    setHealthy(null);
    setHealthy(await pipelineHealth());
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // When healthy, the iframe is full-bleed — no header chrome (title/badge/link/reload), so the
  // embedded Archon UI fills the panel. We keep the health gate so a down sidecar still shows a
  // small setup message instead of a broken cross-origin frame.
  if (healthy === false) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <p className="text-xs text-muted-foreground">
          The Pipelines engine (Archon) isn&apos;t reachable, so the builder can&apos;t load.
          Start the Archon sidecar to continue.
        </p>
      </div>
    );
  }

  return (
    <iframe
      // Keying on workflowName remounts the iframe when the edit target changes, so the canvas
      // reloads with the new ?edit= deep-link (and remounts back to the list when it clears).
      key={workflowName ?? ""}
      src={builderSrc(workflowName)}
      title="Pipeline Builder"
      className="min-h-0 w-full flex-1 border-0"
    />
  );
}
