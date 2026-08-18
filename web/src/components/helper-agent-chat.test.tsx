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
    // With nothing selected but selectable revisions available, that is the
    // "pick one and here is what happens next" wording.
    expect(
      screen.getByText("Pick a saved workflow revision to start"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose a saved revision above. I then explain its nodes and edges, draft YAML here in the chat, and propose fixes for validation errors. Nothing I write reaches the canvas: it has no YAML import, and I cannot edit it.",
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

  it("tells the truth in each context state and never promises to reach the canvas", async () => {
    // R1 [high]: the dag-builder empty state used to read "Describe the pipeline
    // you want; I draft the visual/YAML DAG…" in EVERY state — including the one
    // where the project has no saved workflow at all and the composer is
    // therefore hard-blocked with no way out from this rail. Each state now says
    // what is true of it.
    //
    // R3 [F5]: the previous version of this assertion applied the word ban to
    // five strings (the unavailable title and hint, and the selected title,
    // description and placeholder), leaving the whole unselected state and the
    // unavailable description and placeholder unchecked — and the unavailable
    // description was precisely the string the r3 review's F1 was about. Every
    // user-visible string in every state is collected and checked now.
    //
    // The ban is a FLOOR, not the test. Both r1's and r3's false promises would
    // have to be caught by reading the sentence, not by matching a word: "Save a
    // workflow in the canvas on the left" (F1) and "draft YAML you can copy into
    // the canvas" (F2) both pass this regex. The routes themselves are pinned by
    // the exact-text assertions below and walked in the lane report.
    const NO_CANVAS_REACH = /\bapply\b|\bapplies\b|\bvisual\b/i;
    const visibleCopy: string[] = [];
    const collectVisibleCopy = (title: string, description: string) => {
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      visibleCopy.push(
        title,
        description,
        screen.getByRole("textbox", { name: "Message DAG Builder agent" })
          .getAttribute("placeholder") ?? "",
        screen.getByTestId("helper-agent-blocked-hint").textContent ?? "",
      );
    };

    // (a) The list came back empty. Only ONE route produces a revision this
    // picker lists — Scientific Pipelines' "New typed workflow" — and only the
    // rail's own Reload control refreshes the list, so those are the two things
    // named. The canvas is named for what it actually does, not offered.
    const { unmount: unmountUnavailable } = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        hasSelectableContext={false}
      />,
    );
    collectVisibleCopy(
      "No saved workflow to work on yet",
      "I work on typed workflow revisions, and this project has none yet. Create one in Scientific Pipelines with New typed workflow, then press Reload above and pick its revision. The canvas on the left saves into the pipeline engine's own store, which this picker cannot list.",
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Create a typed workflow in Scientific Pipelines, then press Reload above and pick its revision.",
    );
    unmountUnavailable();

    // (b) The list could NOT be fetched (r3 review F8). Saying "no saved
    // workflow exists" here is a guess, and the wrong one for a project that is
    // full of them, so this state claims nothing about what the project has.
    const { unmount: unmountUnlistable } = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        hasSelectableContext={false}
        contextListFailed
      />,
    );
    collectVisibleCopy(
      "Saved workflows could not be listed",
      "The list above did not load, so I do not know which revisions this project has. Press Reload above to try again.",
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Saved workflows could not be listed. Press Reload above to try again.",
    );
    unmountUnlistable();

    // (c) Revisions exist, none picked.
    const { unmount: unmountUnselected } = render(
      <HelperAgentChat projectId="project-a" profile="dag-builder" />,
    );
    collectVisibleCopy(
      "Pick a saved workflow revision to start",
      "Choose a saved revision above. I then explain its nodes and edges, draft YAML here in the chat, and propose fixes for validation errors. Nothing I write reaches the canvas: it has no YAML import, and I cannot edit it.",
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Pick a saved workflow revision above to ask the DAG Builder agent.",
    );
    unmountUnselected();

    // (d) A revision is bound. Only here does the drafting copy appear, and even
    // then it names both limits: no apply path AND no paste target.
    render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        contextReference={{ kind: "workflow", id: "microscopy_qc@4" }}
      />,
    );
    const selectedTitle = await screen.findByText("Build on this saved workflow revision");
    const selectedDescription = screen.getByText(
      "I explain the nodes and edges of the revision above, draft YAML here in the chat, and propose fixes for validation errors. Nothing I write reaches the canvas: it has no YAML import, and I cannot edit it.",
    );
    visibleCopy.push(
      selectedTitle.textContent ?? "",
      selectedDescription.textContent ?? "",
      screen.getByRole("textbox", { name: "Message DAG Builder agent" })
        .getAttribute("placeholder") ?? "",
    );

    // R1 [medium]: there is no bridge from this rail into the cross-origin
    // builder canvas, so no state may claim it draws or applies anything there.
    // 15 strings: title/description/placeholder/hint for each of (a)–(c), and
    // title/description/placeholder for (d), which has no blocked hint once a
    // revision is bound.
    expect(visibleCopy).toHaveLength(15);
    for (const text of visibleCopy) {
      expect(text).not.toMatch(NO_CANVAS_REACH);
    }
    // No state may name the canvas as a place to put something, which is the
    // shape both r3 findings took. "Save a workflow in the canvas", "copy into
    // the canvas" and "paste into the canvas" all match; "reaches the canvas"
    // and "edit the canvas" — statements of the limit — do not.
    for (const text of visibleCopy) {
      expect(text).not.toMatch(/\b(?:save|copy|paste|drop|put|import)\b[^.]*\b(?:in|into|to)\s+the\s+canvas\b/i);
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
