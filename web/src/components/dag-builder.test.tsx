import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const helperProps = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/components/helper-agent-chat", () => ({
  HelperAgentChat: (props: unknown) => {
    helperProps.capture(props);
    return <div data-testid="builder-helper-agent" />;
  },
}));

import { DagBuilder } from "./dag-builder";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";
import * as dagApi from "@/lib/dag-workflows";

function storedDefinition(
  projectName: string,
  revision: number,
): dagApi.VersionedDagWorkflowDefinition {
  const id = projectName.toLowerCase().replaceAll(" ", "-");
  const graph = createDefaultWorkflowGraph(id, projectName);
  return {
    etag: `"${revision}"`,
    definition: {
      storageVersion: 1,
      id,
      revision,
      createdAt: 1,
      updatedAt: revision,
      graphSha256: `sha-${revision}`,
      graph,
    },
  };
}

function runRecord(
  selected: dagApi.VersionedDagWorkflowDefinition,
  id = "wrun_created",
): dagApi.WorkflowRunRecord {
  return {
    manifest: {
      storageVersion: 1,
      id,
      projectId: "project-a",
      workflowId: selected.definition.id,
      workflowRevision: selected.definition.revision,
      graphSha256: selected.definition.graphSha256,
      requestId: "run-request",
      requestSha256: "request-sha",
      createdAt: 10,
      requestedBy: "user",
      input: {},
      effectiveLimits: {},
      graph: selected.definition.graph,
    },
    state: {
      runId: id,
      status: "queued",
      lastSeq: 1,
      executions: {},
      recoverable: true,
      diagnostics: [],
    },
  };
}

afterEach(() => {
  helperProps.capture.mockClear();
  vi.restoreAllMocks();
});

describe("DagBuilder", () => {
  it("tracks dirty state and saves through revision compare-and-swap", async () => {
    const selected = storedDefinition("Graph Alpha", 4);
    const saved = storedDefinition("Renamed Graph", 5);
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue(saved);
    const onDefinitionChanged = vi.fn();
    render(
      <DagBuilder
        projectId="project-a"
        selectedDefinition={selected}
        activeSessionId={null}
        budgetBlocked={false}
        onDefinitionChanged={onDefinitionChanged}
      />,
    );

    expect(helperProps.capture).toHaveBeenCalledWith(expect.objectContaining({
      profile: "dag-builder",
      contextReference: { kind: "workflow", id: "graph-alpha@4" },
    }));

    expect(await screen.findByTestId("dag-dirty-state")).toHaveTextContent("Saved");
    const graphName = screen.getAllByLabelText("Name")[0];
    await userEvent.clear(graphName);
    await userEvent.type(graphName, "Renamed Graph");
    expect(screen.getByTestId("dag-dirty-state")).toHaveTextContent("Unsaved changes");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "graph-alpha",
        expect.objectContaining({ name: "Renamed Graph" }),
        4,
      );
      expect(onDefinitionChanged).toHaveBeenCalledWith(saved);
    });
    expect(screen.getByTestId("dag-dirty-state")).toHaveTextContent("Saved");
    expect(screen.getByRole("status")).toHaveTextContent("Saved revision 5");
  });

  it("does not invent Builder context when no saved workflow is selected", () => {
    render(
      <DagBuilder
        projectId="project-a"
        selectedDefinition={null}
        activeSessionId={null}
        budgetBlocked={false}
        onDefinitionChanged={vi.fn()}
      />,
    );
    const props = helperProps.capture.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({ profile: "dag-builder" });
    expect(props).not.toHaveProperty("contextReference");
  });

  it("keeps the unsaved draft visible when the server reports a CAS conflict", async () => {
    const selected = storedDefinition("Conflict Graph", 2);
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockRejectedValue(
      new dagApi.DagWorkflowApiError(
        409,
        "Expected workflow revision 2, but the latest revision is 3.",
        "CONFLICT",
      ),
    );
    render(
      <DagBuilder
        projectId="project-a"
        selectedDefinition={selected}
        activeSessionId={null}
        budgetBlocked={false}
        onDefinitionChanged={vi.fn()}
      />,
    );
    const graphName = screen.getAllByLabelText("Name")[0];
    await userEvent.clear(graphName);
    await userEvent.type(graphName, "My local draft");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save conflict");
    expect(graphName).toHaveValue("My local draft");
    expect(screen.getByTestId("dag-dirty-state")).toHaveTextContent("Unsaved changes");
  });

  it("resets draft and selection when the project snapshot changes", async () => {
    const first = storedDefinition("Project One Graph", 1);
    const second = storedDefinition("Project Two Graph", 7);
    const { rerender } = render(
      <DagBuilder
        projectId="project-one"
        selectedDefinition={first}
        activeSessionId={null}
        budgetBlocked={false}
        onDefinitionChanged={vi.fn()}
      />,
    );
    const graphName = screen.getAllByLabelText("Name")[0];
    await userEvent.clear(graphName);
    await userEvent.type(graphName, "Unsaved project one change");
    expect(screen.getByTestId("dag-dirty-state")).toHaveTextContent("Unsaved");

    rerender(
      <DagBuilder
        projectId="project-two"
        selectedDefinition={second}
        activeSessionId={null}
        budgetBlocked={false}
        onDefinitionChanged={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Project Two Graph" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Name")[0]).toHaveValue("Project Two Graph");
    expect(screen.getByTestId("dag-dirty-state")).toHaveTextContent("Saved");
    expect(screen.getByRole("button", { name: "Start, Agent node" })).toHaveAttribute("aria-pressed", "true");
  });

  it("launches the saved revision with a bounded goal and active Kady session once", async () => {
    const selected = storedDefinition("Runnable Graph", 6);
    const createdRun = runRecord(selected);
    let resolveRun!: (run: dagApi.WorkflowRunRecord) => void;
    const pendingRun = new Promise<dagApi.WorkflowRunRecord>((resolve) => {
      resolveRun = resolve;
    });
    vi.spyOn(dagApi, "createDagWorkflowRun").mockReturnValue(pendingRun);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    render(
      <DagBuilder
        projectId="project-a"
        selectedDefinition={selected}
        activeSessionId="session-active"
        budgetBlocked={false}
        onDefinitionChanged={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByLabelText("Run goal"), "  Verify the experiment  ");
    const runButton = screen.getByRole("button", { name: "Run" });
    await userEvent.click(runButton);
    expect(runButton).toBeDisabled();
    await userEvent.click(runButton);
    expect(dagApi.createDagWorkflowRun).toHaveBeenCalledTimes(1);
    expect(dagApi.createDagWorkflowRun).toHaveBeenCalledWith(
      "project-a",
      "runnable-graph",
      {
        requestId: "11111111-1111-4111-8111-111111111111",
        expectedWorkflowRevision: 6,
        sessionId: "session-active",
        input: { goal: "Verify the experiment" },
      },
    );

    resolveRun(createdRun);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created run wrun_created with status queued",
    );
    expect(screen.queryByText(/executing/i)).not.toBeInTheDocument();
  });

  it("allows configured-default runs without a session but disables dirty and budget-blocked launches", async () => {
    const selected = storedDefinition("No Session Graph", 1);
    const blocked = storedDefinition("Budget Blocked Graph", 2);
    const { rerender } = render(
      <DagBuilder
        projectId="project-a"
        selectedDefinition={selected}
        activeSessionId={null}
        budgetBlocked={false}
        onDefinitionChanged={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Run" })).toBeEnabled();
    expect(screen.getByText(/configured Kady default/)).toBeInTheDocument();
    const graphName = screen.getAllByLabelText("Name")[0];
    await userEvent.type(graphName, " changed");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run" })).toHaveAttribute(
      "title",
      "Save this draft before starting a run",
    );

    rerender(
      <DagBuilder
        projectId="project-a"
        selectedDefinition={blocked}
        activeSessionId={null}
        budgetBlocked
        onDefinitionChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Budget Blocked Graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run" })).toHaveAttribute(
      "title",
      "Project spend limit reached",
    );
  });
});
