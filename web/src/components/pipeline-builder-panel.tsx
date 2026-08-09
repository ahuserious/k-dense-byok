// danbot-byok — web/src/components/pipeline-builder-panel.tsx
//
// The "DAG Builder" view surfaces the Scientific DAG Workflow Designer inside Kady
// via a full-bleed iframe (the shared EngineIframePanel), rather than rebuilding it.
// Kady owns the chat + cost UI; the engine owns workflow execution and the visual
// builder. The shared panel health-gates the workflow-engine sidecar and shows a loading
// skeleton + retry instead of a blank/broken frame.

"use client";

import { EngineIframePanel } from "@/components/engine-iframe-panel";
import { PIPELINE_ENGINE_URL } from "@/lib/embed-config";
import { pipelineHealth } from "@/lib/pipelines";

// The visual builder canvas / YAML editor is the default landing view.
const BUILDER_URL = `${PIPELINE_ENGINE_URL}/legacy/workflows/builder`;

// Build the iframe src. With no workflowName we open the blank builder canvas. When a
// workflowName is passed (the Edit affordance from the DAG Pipelines list) we deep-link
// the canvas with it loaded — the builder reads the workflow to open from the
// `?edit=` query param (WorkflowBuilder.tsx auto-loads it on mount); the name is
// URL-encoded to mirror the engine's WorkflowCard deep-link. Changing the src navigates
// the iframe to the new ?edit= URL (a real load), so the canvas re-initializes — no
// component remount / key churn needed.
function builderSrc(workflowName?: string): string {
  if (!workflowName) return BUILDER_URL;
  return `${BUILDER_URL}?edit=${encodeURIComponent(workflowName)}`;
}

export function PipelineBuilderPanel({ workflowName }: { workflowName?: string } = {}) {
  return (
    <EngineIframePanel
      src={builderSrc(workflowName)}
      title="DAG Builder"
      healthCheck={pipelineHealth}
      engineLabel="Scientific DAG Workflow Designer"
    />
  );
}
