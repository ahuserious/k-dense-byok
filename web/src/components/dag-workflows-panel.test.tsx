import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DagWorkflowsPanel } from "./dag-workflows-panel";
import * as dagApi from "@/lib/dag-workflows";
import * as pipelinesApi from "@/lib/pipelines";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";

beforeEach(() => {
  vi.spyOn(pipelinesApi, "pipelineHealth").mockResolvedValue(true);
  vi.spyOn(pipelinesApi, "listPipelines").mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

function renderPanel({
  activeSessionId = null,
  budgetBlocked = false,
  onRunPipeline = vi.fn(),
  onEditPipeline = vi.fn(),
}: {
  activeSessionId?: string | null;
  budgetBlocked?: boolean;
  onRunPipeline?: (name: string) => void;
  onEditPipeline?: (name: string) => void;
} = {}) {
  return render(
    <DagWorkflowsPanel
      projectId="project-a"
      activeSessionId={activeSessionId}
      budgetBlocked={budgetBlocked}
      onRunPipeline={onRunPipeline}
      onEditPipeline={onEditPipeline}
    />,
  );
}

describe("DagWorkflowsPanel", () => {
  it("renders the vendored and typed-engine lists together with all vendored actions", async () => {
    vi.mocked(pipelinesApi.listPipelines).mockResolvedValue([
      { name: "microscopy-qc", description: "Inspect microscopy acquisition quality" },
    ]);
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([
      {
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        schemaVersion: "1.0",
        name: "Fusion review",
        description: "Compare two bounded research paths",
        nodeCount: 4,
        edgeCount: 3,
      },
    ]);
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"7"',
      definition: {
        storageVersion: 1,
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        graph: createDefaultWorkflowGraph("fusion-review", "Fusion review"),
      },
    };
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    const onRunPipeline = vi.fn();
    const onEditPipeline = vi.fn();

    renderPanel({ onRunPipeline, onEditPipeline });

    expect(screen.getByRole("heading", { name: "Scientific Pipelines" })).toBeInTheDocument();
    expect(await screen.findByText("microscopy-qc")).toBeInTheDocument();
    expect(screen.getByText("engine online")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open builder ↗" })).toBeInTheDocument();
    expect(await screen.findByText("Fusion review")).toBeInTheDocument();
    expect(screen.getByText("Revision 7")).toBeInTheDocument();
    expect(screen.getByText("4 nodes")).toBeInTheDocument();
    expect(screen.getByText("3 edges")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onEditPipeline).toHaveBeenCalledWith("microscopy-qc");
    expect(onRunPipeline).toHaveBeenCalledWith("microscopy-qc");

    await userEvent.click(screen.getByRole("button", {
      name: "Open Fusion review details",
    }));
    await waitFor(() => {
      expect(dagApi.readDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "fusion-review",
      );
      expect(screen.getByRole("heading", { name: "Fusion review" })).toBeInTheDocument();
      expect(JSON.parse(screen.getByTestId("raw-typed-definition").textContent ?? ""))
        .toEqual(selected.definition);
      expect(screen.getByRole("button", { name: "Download raw definition" }))
        .toBeInTheDocument();
    });
  });

  it("runs the selected saved revision once with session, bounded goal, and revision safeguards", async () => {
    const graph = createDefaultWorkflowGraph("fusion-review", "Fusion review");
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"7"',
      definition: {
        storageVersion: 1,
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        graph,
      },
    };
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([
      {
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        schemaVersion: graph.schemaVersion,
        name: graph.name,
        description: graph.description ?? null,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
    ]);
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    let resolveRun!: (run: dagApi.WorkflowRunRecord) => void;
    const pendingRun = new Promise<dagApi.WorkflowRunRecord>((resolve) => {
      resolveRun = resolve;
    });
    vi.spyOn(dagApi, "createDagWorkflowRun").mockReturnValue(pendingRun);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    renderPanel({ activeSessionId: "session-active" });

    await userEvent.click(await screen.findByRole("button", {
      name: "Open Fusion review details",
    }));
    const goal = screen.getByLabelText("Typed workflow run goal");
    expect(goal).toHaveAttribute("maxlength", String(dagApi.MAX_WORKFLOW_RUN_GOAL_LENGTH));
    await userEvent.type(goal, "  Verify the experiment  ");
    const runButton = screen.getByRole("button", { name: "Run typed workflow" });
    await userEvent.click(runButton);
    expect(runButton).toBeDisabled();
    await userEvent.click(runButton);
    expect(dagApi.createDagWorkflowRun).toHaveBeenCalledTimes(1);
    expect(dagApi.createDagWorkflowRun).toHaveBeenCalledWith(
      "project-a",
      "fusion-review",
      {
        requestId: "11111111-1111-4111-8111-111111111111",
        expectedWorkflowRevision: 7,
        sessionId: "session-active",
        input: { goal: "Verify the experiment" },
      },
    );

    resolveRun({
      manifest: {
        storageVersion: 1,
        id: "wrun_created",
        projectId: "project-a",
        workflowId: "fusion-review",
        workflowRevision: 7,
        graphSha256: "abc",
        requestId: "11111111-1111-4111-8111-111111111111",
        requestSha256: "request-sha",
        sessionId: "session-active",
        createdAt: 10,
        requestedBy: "user",
        input: { goal: "Verify the experiment" },
        effectiveLimits: {},
        graph,
      },
      state: {
        runId: "wrun_created",
        status: "queued",
        lastSeq: 1,
        executions: {},
        recoverable: true,
        diagnostics: [],
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created run wrun_created with status queued",
    );
  });

  it("blocks typed workflow admission when the project budget is exhausted", async () => {
    const graph = createDefaultWorkflowGraph("budgeted-review", "Budgeted review");
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"2"',
      definition: {
        storageVersion: 1,
        id: "budgeted-review",
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "budget-sha",
        graph,
      },
    };
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([
      {
        id: "budgeted-review",
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "budget-sha",
        schemaVersion: graph.schemaVersion,
        name: graph.name,
        description: graph.description ?? null,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
    ]);
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    const createRun = vi.spyOn(dagApi, "createDagWorkflowRun");

    renderPanel({ activeSessionId: "session-active", budgetBlocked: true });

    await userEvent.click(await screen.findByRole("button", {
      name: "Open Budgeted review details",
    }));
    const runButton = screen.getByRole("button", { name: "Run typed workflow" });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute("title", "Project spend limit reached");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("shows the server code and detail when the typed list fails", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockRejectedValue(
      new dagApi.DagWorkflowApiError(500, "Definition digest failed.", "CORRUPT"),
    );

    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "CORRUPT: Definition digest failed.",
    );
  });

  it("creates a minimal bounded Pi (Kady) graph through the real definition PUT", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const created: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "new-research",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "new-sha",
        graph: createDefaultWorkflowGraph("new-research", "New research"),
      },
    };
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue(created);
    renderPanel();

    await screen.findByText("No typed workflows yet");
    await userEvent.click(screen.getByRole("button", { name: "New typed workflow" }));
    await userEvent.type(screen.getByLabelText("New workflow id"), "new-research");
    await userEvent.type(screen.getByLabelText("New workflow name"), "New research");
    await userEvent.type(screen.getByLabelText("New workflow description"), "Private model study");
    await userEvent.click(screen.getByRole("button", { name: "Create and open" }));

    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "new-research",
        expect.objectContaining({
          id: "new-research",
          name: "New research",
          description: "Private model study",
          defaultModel: expect.objectContaining({
            requested: expect.objectContaining({ source: "kady-current" }),
            resolution: { mode: "exact" },
          }),
          rescue: expect.objectContaining({ enabled: true, maxAttempts: 2 }),
        }),
      );
      expect(screen.getByRole("heading", { name: "New research" })).toBeInTheDocument();
    });
  });

  it("creates the selected Machine Learning & AI template with best-of-2 and evidence routing", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const created: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "ml-model-selection-review",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "template-sha",
        graph: createDefaultWorkflowGraph(
          "ml-model-selection-review",
          "ML Model Selection Review",
        ),
      },
    };
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue(created);
    renderPanel();

    await screen.findByText("No typed workflows yet");
    await userEvent.click(screen.getByRole("button", { name: "New typed workflow" }));
    await userEvent.selectOptions(
      screen.getByLabelText("Workflow template"),
      "ml-model-selection-review",
    );

    expect(screen.getByLabelText("New workflow id")).toHaveValue(
      "ml-model-selection-review",
    );
    expect(screen.getByLabelText("New workflow name")).toHaveValue(
      "ML Model Selection Review",
    );
    expect(screen.getByText("Machine Learning & AI", { selector: "span" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create and open" }));

    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "ml-model-selection-review",
        expect.objectContaining({
          id: "ml-model-selection-review",
          name: "ML Model Selection Review",
          defaultModel: {
            requested: expect.objectContaining({ source: "kady-current" }),
            resolution: { mode: "exact" },
          },
          rescue: expect.objectContaining({ enabled: true }),
          evidence: expect.objectContaining({ enabled: true }),
          nodes: expect.arrayContaining([
            expect.objectContaining({ kind: "best-of-n", candidateCount: 2 }),
            expect.objectContaining({ kind: "evidence-gate", onUnsupportedOutput: "rescue" }),
          ]),
          edges: expect.arrayContaining([
            expect.objectContaining({ condition: "evidence-supported" }),
          ]),
        }),
      );
      expect(screen.getByRole("heading", { name: "ML Model Selection Review" })).toBeInTheDocument();
    });
  });
});
