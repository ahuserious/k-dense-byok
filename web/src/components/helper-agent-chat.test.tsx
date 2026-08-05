import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_A = `wrun_${"a".repeat(32)}`;
const RUN_B = `wrun_${"b".repeat(32)}`;
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadSession: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@/lib/projects", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/lib/use-agent", () => ({
  useAgent: () => ({
    messages: [],
    status: "ready",
    sessionId: "helper-session",
    loadSession: mocks.loadSession,
    send: mocks.send,
    stop: mocks.stop,
  }),
}));
vi.mock("@/components/chat-tab", () => ({ AssistantMessageBody: () => null }));

import { HelperAgentChat } from "./helper-agent-chat";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const source = JSON.parse(String(init?.body)) as { kind: string; id: string };
    return {
      ok: true,
      json: async () => ({ id: `helper-${source.kind}-${source.id}`, source }),
    };
  });
  mocks.loadSession.mockResolvedValue("restored");
  mocks.send.mockResolvedValue(undefined);
});

describe("HelperAgentChat server-owned context boundary", () => {
  it("creates an exact source-scoped Rescue session and sends only the user question", async () => {
    render(
      <HelperAgentChat
        projectId="project-a"
        profile="workflow-rescue"
        contextReference={{ kind: "run", id: RUN_A }}
      />,
    );

    expect(await screen.findByText("Pi (Kady) · bounded context · no tools")).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/helper-sessions/workflow-rescue",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "run", id: RUN_A }),
      }),
      "project-a",
    );
    expect(mocks.loadSession).toHaveBeenCalledWith(`helper-run-${RUN_A}`);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Message Workflow Rescue helper" }),
      "Propose the smallest safe repair.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(mocks.send).toHaveBeenCalledWith("Propose the smallest safe repair.");
  });

  it("requires a typed source and reconnects with empty component state when it changes", async () => {
    const { rerender } = render(
      <HelperAgentChat projectId="project-a" profile="raindrop" />,
    );
    expect(screen.getByText("Select saved context")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Raindrop analyst" })).toBeDisabled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    rerender(
      <HelperAgentChat
        projectId="project-a"
        profile="raindrop"
        contextReference={{ kind: "run", id: RUN_A }}
      />,
    );
    await waitFor(() => expect(mocks.loadSession).toHaveBeenCalledWith(`helper-run-${RUN_A}`));
    const firstTextbox = screen.getByRole("textbox", { name: "Message Raindrop analyst" });
    await userEvent.type(firstTextbox, "Question for A");
    expect(firstTextbox).toHaveValue("Question for A");

    rerender(
      <HelperAgentChat
        projectId="project-a"
        profile="raindrop"
        contextReference={{ kind: "run", id: RUN_B }}
      />,
    );
    await waitFor(() => expect(mocks.loadSession).toHaveBeenCalledWith(`helper-run-${RUN_B}`));
    expect(screen.getByRole("textbox", { name: "Message Raindrop analyst" })).toHaveValue("");
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/helper-sessions/raindrop",
      expect.objectContaining({ body: JSON.stringify({ kind: "run", id: RUN_B }) }),
      "project-a",
    );
  });
});
