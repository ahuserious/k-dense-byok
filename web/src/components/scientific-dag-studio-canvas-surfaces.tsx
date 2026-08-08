import type {
  ComponentProps,
  ComponentType,
  CSSProperties,
  ReactNode,
} from "react";
import { lazy, Suspense, useMemo } from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

export interface LiquidPreviewProps {
  children: ReactNode;
  rainbow?: boolean;
  style?: CSSProperties;
}

export interface CanvasSurfacesSectionProps extends ComponentProps<"section"> {
  loadLiquidPreview?: () => Promise<{
    default: ComponentType<LiquidPreviewProps>;
  }>;
}

export function CanvasSurfacesSection({
  loadLiquidPreview,
  ...props
}: CanvasSurfacesSectionProps) {
  const LazyLiquidPreview = useMemo(
    () => (loadLiquidPreview ? lazy(loadLiquidPreview) : null),
    [loadLiquidPreview],
  );
  const canvas = (
    <div className="scientific-dag-studio-canvas">
      <div className="scientific-dag-studio-canvas__grid" aria-hidden="true" />
      <div className="scientific-dag-studio-canvas__node scientific-dag-studio-canvas__node--source">
        DATASET
      </div>
      <div className="scientific-dag-studio-canvas__edge" aria-hidden="true" />
      <div className="scientific-dag-studio-canvas__node scientific-dag-studio-canvas__node--result">
        RESULT
      </div>
    </div>
  );

  return (
    <ScientificDagStudioSection
      eyebrow="06 / Workspace"
      title="Canvas surfaces"
      {...props}
    >
      {LazyLiquidPreview ? (
        <Suspense fallback={canvas}>
          <LazyLiquidPreview rainbow style={{ minHeight: 220 }}>
            {canvas}
          </LazyLiquidPreview>
        </Suspense>
      ) : (
        canvas
      )}
      {!LazyLiquidPreview ? (
        <p className="scientific-dag-studio-canvas-note" role="note">
          CanvasUI Liquid is not vendored; showing the accessible HTML fallback.
        </p>
      ) : null}
    </ScientificDagStudioSection>
  );
}
