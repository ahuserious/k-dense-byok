"use client";

// RETIRED 2026-08-18 by owner direction: "there should be no components studio".
// The Components Studio has no user-facing entry point any more.
// ScientificDagStudioLauncher below is a retired no-op that renders nothing, so
// every remaining call site (web/src/components/project-view.tsx is the last one,
// and belongs to another lane) is unmounted without that lane having to change.
// The dialog itself — ScientificDagStudio and the specimen sections — stays
// exported and covered so the design reference is not lost; it is simply not
// reachable from the product.

import {
  Component,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

import { ButtonsCtasSection } from "./scientific-dag-studio-buttons-ctas";
import { ChipsBadgesSection } from "./scientific-dag-studio-chips-badges";
import { NodeCardsSection } from "./scientific-dag-studio-node-cards";
import { PaletteSection } from "./scientific-dag-studio-palette";
import { TypographySection } from "./scientific-dag-studio-typography";

const LazyCanvasSurfacesSection = lazy(() =>
  import("./scientific-dag-studio-canvas-surfaces").then((module) => ({
    default: module.CanvasSurfacesSection,
  })),
);

interface ScientificDagStudioProps {
  canvasSurfacesComponent?: ComponentType;
  open: boolean;
  onClose: () => void;
}

interface StudioChunkErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface StudioChunkErrorBoundaryState {
  failed: boolean;
}

class StudioChunkErrorBoundary extends Component<
  StudioChunkErrorBoundaryProps,
  StudioChunkErrorBoundaryState
> {
  state: StudioChunkErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): StudioChunkErrorBoundaryState {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function CanvasSurfacesChunkFallback({ failed }: { failed?: boolean }) {
  return (
    <section
      aria-label={failed ? "Canvas surfaces unavailable" : "Canvas surfaces loading"}
      className="scientific-dag-studio-section scientific-dag-studio-section--loading"
      data-scientific-dag-studio-theme
      role={failed ? "alert" : "status"}
    >
      {failed
        ? "Canvas specimen unavailable; the rest of the studio remains usable."
        : "Loading canvas specimen…"}
    </section>
  );
}

export function ScientificDagStudio({
  canvasSurfacesComponent,
  open,
  onClose,
}: ScientificDagStudioProps) {
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      open={open}
    >
      <ScientificDagStudioContent
        canvasSurfacesComponent={canvasSurfacesComponent}
      />
    </Dialog>
  );
}

function ScientificDagStudioContent({
  canvasSurfacesComponent: CanvasSurfacesComponent =
    LazyCanvasSurfacesSection,
}: Pick<ScientificDagStudioProps, "canvasSurfacesComponent">) {
  return (
    <DialogContent
      className="scientific-dag-studio-dialog"
      data-scientific-dag-studio-theme
      showCloseButton={false}
    >
      <header className="scientific-dag-studio-dialog__header">
        <div>
          <span>Scientific DAG Workflow Designer</span>
          <DialogTitle asChild>
            <h1>Components studio</h1>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Visual reference for Scientific DAG typography, colors, workflow
            nodes, status elements, actions, and canvas surfaces.
          </DialogDescription>
        </div>
        <DialogClose asChild>
          <button
            aria-label="Close components studio"
            className="scientific-dag-studio-close"
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </DialogClose>
      </header>
      <div className="scientific-dag-studio-dialog__body">
        <TypographySection />
        <PaletteSection />
        <NodeCardsSection />
        <ChipsBadgesSection />
        <ButtonsCtasSection />
        <StudioChunkErrorBoundary
          fallback={<CanvasSurfacesChunkFallback failed />}
        >
          <Suspense fallback={<CanvasSurfacesChunkFallback />}>
            <CanvasSurfacesComponent />
          </Suspense>
        </StudioChunkErrorBoundary>
      </div>
    </DialogContent>
  );
}

// RETIRED 2026-08-18: renders nothing. Kept as an export so the remaining call
// site in another lane's file keeps compiling; delete both once that lane drops
// its `{studioEnabled ? <ScientificDagStudioLauncher /> : null}` line.
export function ScientificDagStudioLauncher() {
  return null;
}

export { ButtonsCtasSection } from "./scientific-dag-studio-buttons-ctas";
export { ChipsBadgesSection } from "./scientific-dag-studio-chips-badges";
export { NodeCardsSection } from "./scientific-dag-studio-node-cards";
export { PaletteSection } from "./scientific-dag-studio-palette";
export { TypographySection } from "./scientific-dag-studio-typography";
