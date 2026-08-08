// danbot-byok — web/src/components/dag-builder-surface.tsx
//
// The "DAG Builder" view host: BOTH builders live behind an engine toggle.
//
//   - "typed"  : the target-native typed-engine builder (dag-builder.tsx),
//                unchanged and the default — today's behavior is preserved.
//   - "archon" : the ported Pipelines-engine visual builder, an iframe of the
//                vendored engine's /legacy/workflows/builder
//                (pipeline-builder-panel.tsx), deep-linked via ?edit= when the
//                DAG Pipelines list's Edit affordance routed here.
//
// The parent (page.tsx) owns the engine selection so DAG Pipelines "Edit" and
// DAG Workflows "open definition" can each force the right builder. The iframe
// panel mounts on first "archon" activation and then stays mounted (display
// toggled) so flipping engines doesn't hard-reload the embedded SPA — the same
// keep-mounted treatment PersistentWorkspaceSurfaces gives whole views.

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PipelineBuilderPanel } from "@/components/pipeline-builder-panel";

export type DagBuilderEngine = "typed" | "archon";

const ENGINE_SEGMENTS: { id: DagBuilderEngine; label: string }[] = [
  { id: "typed", label: "Typed builder" },
  { id: "archon", label: "Pipelines engine" },
];

export function DagBuilderSurface({
  engine,
  onEngineChange,
  archonWorkflowName,
  typedBuilder,
}: {
  engine: DagBuilderEngine;
  onEngineChange: (engine: DagBuilderEngine) => void;
  /** Pipeline to deep-link open in the iframe builder (?edit=), if any. */
  archonWorkflowName?: string;
  /** The native typed-engine builder, rendered by the parent with its own props. */
  typedBuilder: ReactNode;
}) {
  // Mount the iframe builder lazily, then keep it mounted across toggles.
  const [archonVisited, setArchonVisited] = useState(engine === "archon");
  useEffect(() => {
    if (engine === "archon") setArchonVisited(true);
  }, [engine]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1 font-mono">
        {ENGINE_SEGMENTS.map((segment) => (
          <button
            key={segment.id}
            type="button"
            onClick={() => onEngineChange(segment.id)}
            aria-pressed={engine === segment.id}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
              engine === segment.id
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {segment.label}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 flex-col overflow-hidden",
          engine === "typed" ? "flex" : "hidden",
        )}
      >
        {typedBuilder}
      </div>
      {archonVisited && (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col overflow-hidden",
            engine === "archon" ? "flex" : "hidden",
          )}
        >
          <PipelineBuilderPanel workflowName={archonWorkflowName} />
        </div>
      )}
    </div>
  );
}
