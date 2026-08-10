import { createHash } from "node:crypto";

function identitySegment(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "identity";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

/**
 * The graph-declared path is a prompt-optimization artifact namespace. Each
 * attempt gets a dedicated receipt target, so project-local concurrent runs
 * cannot replace one another's artifact bytes after verification.
 */
export function promptOptimizationArtifactPath(input: {
  declaredPath: string;
  runId: string;
  nodeId: string;
  attempt: number;
}): string {
  if (!input.declaredPath || input.declaredPath.endsWith("/")) {
    throw new Error("Prompt optimization requires a canonical artifact namespace path.");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Prompt optimization artifact paths require a positive attempt number.");
  }
  const derived = [
    input.declaredPath,
    `run-${identitySegment(input.runId)}`,
    `node-${identitySegment(input.nodeId)}`,
    `attempt-${input.attempt}.json`,
  ].join("/");
  if (derived.length > 1_024) {
    throw new Error("Prompt optimization artifact path exceeds the workflow path limit.");
  }
  return derived;
}
