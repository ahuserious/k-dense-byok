// danbot-byok — web/src/components/pipeline-builder-panel.tsx
//
// The "DAG Builder" view: surfaces Archon's own visual workflow builder inside Kady
// via a full-bleed iframe (the shared ArchonIframePanel), rather than rebuilding it.
// danbot owns the chat + cost UI; Archon owns workflow execution and the visual
// builder. The shared panel health-gates the Archon sidecar and shows a loading
// skeleton + retry instead of a blank/broken frame.

"use client";

import { ArchonIframePanel } from "@/components/archon-iframe-panel";
import { ARCHON_URL } from "@/lib/embed-config";
import { pipelineHealth } from "@/lib/pipelines";

// Archon's visual builder canvas / YAML editor — the default landing view (this is where
// Archon's "+ New pipeline" used to go).
const BUILDER_URL = `${ARCHON_URL}/legacy/workflows/builder`;

// Build the iframe src. With no workflowName we open the blank builder canvas. When a
// workflowName is passed (the Edit affordance from the DAG Pipelines list) we deep-link
// the canvas with it loaded — Archon's builder reads the workflow to open from the
// `?edit=` query param (WorkflowBuilder.tsx auto-loads it on mount); the name is
// URL-encoded to mirror Archon's own WorkflowCard deep-link. Changing the src navigates
// the iframe to the new ?edit= URL (a real load), so the canvas re-initializes — no
// component remount / key churn needed.
function builderSrc(workflowName?: string): string {
  if (!workflowName) return BUILDER_URL;
  return `${BUILDER_URL}?edit=${encodeURIComponent(workflowName)}`;
}

export function PipelineBuilderPanel({ workflowName }: { workflowName?: string } = {}) {
  return (
    <ArchonIframePanel
      src={builderSrc(workflowName)}
      title="DAG Builder"
      healthCheck={pipelineHealth}
      engineLabel="Pipelines engine (Archon)"
    />
  );
}
