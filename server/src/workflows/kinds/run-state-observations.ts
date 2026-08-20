import type { RunStateV1 } from "../run-state.ts";

/**
 * Project `nodes[].recruitment` / `nodes[].branches` from a node's durable
 * output. Kept off `workflows/index.ts` so the typed-export snapshot stays
 * unchanged. INTEGRATION.md tells the orchestrator to import this from here.
 */
export function runStateNodeObservations(output: unknown): {
  recruitment?: RunStateV1["nodes"][number]["recruitment"];
  branches?: RunStateV1["nodes"][number]["branches"];
} {
  if (!output || typeof output !== "object" || Array.isArray(output)) return {};
  const record = output as Record<string, unknown>;
  const extras: {
    recruitment?: RunStateV1["nodes"][number]["recruitment"];
    branches?: RunStateV1["nodes"][number]["branches"];
  } = {};
  const recruitment = record.recruitment;
  if (
    recruitment &&
    typeof recruitment === "object" &&
    !Array.isArray(recruitment) &&
    Number.isInteger((recruitment as { recruited?: unknown }).recruited) &&
    Number.isInteger((recruitment as { maxRecruits?: unknown }).maxRecruits)
  ) {
    const recruited = (recruitment as { recruited: number }).recruited;
    const maxRecruits = (recruitment as { maxRecruits: number }).maxRecruits;
    const reason = (recruitment as { reason?: unknown }).reason;
    extras.recruitment = {
      recruited,
      maxRecruits,
      ...(typeof reason === "string" && reason.length > 0 ? { reason: reason.slice(0, 256) } : {}),
    };
  }
  const branches = record.branches;
  if (Array.isArray(branches)) {
    extras.branches = branches.slice(0, 32).flatMap((branch) => {
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) return [];
      const item = branch as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.status !== "string") return [];
      return [{
        id: item.id,
        status: item.status as RunStateV1["nodes"][number]["status"],
        ...(typeof item.label === "string" ? { label: item.label.slice(0, 256) } : {}),
        ...(typeof item.executionId === "string" ? { executionId: item.executionId } : {}),
      }];
    });
  }
  return extras;
}
