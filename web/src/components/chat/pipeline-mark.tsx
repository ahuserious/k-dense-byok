// danbot-byok — web/src/components/chat/pipeline-mark.tsx
//
// Row 17's "3-connected-block logo", drawn rather than fetched.
//
// Constraints it is built to, from master brief §6.1 and §6.6:
//   - inline SVG, no raster asset, no icon-library addition;
//   - `currentColor` ONLY — no hex, no rgb, no hsl, no oklch literal — so the
//     mark inherits the token colour of whatever text it sits beside and is
//     correct in `:root` and `.dark` without a second declaration;
//   - it is never the only carrier of meaning: every use pairs it with a real
//     text label, so it ships `aria-hidden` by default and takes a `title` only
//     when a caller genuinely has no adjacent text;
//   - stroke widths are chosen so the three blocks and the two connectors stay
//     distinguishable down to 16px, which is the smallest size this repo
//     renders it at.
//
// The three blocks are one source feeding two successors: the smallest drawing
// that is actually a DAG rather than a chain, which is the thing being elevated
// TO.

import { cn } from "@/lib/utils";

export function PipelineMark({
  className,
  title,
}: {
  className?: string;
  /** Supply ONLY when there is no adjacent text label. Omit to mark decorative. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-4 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* Connectors first, so the blocks paint over the joins. */}
      <path d="M9 12h2.5a1.5 1.5 0 0 0 1.5-1.5V7.5A1.5 1.5 0 0 1 14.5 6H15" />
      <path d="M9 12h2.5a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 0 14.5 18H15" />
      <rect x="1.5" y="8.5" width="7" height="7" rx="1.75" fill="currentColor" stroke="none" />
      <rect x="15.5" y="2.5" width="7" height="7" rx="1.75" />
      <rect x="15.5" y="14.5" width="7" height="7" rx="1.75" />
    </svg>
  );
}
