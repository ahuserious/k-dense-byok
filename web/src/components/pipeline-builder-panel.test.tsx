import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const iframeProps = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/components/engine-iframe-panel", () => ({
  EngineIframePanel: (props: unknown) => {
    iframeProps.capture(props);
    return <div />;
  },
}));

import { PipelineBuilderPanel } from "./pipeline-builder-panel";

describe("PipelineBuilderPanel", () => {
  it("binds same-filename edit links to the exact project codebase", () => {
    const { rerender } = render(<PipelineBuilderPanel editTarget={{
      workflowId: "shared.yaml",
      codebaseId: "codebase-a",
    }} />);
    const firstSrc = new URL(iframeProps.capture.mock.lastCall?.[0].src);
    expect(firstSrc.searchParams.get("edit")).toBe("shared.yaml");
    expect(firstSrc.searchParams.get("codebaseId")).toBe("codebase-a");

    rerender(<PipelineBuilderPanel editTarget={{
      workflowId: "shared.yaml",
      codebaseId: "codebase-b",
    }} />);
    const secondSrc = new URL(iframeProps.capture.mock.lastCall?.[0].src);
    expect(secondSrc.searchParams.get("edit")).toBe("shared.yaml");
    expect(secondSrc.searchParams.get("codebaseId")).toBe("codebase-b");
    expect(secondSrc.href).not.toBe(firstSrc.href);
  });
});
