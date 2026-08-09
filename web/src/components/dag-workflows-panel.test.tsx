import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DagWorkflowsPanel } from "./dag-workflows-panel";
import * as dagApi from "@/lib/dag-workflows";
import * as pipelinesApi from "@/lib/pipelines";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";

beforeEach(() => {
  window.sessionStorage.clear();
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
  onRunPipeline?: (name: string) => Promise<unknown>;
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

  it("routes the selected vendored pipeline directly without invoking typed admission or Builder", async () => {
    vi.mocked(pipelinesApi.listPipelines).mockResolvedValue([
      { name: "microscopy-qc", description: "Inspect microscopy acquisition quality" },
    ]);
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const createTypedRun = vi.spyOn(dagApi, "createDagWorkflowRun");
    const onEditPipeline = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, status: "started" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderPanel({
      onEditPipeline,
      onRunPipeline: async (name) => ({
        receiptId: "vendored-receipt-1",
        response: await pipelinesApi.runPipeline(
          name,
          "vendored-receipt-1",
          `Run vendored pipeline ${name}.`,
        ),
      }),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Run" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/pipelines/microscopy-qc/run");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      conversationId: "vendored-receipt-1",
      message: "Run vendored pipeline microscopy-qc.",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Dispatch vendored-receipt-1 · started",
    );
    expect(createTypedRun).not.toHaveBeenCalled();
    expect(onEditPipeline).not.toHaveBeenCalled();
  });

  it("blocks vendored pipeline submission when the project budget is exhausted", async () => {
    vi.mocked(pipelinesApi.listPipelines).mockResolvedValue([
      { name: "microscopy-qc", description: "Inspect microscopy acquisition quality" },
    ]);
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const onRunPipeline = vi.fn().mockResolvedValue({
      receiptId: "must-not-run",
      response: { accepted: true, status: "started" },
    });

    renderPanel({ budgetBlocked: true, onRunPipeline });

    expect(await screen.findByText(
      "Vendored pipeline runs are disabled because the project spend limit is reached.",
    )).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(onRunPipeline).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      "Run failed: Project spend limit reached.",
    ));
  });

  it.each([
    {
      httpStatus: 400,
      body: { error: "Invalid workflow name." },
      detail: "Pipeline run failed (400): Invalid workflow name.",
    },
    {
      httpStatus: 502,
      body: { detail: "Vendored engine unavailable." },
      detail: "Pipeline run failed (502): Vendored engine unavailable.",
    },
    {
      httpStatus: 503,
      body: { message: "Vendored engine starting." },
      detail: "Pipeline run failed (503): Vendored engine starting.",
    },
    { httpStatus: 200, body: { status: "started" }, detail: "Vendored pipeline response did not confirm acceptance." },
  ])("renders HTTP $httpStatus non-success or unknown shapes as failures", async ({ httpStatus, body, detail }) => {
    vi.mocked(pipelinesApi.listPipelines).mockResolvedValue([
      { name: "microscopy-qc", description: "Inspect microscopy acquisition quality" },
    ]);
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: httpStatus,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderPanel({
      onRunPipeline: async (name) => ({
        receiptId: "vendored-receipt-failed",
        response: await pipelinesApi.runPipeline(
          name,
          "vendored-receipt-failed",
          `Run vendored pipeline ${name}.`,
        ),
      }),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      `Run failed: ${detail}`,
    ));
    expect(screen.queryByText(/Dispatch vendored-receipt-failed/)).not.toBeInTheDocument();
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

  it("reuses an ambiguous admission request id after remount until the run intent changes", async () => {
    const graph = createDefaultWorkflowGraph("retry-review", "Retry review");
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"4"',
      definition: {
        storageVersion: 1,
        id: "retry-review",
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "retry-sha",
        graph,
      },
    };
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([
      {
        id: "retry-review",
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "retry-sha",
        schemaVersion: graph.schemaVersion,
        name: graph.name,
        description: graph.description ?? null,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
    ]);
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    const createRun = vi.spyOn(dagApi, "createDagWorkflowRun")
      .mockRejectedValueOnce(
        new dagApi.DagWorkflowApiError(503, "Response lost after admission.", "UNAVAILABLE"),
      )
      .mockRejectedValueOnce(new TypeError("Transport connection reset."))
      .mockResolvedValueOnce({
        manifest: {
          storageVersion: 1,
          id: "wrun_reconciled",
          projectId: "project-a",
          workflowId: "retry-review",
          workflowRevision: 4,
          graphSha256: "retry-sha",
          requestId: "22222222-2222-4222-8222-222222222222",
          requestSha256: "request-sha",
          sessionId: "session-active",
          createdAt: 10,
          requestedBy: "user",
          input: { goal: "Changed goal" },
          effectiveLimits: {},
          graph,
        },
        state: {
          runId: "wrun_reconciled",
          status: "queued",
          lastSeq: 1,
          executions: {},
          recoverable: true,
          diagnostics: [],
        },
      });
    const randomUuid = vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

    const firstMount = renderPanel({ activeSessionId: "session-active" });

    await userEvent.click(await screen.findByRole("button", {
      name: "Open Retry review details",
    }));
    const goal = screen.getByLabelText("Typed workflow run goal");
    const runButton = screen.getByRole("button", { name: "Run typed workflow" });
    await userEvent.type(goal, "Original goal");

    await userEvent.click(runButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Retrying this unchanged run will reuse the same request id.",
    );
    expect(
      window.sessionStorage.getItem("kady:typed-workflow-run-requests:v1:project-a"),
    ).toContain("11111111-1111-4111-8111-111111111111");
    expect(
      window.sessionStorage.getItem("kady:typed-workflow-run-requests:v1:project-b"),
    ).toBeNull();

    firstMount.unmount();
    renderPanel({ activeSessionId: "session-active" });
    await userEvent.click(await screen.findByRole("button", {
      name: "Open Retry review details",
    }));
    const restoredGoal = screen.getByLabelText("Typed workflow run goal");
    await waitFor(() => expect(restoredGoal).toHaveValue("Original goal"));
    const restoredRunButton = screen.getByRole("button", { name: "Run typed workflow" });
    await userEvent.click(restoredRunButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(restoredRunButton).toBeEnabled());

    expect(createRun.mock.calls.slice(0, 2).map((call) => call[2].requestId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);

    await userEvent.clear(restoredGoal);
    await userEvent.type(restoredGoal, "Changed goal");
    await userEvent.click(restoredRunButton);
    expect(await screen.findByRole("status")).toHaveTextContent("Created run wrun_reconciled");

    expect(createRun.mock.calls.map((call) => call[2].requestId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(randomUuid).toHaveBeenCalledTimes(2);
    expect(
      window.sessionStorage.getItem("kady:typed-workflow-run-requests:v1:project-a"),
    ).toBeNull();
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
