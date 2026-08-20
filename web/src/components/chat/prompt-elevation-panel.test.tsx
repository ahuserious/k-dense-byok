import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptElevationPanel } from "./prompt-elevation-panel";
import {
  ELEVATION_API_UNAVAILABLE_REASON,
  ELEVATION_QUESTION,
  NO_SESSION_REASON,
} from "@/lib/prompt-elevation";

function renderPanel(overrides: Partial<Parameters<typeof PromptElevationPanel>[0]> = {}) {
  return render(
    <PromptElevationPanel
      sessionId="session-a"
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PromptElevationPanel — Gate U, the affordance", () => {
  it("asks the master brief's question and offers both answers", () => {
    renderPanel();
    expect(screen.getByRole("region", { name: "Prompt elevation" })).toBeInTheDocument();
    expect(screen.getByText(ELEVATION_QUESTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elevate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
  });

  it("renders the 3-connected-block mark without making it the only carrier of meaning", () => {
    const { container } = renderPanel();
    const mark = container.querySelector("svg");
    expect(mark).not.toBeNull();
    // Three blocks, two connectors.
    expect(mark?.querySelectorAll("rect")).toHaveLength(3);
    expect(mark?.querySelectorAll("path")).toHaveLength(2);
    // Decorative beside a real text label, per §6.6.
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("declining keeps the disabled entry point and its reason reachable", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(ELEVATION_QUESTION)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Elevate this chat to a DAG pipeline" }),
    ).toBeDisabled();
    expect(screen.getByText(ELEVATION_API_UNAVAILABLE_REASON)).toBeVisible();
  });

  it("is operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    renderPanel();
    // Native-disabled controls correctly leave the tab order; the visible
    // reason is read with the panel, and the next live action is Not now.
    await user.tab();
    expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus();
  });
});

describe("PromptElevationPanel — §6.7, honest disabled states", () => {
  it("disables with a visible F5 reason even when a conversation exists", () => {
    renderPanel();
    const elevate = screen.getByRole("button", { name: "Elevate" });
    expect(elevate).toBeDisabled();
    expect(screen.getByText(ELEVATION_API_UNAVAILABLE_REASON)).toBeVisible();
    // The reason is TIED to the control, not merely nearby.
    expect(elevate).toHaveAttribute(
      "aria-describedby",
      screen.getByText(ELEVATION_API_UNAVAILABLE_REASON).id,
    );
  });

  it("names both the missing conversation and missing API before a session exists", () => {
    renderPanel({ sessionId: null });
    expect(screen.getByRole("button", { name: "Elevate" })).toBeDisabled();
    expect(screen.getByText(new RegExp(NO_SESSION_REASON))).toBeVisible();
    expect(screen.getByText(new RegExp(ELEVATION_API_UNAVAILABLE_REASON))).toBeVisible();
  });
});

describe("PromptElevationPanel — no duplicate elevator", () => {
  it("issues no request and opens no dialog while the shared API is absent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Elevate" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
