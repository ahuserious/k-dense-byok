"use client";

import { lazy, Suspense } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
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
  open: boolean;
  onClose: () => void;
}

export function ScientificDagStudio({
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
      <ScientificDagStudioContent />
    </Dialog>
  );
}

function ScientificDagStudioContent() {
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
        <Suspense
          fallback={
            <section
              aria-label="Canvas surfaces loading"
              className="scientific-dag-studio-section scientific-dag-studio-section--loading"
              data-scientific-dag-studio-theme
            >
              Loading canvas specimen…
            </section>
          }
        >
          <LazyCanvasSurfacesSection />
        </Suspense>
      </div>
    </DialogContent>
  );
}

export function ScientificDagStudioLauncher() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="scientific-dag-studio-launcher"
          data-scientific-dag-studio-theme
          type="button"
        >
          Components studio
        </button>
      </DialogTrigger>
      <ScientificDagStudioContent />
    </Dialog>
  );
}

export { ButtonsCtasSection } from "./scientific-dag-studio-buttons-ctas";
export { CanvasSurfacesSection } from "./scientific-dag-studio-canvas-surfaces";
export { ChipsBadgesSection } from "./scientific-dag-studio-chips-badges";
export { NodeCardsSection } from "./scientific-dag-studio-node-cards";
export { PaletteSection } from "./scientific-dag-studio-palette";
export { TypographySection } from "./scientific-dag-studio-typography";
