import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceNavigation } from "./workspace-navigation";

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
});
