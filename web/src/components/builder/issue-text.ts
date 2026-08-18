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
 * Where an issue points, in the author's terms.
 *
 * The validator's `path` is a JSON pointer into the document ("/nodes/1/name"),
 * which is precise and unreadable. A node or edge id is what the author can
 * actually find on the canvas, so it wins when the validator supplies one; the
 * pointer is the fallback rather than the headline.
 */
export function issueLocation(issue: BuilderIssue): string | null {
  if (issue.nodeId) return `node ${issue.nodeId}`;
  if (issue.edgeId) return `edge ${issue.edgeId}`;
  if (issue.path && issue.path !== "/") return issue.path;
  return null;
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
