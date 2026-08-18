import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SOURCE_ROW_HEIGHT,
  SourcePicker,
  flattenSourceRows,
  windowedRange,
} from "@/components/builder/source-picker";
import type { BuilderSourceGroup } from "@/lib/builder-bridge";

/** The real library size the round-2 prompt import will push through this list. */
const LIBRARY_SIZE = 326;

function groups(librarySize = LIBRARY_SIZE): BuilderSourceGroup[] {
  return [
    {
      id: "kady-workflows",
      label: "Kady workflows",
      entries: [
        { id: "microscopy-qc", label: "Microscopy QC", description: "Bench QC", badge: "4 nodes" },
        { id: "assay-triage", label: "Assay Triage", badge: "6 nodes" },
      ],
    },
    {
      id: "workflows-library",
      label: "Workflows library",
      entries: Array.from({ length: librarySize }, (_, index) => ({
        id: `template-${index}`,
        label: `Library template ${index}`,
        description: index === 7 ? "A uniquely findable description" : "Library template",
        badge: "Literature",
      })),
    },
  ];
}

describe("flattenSourceRows", () => {
  it("emits a header per non-empty group followed by its entries", () => {
    const rows = flattenSourceRows(groups(2), "");

    expect(rows.map((row) => row.kind)).toEqual([
      "group",
      "entry",
      "entry",
      "group",
      "entry",
      "entry",
    ]);
    expect(rows[0]).toMatchObject({ label: "Kady workflows", count: 2 });
  });

  it("filters on label, description, badge, and id, dropping emptied groups", () => {
    expect(flattenSourceRows(groups(), "uniquely findable")).toHaveLength(2);
    expect(flattenSourceRows(groups(), "assay").map((row) => row.key)).toEqual([
      "group:kady-workflows",
      "kady-workflows:assay-triage",
    ]);
    // 325 is the last id, so nothing longer can contain it as a substring.
    expect(flattenSourceRows(groups(), "template-325").map((row) => row.key)).toEqual([
      "group:workflows-library",
      "workflows-library:template-325",
    ]);
    expect(flattenSourceRows(groups(), "no such workflow")).toEqual([]);
  });
});

describe("windowedRange", () => {
  it("returns an empty range for an empty list", () => {
    expect(windowedRange([0], 0, 264)).toEqual({ start: 0, end: 0 });
  });

  it("advances with the scroll position and clamps at both ends", () => {
    const offsets = Array.from({ length: 101 }, (_, index) => index * SOURCE_ROW_HEIGHT);

    expect(windowedRange(offsets, 0, 264).start).toBe(0);
    const deep = windowedRange(offsets, 40 * SOURCE_ROW_HEIGHT, 264);
    expect(deep.start).toBeGreaterThan(30);
    expect(deep.end).toBeLessThan(60);
    expect(windowedRange(offsets, 1_000_000, 264).end).toBe(100);
  });
});

describe("SourcePicker", () => {
  it("renders a windowed slice rather than all 328 rows", () => {
    render(<SourcePicker groups={groups()} onSelect={vi.fn()} />);

    const list = screen.getByTestId("source-picker-list");
    const options = within(list).getAllByRole("option");

    expect(options.length).toBeGreaterThan(0);
    // The viewport is 264px of 44px rows: a couple of screens' worth at most,
    // never the whole library.
    expect(options.length).toBeLessThan(20);
    expect(screen.getByTestId("source-picker-count")).toHaveTextContent("328 of 328 workflows");
  });

  it("narrows the list as the author types and reports the visible count", () => {
    render(<SourcePicker groups={groups()} onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Search workflow sources"), {
      target: { value: "uniquely findable" },
    });

    expect(screen.getByTestId("source-picker-count")).toHaveTextContent("1 of 328 workflows");
    expect(screen.getByRole("option", { name: /Library template 7/ })).toBeInTheDocument();
  });

  it("reports the group and entry that were chosen", () => {
    const onSelect = vi.fn();
    render(<SourcePicker groups={groups(2)} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("option", { name: /Microscopy QC/ }));

    expect(onSelect).toHaveBeenCalledWith("kady-workflows", "microscopy-qc");
  });

  it("marks the loaded workflow selected and disables the one that is loading", () => {
    render(
      <SourcePicker
        groups={groups(2)}
        selectedKey="kady-workflows:microscopy-qc"
        busyKey="kady-workflows:assay-triage"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: /Microscopy QC/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Assay Triage/ })).toBeDisabled();
  });

  it("explains an empty list instead of showing a blank box", () => {
    render(
      <SourcePicker
        groups={[{ id: "kady-workflows", label: "Kady workflows", entries: [] }]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(/No workflows yet/)).toBeInTheDocument();
    expect(screen.getByTestId("source-picker-count")).toHaveTextContent("0 of 0 workflows");
  });

  it("says which query matched nothing when the list is not empty", () => {
    render(<SourcePicker groups={groups(2)} onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Search workflow sources"), {
      target: { value: "zzz" },
    });

    expect(screen.getByText(/No workflow matches/)).toBeInTheDocument();
  });
});
