import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkflowsPanel } from "./workflows-panel";

vi.mock("@/components/model-selector", () => ({
  DEFAULT_MODEL: {
    id: "test/model",
    label: "Test model",
    provider: "Test",
    tier: "budget",
    context_length: 1_000,
    pricing: { prompt: 0, completion: 0 },
    modality: null,
    description: "Test model",
  },
  ModelSelector: () => <div>Model selector</div>,
  modelUsesBillableBudget: () => false,
}));

vi.mock("@/lib/use-models", () => ({
  useModels: () => ({ modelAvailability: () => "available" }),
}));

describe("WorkflowsPanel template preconditions", () => {
  it("shows missing variable and file requirements and blocks launch until both exist", async () => {
    const onLaunch = vi.fn();
    const onUploadFiles = vi.fn().mockResolvedValue(["user_data/classification.csv"]);
    render(<WorkflowsPanel onLaunch={onLaunch} onUploadFiles={onUploadFiles} />);

    await userEvent.click(screen.getByRole("button", { name: /Build a Classifier/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Target class variable is required.");
    expect(screen.getByRole("alert")).toHaveTextContent("Uploaded classification dataset is required.");
    const launchButton = screen.getByRole("button", { name: "Run workflow" });
    expect(launchButton).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("Target class variable"), "outcome");
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(
      fileInput!,
      new File(["feature,target\n1,0\n"], "classification.csv", { type: "text/csv" }),
    );

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(launchButton).toBeEnabled();
    await userEvent.click(launchButton);
    expect(onLaunch).toHaveBeenCalledTimes(1);
  }, 30000);

  it("keeps the panel and its category strip inside the pane width", () => {
    const { container } = render(<WorkflowsPanel onLaunch={vi.fn()} />);

    const root = container.firstElementChild as HTMLElement;
    // The panel is the single flex child of the workspace surface wrapper; a
    // flex item keeps min-width:auto, so without this the one-row category
    // chip strip sizes the whole pane to the width of all chips.
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("max-w-full");

    const chipStrip = screen
      .getByRole("button", { name: "Paper & Manuscript" })
      .parentElement as HTMLElement;
    expect(chipStrip.className).toContain("overflow-x-auto");
    expect(chipStrip.className).toContain("min-w-0");
    expect(chipStrip.className).toContain("max-w-full");
  });
});
