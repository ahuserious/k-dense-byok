import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ScientificDagStudioLauncher } from "./scientific-dag-studio";

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
});
