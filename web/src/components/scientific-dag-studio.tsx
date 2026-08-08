"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ScientificDagStudioProps {
  open: boolean;
  onClose: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

export function ScientificDagStudio({
  open,
  onClose,
}: ScientificDagStudioProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const firstFocusable = dialog ? focusableElements(dialog)[0] : null;
    (firstFocusable ?? dialog)?.focus();

    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab" || !dialogRef.current) return;

    const elements = focusableElements(dialogRef.current);
    if (elements.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }

    const firstElement = elements[0];
    const lastElement = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  return createPortal(
    <div
      className="scientific-dag-studio-backdrop"
      data-scientific-dag-studio-theme
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby="scientific-dag-studio-title"
        aria-modal="true"
        className="scientific-dag-studio-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="scientific-dag-studio-dialog__header">
          <div>
            <span>Scientific DAG Workflow Designer</span>
            <h1 id="scientific-dag-studio-title">Components studio</h1>
          </div>
          <button
            aria-label="Close components studio"
            className="scientific-dag-studio-close"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
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
      </div>
    </div>,
    document.body,
  );
}

export function ScientificDagStudioLauncher() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="scientific-dag-studio-launcher"
        data-scientific-dag-studio-theme
        onClick={() => setOpen(true)}
        type="button"
      >
        Components studio
      </button>
      <ScientificDagStudio onClose={() => setOpen(false)} open={open} />
    </>
  );
}

export { ButtonsCtasSection } from "./scientific-dag-studio-buttons-ctas";
export { CanvasSurfacesSection } from "./scientific-dag-studio-canvas-surfaces";
export { ChipsBadgesSection } from "./scientific-dag-studio-chips-badges";
export { NodeCardsSection } from "./scientific-dag-studio-node-cards";
export { PaletteSection } from "./scientific-dag-studio-palette";
export { TypographySection } from "./scientific-dag-studio-typography";
