"use client";

import { PipelineBuilderPanel } from "@/components/pipeline-builder-panel";
import type { VendoredPipelineEditTarget } from "@/lib/scientific-pipeline-registry";

export function DagBuilderSurface({
  editTarget,
}: {
  /** Pipeline to deep-link open in the vendored visual builder, if any. */
  editTarget?: VendoredPipelineEditTarget;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <PipelineBuilderPanel editTarget={editTarget} />
    </div>
  );
}
