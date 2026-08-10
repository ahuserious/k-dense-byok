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
import type { VendoredPipelineEditTarget } from "@/lib/scientific-pipeline-registry";

// The visual builder canvas / YAML editor is the default landing view.
const BUILDER_URL = `${PIPELINE_ENGINE_URL}/legacy/workflows/builder`;

// Edit links bind both the stable workflow id and its exact registered codebase.
// Changing either value navigates the iframe, clearing any prior project's builder state.
export function builderSrc(editTarget?: VendoredPipelineEditTarget): string {
  if (!editTarget) return BUILDER_URL;
  const query = new URLSearchParams({
    edit: editTarget.workflowId,
    codebaseId: editTarget.codebaseId,
  });
  return `${BUILDER_URL}?${query.toString()}`;
}

export function PipelineBuilderPanel({
  editTarget,
}: { editTarget?: VendoredPipelineEditTarget } = {}) {
  return (
    <EngineIframePanel
      src={builderSrc(editTarget)}
      title="DAG Builder"
      healthCheck={pipelineHealth}
      engineLabel="Scientific DAG Workflow Designer"
    />
  );
}
