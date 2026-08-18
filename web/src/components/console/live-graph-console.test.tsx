import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/helper-agent-chat", () => ({
  HelperAgentChat: ({ profile }: { profile: string }) => (
    <div aria-label="Mock workflow rescue helper" data-profile={profile} />
  ),
}));

import { LiveGraphConsole } from "./live-graph-console";
import * as projectsApi from "@/lib/projects";
import * as dagApi from "@/lib/dag-workflows";
import { WORKSPACE_SCHEMA_VERSION, WORKSPACE_STORAGE_KEY } from "@/lib/workspace-persistence";

const NOW = Date.now();

function runSummary(
  id: string,
  status: dagApi.WorkflowRunStatus,
): dagApi.WorkflowRunSummary {
  return {
    id,
    workflowId: "rna-seq",
    workflowRevision: 1,
    graphSha256: "sha",
    sessionId: null,
    createdAt: NOW - 20_000,
    requestedBy: "user",
    status,
    lastSeq: 2,
    startedAt: NOW - 10_000,
    finishedAt: null,
    interruptedAt: null,
    recoverable: false,
    lastError: null,
    diagnostics: [],
  };
}

const RUN_FRAMES = [
  { seq: 1, type: "run_start", runId: "run-1" },
  { seq: 2, type: "turn_start" },
  { seq: 3, type: "message_start", role: "user", content: "Cluster the RNA-seq counts." },
  { seq: 4, type: "tool_start", toolCallId: "call_a1", toolName: "bash", args: { command: "head counts.tsv" } },
];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

let sessionRows: Array<Record<string, unknown>>;
let runStateBody: unknown;
let workflowRunStateBody: unknown;
let apiFetchPaths: string[];

beforeEach(() => {
  sessionRows = [
    {
      id: "session-a",
      name: "RNA clustering",
      created: new Date(NOW - 300_000).toISOString(),
      modified: new Date(NOW - 5_000).toISOString(),
      messageCount: 4,
      firstMessage: "Cluster the RNA-seq counts.",
    },
  ];
  runStateBody = { status: "none" };
  workflowRunStateBody = { state: null };
  apiFetchPaths = [];
  window.localStorage.clear();

  vi.spyOn(projectsApi, "listProjects").mockResolvedValue([
    {
      id: "default",
      name: "Genomics",
      description: "",
      tags: [],
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      archived: false,
      spendLimitUsd: null,
    },
  ]);
  vi.spyOn(projectsApi, "listProjectActivities").mockResolvedValue({});
  vi.spyOn(dagApi, "listDagWorkflowRuns").mockResolvedValue([runSummary("wrun_1", "running")]);
  vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue({
    events: [
      { schemaVersion: 1, eventId: "e1", runId: "wrun_1", seq: 1, ts: NOW, type: "run_started" },
      {
        schemaVersion: 1,
        eventId: "e2",
        runId: "wrun_1",
        seq: 2,
        ts: NOW + 1,
        type: "node_started",
        nodeId: "analyze",
      },
    ],
    lastSeq: 2,
    hasMore: false,
    diagnostics: [],
  });
  vi.spyOn(projectsApi, "apiFetch").mockImplementation(async (path: string) => {
    apiFetchPaths.push(path);
    if (path === "/sessions") return jsonResponse(sessionRows);
    if (path.endsWith("/run/state")) return jsonResponse(runStateBody);
    if (path.endsWith("/workflow-run-state")) return jsonResponse(workflowRunStateBody);
    throw new Error(`unexpected apiFetch ${path}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live-graph console shell", () => {
  it("lists running DAG runs and recent sessions in the rail", async () => {
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    const rail = await screen.findByRole("complementary", { name: "Live work" });
    await waitFor(() => {
      expect(within(rail).getByRole("button", { name: /rna-seq/ })).toBeInTheDocument();
    });
    expect(within(rail).getByRole("button", { name: /RNA clustering/ })).toBeInTheDocument();
    // The typed run console stays the default main area.
    expect(screen.getByText("typed run console")).toBeInTheDocument();
  });

  it("names the reason when nothing is running, never a bare spinner", async () => {
    vi.mocked(dagApi.listDagWorkflowRuns).mockResolvedValue([]);
    sessionRows = [];

    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);
    const rail = await screen.findByRole("complementary", { name: "Live work" });
    const empty = await within(rail).findByText(/no queued or running DAG workflow runs/i);
    expect(empty).toHaveTextContent(/last 30 minutes/i);
    // The retired-brand absence assertion lives in the specs whose token-ban
    // waiver already names the token (e2e/builder.spec.ts, e2e/workspace.spec.ts);
    // repeating it here would need a config/token-ban.json entry this lane
    // does not own.
    expect(empty.textContent ?? "").toMatch(/no queued or running DAG workflow runs/i);
  });

  it("shows the session root and its turn/tool nodes, and advances status", async () => {
    runStateBody = {
      status: "running",
      run: {
        runId: "run-1",
        prompt: "Cluster the RNA-seq counts.",
        images: [],
        baseline: { messages: [], contextUsage: null },
        frames: RUN_FRAMES,
        lastSeq: 4,
      },
    };
    const user = userEvent.setup();
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    const rail = await screen.findByRole("complementary", { name: "Live work" });
    await user.click(await within(rail).findByRole("button", { name: /RNA clustering/ }));

    const graph = await screen.findByRole("region", { name: "Session live graph" });
    const root = await waitFor(() => {
      const node = graph.querySelector('[data-node-id="session:session-a"]');
      if (!node) throw new Error("session root not rendered");
      return node;
    });
    expect(root.getAttribute("data-node-status")).toBe("running");
    expect(graph.querySelector('[data-node-id="turn:1"]')).not.toBeNull();
    const tool = graph.querySelector('[data-node-id="tool:call_a1"]');
    expect(tool?.getAttribute("data-node-status")).toBe("running");

    // The next poll carries the tool's end and the run's completion.
    runStateBody = {
      status: "complete",
      run: {
        runId: "run-1",
        prompt: "Cluster the RNA-seq counts.",
        images: [],
        baseline: { messages: [], contextUsage: null },
        frames: [
          ...RUN_FRAMES,
          { seq: 5, type: "tool_end", toolCallId: "call_a1", toolName: "bash", isError: false, result: "ok" },
          { seq: 6, type: "turn_end" },
          { seq: 7, type: "done" },
        ],
        lastSeq: 7,
      },
    };
    await waitFor(
      () => {
        const node = graph.querySelector('[data-node-id="tool:call_a1"]');
        expect(node?.getAttribute("data-node-status")).toBe("ok");
      },
      { timeout: 8_000 },
    );
  }, 15_000);

  it("says the run graph waits on the snapshot instead of stubbing it", async () => {
    const user = userEvent.setup();
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    const rail = await screen.findByRole("complementary", { name: "Live work" });
    await user.click(await within(rail).findByRole("button", { name: /rna-seq/ }));

    const main = await screen.findByRole("region", { name: "DAG run graph" });
    expect(main).toHaveTextContent(/run graph lands with the typed run-document snapshot/i);
    // Its persisted events are still real, in the drawer.
    const drawer = await screen.findByRole("complementary", { name: "Event drawer" });
    await waitFor(() => {
      expect(within(drawer).getByText("node_started")).toBeInTheDocument();
    });
    expect(
      within(drawer).getByRole("button", { name: "Workflow Rescue" }),
    ).toBeInTheDocument();
  });

  it("selects the source named by a ?run= deep link", async () => {
    window.history.replaceState(null, "", "/?run=wrun_1");
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    expect(await screen.findByRole("region", { name: "DAG run graph" })).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("makes no request at all while the Console is not the visible view", async () => {
    // The Console stays mounted-but-hidden once visited, so `active` is the
    // only thing standing between the reader being in Chat and this surface
    // sweeping every project's sessions every three seconds.
    render(
      <LiveGraphConsole
        projectId="default"
        active={false}
        runsConsole={<div>typed run console</div>}
      />,
    );
    const rail = await screen.findByRole("complementary", { name: "Live work" });
    expect(rail).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(projectsApi.listProjects).not.toHaveBeenCalled();
    expect(projectsApi.listProjectActivities).not.toHaveBeenCalled();
    expect(dagApi.listDagWorkflowRuns).not.toHaveBeenCalled();
    expect(dagApi.pageDagWorkflowRunEvents).not.toHaveBeenCalled();
    expect(apiFetchPaths).toEqual([]);
  });

  it("badges a running session in the rail without it being selected", async () => {
    // Round 1 hard-coded every session `idle`, so a session whose own header
    // said RUN RUNNING still read `idle` with no live chip in the rail.
    runStateBody = {
      status: "running",
      run: {
        runId: "run-1",
        prompt: "Cluster the RNA-seq counts.",
        images: [],
        baseline: { messages: [], contextUsage: null },
        frames: RUN_FRAMES,
        lastSeq: 4,
      },
    };
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    const rail = await screen.findByRole("complementary", { name: "Live work" });
    const row = await within(rail).findByRole("button", { name: /RNA clustering/ });
    await waitFor(() => {
      // The pulsing chip and the status word are separate elements, so match
      // them exactly rather than against the row's run-together text content.
      expect(within(row).getByText("live")).toBeInTheDocument();
    });
    expect(within(row).getByText("running")).toBeInTheDocument();
    expect(apiFetchPaths).toContain("/sessions/session-a/run/state");
  });

  it("lists the session's real frames in the drawer, not its projected nodes", async () => {
    runStateBody = {
      status: "running",
      run: {
        runId: "run-1",
        prompt: "Cluster the RNA-seq counts.",
        images: [],
        baseline: { messages: [], contextUsage: null },
        frames: [
          ...RUN_FRAMES,
          { seq: 5, type: "text_delta", delta: "Inspecting the matrix." },
        ],
        lastSeq: 5,
      },
    };
    const user = userEvent.setup();
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    const rail = await screen.findByRole("complementary", { name: "Live work" });
    await user.click(await within(rail).findByRole("button", { name: /RNA clustering/ }));

    const graph = await screen.findByRole("region", { name: "Session live graph" });
    await waitFor(() => {
      expect(graph.querySelector('[data-node-id="turn:1"]')).not.toBeNull();
    });
    await user.click(graph.querySelector('[data-node-id="turn:1"]') as HTMLElement);

    const drawer = await screen.findByRole("complementary", { name: "Event drawer" });
    const list = within(drawer).getByLabelText("Ordered events");
    await waitFor(() => {
      // Genuine frame types, including the ones the fold models away.
      expect(list.querySelector('[data-event-type="message_start"]')).not.toBeNull();
    });
    expect(list.querySelector('[data-event-type="text_delta"]')).not.toBeNull();
    expect(list.querySelector('[data-event-type="tool_start"]')).not.toBeNull();
    // Not the node restatements the round-1 drawer showed.
    expect(list.textContent).not.toMatch(/tool\.running/);
  });

  it("swaps to the delegated typed run when its dag node is clicked", async () => {
    runStateBody = {
      status: "running",
      run: {
        runId: "run-1",
        prompt: "Cluster the RNA-seq counts.",
        images: [],
        baseline: { messages: [], contextUsage: null },
        frames: RUN_FRAMES,
        lastSeq: 4,
      },
    };
    workflowRunStateBody = {
      state: {
        schemaVersion: 1,
        runId: "wrun_1",
        workflowId: "rna-seq",
        workflowRevision: 1,
        status: "running",
        nodes: [],
        topology: { nodes: [], edges: [] },
      },
    };
    const user = userEvent.setup();
    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);

    const rail = await screen.findByRole("complementary", { name: "Live work" });
    await user.click(await within(rail).findByRole("button", { name: /RNA clustering/ }));

    const graph = await screen.findByRole("region", { name: "Session live graph" });
    const dagNode = await waitFor(() => {
      const node = graph.querySelector('[data-node-id="dag:wrun_1"]');
      if (!node) throw new Error("dag node not rendered");
      return node as HTMLElement;
    });
    expect(dagNode.getAttribute("data-node-kind")).toBe("dag");

    await user.click(dagNode);
    const main = await screen.findByRole("region", { name: "DAG run graph" });
    expect(main.getAttribute("data-run-id")).toBe("wrun_1");
    const drawer = await screen.findByRole("complementary", { name: "Event drawer" });
    await waitFor(() => {
      expect(within(drawer).getByText("node_started")).toBeInTheDocument();
    });
  });

  it("includes an open chat tab from another project when all projects are on", async () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: WORKSPACE_SCHEMA_VERSION,
        screen: "workspace",
        openedProjectIds: ["default"],
        projects: {
          default: {
            tabs: [{ id: "tab-9", title: "Open elsewhere", sessionId: "session-open" }],
            activeTabId: "tab-9",
          },
        },
      }),
    );

    render(<LiveGraphConsole projectId="default" runsConsole={<div>typed run console</div>} />);
    const rail = await screen.findByRole("complementary", { name: "Live work" });
    expect(
      await within(rail).findByRole("button", { name: /Open elsewhere/ }),
    ).toBeInTheDocument();
  });
});
