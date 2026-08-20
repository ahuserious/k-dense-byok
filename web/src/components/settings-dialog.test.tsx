import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/projects", () => ({ apiFetch }));

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({ activeProject: { id: "p1", name: "P1" }, activeProjectId: "p1" }),
}));

import { SettingsDialog } from "@/components/settings-dialog";

describe("SettingsDialog", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          openrouter: { set: false, masked: null },
          exa: { set: false, masked: null },
          perplexity: { set: false, masked: null },
          gemini: { set: false, masked: null },
          modalTokenId: { set: false, masked: null },
          modalTokenSecret: { set: false, masked: null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  it("shows the capability tabs (Skills, Specialists, Connectors) alongside API keys", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /model providers/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /api keys/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /specialists/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /connectors/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pipelines/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Kady CLI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /fusion/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /appearance/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /workspace/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /agents/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^runtime$/i })).not.toBeInTheDocument();
    expect(
      [...document.querySelectorAll('[role="presentation"]')].map((node) => node.textContent),
    ).toEqual(["Workspace", "Agents", "Runtime", "Appearance"]);
  });

  it("restores focus to the Open settings trigger when the overlay closes", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.setAttribute("aria-label", "Open settings");
    document.body.appendChild(trigger);
    trigger.focus();

    const onOpenChange = vi.fn();
    const { rerender } = render(<SettingsDialog open onOpenChange={onOpenChange} />);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();

    await user.keyboard("{Escape}");
    rerender(<SettingsDialog open={false} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
    trigger.remove();
  });

  it("identifies the active, Kady-owned pipeline runtime as Pi (Kady)", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => {}} />);

    await user.click(screen.getByRole("tab", { name: "Pipelines" }));

    expect(screen.getByRole("heading", { name: "DAG Runtime" })).toBeInTheDocument();
    expect(screen.getByText("Pi (Kady)")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Kady owns the typed graph/i)).toBeInTheDocument();
    expect(screen.getByText(
      /Kady-owned local\/OpenAI-compatible\/\s*OpenRouter\/OAuth/i,
    )).toBeInTheDocument();
    expect(screen.queryByText(/Pi \(community\)/i)).not.toBeInTheDocument();
  });

  it("saves Modal credentials as a tested pair and broadcasts the change", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    window.addEventListener("kady:credentials-changed", changed);
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            modalTokenId: { set: false, masked: null },
            modalTokenSecret: { set: false, masked: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            modalConfigured: true,
            modalTokenId: { set: true, masked: "ak-…1234" },
            modalTokenSecret: { set: true, masked: "as-…5678" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<SettingsDialog open onOpenChange={() => {}} />);
    await screen.findByText("Not connected");
    await user.type(screen.getByLabelText("Token ID"), "ak-test");
    await user.type(screen.getByLabelText("Token Secret"), "as-test");
    await user.click(screen.getByRole("button", { name: /save & test/i }));

    expect(await screen.findByText(/Connected — Modal compute is ready/i)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/credentials",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          modalTokenId: "ak-test",
          modalTokenSecret: "as-test",
        }),
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener("kady:credentials-changed", changed);
  });

  it("shows Testing and handles backend pair-validation errors", async () => {
    let resolveSave!: (response: Response) => void;
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            modalTokenId: { set: false, masked: null },
            modalTokenSecret: { set: false, masked: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSave = resolve;
        }),
      );
    render(<SettingsDialog open onOpenChange={() => {}} />);
    await screen.findByText("Not connected");
    fireEvent.change(screen.getByLabelText("Token ID"), { target: { value: "ak-bad" } });
    fireEvent.change(screen.getByLabelText("Token Secret"), { target: { value: "as-bad" } });
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }));
    expect(screen.getByText(/Testing Modal connection/i)).toBeInTheDocument();

    resolveSave(
      new Response(
        JSON.stringify({
          detail: {
            message: "Modal token pair could not be authenticated",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("alert"),
      ).toHaveTextContent("Modal token pair could not be authenticated"),
    );
  });
});
