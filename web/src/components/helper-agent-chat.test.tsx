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
    expect(screen.getByRole("textbox", { name: "Message Raindrop analyst" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
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

describe("HelperAgentChat blocked composer states the reason", () => {
  it("keeps Send focusable, explains the missing context, and refuses to submit", async () => {
    render(<HelperAgentChat projectId="project-a" profile="raindrop" />);

    const send = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox", { name: "Message Raindrop analyst" });

    // Focusable, not natively disabled: the old bare `disabled` made both the
    // reason and the control unreachable from the keyboard.
    expect(send).not.toBeDisabled();
    expect(textarea).not.toBeDisabled();
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).not.toHaveAttribute("title");
    send.focus();
    expect(send).toHaveFocus();

    const hint = screen.getByTestId("helper-agent-blocked-hint");
    expect(hint).toHaveTextContent(
      "Pick a saved run or chat log on the left to ask the Raindrop analyst.",
    );
    expect(send).toHaveAttribute("aria-describedby", hint.id);
    expect(textarea).toHaveAttribute("aria-describedby", hint.id);
    // The placeholder survives the blocked state.
    expect(textarea).toHaveAttribute("placeholder", "Ask what failed and why…");

    // The blocked look is colour, never whole-element opacity: `opacity`
    // composites the focus indicator along with everything else, which is what
    // dropped these two to 1.56:1 and 2.68:1.
    for (const control of [textarea, send]) {
      expect(control.className).not.toMatch(/(^|:)opacity-\d/);
    }
    expect(textarea).toHaveClass(
      "aria-disabled:bg-muted",
      "aria-disabled:text-muted-foreground",
      "aria-disabled:cursor-not-allowed",
    );
    expect(send).toHaveClass(
      "aria-disabled:bg-muted",
      "aria-disabled:text-muted-foreground",
      "aria-disabled:cursor-not-allowed",
    );

    await userEvent.click(send);
    await userEvent.type(textarea, "Why did it fail?{Enter}");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("names the profile whose context is missing", () => {
    const { unmount } = render(
      <HelperAgentChat projectId="project-a" profile="workflow-rescue" />,
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Select a stopped run to ask the Workflow Rescue helper.",
    );
    unmount();

    render(<HelperAgentChat projectId="project-a" profile="dag-builder" />);
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Pick a saved workflow revision above to ask the DAG Builder agent.",
    );
  });

  it("keeps the DAG-building and log-analysis empty states unmistakably apart", () => {
    const { unmount } = render(
      <HelperAgentChat projectId="project-a" profile="dag-builder" />,
    );
    // O2: the Builder assistant says what it drafts, in the Builder's words.
    expect(
      screen.getByText("Build this workflow with a separate Builder agent"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Describe the pipeline you want; I draft the visual/YAML DAG, explain nodes and edges, and propose fixes for validation errors.",
      ),
    ).toBeInTheDocument();
    unmount();

    render(<HelperAgentChat projectId="project-a" profile="raindrop" />);
    // O3: the analyst is a LOG reader. No DAG-building language anywhere in its
    // empty state, its hint, or its placeholder — that copy is what the owner
    // read as the misplaced pipeline chat.
    expect(screen.getByText("Analyze a saved log")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pick a saved run or chat log on the left, then ask for a causal timeline of what happened.",
      ),
    ).toBeInTheDocument();
    for (const text of [
      screen.getByText("Analyze a saved log").textContent ?? "",
      screen.getByText(
        "Pick a saved run or chat log on the left, then ask for a causal timeline of what happened.",
      ).textContent ?? "",
      screen.getByTestId("helper-agent-blocked-hint").textContent ?? "",
      screen.getByRole("textbox", { name: "Message Raindrop analyst" })
        .getAttribute("placeholder") ?? "",
    ]) {
      expect(text).not.toMatch(/\bbuild|\bdraft|\bdesign|\bDAG\b/i);
    }
  });

  it("states the provider reason first and refuses to send without one", async () => {
    render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        contextReference={{ kind: "workflow", id: "microscopy_qc@4" }}
        providerBlocked
      />,
    );

    const hint = await screen.findByTestId("helper-agent-blocked-hint");
    // Same wording and same visible-hint treatment as the chat composer's
    // Submit, so one reason is learned once.
    expect(hint).toHaveTextContent("Connect a provider in Settings to send");
    const send = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox", { name: "Message DAG Builder agent" });
    expect(send).not.toBeDisabled();
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAttribute("aria-describedby", hint.id);
    expect(textarea).toHaveAttribute("aria-describedby", hint.id);

    await userEvent.type(textarea, "Draft me a two-node graph.{Enter}");
    await userEvent.click(send);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("drops the hint once the helper session is ready", async () => {
    render(
      <HelperAgentChat
        projectId="project-a"
        profile="raindrop"
        contextReference={{ kind: "run", id: RUN_A }}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("helper-agent-blocked-hint")).not.toBeInTheDocument(),
    );
    const send = screen.getByRole("button", { name: "Send" });
    // Empty draft still blocks the send, but that needs no explanation.
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).not.toHaveAttribute("aria-describedby");

    // The focus indicators do not depend on the blocked state: the same
    // foreground-coloured outline/ring is declared whether or not the control
    // is accepting input, so the enabled state cannot regress separately.
    expect(send).toHaveClass(
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-foreground",
    );
    expect(screen.getByRole("textbox", { name: "Message Raindrop analyst" })).toHaveClass(
      "focus-visible:ring-2",
      "focus-visible:ring-foreground/60",
    );

    await userEvent.type(
      screen.getByRole("textbox", { name: "Message Raindrop analyst" }),
      "Give me the timeline.",
    );
    expect(send).not.toHaveAttribute("aria-disabled");
    await userEvent.click(send);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("Give me the timeline."));
  });
});
