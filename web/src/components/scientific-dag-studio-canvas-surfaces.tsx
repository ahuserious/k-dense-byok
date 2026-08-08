import {
  Component,
  lazy,
  Suspense,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ScientificDagStudioSection } from "./scientific-dag-studio-section";

export interface LiquidPreviewProps {
  children: ReactNode;
  rainbow?: boolean;
  style?: CSSProperties;
}

const LazyLiquidPreview = lazy(() =>
  import("./canvasui/Liquid").then((module) => ({
    default: module.Liquid,
  })),
);

export interface CanvasSurfacesSectionProps extends ComponentProps<"section"> {
  LiquidPreview?: ComponentType<LiquidPreviewProps>;
}

interface LiquidPreviewErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface LiquidPreviewErrorBoundaryState {
  failed: boolean;
}

class LiquidPreviewErrorBoundary extends Component<
  LiquidPreviewErrorBoundaryProps,
  LiquidPreviewErrorBoundaryState
> {
  state: LiquidPreviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): LiquidPreviewErrorBoundaryState {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function CanvasSurfacePreview() {
  return (
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
}

function CanvasLiquidFallback({ reason }: { reason: "loading" | "error" }) {
  return (
    <>
      <CanvasSurfacePreview />
      <p
        className="scientific-dag-studio-canvas-note"
        role={reason === "error" ? "alert" : "status"}
      >
        {reason === "error"
          ? "CanvasUI Liquid failed to load; showing the HTML canvas surface."
          : "CanvasUI Liquid is loading; showing the HTML canvas surface."}
      </p>
    </>
  );
}

export function CanvasSurfacesSection({
  LiquidPreview = LazyLiquidPreview,
  ...props
}: CanvasSurfacesSectionProps) {
  const errorFallback = <CanvasLiquidFallback reason="error" />;

  return (
    <ScientificDagStudioSection
      eyebrow="06 / Workspace"
      title="Canvas surfaces"
      {...props}
    >
      <LiquidPreviewErrorBoundary fallback={errorFallback}>
        <Suspense fallback={<CanvasLiquidFallback reason="loading" />}>
          <LiquidPreview rainbow style={{ minHeight: 220 }}>
            <CanvasSurfacePreview />
          </LiquidPreview>
        </Suspense>
      </LiquidPreviewErrorBoundary>
    </ScientificDagStudioSection>
  );
}
