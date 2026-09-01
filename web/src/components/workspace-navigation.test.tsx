import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceNavigation } from "./workspace-navigation";

describe("WorkspaceNavigation", () => {
  it("renders every canonical project view and reports selections", () => {
    const onChange = vi.fn();
    render(<WorkspaceNavigation view="dag-workflows" onChange={onChange} />);

    for (const label of [
      "Chat",
      "Workflows",
      "DAG Workflows",
      "DAG Builder",
      "Console",
      "Raindrop",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "DAG Workflows" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    expect(onChange).toHaveBeenCalledWith("console");
  });
});
