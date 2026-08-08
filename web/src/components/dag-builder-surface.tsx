"use client";

import { PipelineBuilderPanel } from "@/components/pipeline-builder-panel";

export function DagBuilderSurface({
  workflowName,
}: {
  /** Pipeline to deep-link open in the vendored visual builder, if any. */
  workflowName?: string;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <PipelineBuilderPanel workflowName={workflowName} />
    </div>
  );
}
