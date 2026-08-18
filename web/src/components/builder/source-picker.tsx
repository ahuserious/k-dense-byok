// danbot-byok — web/src/components/builder/source-picker.tsx
//
// The direct fix for "none of the workflows have loaded".
//
// The vendored builder's own "Load pipeline" select enumerates engine YAML on
// disk and nothing else, so in a hermetic preview it is empty. This picker is
// rendered in KADY chrome above the iframe, is fed by the Kady host, and lists
// the workflows the owner actually has: typed Kady workflows and the workflow
// library. The same groups are pushed over the bridge so the in-iframe select
// renders them too.
//
// Search and virtualization are not polish. The library group alone will carry
// 300+ entries once round 2 lands the prompt-library import, and an unfiltered,
// fully-rendered list is not usable at that size — so the list renders a
// windowed slice from the start and `source-picker.test.tsx` holds it to that
// at 326 entries.

"use client";

import { SearchIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { BuilderSourceGroup } from "@/lib/builder-bridge";
import { cn } from "@/lib/utils";

/** Row height in px. Fixed, so the windowing maths needs no measurement pass. */
export const SOURCE_ROW_HEIGHT = 44;
const GROUP_HEADER_HEIGHT = 24;
const VIEWPORT_HEIGHT = 264;
/** Rows rendered above and below the viewport so a fast scroll shows no gap. */
const OVERSCAN_ROWS = 4;

type FlatRow =
  | { kind: "group"; key: string; label: string; count: number }
  | {
      kind: "entry";
      key: string;
      groupId: BuilderSourceGroup["id"];
      entryId: string;
      label: string;
      description?: string;
      badge?: string;
    };

function matches(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && haystack.toLowerCase().includes(needle);
}

/**
 * Flatten the grouped list into rows, dropping groups a filter empties.
 *
 * Exported so the picker's windowing can be tested without a DOM: the
 * expensive part of a 300+ entry list is this projection plus how many rows
 * reach React, not the styling.
 */
export function flattenSourceRows(
  groups: readonly BuilderSourceGroup[],
  query: string,
): FlatRow[] {
  const needle = query.trim().toLowerCase();
  const rows: FlatRow[] = [];
  for (const group of groups) {
    const entries = needle
      ? group.entries.filter(
          (entry) =>
            matches(entry.label, needle)
            || matches(entry.description, needle)
            || matches(entry.badge, needle)
            || matches(entry.id, needle),
        )
      : group.entries;
    if (entries.length === 0) continue;
    rows.push({ kind: "group", key: `group:${group.id}`, label: group.label, count: entries.length });
    for (const entry of entries) {
      rows.push({
        kind: "entry",
        key: `${group.id}:${entry.id}`,
        groupId: group.id,
        entryId: entry.id,
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.badge ? { badge: entry.badge } : {}),
      });
    }
  }
  return rows;
}

function rowHeight(row: FlatRow): number {
  return row.kind === "group" ? GROUP_HEADER_HEIGHT : SOURCE_ROW_HEIGHT;
}

/** Running offsets, so a scroll position maps to a row index without a loop per frame. */
function rowOffsets(rows: readonly FlatRow[]): number[] {
  const offsets: number[] = [0];
  for (const row of rows) offsets.push(offsets[offsets.length - 1] + rowHeight(row));
  return offsets;
}

export function windowedRange(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return { start: 0, end: 0 };
  let start = 0;
  while (start < rowCount && offsets[start + 1] <= scrollTop) start += 1;
  let end = start;
  while (end < rowCount && offsets[end] < scrollTop + viewportHeight) end += 1;
  return {
    start: Math.max(0, start - OVERSCAN_ROWS),
    end: Math.min(rowCount, end + OVERSCAN_ROWS),
  };
}

export function SourcePicker({
  groups,
  selectedKey,
  busyKey,
  disabled = false,
  onSelect,
}: {
  groups: readonly BuilderSourceGroup[];
  /** `<groupId>:<entryId>` of the workflow currently on the canvas. */
  selectedKey?: string | null;
  /** `<groupId>:<entryId>` currently loading. */
  busyKey?: string | null;
  disabled?: boolean;
  onSelect: (groupId: BuilderSourceGroup["id"], entryId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => flattenSourceRows(groups, query), [groups, query]);
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  const totalHeight = offsets[offsets.length - 1] ?? 0;
  const { start, end } = useMemo(
    () => windowedRange(offsets, scrollTop, VIEWPORT_HEIGHT),
    [offsets, scrollTop],
  );

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  // A new filter must not leave the viewport scrolled past the shorter list.
  // Done in the event handler rather than an effect so there is no second
  // render pass between typing and the correctly-windowed list.
  const onQueryChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, []);

  const totalEntries = groups.reduce((count, group) => count + group.entries.length, 0);
  const shownEntries = rows.filter((row) => row.kind === "entry").length;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="relative flex items-center">
        <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
        <span className="sr-only">Search workflow sources</span>
        <input
          type="search"
          value={query}
          onChange={onQueryChange}
          placeholder="Search workflows…"
          aria-label="Search workflow sources"
          className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="listbox"
        aria-label="Workflow sources"
        data-testid="source-picker-list"
        className="overflow-y-auto rounded-md border"
        style={{ height: VIEWPORT_HEIGHT }}
      >
        {rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {totalEntries === 0
              ? "No workflows yet. Create one in Scientific Pipelines, or pick a library template once one is available."
              : `No workflow matches “${query}”.`}
          </p>
        ) : (
          <div style={{ height: totalHeight, position: "relative" }}>
            {rows.slice(start, end).map((row, index) => {
              const absolute = start + index;
              const top = offsets[absolute];
              if (row.kind === "group") {
                return (
                  <div
                    key={row.key}
                    role="presentation"
                    style={{ position: "absolute", top, height: GROUP_HEADER_HEIGHT, left: 0, right: 0 }}
                    className="flex items-center gap-1.5 bg-muted/40 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {row.label}
                    <span className="font-normal normal-case tracking-normal">({row.count})</span>
                  </div>
                );
              }
              const isSelected = selectedKey === row.key;
              const isBusy = busyKey === row.key;
              return (
                <button
                  key={row.key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={disabled || isBusy}
                  onClick={() => onSelect(row.groupId, row.entryId)}
                  style={{ position: "absolute", top, height: SOURCE_ROW_HEIGHT, left: 0, right: 0 }}
                  className={cn(
                    "flex w-full flex-col justify-center gap-0.5 px-2 text-left transition-colors",
                    "hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60",
                    isSelected && "bg-muted",
                  )}
                >
                  <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                    {row.label}
                    {row.badge && (
                      <span className="shrink-0 rounded border px-1 text-[10px] font-normal text-muted-foreground">
                        {row.badge}
                      </span>
                    )}
                    {isBusy && <span className="text-[10px] text-muted-foreground">loading…</span>}
                  </span>
                  {row.description && (
                    <span className="truncate text-[11px] text-muted-foreground">{row.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground" data-testid="source-picker-count">
        {shownEntries} of {totalEntries} workflows
      </p>
    </div>
  );
}
