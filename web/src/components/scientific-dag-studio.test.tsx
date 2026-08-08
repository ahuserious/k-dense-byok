import { lazy, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ScientificDagStudioLauncher } from "./scientific-dag-studio";

vi.mock("./canvasui/Liquid", () => ({
  Liquid: ({ children }: { children: ReactNode }) => children,
}));

const loadRejectingCanvasSurfacesChunk = vi.fn(() =>
  Promise.reject(new Error("simulated outer studio chunk rejection")),
);
const RejectingCanvasSurfacesSection = lazy(loadRejectingCanvasSurfacesChunk);

describe("ScientificDagStudio", () => {
  it("traps focus, closes with Escape, and restores launcher focus", async () => {
    const user = userEvent.setup();
    render(<ScientificDagStudioLauncher />);

    const launcher = screen.getByRole("button", { name: "Components studio" });
    launcher.focus();
    await user.click(launcher);

    const dialog = await screen.findByRole("dialog", {
      name: "Components studio",
    });
    const closeButton = screen.getByRole("button", {
      name: "Close components studio",
    });
    await waitFor(() => expect(closeButton).toHaveFocus());

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
        <ScientificDagStudioLauncher />
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
        <ScientificDagStudioLauncher
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
});
