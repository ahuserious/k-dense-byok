import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pipelineBuilderProps = vi.hoisted(() => ({ capture: vi.fn() }));
const helperProps = vi.hoisted(() => ({ capture: vi.fn() }));
const mocks = vi.hoisted(() => ({
  listDagWorkflowDefinitions: vi.fn(),
  models: [] as Array<{ id: string; available?: boolean }>,
}));

vi.mock("@/components/pipeline-builder-panel", () => ({
  PipelineBuilderPanel: (props: unknown) => {
    pipelineBuilderProps.capture(props);
    return <div data-testid="vendored-visual-builder" />;
  },
}));

vi.mock("@/components/helper-agent-chat", () => ({
  HelperAgentChat: (props: {
    profile: string;
    contextReference?: { kind: string; id: string };
    hasSelectableContext?: boolean;
    contextListFailed?: boolean;
    contextListLoading?: boolean;
    providerBlocked?: boolean;
  }) => {
    helperProps.capture(props);
    return (
      <div data-testid="builder-assistant">
        {props.profile}:
        {props.contextReference ? `${props.contextReference.kind}:${props.contextReference.id}` : "no-context"}
        {props.hasSelectableContext === false ? ":nothing-to-select" : ""}
        {props.contextListFailed ? ":list-failed" : ""}
        {props.contextListLoading ? ":list-loading" : ""}
        {props.providerBlocked ? ":provider-blocked" : ""}
      </div>
    );
  },
}));

vi.mock("@/lib/dag-workflows", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dag-workflows")>();
  return { ...original, listDagWorkflowDefinitions: mocks.listDagWorkflowDefinitions };
});

vi.mock("@/lib/use-models", () => ({ useModels: () => ({ models: mocks.models }) }));

import { DagBuilderSurface } from "./dag-builder-surface";

// The same two regexes helper-agent-chat.test.tsx applies to the empty-state
// copy, kept verbatim so the two halves of the ban cannot drift apart. `saves?`
// rather than `save`: r4's copy ("The canvas on the left saves into the pipeline
// engine's own store") cleared the old pattern only because `\bsave\b` does not
// match "saves", which was luck rather than design (r4 review R4). It clears the
// tightened pattern on the merits — "the canvas" precedes the verb there instead
// of following it.
const NO_CANVAS_REACH = /\bapply\b|\bapplies\b|\bvisual\b/i;
const NOTHING_GOES_INTO_THE_CANVAS =
  /\b(?:saves?|cop(?:y|ies)|pastes?|drops?|puts?|imports?)\b[^.]*\b(?:in|into|to)\s+the\s+canvas\b/i;

function workflow(id: string, revision: number, name: string) {
  return {
    id,
    revision,
    createdAt: 1,
    updatedAt: 2,
    graphSha256: "0".repeat(64),
    schemaVersion: "1",
    name,
    description: null,
    nodeCount: 3,
    edgeCount: 2,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.models = [{ id: "openrouter/a", available: true }];
  mocks.listDagWorkflowDefinitions.mockResolvedValue([
    workflow("microscopy_qc", 4, "Microscopy QC"),
    workflow("rna_seq", 1, "RNA-seq"),
  ]);
});

describe("DagBuilderSurface", () => {
  it("renders the vendored visual builder, forwards the edit target, and adds no canvas effects", () => {
    const { container } = render(
      <DagBuilderSurface
        projectId="project-a"
        editTarget={{ workflowId: "microscopy-qc.yaml", codebaseId: "codebase-a" }}
      />,
    );

    expect(screen.getByTestId("vendored-visual-builder")).toBeInTheDocument();
    expect(pipelineBuilderProps.capture).toHaveBeenCalledWith({
      editTarget: { workflowId: "microscopy-qc.yaml", codebaseId: "codebase-a" },
    });
    expect(screen.queryByRole("button", { name: "Typed builder" })).not.toBeInTheDocument();

    // O1: the Kady shell wraps the builder in slim chrome only — no gradient,
    // blur, glow, or drop shadow around the iframe.
    expect(container.innerHTML).not.toMatch(/gradient|blur|glow|drop-shadow|shadow-/i);
  });

  it("mounts the dedicated DAG-builder helper open on a first visit, never the main Kady chat", async () => {
    render(<DagBuilderSurface projectId="project-a" />);

    const assistant = await screen.findByRole("complementary", { name: "DAG builder assistant" });
    expect(assistant.className).toContain("flex");
    expect(assistant.className).not.toContain("hidden");
    expect(screen.getByTestId("builder-assistant")).toHaveTextContent("dag-builder:no-context");
    // The rail must not fall back to the MAIN Kady chat. chat-rail.tsx was
    // deleted in round 2, so the guarantee is now structural; this asserts the
    // user-visible half of it — the main chat composer's placeholder and its
    // "Add to pipeline" control are nowhere in the Builder.
    expect(screen.queryByPlaceholderText(/Ask Kady anything/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add to pipeline/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide builder assistant" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("sends only a typed saved-revision pointer as the assistant's context", async () => {
    render(<DagBuilderSurface projectId="project-a" />);

    const picker = await screen.findByLabelText("SAVED WORKFLOW REVISION");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(picker, "microscopy_qc@4");

    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).toHaveTextContent(
        "dag-builder:workflow:microscopy_qc@4",
      ),
    );
    expect(helperProps.capture).toHaveBeenLastCalledWith({
      projectId: "project-a",
      profile: "dag-builder",
      contextReference: { kind: "workflow", id: "microscopy_qc@4" },
      hasSelectableContext: true,
      contextListFailed: false,
      contextListLoading: false,
      providerBlocked: false,
    });

    // R1 [medium]: the boundary sentence used to be the `else` branch of a
    // ternary, so it vanished the moment a revision was picked — exactly when
    // context WAS being sent. It is permanent now, and the projection size is
    // an additional line rather than a substitution.
    expect(
      screen.getByText("Only the selected revision is sent — never the unsaved canvas draft."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/3 nodes · 2 edges sent as bounded, server-rebuilt context\./),
    ).toBeInTheDocument();
  });

  it("remembers a collapsed rail and keeps the helper session mounted", async () => {
    const { unmount } = render(<DagBuilderSurface projectId="project-a" />);

    await userEvent.click(screen.getByRole("button", { name: "Hide builder assistant" }));
    const collapsed = screen.getByRole("complementary", { name: "DAG builder assistant" });
    expect(collapsed.className).toContain("hidden");
    // Collapsed, not unmounted: an in-flight helper turn keeps streaming.
    expect(screen.getByTestId("builder-assistant")).toBeInTheDocument();
    expect(window.localStorage.getItem("kady.dagBuilderAssistant.open")).toBe("0");
    unmount();

    render(<DagBuilderSurface projectId="project-a" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show builder assistant" }),
      ).toHaveAttribute("aria-pressed", "false"),
    );
  });

  it("states the no-apply boundary permanently, in every selection state", async () => {
    // R1 [medium]: nothing the assistant produces can reach the cross-origin
    // canvas, so the rail says so where the user can always see it rather than
    // only inside a transcript empty state that disappears on the first reply.
    render(<DagBuilderSurface projectId="project-a" />);

    expect(
      await screen.findByText(
        "Only the selected revision is sent — never the unsaved canvas draft.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The assistant explains and drafts YAML here in the chat. It cannot edit the canvas, and the canvas has no YAML import.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sent as bounded, server-rebuilt context/)).not.toBeInTheDocument();
  });

  it("tells the helper when the project has no saved workflow to select", async () => {
    // R1 [high]: on a project with nothing saved, the picker's only option is
    // "No saved workflows yet" and the composer can never send. The rail passes
    // that fact down so the assistant's copy names the way out instead of
    // inviting the user to describe a pipeline into a dead composer.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([]);
    render(<DagBuilderSurface projectId="project-a" />);

    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":nothing-to-select"),
    );
    expect(
      screen.getByRole("option", { name: "No saved workflows yet" }),
    ).toBeInTheDocument();
  });

  it("distinguishes a list that failed from a project with nothing saved", async () => {
    // R3 [F8]: the .catch set the error and marked the list loaded while leaving
    // `workflows` at [], so the rail asserted "No saved workflow to work on yet"
    // and then told the user to go create one they may already own. A failed
    // fetch is not evidence about what the project contains.
    mocks.listDagWorkflowDefinitions.mockRejectedValue(new Error("Saved workflows could not be listed."));
    render(<DagBuilderSurface projectId="project-a" />);

    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":list-failed"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Saved workflows could not be listed.");
    // The picker stops claiming the project is empty too.
    expect(
      screen.getByRole("option", { name: "Saved workflows could not be listed" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "No saved workflows yet" })).not.toBeInTheDocument();

    // A successful reload clears both the alert and the failed flag.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([workflow("microscopy_qc", 4, "Microscopy QC")]);
    await userEvent.click(screen.getByRole("button", { name: "Reload the workflow list" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("builder-assistant")).not.toHaveTextContent(":list-failed");
  });

  it("gives its reload control a name that cannot collide with another Refresh", async () => {
    // R3 [F7, latent]: the control was named "Refresh the workflow list", and
    // Playwright's getByRole matches an accessible name by SUBSTRING, so
    // getByRole("button", { name: "Refresh" }) — used by
    // e2e/console-raindrop.spec.ts, e2e/scientific-pipelines.spec.ts and
    // e2e/live-backend.spec.ts — would also match this one as soon as a spec
    // visits the Builder with the rail visible. It does not today only because
    // the inactive surface is display:none.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([]);
    render(<DagBuilderSurface projectId="project-a" />);

    const reload = await screen.findByRole("button", { name: "Reload the workflow list" });
    expect(reload).toBeInTheDocument();
    expect(reload.textContent).not.toMatch(/refresh/i);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label") ?? button.textContent ?? "").not.toMatch(/refresh/i);
    }
    // And still not a second match for the picker's own label.
    expect(screen.getByLabelText("SAVED WORKFLOW REVISION")).toBe(
      screen.getByRole("combobox"),
    );
  });

  it("revalidates the saved-revision list on refresh and on reopening the rail", async () => {
    // R1 [medium]: the list was fetched once per page load while a comment
    // claimed the option list was authoritative. The canvas saves revisions in
    // a cross-origin iframe this rail cannot observe, so a stale list showed
    // "No saved workflows yet" after a save and pinned superseded revisions the
    // server then rejected with CONFLICT.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([]);
    render(<DagBuilderSurface projectId="project-a" />);

    // COUNTED AS A DELTA, not an absolute. Since the W3 typed controller merged
    // into this surface there are two independent listers on one mount — the
    // controller builds the source list it pushes to the canvas, and the rail
    // builds its own revision picker — so the interesting number is how many
    // MORE calls each rail-owned trigger causes, not the total.
    await waitFor(() => expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalled());
    const afterMount = mocks.listDagWorkflowDefinitions.mock.calls.length;

    // A workflow is saved in the canvas while the rail is open.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([workflow("microscopy_qc", 4, "Microscopy QC")]);
    await userEvent.click(screen.getByRole("button", { name: "Reload the workflow list" }));
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("SAVED WORKFLOW REVISION")).getByRole("option", {
          name: "Microscopy QC · rev 4",
        }),
      ).toBeInTheDocument(),
    );
    expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(afterMount + 1);

    // Collapsing and reopening the rail refetches too.
    await userEvent.click(screen.getByRole("button", { name: "Hide builder assistant" }));
    expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(afterMount + 1);
    await userEvent.click(screen.getByRole("button", { name: "Show builder assistant" }));
    await waitFor(() =>
      expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(afterMount + 2),
    );
  });

  it("keeps the Builder up when localStorage is unavailable", async () => {
    // R1 [low]: the lazy initializer read localStorage unguarded during render,
    // and a SecurityError in blocked-storage contexts took the whole Builder
    // surface down instead of degrading to the open-by-default rail.
    const storage = window.localStorage;
    const blocked = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    Object.defineProperty(window, "localStorage", { value: blocked, configurable: true });
    try {
      render(<DagBuilderSurface projectId="project-a" />);
      const assistant = await screen.findByRole("complementary", { name: "DAG builder assistant" });
      expect(assistant.className).toContain("flex");
      // And toggling still works — the write throws and is swallowed; only the
      // persistence of the choice is lost.
      await userEvent.click(screen.getByRole("button", { name: "Hide builder assistant" }));
      expect(
        screen.getByRole("complementary", { name: "DAG builder assistant" }).className,
      ).toContain("hidden");
    } finally {
      Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    }
  });

  it("blocks the assistant with the provider hint when no model is available", async () => {
    mocks.models = [{ id: "openrouter/a", available: false }];
    render(<DagBuilderSurface projectId="project-a" />);

    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":provider-blocked"),
    );
  });

  it("treats a 200 that is not a list as unlistable rather than crashing the page", async () => {
    // r4 review R3b. `listDagWorkflowDefinitions` returns `body.workflows` with
    // no validation, so `GET /dag-workflows` -> `200 {}` handed this state
    // `undefined`; the `workflows.find` memo then threw IN THE RENDER PHASE.
    // The effect's `.catch` cannot see that — nothing rejected — so the throw
    // escaped the rail and took the whole tab down with "Application error: a
    // client-side exception has occurred". A malformed envelope is not evidence
    // about what the project holds, so it lands in the same state as a failed
    // fetch and never claims the project is empty.
    mocks.listDagWorkflowDefinitions.mockResolvedValue(undefined as never);
    render(<DagBuilderSurface projectId="project-a" />);

    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":list-failed"),
    );
    expect(
      screen.getByRole("complementary", { name: "DAG builder assistant" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Saved workflows could not be listed.");
    expect(
      screen.getByRole("option", { name: "Saved workflows could not be listed" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "No saved workflows yet" })).not.toBeInTheDocument();

    // And it recovers: a well-formed reload clears the alert and lists again.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([workflow("microscopy_qc", 4, "Microscopy QC")]);
    await userEvent.click(screen.getByRole("button", { name: "Reload the workflow list" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops a row it can neither render nor address, and reports the gap", async () => {
    // r4 review R3a. `200 {"workflows":[{"id":"broken"}]}` rendered a selectable
    // option whose entire visible text was "· rev", and selecting it bound the
    // pointer "undefined@undefined". Dropping it silently would be the r3 F8
    // failure in miniature — a picker claiming to be the whole list — so the
    // drop is reported while the rows that ARE usable stay selectable.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([
      workflow("microscopy_qc", 4, "Microscopy QC"),
      { id: "broken" } as never,
    ]);
    render(<DagBuilderSurface projectId="project-a" />);

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument(),
    );
    // Scoped to the RAIL's picker: the typed controller merged into this
    // surface renders its own source list as `role="option"` buttons, so an
    // unscoped sweep now counts rows this assertion is not about.
    const options = within(screen.getByLabelText("SAVED WORKFLOW REVISION")).getAllByRole(
      "option",
    );
    expect(options).toHaveLength(2); // the placeholder and the one usable row
    for (const option of options) {
      expect(option.textContent ?? "").not.toMatch(/undefined/);
      expect(option.textContent ?? "").not.toMatch(/^\s*·\s*rev\s*$/);
    }
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some saved workflows could not be read and are not listed.",
    );
    // One bad row does not deny the working route the other row is.
    expect(screen.getByTestId("builder-assistant")).not.toHaveTextContent(":nothing-to-select");

    // Every row malformed collapses to the unlistable state instead — there is
    // then nothing to select AND nothing known about the project. The alert
    // stops saying "some", because none of them survived.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([{ id: "broken" } as never]);
    await userEvent.click(screen.getByRole("button", { name: "Reload the workflow list" }));
    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":nothing-to-select"),
    );
    expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":list-failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Saved workflows could not be read.");
    expect(screen.queryByRole("option", { name: "No saved workflows yet" })).not.toBeInTheDocument();
  });

  it("says the list is still loading rather than pointing at an empty picker", async () => {
    // r4 review R2. Before the first fetch resolved, four strings told the user
    // to choose a revision from a picker whose only option read "Loading saved
    // workflows…". The instant now has a state of its own; `hasSelectableContext`
    // is false during it, but the helper's ladder ranks "loading" above
    // "unavailable" so nothing claims the project is empty.
    let settle: (rows: unknown[]) => void = () => {};
    mocks.listDagWorkflowDefinitions.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        settle = resolve;
      }),
    );
    render(<DagBuilderSurface projectId="project-a" />);

    expect(
      await screen.findByRole("option", { name: "Loading saved workflows…" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("builder-assistant")).toHaveTextContent(":list-loading");
    expect(screen.getByTestId("builder-assistant")).not.toHaveTextContent(":list-failed");

    settle([workflow("microscopy_qc", 4, "Microscopy QC")]);
    await waitFor(() =>
      expect(screen.getByTestId("builder-assistant")).not.toHaveTextContent(":list-loading"),
    );
    expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument();

    // A RELOAD behind a settled list is not the loading instant: the picker
    // still holds its options, so the copy must not go back to waiting.
    mocks.listDagWorkflowDefinitions.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        settle = resolve;
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Reload the workflow list" }));
    expect(screen.getByTestId("builder-assistant")).not.toHaveTextContent(":list-loading");
    settle([workflow("microscopy_qc", 4, "Microscopy QC")]);
  });

  it("bans the canvas-reach words across this surface's own copy, in every list state", async () => {
    // r4 review R4. helper-agent-chat.test.tsx runs the ban over the 19 strings
    // `helperEmptyState("dag-builder")` returns, and r4's report then summarised
    // that as "every user-visible string in all four states", which it is not:
    // the rail's other fixed strings are rendered by THIS file, including the
    // permanent strip line that r3's F2 was actually about. This is the other
    // half of the ban.
    const seen = new Set<string>();
    const collect = (container: HTMLElement) => {
      for (const element of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
        // The helper is mocked out here; its strings are banned in its own file.
        if (element.closest("[data-testid='builder-assistant']")) continue;
        const label = element.getAttribute("aria-label");
        if (label) seen.add(label);
        if (element.children.length === 0 && element.textContent) seen.add(element.textContent);
        // Direct text nodes too: a control like `<Icon /> Send` has an element
        // child, so the leaf rule alone would skip its label.
        for (const node of Array.from(element.childNodes)) {
          const text = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").trim() : "";
          if (text) seen.add(text);
        }
      }
    };

    // (a) the first fetch still in flight.
    const pending = render(<DagBuilderSurface projectId="project-a" />);
    mocks.listDagWorkflowDefinitions.mockReturnValue(new Promise<unknown[]>(() => {}));
    pending.unmount();
    const loading = render(<DagBuilderSurface projectId="project-a" />);
    expect(
      await screen.findByRole("option", { name: "Loading saved workflows…" }),
    ).toBeInTheDocument();
    collect(loading.container);
    loading.unmount();

    // (b) a list with rows, and one of them selected — the only state that
    //     renders the node/edge strip line.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([
      workflow("microscopy_qc", 4, "Microscopy QC"),
      workflow("rna_seq", 1, "RNA-seq"),
    ]);
    const listed = render(<DagBuilderSurface projectId="project-a" />);
    const picker = await screen.findByLabelText("SAVED WORKFLOW REVISION");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument(),
    );
    collect(listed.container);
    await userEvent.selectOptions(picker, "microscopy_qc@4");
    await waitFor(() =>
      expect(screen.getByText(/3 nodes · 2 edges/)).toBeInTheDocument(),
    );
    collect(listed.container);
    // The collapsed rail too, for the toggle's other accessible name. Reopened
    // afterwards because the choice is persisted, and a rail that mounts
    // collapsed never fetches at all.
    await userEvent.click(screen.getByRole("button", { name: "Hide builder assistant" }));
    collect(listed.container);
    await userEvent.click(screen.getByRole("button", { name: "Show builder assistant" }));
    listed.unmount();

    // (c) the empty list, (d) the failed list, (e) the malformed envelope.
    for (const rows of [[] as unknown[], null, undefined]) {
      if (rows === null) {
        mocks.listDagWorkflowDefinitions.mockRejectedValue(
          new Error("Saved workflows could not be listed."),
        );
      } else {
        mocks.listDagWorkflowDefinitions.mockResolvedValue(rows as never);
      }
      const view = render(<DagBuilderSurface projectId="project-a" />);
      await waitFor(() =>
        expect(screen.getByTestId("builder-assistant")).toHaveTextContent("dag-builder:"),
      );
      await waitFor(() =>
        expect(screen.queryByRole("option", { name: "Loading saved workflows…" })).not
          .toBeInTheDocument(),
      );
      collect(view.container);
      view.unmount();
    }

    const collected = [...seen];
    // The collector really does reach the strings the review named — otherwise
    // the loop above could pass by seeing nothing.
    for (const pinned of [
      "Only the selected revision is sent — never the unsaved canvas draft.",
      "The assistant explains and drafts YAML here in the chat. It cannot edit the canvas, and the canvas has no YAML import.",
      "Loading saved workflows…",
      "Select a saved workflow…",
      "No saved workflows yet",
      "Saved workflows could not be listed",
      "Reload the workflow list",
      "Hide builder assistant",
      "Show builder assistant",
      "DAG BUILDER",
      "BUILDER ASSISTANT",
      "SAVED WORKFLOW REVISION",
      "separate session",
    ]) {
      expect(collected).toContain(pinned);
    }
    for (const text of collected) {
      expect(text).not.toMatch(NO_CANVAS_REACH);
      expect(text).not.toMatch(NOTHING_GOES_INTO_THE_CANVAS);
    }
  });
});
