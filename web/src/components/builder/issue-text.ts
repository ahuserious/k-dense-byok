import type { BuilderIssue } from "@/lib/builder-bridge";

/**
 * Turning validator issues into the words an author reads.
 *
 * These live outside `dag-builder-surface.tsx` for the same reason
 * `cas-conflict.ts` does: the surface is a bridge-driven React component with no
 * test renderer for its host wiring, so logic embedded in it is provable only by
 * reading it. The round that introduced these strings is the round that was told
 * a fix without a regression is protected by code review alone.
 */

/**
 * The `/nodes/<i>` or `/edges/<i>` prefix an entity id already accounts for.
 *
 * Kept as a prefix strip rather than a full parse so a pointer this does not
 * recognise survives whole: naming the node must never cost the author the
 * field, which is the half of the pointer the id cannot replace.
 */
function fieldPointer(path: string): string | null {
  if (!path || path === "/") return null;
  const withoutEntity = path.replace(/^\/(?:nodes|edges)\/\d+/, "");
  if (withoutEntity === "") return null;
  return withoutEntity;
}

/**
 * Where an issue points, in the author's terms.
 *
 * The validator's `path` is a JSON pointer into the document ("/nodes/1/name"),
 * whose array INDEX the canvas never renders — an author handed one has to
 * count nodes. `POST /dag-workflows/validate` resolves that index back to the
 * id (`issueEntityIds` in server/src/api/dag-workflows-validate.ts), and the id
 * is what the author can actually find on the canvas, so it leads.
 *
 * It does not REPLACE the pointer, it absorbs the part of it the id says
 * better: "/nodes/1/workspace/isolation" with nodeId "review-council" reads
 * `node review-council (/workspace/isolation)` — which node AND which field.
 * An issue that names no entity (`/entryNodeId`, `/nodes` itself) keeps the
 * bare pointer, and a document-root `/` has no location at all.
 */
export function issueLocation(issue: BuilderIssue): string | null {
  const entity = issue.nodeId
    ? `node ${issue.nodeId}`
    : issue.edgeId
      ? `edge ${issue.edgeId}`
      : null;
  if (entity === null) {
    if (issue.path && issue.path !== "/") return issue.path;
    return null;
  }
  const field = fieldPointer(issue.path);
  return field === null ? entity : `${entity} (${field})`;
}

/** One issue as a single line, for the status region and the pill tooltip. */
export function issueLine(issue: BuilderIssue): string {
  const location = issueLocation(issue);
  return location === null ? issue.message : `${location}: ${issue.message}`;
}

/**
 * What the status line says when validation refuses a save.
 *
 * A count alone ("3 issue(s) block this save.") tells an author how much is
 * wrong and nothing about what, which leaves undoing edits at random as the
 * only way forward. The first blocking message goes in the status line and the
 * rest are listed below it.
 *
 * The headline is the first ERROR, not simply the first issue. Today the typed
 * validator marks every issue on a refused save as an error
 * (`dag-workflows-validate.ts`), so the two are the same string; the `severity`
 * field exists so a future warning channel does not need a wire change, and on
 * that day a warning must not headline the reason a save was blocked.
 */
export function blockedSaveStatus(issues: BuilderIssue[]): string {
  const headline = issues.find((issue) => issue.severity === "error") ?? issues[0];
  if (!headline) return "This workflow cannot be saved yet.";
  const remaining = issues.length - 1;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `Cannot save — ${issueLine(headline)}${suffix}`;
}
