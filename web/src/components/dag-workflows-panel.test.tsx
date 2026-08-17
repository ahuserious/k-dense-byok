import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DagWorkflowsPanel } from "./dag-workflows-panel";
import * as dagApi from "@/lib/dag-workflows";
import * as pipelinesApi from "@/lib/pipelines";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";
import * as registryApi from "@/lib/scientific-pipeline-registry";
import { createDagWorkflowTemplateGraph } from "@/lib/dag-workflow-templates";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.spyOn(registryApi, "vendoredPipelineEngineHealth").mockResolvedValue(true);
  vi.spyOn(registryApi, "listVendoredWorkflowRegistrySources").mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

function mockVendoredWorkflows(
  workflows: Array<{ name: string; description: string; nodes?: unknown[] }>,
): void {
  vi.mocked(registryApi.listVendoredWorkflowRegistrySources).mockResolvedValue(
    workflows.map((workflow) => registryApi.vendoredWorkflowRegistrySource({
      ...workflow,
      nodes: workflow.nodes ?? [{ id: `${workflow.name}-node`, prompt: "Run workflow." }],
    }, { codebaseId: "codebase-a" })!),
  );
}

function renderPanel({
  activeSessionId = null,
  budgetBlocked = false,
  uploadedFiles = [],
  onRunPipeline = vi.fn(),
  onEditPipeline = vi.fn(),
}: {
  activeSessionId?: string | null;
  budgetBlocked?: boolean;
  uploadedFiles?: readonly string[];
  onRunPipeline?: (name: string) => Promise<unknown>;
  onEditPipeline?: (target: registryApi.VendoredPipelineEditTarget) => void;
} = {}) {
  return render(
    <DagWorkflowsPanel
      projectId="project-a"
      activeSessionId={activeSessionId}
      budgetBlocked={budgetBlocked}
      uploadedFiles={uploadedFiles}
      onRunPipeline={onRunPipeline}
      onEditPipeline={onEditPipeline}
    />,
  );
}

describe("DagWorkflowsPanel", () => {
  it("renders one registry list with both engines and all backing actions", async () => {
    mockVendoredWorkflows([
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
    expect(screen.getByText("vendored engine online")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open builder ↗" })).toBeInTheDocument();
    expect(await screen.findByText("Fusion review")).toBeInTheDocument();
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.getByText("Revision 7")).toBeInTheDocument();
    expect(screen.getByText("4 nodes")).toBeInTheDocument();
    expect(screen.getByText("3 edges")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", {
      name: "Edit microscopy-qc with vendored engine",
    }));
    await userEvent.click(screen.getByRole("button", {
      name: "Run microscopy-qc with vendored engine",
    }));
    expect(onEditPipeline).toHaveBeenCalledWith({
      workflowId: "microscopy-qc",
      codebaseId: "codebase-a",
    });
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

  it("renders the same cross-engine workflow once when name and structure match", async () => {
    const graph = createDefaultWorkflowGraph("shared-review", "Shared Review");
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "shared-review",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "shared-sha",
        graph,
      },
    };
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([{
      id: "shared-review",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      graphSha256: "shared-sha",
      schemaVersion: graph.schemaVersion,
      name: "Shared Review",
      description: graph.description ?? null,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    }]);
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    mockVendoredWorkflows([{
      name: "  shared   review ",
      description: "The same workflow in the vendored engine",
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        prompt: "Run workflow.",
        depends_on: graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
      })),
    }]);

    renderPanel();

    const list = await screen.findByRole("list", { name: "Scientific pipeline workflows" });
    await waitFor(() => expect(within(list).getByText("Vendored")).toBeInTheDocument());
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Typed")).toBeInTheDocument();
  });

  it("publishes runnable typed rows while vendored loading hangs, then deduplicates late data", async () => {
    const graph = createDefaultWorkflowGraph("late-shared-review", "Late Shared Review");
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "late-shared-review",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "late-shared-sha",
        graph,
      },
    };
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([{
      id: "late-shared-review",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      graphSha256: "late-shared-sha",
      schemaVersion: graph.schemaVersion,
      name: graph.name,
      description: graph.description ?? null,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    }]);
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    const createRun = vi.spyOn(dagApi, "createDagWorkflowRun").mockResolvedValue({
      manifest: { id: "late-typed-run" },
      state: { status: "queued" },
    } as dagApi.WorkflowRunRecord);
    let resolveVendored!: (sources: registryApi.VendoredWorkflowRegistrySource[]) => void;
    vi.mocked(registryApi.listVendoredWorkflowRegistrySources).mockReturnValue(
      new Promise((resolve) => {
        resolveVendored = resolve;
      }),
    );

    renderPanel();

    const list = await screen.findByRole("list", { name: "Scientific pipeline workflows" });
    expect(within(list).getByText("Late Shared Review")).toBeInTheDocument();
    expect(within(list).getByText("Typed")).toBeInTheDocument();
    expect(within(list).queryByText("Vendored")).not.toBeInTheDocument();

    await userEvent.click(within(list).getByRole("button", {
      name: "Open Late Shared Review details",
    }));
    const runButton = await screen.findByRole("button", { name: "Run typed workflow" });
    expect(runButton).toBeEnabled();
    await userEvent.click(runButton);
    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      "project-a",
      "late-shared-review",
      expect.objectContaining({ expectedWorkflowRevision: 1 }),
    ));

    const vendored = registryApi.vendoredWorkflowRegistrySource({
      name: " late shared review ",
      description: "Late vendored alias",
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        prompt: "Run workflow.",
        depends_on: graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
      })),
    }, { codebaseId: "codebase-a" });
    await act(async () => resolveVendored([vendored!]));

    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
      expect(within(list).getByText("Typed")).toBeInTheDocument();
      expect(within(list).getByText("Vendored")).toBeInTheDocument();
    });
  });

  it("publishes vendored rows while the typed list remains pending", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockReturnValue(
      new Promise<dagApi.DagWorkflowDefinitionSummary[]>(() => {}),
    );
    mockVendoredWorkflows([{
      name: "vendored-first",
      description: "Available before the typed API settles",
    }]);

    renderPanel();

    const list = await screen.findByRole("list", { name: "Scientific pipeline workflows" });
    expect(within(list).getByText("vendored-first")).toBeInTheDocument();
    expect(within(list).getByText("Vendored")).toBeInTheDocument();
    expect(within(list).queryByText("Typed")).not.toBeInTheDocument();
    expect(within(list).getByRole("button", {
      name: "Run vendored-first with vendored engine",
    })).toBeEnabled();
  });

  it("publishes and runs vendored rows while the advisory health request hangs", async () => {
    vi.mocked(registryApi.vendoredPipelineEngineHealth).mockReturnValue(
      new Promise<boolean>(() => {}),
    );
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    mockVendoredWorkflows([{
      name: "health-independent",
      description: "Available without the advisory probe",
    }]);
    const onRunPipeline = vi.fn().mockResolvedValue({
      accepted: true,
      status: "started",
    });

    renderPanel({ onRunPipeline });

    const runButton = await screen.findByRole("button", {
      name: "Run health-independent with vendored engine",
    });
    expect(screen.getByText("checking vendored engine…")).toBeInTheDocument();
    await userEvent.click(runButton);
    await waitFor(() => expect(onRunPipeline).toHaveBeenCalledWith("health-independent"));
  });

  it("shows degraded health without clearing a successful vendored list", async () => {
    vi.mocked(registryApi.vendoredPipelineEngineHealth).mockRejectedValue(
      new Error("health probe timed out"),
    );
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    mockVendoredWorkflows([{
      name: "degraded-health",
      description: "List remains authoritative for presentation",
    }]);

    renderPanel();

    expect(await screen.findByText("degraded-health")).toBeInTheDocument();
    expect(await screen.findByText("vendored health degraded")).toBeInTheDocument();
    expect(screen.getByText(/health probe timed out/)).toHaveTextContent(
      "Workflows returned by the list request remain available.",
    );
  });

  it("routes duplicate vendored names independently by stable workflow id", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    vi.mocked(registryApi.listVendoredWorkflowRegistrySources).mockResolvedValue([
      registryApi.vendoredWorkflowRegistrySource({
        name: "duplicate-name",
        description: "First record",
        nodes: [{ id: "collect" }],
      }, {
        codebaseId: "codebase-a",
        origin: "project",
        filename: "first.yaml",
        workflowId: "workflow_11111111111111111111111111111111",
      })!,
      registryApi.vendoredWorkflowRegistrySource({
        name: "duplicate-name",
        description: "Second record",
        nodes: [{ id: "collect" }],
      }, {
        codebaseId: "codebase-a",
        origin: "project",
        filename: "second.yaml",
        workflowId: "workflow_22222222222222222222222222222222",
      })!,
    ]);
    const onEditPipeline = vi.fn();
    const onRunPipeline = vi.fn();

    renderPanel({ onEditPipeline, onRunPipeline });

    const list = await screen.findByRole("list", { name: "Scientific pipeline workflows" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const editButtons = within(list).getAllByRole("button", {
      name: "Edit duplicate-name with vendored engine",
    });
    const runButtons = within(list).getAllByRole("button", {
      name: "Run duplicate-name with vendored engine",
    });
    for (const button of [...editButtons, ...runButtons]) {
      expect(button).toBeEnabled();
      await userEvent.click(button);
    }
    expect(onEditPipeline.mock.calls.map(([target]) => target)).toEqual([
      {
        workflowId: "workflow_11111111111111111111111111111111",
        codebaseId: "codebase-a",
      },
      {
        workflowId: "workflow_22222222222222222222222222222222",
        codebaseId: "codebase-a",
      },
    ]);
    expect(onRunPipeline.mock.calls.map(([id]) => id)).toEqual([
      "workflow_11111111111111111111111111111111",
      "workflow_22222222222222222222222222222222",
    ]);
  });

  it("routes normalized display-name collisions independently by stable filename", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    vi.mocked(registryApi.listVendoredWorkflowRegistrySources).mockResolvedValue([
      registryApi.vendoredWorkflowRegistrySource({
        name: " foo ",
        nodes: [{ id: "collect", prompt: "Collect evidence." }],
      }, { codebaseId: "codebase-a", origin: "project", filename: "padded.yaml" })!,
      registryApi.vendoredWorkflowRegistrySource({
        name: "foo",
        nodes: [{ id: "collect", prompt: "Collect evidence." }],
      }, { codebaseId: "codebase-a", origin: "catalogue", filename: "plain.yaml" })!,
    ]);
    const onEditPipeline = vi.fn();
    const onRunPipeline = vi.fn().mockResolvedValue({ accepted: true, status: "started" });

    renderPanel({ onEditPipeline, onRunPipeline });

    const list = await screen.findByRole("list", { name: "Scientific pipeline workflows" });
    const editButtons = within(list).getAllByRole("button", {
      name: "Edit foo with vendored engine",
    });
    const runButtons = within(list).getAllByRole("button", {
      name: "Run foo with vendored engine",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(editButtons[0]);
    await userEvent.click(editButtons[1]);
    await userEvent.click(runButtons[0]);
    await userEvent.click(runButtons[1]);

    expect(onEditPipeline.mock.calls.map(([target]) => target))
      .toEqual([
        { workflowId: "padded.yaml", codebaseId: "codebase-a" },
        { workflowId: "plain.yaml", codebaseId: "codebase-a" },
      ]);
    await waitFor(() => expect(onRunPipeline.mock.calls.map(([identifier]) => identifier))
      .toEqual(["padded.yaml", "plain.yaml"]));
  });

  it("routes the selected vendored pipeline directly without invoking typed admission or Builder", async () => {
    mockVendoredWorkflows([
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

    await userEvent.click(await screen.findByRole("button", {
      name: "Run microscopy-qc with vendored engine",
    }));

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
    mockVendoredWorkflows([
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
    await userEvent.click(screen.getByRole("button", {
      name: "Run microscopy-qc with vendored engine",
    }));

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
    mockVendoredWorkflows([
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

    await userEvent.click(await screen.findByRole("button", {
      name: "Run microscopy-qc with vendored engine",
    }));

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

  it("binds distinct uploaded files to each named required-file input", async () => {
    const graph = {
      ...createDefaultWorkflowGraph("file-review", "File review"),
      preconditions: {
        requiredInputs: [],
        requiredFiles: [
          { key: "dataset", label: "Dataset", minimumCount: 1 },
          { key: "protocol", label: "Protocol", minimumCount: 1 },
        ],
        requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
      },
    } satisfies dagApi.WorkflowGraphDocument;
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([{
      id: graph.id,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      graphSha256: "file-sha",
      schemaVersion: graph.schemaVersion,
      name: graph.name,
      description: graph.description ?? null,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    }]);
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue({
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: graph.id,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "file-sha",
        graph,
      },
    });
    const createRun = vi.spyOn(dagApi, "createDagWorkflowRun")
      .mockImplementation(() => new Promise<dagApi.WorkflowRunRecord>(() => undefined));

    renderPanel({
      uploadedFiles: ["user_data/dataset.csv", "user_data/protocol.md"],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Open File review details" }));
    await userEvent.type(screen.getByLabelText("Typed workflow run goal"), "Review inputs");
    await userEvent.click(screen.getByLabelText("Dataset: user_data/dataset.csv"));
    await userEvent.click(screen.getByLabelText("Protocol: user_data/protocol.md"));
    await userEvent.click(screen.getByRole("button", { name: "Run typed workflow" }));

    expect(createRun).toHaveBeenCalledWith("project-a", graph.id, expect.objectContaining({
      input: {
        goal: "Review inputs",
        files: {
          dataset: ["user_data/dataset.csv"],
          protocol: ["user_data/protocol.md"],
        },
      },
    }));
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
    const created: dagApi.SavedDagWorkflowDefinition = {
      outcome: "created",
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

    await screen.findByText("No workflows yet");
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
        { kind: "create" },
      );
      expect(screen.getByRole("heading", { name: "New research" })).toBeInTheDocument();
    });
  });

  it("creates the selected Machine Learning & AI template with best-of-2 and evidence routing", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const expectedGraph = createDagWorkflowTemplateGraph(
      "ml-model-selection-review",
      "ml-model-selection-review",
      "ML Model Selection Review",
    );
    const created: dagApi.SavedDagWorkflowDefinition = {
      outcome: "created",
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "ml-model-selection-review",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "template-sha",
        graph: expectedGraph,
      },
    };
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue(created);
    renderPanel();

    await screen.findByText("No workflows yet");
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
        expectedGraph,
        { kind: "create" },
      );
      expect(screen.getByRole("heading", { name: "ML Model Selection Review" })).toBeInTheDocument();
    });
  });

  it("surfaces a create conflict instead of overwriting an existing definition", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockRejectedValue(
      new dagApi.DagWorkflowApiError(
        409,
        "Workflow new-research already exists at revision 1; create requires absence.",
        "CONFLICT",
      ),
    );
    renderPanel();

    await screen.findByText("No workflows yet");
    await userEvent.click(screen.getByRole("button", { name: "New typed workflow" }));
    await userEvent.type(screen.getByLabelText("New workflow id"), "new-research");
    await userEvent.type(screen.getByLabelText("New workflow name"), "New research");
    await userEvent.click(screen.getByRole("button", { name: "Create and open" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "CONFLICT: Workflow new-research already exists at revision 1; create requires absence.",
    );
    expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledWith(
      "project-a",
      "new-research",
      expect.objectContaining({ id: "new-research" }),
      { kind: "create" },
    );
  });

  describe("opened details stay inside the pane and keep keyboard focus", () => {
    function mockOneTypedWorkflow() {
      const graph = createDefaultWorkflowGraph("fusion-review", "Fusion review");
      vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([{
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        schemaVersion: graph.schemaVersion,
        name: "Fusion review",
        description: graph.description ?? null,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      }]);
      vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue({
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
      });
    }

    async function openDetails() {
      renderPanel();
      const opener = await screen.findByRole("button", {
        name: "Open Fusion review details",
      });
      await userEvent.click(opener);
      const details = await screen.findByRole("region", { name: "Fusion review" });
      return { details, opener };
    }

    it("constrains the details panel and its raw definition box to the pane width", async () => {
      mockOneTypedWorkflow();
      const { details } = await openDetails();

      // Without these the JSON's single-line prompt strings size every flex
      // ancestor to the text, pushing Run/Close/Download off-screen.
      expect(details.className).toContain("min-w-0");
      expect(details.className).toContain("max-w-full");
      const rawDefinition = screen.getByTestId("raw-typed-definition");
      expect(rawDefinition.className).toContain("max-w-full");
      expect(rawDefinition.className).toContain("overflow-auto");
    });

    it("moves focus into the opened panel and returns it to the row control on close", async () => {
      mockOneTypedWorkflow();
      const { opener } = await openDetails();

      const heading = screen.getByRole("heading", { name: "Fusion review" });
      await waitFor(() => expect(heading).toHaveFocus());
      // ...and the arrival has to be visible. The heading used to carry
      // `outline-none`, so focus landed on a stop that looked identical
      // focused and unfocused. The indicator is drawn in the foreground
      // colour, not the faint shared ring token.
      expect(heading.className).not.toContain("outline-none");
      expect(heading.className).toContain("focus-visible:outline-2");
      expect(heading.className).toContain("focus-visible:outline-offset-2");
      expect(heading.className).toContain("focus-visible:outline-foreground");
      // The row control must survive the re-render so focus has somewhere to return.
      expect(opener).toBeInTheDocument();
      expect(opener).not.toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Close details" }));
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Fusion review" })).not.toBeInTheDocument(),
      );
      expect(opener).toHaveFocus();
    });

    it("labels the row with an identity the graph attach cannot change", async () => {
      mockOneTypedWorkflow();
      renderPanel();
      const opener = await screen.findByRole("button", {
        name: "Open Fusion review details",
      });
      const row = opener.closest("li") as HTMLElement;
      // Engine-namespaced source id + normalized name: unlike entry.id it
      // carries no structure hash, so it cannot collide with a second
      // definition the engine lists under the same id either.
      expect(row.getAttribute("data-workflow-registry-id")).toBe(
        "typed:fusion-review:fusion%20review",
      );

      await userEvent.click(opener);
      await screen.findByRole("region", { name: "Fusion review" });

      // Same node, same identity: opening attaches the graph and rewrites
      // entry.id, which is exactly what used to remount the row.
      expect(row.contains(opener)).toBe(true);
      expect(row.getAttribute("data-workflow-registry-id")).toBe(
        "typed:fusion-review:fusion%20review",
      );
    });

    it("ignores Escape typed inside a field so it cannot discard the run intent", async () => {
      mockOneTypedWorkflow();
      await openDetails();

      const goalInput = screen.getByLabelText("Typed workflow run goal");
      await userEvent.type(goalInput, "keep me");
      goalInput.focus();
      await userEvent.keyboard("{Escape}");

      // The panel holds the run goal, precondition values and file selections
      // in state a close throws away, and Escape in a text field is a reflex
      // (clear the field / dismiss an autocomplete), not a request to leave.
      expect(screen.getByRole("region", { name: "Fusion review" })).toBeInTheDocument();
      expect(goalInput).toHaveValue("keep me");
      expect(goalInput).toHaveFocus();
    });

    it("closes the panel with Escape and restores focus to the opener", async () => {
      mockOneTypedWorkflow();
      const { opener } = await openDetails();

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Fusion review" })).toHaveFocus(),
      );
      await userEvent.keyboard("{Escape}");

      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Fusion review" })).not.toBeInTheDocument(),
      );
      expect(opener).toHaveFocus();
    });
  });
});
