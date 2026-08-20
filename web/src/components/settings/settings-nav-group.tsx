"use client";

/**
 * A group heading inside the Settings rail.
 *
 * The rail is a vertical, already-scrolling `TabsList`, so eight entries was
 * never an overflow problem — it is a navigability one, and it gets worse with
 * every lane that adds a tab. Grouping costs one 10px label per group and buys a
 * structure that absorbs the next additions without another layout decision.
 *
 * `role="presentation"` matters: a `tablist` should contain tabs, and Radix's
 * roving focus only manages registered items. The heading is therefore ignored
 * by assistive tech and by keyboard navigation — arrowing through the rail still
 * visits exactly the tabs, in order, and nothing else.
 */

export function SettingsNavGroup({ label }: { label: string }) {
  return (
    <div
      role="presentation"
      className="text-muted-foreground w-full px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider first:pt-0"
    >
      {label}
    </div>
  );
}
