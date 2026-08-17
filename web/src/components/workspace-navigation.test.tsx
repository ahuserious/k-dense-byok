import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceNavigation,
  type WorkspaceNavigationHandle,
} from "./workspace-navigation";

describe("WorkspaceNavigation", () => {
  it("renders every canonical project view and reports selections", () => {
    const onChange = vi.fn();
    render(<WorkspaceNavigation view="scientific-pipelines" onChange={onChange} />);

    for (const label of [
      "Chat",
      "Workflows",
      "Scientific Pipelines",
      "Builder",
      "Console",
      "Raindrop",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Scientific Pipelines" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: "DAG Workflows" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "DAG Pipelines" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    expect(onChange).toHaveBeenCalledWith("console");
  });

  it("focusFirst() moves the keyboard to the first primary control", () => {
    const ref = createRef<WorkspaceNavigationHandle>();
    render(<WorkspaceNavigation ref={ref} view="chat" onChange={vi.fn()} />);

    expect(document.activeElement).toBe(document.body);
    ref.current?.focusFirst();
    // "Chat" is NAVIGATION_ITEMS[0] — the first control of
    // <nav aria-label="Project workspace">, where the shell hands focus after a
    // project is opened from the picker.
    const first = screen.getByRole("button", { name: "Chat" });
    expect(document.activeElement).toBe(first);
    expect(
      screen.getByRole("navigation", { name: "Project workspace" }).contains(first),
    ).toBe(true);
  });
});
