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
  // Steerable so the streaming chrome ("Stop") is reachable by the DOM sweep
  // below; every other test leaves it at the default.
  agentStatus: "ready" as string,
}));

vi.mock("@/lib/projects", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/lib/use-agent", () => ({
  useAgent: () => ({
    messages: [],
    get status() {
      return mocks.agentStatus;
    },
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
  mocks.agentStatus = "ready";
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
    // Kept verbatim in dag-builder-surface.test.tsx, which bans the same two
    // patterns across the rail's OTHER fixed strings. `saves?` rather than
    // `save`: the unavailable state's "The canvas on the left saves into the
    // pipeline engine's own store" cleared the old pattern only because
    // `\bsave\b` does not match "saves" (r4 review R4). It clears the tightened
    // pattern on the merits — there "the canvas" precedes the verb rather than
    // following it, which is the difference between describing the canvas and
    // offering it as a destination.
    const NOTHING_GOES_INTO_THE_CANVAS =
      /\b(?:saves?|cop(?:y|ies)|pastes?|drops?|puts?|imports?)\b[^.]*\b(?:in|into|to)\s+the\s+canvas\b/i;
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

    // (a) The first fetch has not come back (r4 review R2). Neither "choose a
    // revision above" nor "this project has none" is knowable yet, so the copy
    // says only what is true: it is waiting. `hasSelectableContext` is false
    // here exactly as it is for an empty list — the loading flag is what tells
    // the two apart, and it outranks everything but a bound revision.
    const { unmount: unmountLoading } = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        hasSelectableContext={false}
        contextListLoading
      />,
    );
    collectVisibleCopy(
      "Checking this project's saved workflows",
      "The list above is still loading. Once it settles, pick a revision and I explain its nodes and edges, draft YAML here in the chat, and propose fixes for validation errors.",
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "The saved workflow list above is still loading.",
    );
    unmountLoading();

    // (b) The list came back empty. TWO routes now produce a revision this
    // picker lists — the builder toolbar's "Load workflow" → a Workflows library
    // template → "Save workflow", which PUTs a typed document to /dag-workflows
    // with `If-None-Match: *`, and Scientific Pipelines' "New typed workflow" —
    // and only the rail's own Reload control refreshes the list. All three are
    // named, shortest route first. Round 5 named only the second and asserted
    // that the canvas "saves into the pipeline engine's own store, which this
    // picker cannot list": true of the ENGINE-native save, and read by a
    // first-run user as "the thing in front of you cannot get you out of this
    // state", which after lane W3 is false.
    const { unmount: unmountUnavailable } = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        hasSelectableContext={false}
      />,
    );
    collectVisibleCopy(
      "No saved workflow to work on yet",
      "I work on typed workflow revisions, and this project has none yet. Quickest: in the builder toolbar press Load workflow, start from a Workflows library template, then press Save workflow — that writes a typed revision. Scientific Pipelines → New typed workflow produces one too. Either way, press Reload above and pick it.",
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Save a Workflows library template from the builder toolbar, or create one in Scientific Pipelines, then press Reload above and pick its revision.",
    );
    unmountUnavailable();

    // (c) The list could NOT be fetched (r3 review F8). Saying "no saved
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
      "The list above could not be read, so I do not know which revisions this project has. Press Reload above to try again.",
    );
    expect(screen.getByTestId("helper-agent-blocked-hint")).toHaveTextContent(
      "Saved workflows could not be listed. Press Reload above to try again.",
    );
    unmountUnlistable();

    // (d) Revisions exist, none picked.
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

    // (e) A revision is bound. Only here does the drafting copy appear, and even
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
    // 19 strings: title/description/placeholder/hint for each of (a)–(d), and
    // title/description/placeholder for (e), which has no blocked hint once a
    // revision is bound. This is the WHOLE of what this assertion covers — the
    // rail's other fixed strings live in dag-builder-surface.tsx and are banned
    // by dag-builder-surface.test.tsx (r4 review R4). The length is the tripwire
    // for a sixth context state added without extending the collector.
    expect(visibleCopy).toHaveLength(19);
    for (const text of visibleCopy) {
      expect(text).not.toMatch(NO_CANVAS_REACH);
    }
    // No state may name the canvas as a place to put something, which is the
    // shape both r3 findings took. "Save a workflow in the canvas", "copy into
    // the canvas" and "paste into the canvas" all match; "reaches the canvas"
    // and "edit the canvas" — statements of the limit — do not.
    for (const text of visibleCopy) {
      expect(text).not.toMatch(NOTHING_GOES_INTO_THE_CANVAS);
    }
  });

  // The two assertions below are the WEB half of a reciprocal pair. The server
  // half is in server/test/raindrop-context.test.ts: the dag-builder profile
  // prompt must contain no apply-to-canvas promise. That direction was guarded
  // from lane S8B onward; this direction was not, which is why round 5 shipped
  // copy that DENIED a route lane W3 had built. Both directions are guarded now.
  //
  // Rendered rather than asserted against `helperEmptyState` directly: the
  // export is internal, and what a user is harmed by is what reaches the DOM.
  const collectDagBuilderCopy = async () => {
    const states: Array<Partial<React.ComponentProps<typeof HelperAgentChat>>> = [
      { hasSelectableContext: false, contextListLoading: true },
      { hasSelectableContext: false },
      { hasSelectableContext: false, contextListFailed: true },
      {},
      { contextReference: { kind: "workflow" as const, id: "microscopy_qc@4" } },
    ];
    const copy: string[] = [];
    for (const state of states) {
      const { unmount } = render(
        <HelperAgentChat projectId="project-a" profile="dag-builder" {...state} />,
      );
      const textarea = await screen.findByRole("textbox", {
        name: "Message DAG Builder agent",
      });
      copy.push(
        ...Array.from(
          textarea.closest("section")?.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4") ?? [],
        ).map((element) => element.textContent ?? ""),
        textarea.getAttribute("placeholder") ?? "",
        screen.queryByTestId("helper-agent-blocked-hint")?.textContent ?? "",
      );
      unmount();
    }
    return copy.filter((text) => text.trim().length > 0);
  };

  it("never tells the user the canvas cannot produce a revision this picker lists", async () => {
    // Round 5 wrote, for a first-run project with nothing saved: "The canvas on
    // the left saves into the pipeline engine's own store, which this picker
    // cannot list." True of the canvas's ENGINE-native Save, and false as the
    // thing a first-run user takes from it — after lane W3 merged, "Load
    // workflow" above the builder lists the Workflows library, and saving a
    // template with "Save workflow" PUTs a typed document to /dag-workflows,
    // which is exactly the revision this picker lists (e2e/builder-typed.spec.ts
    // "saves a library draft as a create", web/src/lib/dag-workflows.ts
    // `saveDagWorkflowDefinition` with `If-None-Match: *`).
    //
    // The pattern catches the SHAPE of that denial — the canvas named in the
    // same sentence as an inability to list or reach a revision — rather than
    // the one sentence that happened to be wrong.
    const CANVAS_CANNOT_PRODUCE_A_REVISION =
      /\bcanvas\b[^.]*\b(?:cannot|can ?not|can't|never|no way)\b[^.]*\b(?:list|listed|listable|picker|revision)\b/i;
    const copy = await collectDagBuilderCopy();

    expect(copy.length).toBeGreaterThan(0);
    for (const text of copy) {
      expect(text).not.toMatch(CANVAS_CANNOT_PRODUCE_A_REVISION);
    }

    // And the state that needs the route actually names it, control by control,
    // so a user can walk it without leaving the Builder.
    const emptyStateCopy = copy.join("\n");
    expect(emptyStateCopy).toContain("Load workflow");
    expect(emptyStateCopy).toContain("Workflows library");
    expect(emptyStateCopy).toContain("Save workflow");
    // The second route is still real and still named.
    expect(emptyStateCopy).toContain("Scientific Pipelines");
  });

  it("never claims what the assistant writes reaches the canvas", async () => {
    // The reciprocal of the server-side prompt assertion, and the reason the
    // load-bearing sentence survives round 6 unchanged: W3's bridge carries a
    // document the HOST loaded from the typed store or built from a library
    // template, never chat output, and `builder.documentReplaced` — the one
    // message that could carry a hand-authored document — has a handler and no
    // producer (web/src/lib/builder-bridge.ts:57-66).
    //
    // Direction-aware, because "reaches the canvas" appears in the copy as a
    // DENIAL: every sentence that mentions the canvas must also negate it.
    const NEGATED = /\b(?:no|not|nothing|cannot|can ?not|can't|never|neither|without)\b/i;
    const copy = await collectDagBuilderCopy();
    const canvasSentences = copy
      .flatMap((text) => text.split(/(?<=[.!?])\s+/))
      .filter((sentence) => /\bcanvas\b/i.test(sentence));

    // The denial sentences are present — otherwise an empty filter would pass
    // this test by saying nothing at all.
    expect(canvasSentences.length).toBeGreaterThan(0);
    for (const sentence of canvasSentences) {
      expect(sentence).toMatch(NEGATED);
    }
    expect(copy.join("\n")).toContain(
      "Nothing I write reaches the canvas: it has no YAML import, and I cannot edit it.",
    );
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

  it("bans the canvas-reach words across this component's own chrome too", async () => {
    // r4 review R4. The walk above covers the 19 strings `helperEmptyState`
    // returns; this covers everything ELSE this component renders — the
    // landmark and header labels, the four connection statuses, the composer
    // labels, Send/Stop, and all three blocked hints. Together with the sweep
    // in dag-builder-surface.test.tsx, every fixed string the Builder rail can
    // render is now under the ban. Swept from the rendered DOM rather than
    // listed by hand so a string added later is caught without anyone
    // remembering to extend a list.
    const NO_CANVAS_REACH = /\bapply\b|\bapplies\b|\bvisual\b/i;
    const NOTHING_GOES_INTO_THE_CANVAS =
      /\b(?:saves?|cop(?:y|ies)|pastes?|drops?|puts?|imports?)\b[^.]*\b(?:in|into|to)\s+the\s+canvas\b/i;
    const seen = new Set<string>();
    const collect = (container: HTMLElement) => {
      for (const element of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
        const label = element.getAttribute("aria-label");
        if (label) seen.add(label);
        const placeholder = element.getAttribute("placeholder");
        if (placeholder) seen.add(placeholder);
        if (element.children.length === 0 && element.textContent) seen.add(element.textContent);
        // Direct text nodes too: a control like `<Icon /> Send` has an element
        // child, so the leaf rule alone would skip its label.
        for (const node of Array.from(element.childNodes)) {
          const text = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").trim() : "";
          if (text) seen.add(text);
        }
      }
    };

    // (a) waiting for a context, with no provider connected.
    const waiting = render(
      <HelperAgentChat projectId="project-a" profile="dag-builder" providerBlocked />,
    );
    collect(waiting.container);
    waiting.unmount();

    // (b) connecting, then ready — the session POST is held open so the
    //     "Connecting…" status and "Restoring helper session…" line are real.
    let letSessionThrough: (value: unknown) => void = () => {};
    mocks.apiFetch.mockReturnValue(
      new Promise((resolve) => {
        letSessionThrough = resolve;
      }),
    );
    const connecting = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        contextReference={{ kind: "workflow", id: "microscopy_qc@4" }}
      />,
    );
    expect(await screen.findByText("Connecting…")).toBeInTheDocument();
    collect(connecting.container);
    letSessionThrough({
      ok: true,
      json: async () => ({
        id: "helper-workflow-microscopy_qc@4",
        source: { kind: "workflow", id: "microscopy_qc@4" },
      }),
    });
    expect(
      await screen.findByText("Pi (Kady) · bounded context · no tools"),
    ).toBeInTheDocument();
    collect(connecting.container);
    connecting.unmount();

    // (c) streaming — the only state that renders Stop instead of Send.
    mocks.agentStatus = "streaming";
    const streaming = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        contextReference={{ kind: "workflow", id: "microscopy_qc@4" }}
      />,
    );
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    collect(streaming.container);
    streaming.unmount();
    mocks.agentStatus = "ready";

    // (d) the session failed.
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: "Helper session backend exploded." }),
    });
    const failed = render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        contextReference={{ kind: "workflow", id: "microscopy_qc@4" }}
      />,
    );
    await screen.findByTestId("helper-agent-blocked-hint");
    collect(failed.container);
    failed.unmount();

    const collected = [...seen];
    // The sweep really reaches the chrome — otherwise the loop below could
    // pass by having seen almost nothing.
    for (const pinned of [
      "DAG Builder agent",
      "Message DAG Builder agent",
      "Connecting…",
      "Pi (Kady) · bounded context · no tools",
      "Select saved context",
      "Unavailable",
      "Restoring helper session…",
      "Connect a provider in Settings to send",
      "DAG Builder agent is connecting…",
      "DAG Builder agent could not start, so this box cannot send. The reason is above.",
      "Shift+Enter for a new line",
      "Stop",
      "Send",
    ]) {
      expect(collected).toContain(pinned);
    }
    for (const text of collected) {
      expect(text).not.toMatch(NO_CANVAS_REACH);
      expect(text).not.toMatch(NOTHING_GOES_INTO_THE_CANVAS);
    }
  });

  it("explains itself when the helper session failed, beside the composer that is refusing", async () => {
    // r4 review R1. `connection === "error"` fell off the end of the hint
    // ladder, so a helper session that failed to start rendered the FULL
    // capability copy — "I explain the nodes and edges…", "Ask about this
    // workflow…" — over a textarea that was silently readOnly, with the only
    // explanation a 10px destructive line at the top of the rail, some 300px
    // from the control refusing the input.
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: "Helper session backend exploded." }),
    });
    render(
      <HelperAgentChat
        projectId="project-a"
        profile="dag-builder"
        contextReference={{ kind: "workflow", id: "microscopy_qc@4" }}
      />,
    );

    const hint = await screen.findByTestId("helper-agent-blocked-hint");
    expect(hint).toHaveTextContent(
      "DAG Builder agent could not start, so this box cannot send. The reason is above.",
    );
    // And "above" is a real place: the server's own reason is on screen.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Helper session backend exploded.");

    const textarea = screen.getByRole("textbox", { name: "Message DAG Builder agent" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(textarea).toHaveAttribute("readonly");
    expect(textarea).toHaveAttribute("aria-disabled", "true");
    // Both, error first: the alert carries the cause and the hint the
    // consequence. The alert wiring predates this hint and must survive it —
    // dropping it would take the specific reason away from screen-reader users
    // in exchange for the sentence sighted users just gained.
    expect(textarea).toHaveAttribute("aria-describedby", `${alert.id} ${hint.id}`);
    expect(send).toHaveAttribute("aria-describedby", `${alert.id} ${hint.id}`);
    expect(alert.id).not.toBe("");

    // Still refuses to send, and still focusable so the reason is reachable.
    send.focus();
    expect(send).toHaveFocus();
    await userEvent.click(send);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
