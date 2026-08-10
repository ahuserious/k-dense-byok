"use client";

import { PromptOptimizationInterview } from "@/components/prompt-opt-interview";

export function PromptOptimizationConsoleSurface({
  projectId,
  runId,
  nodes,
  runStatus,
}: {
  projectId: string;
  runId: string;
  nodes: Array<{ id: string; kind: string }>;
  runStatus: string;
}) {
  const runActive = ["queued", "running", "waiting", "blocked", "paused"].includes(runStatus);
  const promptOptimizationNodes = nodes.filter((node) => node.kind === "prompt-optimization");
  if (!runActive || promptOptimizationNodes.length === 0) return null;
  return (
    <div className="shrink-0 border-b p-3">
      {promptOptimizationNodes.map((node) => (
        <PromptOptimizationInterview
          key={node.id}
          projectId={projectId}
          runId={runId}
          nodeId={node.id}
          runActive={runActive}
        />
      ))}
    </div>
  );
}
