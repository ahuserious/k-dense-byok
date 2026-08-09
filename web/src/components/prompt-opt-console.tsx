"use client";

import { PromptOptimizationInterview } from "@/components/prompt-opt-interview";

export function PromptOptimizationConsoleSurface({
  projectId,
  runId,
  nodes,
}: {
  projectId: string;
  runId: string;
  nodes: Array<{ id: string; kind: string }>;
}) {
  const promptOptimizationNodes = nodes.filter((node) => node.kind === "prompt-optimization");
  if (promptOptimizationNodes.length === 0) return null;
  return (
    <div className="shrink-0 border-b p-3">
      {promptOptimizationNodes.map((node) => (
        <PromptOptimizationInterview
          key={node.id}
          projectId={projectId}
          runId={runId}
          nodeId={node.id}
        />
      ))}
    </div>
  );
}
