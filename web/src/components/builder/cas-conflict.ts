// danbot-byok — web/src/components/builder/cas-conflict.ts
//
// What the builder surface may offer after a definition write loses its
// precondition.
//
// The rule this file exists to hold in one place: FORCE-OVERWRITE IS OFFERED
// ONLY WHEN THE SERVER PUBLISHED THE REVISION IT COMPARED AGAINST. With that
// revision the retry is still a conditional write; without it the only honest
// options are to reload or to save a copy. There is deliberately no code path
// that writes a workflow definition without a precondition.
//
// It lives beside the surface rather than inside it because the surface's own
// unit test belongs to another lane, and a policy this consequential must be
// covered by a test that ships with it.

import { isDagWorkflowConflict } from "@/lib/dag-workflows";

export interface CasConflictActions {
  /** Human-readable reason the write was refused. */
  detail: string;
  /**
   * The revision a force-overwrite would send as `If-Match`, or null when the
   * server published none — in which case no overwrite may be offered.
   */
  overwriteRevision: number | null;
}

/**
 * Classify a failed save. Returns null for anything that is not a lost
 * precondition, so transport and validation failures keep their own reporting
 * instead of being dressed up as a conflict the author can "resolve".
 */
export function casConflictActions(error: unknown): CasConflictActions | null {
  if (!isDagWorkflowConflict(error)) return null;
  return { detail: error.detail, overwriteRevision: error.currentRevision };
}

/** The workflow id a "save as copy" writes to, kept inside the schema's 64-char id limit. */
export function copyWorkflowId(workflowId: string): string {
  const suffixed = `${workflowId}-copy`;
  return suffixed.length <= 64 ? suffixed : `${workflowId.slice(0, 59)}-copy`;
}

/** The schema's `ShortTextSchema` bound on a workflow `name`. */
const WORKFLOW_NAME_MAX_LENGTH = 256;
const COPY_NAME_SUFFIX = " (copy)";

/**
 * The workflow NAME a "save as copy" writes.
 *
 * The id alone is not enough: every list in the product — the Kady picker, the
 * builder's own select — renders `name`, so a copy that kept its name produced
 * two rows an author could not tell apart, on the one path where they are
 * already confused about which document they are editing.
 *
 * Kept inside the schema's 256-char `name` bound, and idempotent: copying a
 * copy yields "X (copy)", not "X (copy) (copy)".
 */
export function copyWorkflowName(workflowName: string): string {
  if (workflowName.endsWith(COPY_NAME_SUFFIX)) return workflowName;
  const suffixed = `${workflowName}${COPY_NAME_SUFFIX}`;
  if (suffixed.length <= WORKFLOW_NAME_MAX_LENGTH) return suffixed;
  return `${workflowName.slice(0, WORKFLOW_NAME_MAX_LENGTH - COPY_NAME_SUFFIX.length)}${COPY_NAME_SUFFIX}`;
}
