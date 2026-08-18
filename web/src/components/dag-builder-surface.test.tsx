import { render, screen, waitFor } from "@testing-library/react";
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
    providerBlocked?: boolean;
  }) => {
    helperProps.capture(props);
    return (
      <div data-testid="builder-assistant">
        {props.profile}:
        {props.contextReference ? `${props.contextReference.kind}:${props.contextReference.id}` : "no-context"}
        {props.hasSelectableContext === false ? ":nothing-to-select" : ""}
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
      screen.getByText("The assistant explains and drafts YAML you copy in. It cannot edit the canvas."),
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

  it("revalidates the saved-revision list on refresh and on reopening the rail", async () => {
    // R1 [medium]: the list was fetched once per page load while a comment
    // claimed the option list was authoritative. The canvas saves revisions in
    // a cross-origin iframe this rail cannot observe, so a stale list showed
    // "No saved workflows yet" after a save and pinned superseded revisions the
    // server then rejected with CONFLICT.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([]);
    render(<DagBuilderSurface projectId="project-a" />);

    await waitFor(() => expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(1));

    // A workflow is saved in the canvas while the rail is open.
    mocks.listDagWorkflowDefinitions.mockResolvedValue([workflow("microscopy_qc", 4, "Microscopy QC")]);
    await userEvent.click(screen.getByRole("button", { name: "Refresh the workflow list" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Microscopy QC · rev 4" })).toBeInTheDocument(),
    );
    expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(2);

    // Collapsing and reopening the rail refetches too.
    await userEvent.click(screen.getByRole("button", { name: "Hide builder assistant" }));
    expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Show builder assistant" }));
    await waitFor(() => expect(mocks.listDagWorkflowDefinitions).toHaveBeenCalledTimes(3));
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
});
