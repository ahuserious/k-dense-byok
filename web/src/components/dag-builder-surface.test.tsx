import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pipelineBuilderProps = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/components/pipeline-builder-panel", () => ({
  PipelineBuilderPanel: (props: unknown) => {
    pipelineBuilderProps.capture(props);
    return <div data-testid="vendored-visual-builder" />;
  },
}));

import { DagBuilderSurface } from "./dag-builder-surface";

describe("DagBuilderSurface", () => {
  it("renders only the vendored visual builder and forwards the edit target", () => {
    render(<DagBuilderSurface editTarget={{
      workflowId: "microscopy-qc.yaml",
      codebaseId: "codebase-a",
    }} />);

    expect(screen.getByTestId("vendored-visual-builder")).toBeInTheDocument();
    expect(pipelineBuilderProps.capture).toHaveBeenCalledWith({
      editTarget: {
        workflowId: "microscopy-qc.yaml",
        codebaseId: "codebase-a",
      },
    });
    expect(screen.queryByRole("button", { name: "Typed builder" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("DAG Builder agent")).not.toBeInTheDocument();
  });
});
