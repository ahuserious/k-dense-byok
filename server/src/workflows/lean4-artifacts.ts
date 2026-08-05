import path from "node:path";

export const KADY_LEAN_ARTIFACT_ROOT = "workflow_artifacts/dag-workflows/lean";

const WORKFLOW_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface TrustedLeanArtifactPaths {
  directory: string;
  proof: string;
  log: string;
}

function assertWorkflowIdentity(value: string, description: string): void {
  if (!WORKFLOW_IDENTITY.test(value)) {
    throw new Error(`${description} is not a canonical workflow identity.`);
  }
}

/**
 * These paths are derived by Kady from durable runner identities. They are not
 * graph-authored write permissions and are never exposed to the read-only leaf
 * agent as writable workspace paths.
 */
export function trustedLeanArtifactPaths(
  runId: string,
  executionId: string,
): TrustedLeanArtifactPaths {
  assertWorkflowIdentity(runId, "Lean run id");
  assertWorkflowIdentity(executionId, "Lean execution id");
  const directory = path.posix.join(KADY_LEAN_ARTIFACT_ROOT, runId, executionId);
  return {
    directory,
    proof: path.posix.join(directory, "Proof.lean"),
    log: path.posix.join(directory, "verification.log"),
  };
}

export function isTrustedLeanArtifactPath(
  runId: string,
  executionId: string,
  candidate: string,
): boolean {
  const expected = trustedLeanArtifactPaths(runId, executionId);
  return candidate === expected.proof || candidate === expected.log;
}
