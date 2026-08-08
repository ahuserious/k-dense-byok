import { lazy, type ComponentType } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanvasSurfacesSection,
  type LiquidPreviewProps,
} from "./scientific-dag-studio-canvas-surfaces";

type LiquidPreviewComponent = ComponentType<LiquidPreviewProps>;

const LoadingLiquidPreview = lazy<LiquidPreviewComponent>(
  () => new Promise<{ default: LiquidPreviewComponent }>(() => undefined),
);

const FailingLiquidPreview = lazy<LiquidPreviewComponent>(() =>
  Promise.reject(new Error("Liquid registry chunk unavailable")),
);

describe("CanvasSurfacesSection Liquid fallbacks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the HTML canvas surface while Liquid is loading", () => {
    render(<CanvasSurfacesSection LiquidPreview={LoadingLiquidPreview} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "CanvasUI Liquid is loading",
    );
    expect(screen.getByText("DATASET")).toBeInTheDocument();
    expect(screen.getByText("RESULT")).toBeInTheDocument();
  });

  it("shows the HTML canvas surface when Liquid fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<CanvasSurfacesSection LiquidPreview={FailingLiquidPreview} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "CanvasUI Liquid failed to load",
    );
    expect(screen.getByText("DATASET")).toBeInTheDocument();
    expect(screen.getByText("RESULT")).toBeInTheDocument();
  });
});
