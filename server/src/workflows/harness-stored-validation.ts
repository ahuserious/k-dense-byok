import type { WorkflowGraphDocument } from "./schema.ts";
import {
  normalizeWorkflowGraphDocument,
  validateWorkflowGraphDocument,
  type WorkflowValidationResult,
} from "./validate.ts";

const STORED_GRAPH_COMPATIBILITY_ISSUE_CODES = new Set([
  "unreachable-node-harness",
  "unreachable-inherited-harness",
]);

/**
 * Validate bytes that were accepted and persisted by an earlier release.
 *
 * Harness reachability is an authoring rule: new saves must refuse a harness
 * that the executor cannot dispatch. It is not a corruption rule. Ignoring
 * only these two diagnostics on a read keeps older definitions and immutable
 * run snapshots readable without weakening the strict authoring validator.
 *
 * This compatibility helper is intentionally not re-exported by workflows'
 * public index. Only the store's two immutable read boundaries should call it.
 */
export function validateStoredWorkflowGraphDocument(
  value: unknown,
): WorkflowValidationResult {
  const strict = validateWorkflowGraphDocument(value);
  if (strict.ok) return strict;

  const blockingIssues = strict.issues.filter(
    (issue) => !STORED_GRAPH_COMPATIBILITY_ISSUE_CODES.has(issue.code),
  );
  if (blockingIssues.length > 0) {
    return { ok: false, issues: blockingIssues };
  }

  // Only semantic reachability diagnostics survived strict validation, so the
  // value already passed WorkflowGraphDocumentSchema.
  return {
    ok: true,
    document: normalizeWorkflowGraphDocument(value as WorkflowGraphDocument),
  };
}
