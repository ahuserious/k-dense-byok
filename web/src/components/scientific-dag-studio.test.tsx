import { lazy, useState, type ComponentType, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ScientificDagStudio,
  ScientificDagStudioLauncher,
} from "./scientific-dag-studio";

vi.mock("./canvasui/Liquid", () => ({
  Liquid: ({ children }: { children: ReactNode }) => children,
}));

const loadRejectingCanvasSurfacesChunk = vi.fn(() =>
  Promise.reject(new Error("simulated outer studio chunk rejection")),
);
const RejectingCanvasSurfacesSection = lazy(loadRejectingCanvasSurfacesChunk);

// RETIRED 2026-08-18: the product no longer ships a "Components studio" entry
// point, so these specimens open the dialog through a test-local trigger that
// stands in for the launcher the workspace header used to render. The dialog
// itself is still exported and still has to behave.
function StudioHarness({
  canvasSurfacesComponent,
}: {
  canvasSurfacesComponent?: ComponentType;
} = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Components studio
      </button>
      <ScientificDagStudio
        canvasSurfacesComponent={canvasSurfacesComponent}
        onClose={() => setOpen(false)}
        open={open}
      />
    </>
  );
}

describe("ScientificDagStudio", () => {
  it("traps focus and releases it when Escape closes the dialog", async () => {
    const user = userEvent.setup();
    render(<StudioHarness />);

    const launcher = screen.getByRole("button", { name: "Components studio" });
    launcher.focus();
    await user.click(launcher);

    const dialog = await screen.findByRole("dialog", {
      name: "Components studio",
    });
    const closeButton = screen.getByRole("button", {
      name: "Close components studio",
    });
    const disabledSpecimenButtons = ["Run graph", "Validate", "Save draft"].map(
      (name) => screen.getByRole("button", { name }),
    );
    await waitFor(() => expect(closeButton).toHaveFocus());

    for (const disabledSpecimenButton of disabledSpecimenButtons) {
      expect(disabledSpecimenButton).toBeDisabled();
      disabledSpecimenButton.focus();
      expect(disabledSpecimenButton).not.toHaveFocus();
    }

    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.tab();
    expect(closeButton).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The retired launcher was a DialogTrigger, so Radix used to hand focus
    // back to it. With no trigger left in the product there is nothing to
    // return to: the assertion that still matters is that the closed dialog
    // holds no focus and the surrounding page is interactive again.
    expect(dialog).not.toBeInTheDocument();
    expect(dialog).not.toContainElement(document.activeElement as HTMLElement);
    launcher.focus();
    expect(launcher).toHaveFocus();
  });

  it("prevents outside controls from receiving focus or activation", async () => {
    const user = userEvent.setup();
    const outsideActivation = vi.fn();
    render(
      <>
        <button onClick={outsideActivation} type="button">
          Outside control
        </button>
        <StudioHarness />
      </>,
    );

    await user.click(
      screen.getByRole("button", { name: "Components studio" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Components studio",
    });
    const outsideControl = screen.getByText("Outside control");
    expect(outsideControl.closest('[aria-hidden="true"]')).not.toBeNull();

    outsideControl.focus();
    await waitFor(() => {
      expect(outsideControl).not.toHaveFocus();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });

    await expect(user.click(outsideControl)).rejects.toThrow(/pointer-events/i);
    expect(outsideActivation).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("loads the outer canvas chunk only when opened and survives rejection", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(loadRejectingCanvasSurfacesChunk).not.toHaveBeenCalled();

      render(
        <StudioHarness
          canvasSurfacesComponent={RejectingCanvasSurfacesSection}
        />,
      );
      expect(loadRejectingCanvasSurfacesChunk).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole("button", { name: "Components studio" }),
      );

      expect(
        await screen.findByRole("alert", {
          name: "Canvas surfaces unavailable",
        }),
      ).toHaveTextContent(
        "Canvas specimen unavailable; the rest of the studio remains usable.",
      );
      expect(loadRejectingCanvasSurfacesChunk).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("dialog", { name: "Components studio" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Typography")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("has no launcher left: the retired entry point renders nothing at all", () => {
    // Owner, 2026-08-17: "there should be no components studio". The launcher
    // is a no-op so every call site is unmounted, including the one in another
    // lane's file that this lane may not edit.
    const { container } = render(<ScientificDagStudioLauncher />);

    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: "Components studio" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
