import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/helper-agent-chat", () => ({
  HelperAgentChat: ({
    profile,
    contextReference,
  }: {
    profile: string;
    contextReference?: { kind: string; id: string };
  }) => (
    <div aria-label="Mock workflow rescue helper" data-profile={profile}>
      {contextReference ? `${contextReference.kind}:${contextReference.id}` : "no-source"}
    </div>
  ),
}));

import { DagWorkflowConsole } from "./dag-workflow-console";
import * as dagApi from "@/lib/dag-workflows";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";

function runFixture(
  status: dagApi.WorkflowRunStatus,
  id = `wrun_${status}`,
): dagApi.WorkflowRunRecord {
  return {
    manifest: {
      storageVersion: 1,
      id,
      projectId: "project-a",
      workflowId: "workflow-a",
      workflowRevision: 3,
      graphSha256: "graph-sha",
      requestId: `request-${id}`,
      requestSha256: "request-sha",
      createdAt: 1_800_000_000_000,
      requestedBy: "user",
      input: {},
      effectiveLimits: {},
      graph: createDefaultWorkflowGraph("workflow-a", "Workflow A"),
    },
    state: {
      runId: id,
      status,
      lastSeq: 1,
      executions: {},
      recoverable: status === "interrupted" || status === "failed",
      diagnostics: [],
    },
  };
}

function summaryFixture(run: dagApi.WorkflowRunRecord): dagApi.WorkflowRunSummary {
  return {
    id: run.manifest.id,
    workflowId: run.manifest.workflowId,
    workflowRevision: run.manifest.workflowRevision,
    graphSha256: run.manifest.graphSha256,
    sessionId: run.manifest.sessionId ?? null,
    createdAt: run.manifest.createdAt,
    requestedBy: run.manifest.requestedBy,
    status: run.state.status,
    lastSeq: run.state.lastSeq,
    startedAt: run.state.startedAt ?? null,
    finishedAt: run.state.finishedAt ?? null,
    interruptedAt: run.state.interruptedAt ?? null,
    recoverable: run.state.recoverable,
    lastError: run.state.lastError ?? null,
    diagnostics: run.state.diagnostics,
  };
}

function emptyEventPage(): dagApi.WorkflowRunEventPage {
  return { events: [], lastSeq: 0, hasMore: false, diagnostics: [] };
}

function emptyBudget(runId: string): dagApi.WorkflowRunBudgetSummary {
  return {
    runId,
    reservationCount: 0,
    ceilings: null,
    modelCallCount: 0,
    activeReservationCount: 0,
    activeReservedMaximumUsd: 0,
    activeReservedMaximumTokens: 0,
    settledReservationCount: 0,
    settledChargedUsd: 0,
    observedUsageTokens: 0,
    missingUsageMaximumTokens: 0,
    staleReservationCount: 0,
    fullChargeReservationCount: 0,
  };
}

beforeEach(() => {
  vi.spyOn(dagApi, "readDagWorkflowRunBudget").mockImplementation(
    async (_projectId, runId) => emptyBudget(runId),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DagWorkflowConsole", () => {
  it("refreshes durable runs when a previously mounted Console is reopened", async () => {
    const list = vi.spyOn(dagApi, "listDagWorkflowRuns").mockResolvedValue([]);
    const { rerender } = render(
      <DagWorkflowConsole projectId="project-a" active={false} />,
    );
    expect(list).not.toHaveBeenCalled();

    rerender(<DagWorkflowConsole projectId="project-a" active />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    rerender(<DagWorkflowConsole projectId="project-a" active={false} />);
    rerender(<DagWorkflowConsole projectId="project-a" active />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("keeps queued runs honest and pages authoritative ordered events", async () => {
    const summary: dagApi.WorkflowRunSummary = {
      id: "wrun_123",
      workflowId: "fusion-review",
      workflowRevision: 2,
      graphSha256: "abc",
      sessionId: null,
      createdAt: 1_800_000_000_000,
      requestedBy: "user",
      status: "queued",
      lastSeq: 2,
      startedAt: null,
      finishedAt: null,
      interruptedAt: null,
      recoverable: true,
      lastError: null,
      diagnostics: [],
    };
    const run: dagApi.WorkflowRunRecord = {
      manifest: {
        storageVersion: 1,
        id: "wrun_123",
        projectId: "project-a",
        workflowId: "fusion-review",
        workflowRevision: 2,
        graphSha256: "abc",
        requestId: "request-1",
        requestSha256: "def",
        createdAt: 1_800_000_000_000,
        requestedBy: "user",
        input: {},
        effectiveLimits: {},
        graph: createDefaultWorkflowGraph("fusion-review", "Fusion review"),
      },
      state: {
        runId: "wrun_123",
        status: "queued",
        lastSeq: 2,
        executions: {},
        recoverable: true,
        diagnostics: [{
          code: "torn-event-tail",
          message: "Recovered an incomplete final line.",
          fatal: false,
          line: 3,
        }],
      },
    };
    vi.spyOn(dagApi, "listDagWorkflowRuns").mockResolvedValue([summary]);
    vi.spyOn(dagApi, "readDagWorkflowRun").mockResolvedValue(run);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents")
      .mockResolvedValueOnce({
        events: [{
          schemaVersion: 1,
          eventId: "event-1",
          runId: "wrun_123",
          seq: 1,
          ts: 1_800_000_000_001,
          type: "run_queued",
          data: { source: "user" },
        }],
        lastSeq: 2,
        hasMore: true,
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        events: [{
          schemaVersion: 1,
          eventId: "event-2",
          runId: "wrun_123",
          seq: 2,
          ts: 1_800_000_000_002,
          type: "store_repaired",
        }],
        lastSeq: 2,
        hasMore: false,
        diagnostics: [],
      });

    render(<DagWorkflowConsole projectId="project-a" />);

    expect((await screen.findAllByText("Queued")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(await screen.findByText("torn-event-tail")).toBeInTheDocument();
    expect(screen.getByLabelText("Run budget commitments")).toHaveTextContent(
      "No model-call budget reservations yet.",
    );
    expect(screen.getByText("run_queued")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("store_repaired")).toBeInTheDocument();
    await waitFor(() => {
      expect(dagApi.pageDagWorkflowRunEvents).toHaveBeenLastCalledWith(
        "project-a",
        "wrun_123",
        { after: 1, limit: 200 },
      );
    });

    const eventRows = within(screen.getByLabelText("Authoritative workflow events"))
      .getAllByRole("listitem");
    expect(eventRows[0]).toHaveTextContent("#1");
    expect(eventRows[1]).toHaveTextContent("#2");
  });

  it("renders bounded run commitments and warns when missing usage was full-charged", async () => {
    const succeeded = runFixture("succeeded", "wrun_budget");
    vi.spyOn(dagApi, "listDagWorkflowRuns").mockResolvedValue([summaryFixture(succeeded)]);
    vi.spyOn(dagApi, "readDagWorkflowRun").mockResolvedValue(succeeded);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue(emptyEventPage());
    vi.mocked(dagApi.readDagWorkflowRunBudget).mockResolvedValue({
      runId: succeeded.manifest.id,
      reservationCount: 5,
      ceilings: { maxCostUsd: 12, maxTokens: 10_000, maxModelCalls: 8 },
      modelCallCount: 3,
      activeReservationCount: 1,
      activeReservedMaximumUsd: 2.5,
      activeReservedMaximumTokens: 300,
      settledReservationCount: 4,
      settledChargedUsd: 1.25,
      observedUsageTokens: 400,
      missingUsageMaximumTokens: 200,
      staleReservationCount: 1,
      fullChargeReservationCount: 2,
    });

    render(<DagWorkflowConsole projectId="project-a" />);

    const strip = await screen.findByLabelText("Run budget commitments");
    expect(strip).toHaveTextContent("Ceiling $12.00 · 10,000 tokens");
    expect(strip).toHaveTextContent("Model calls 3 / 8");
    expect(strip).toHaveTextContent("Active max $2.50 · 300 tokens (1)");
    expect(strip).toHaveTextContent("Settled $1.25");
    expect(strip).toHaveTextContent("Tokens 400 observed · ≤200 missing-usage envelope");
    expect(strip).toHaveTextContent(
      "2 settlements reported no terminal usage and charged the full reserved maximum. 1 was stale.",
    );
  });

  it("surfaces run-list errors with the backend code and detail", async () => {
    vi.spyOn(dagApi, "listDagWorkflowRuns").mockRejectedValue(
      new dagApi.DagWorkflowApiError(500, "Event history is malformed.", "CORRUPT"),
    );

    render(<DagWorkflowConsole projectId="project-a" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "CORRUPT: Event history is malformed.",
    );
  });

  it("polls active runs and appends newly persisted events without losing the cursor", async () => {
    vi.useFakeTimers();
    const running = runFixture("running", "wrun_poll");
    const succeeded = runFixture("succeeded", "wrun_poll");
    succeeded.state.lastSeq = 2;
    vi.spyOn(dagApi, "listDagWorkflowRuns")
      .mockResolvedValueOnce([summaryFixture(running)])
      .mockResolvedValue([summaryFixture(succeeded)]);
    vi.spyOn(dagApi, "readDagWorkflowRun")
      .mockResolvedValueOnce(running)
      .mockResolvedValue(succeeded);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents")
      .mockResolvedValueOnce({
        events: [{
          schemaVersion: 1,
          eventId: "event-started",
          runId: "wrun_poll",
          seq: 1,
          ts: 1_800_000_000_001,
          type: "node_started",
        }],
        lastSeq: 1,
        hasMore: false,
        diagnostics: [],
      })
      .mockResolvedValue({
        events: [{
          schemaVersion: 1,
          eventId: "event-succeeded",
          runId: "wrun_poll",
          seq: 2,
          ts: 1_800_000_000_002,
          type: "run_succeeded",
        }],
        lastSeq: 2,
        hasMore: false,
        diagnostics: [],
      });

    render(<DagWorkflowConsole projectId="project-a" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("node_started")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByText("run_succeeded")).toBeInTheDocument();
    expect(screen.getByText("node_started")).toBeInTheDocument();
    expect((screen.getAllByText("Succeeded")).length).toBeGreaterThan(0);
    expect(dagApi.pageDagWorkflowRunEvents).toHaveBeenLastCalledWith(
      "project-a",
      "wrun_poll",
      { after: 1, limit: 200 },
    );
    expect(dagApi.readDagWorkflowRunBudget).toHaveBeenLastCalledWith(
      "project-a",
      "wrun_poll",
    );
    expect(dagApi.readDagWorkflowRunBudget).toHaveBeenCalledTimes(2);
  });

  it("cancels an active run and refreshes its authoritative record immediately", async () => {
    const queued = runFixture("queued", "wrun_cancel");
    const cancelled = runFixture("cancelled", "wrun_cancel");
    vi.spyOn(dagApi, "listDagWorkflowRuns")
      .mockResolvedValueOnce([summaryFixture(queued)])
      .mockResolvedValue([summaryFixture(cancelled)]);
    vi.spyOn(dagApi, "readDagWorkflowRun")
      .mockResolvedValueOnce(queued)
      .mockResolvedValue(cancelled);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue(emptyEventPage());
    vi.spyOn(dagApi, "cancelDagWorkflowRun").mockResolvedValue(cancelled);

    render(<DagWorkflowConsole projectId="project-a" />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(dagApi.cancelDagWorkflowRun).toHaveBeenCalledWith("project-a", "wrun_cancel");
    expect(await screen.findByRole("status")).toHaveTextContent("Cancel requested");
    await waitFor(() => expect(dagApi.listDagWorkflowRuns).toHaveBeenCalledTimes(2));
    expect((screen.getAllByText("Cancelled")).length).toBeGreaterThan(0);
  });

  it("resumes only interrupted runs and refreshes the same run", async () => {
    const interrupted = runFixture("interrupted", "wrun_resume");
    const running = runFixture("running", "wrun_resume");
    vi.spyOn(dagApi, "listDagWorkflowRuns")
      .mockResolvedValueOnce([summaryFixture(interrupted)])
      .mockResolvedValue([summaryFixture(running)]);
    vi.spyOn(dagApi, "readDagWorkflowRun")
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValue(running);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue(emptyEventPage());
    vi.spyOn(dagApi, "resumeDagWorkflowRun").mockResolvedValue(running);

    render(<DagWorkflowConsole projectId="project-a" />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Resume" }));

    expect(dagApi.resumeDagWorkflowRun).toHaveBeenCalledWith("project-a", "wrun_resume");
    expect(await screen.findByRole("status")).toHaveTextContent("Resume requested");
    await waitFor(() => expect(dagApi.listDagWorkflowRuns).toHaveBeenCalledTimes(2));
  });

  it("creates and selects a distinct manual rescue run for a failed run", async () => {
    const failed = runFixture("failed", "wrun_failed");
    const rescue = runFixture("queued", "wrun_rescue");
    vi.spyOn(dagApi, "listDagWorkflowRuns")
      .mockResolvedValueOnce([summaryFixture(failed)])
      .mockResolvedValue([summaryFixture(rescue)]);
    vi.spyOn(dagApi, "readDagWorkflowRun").mockImplementation(
      async (_projectId, runId) => runId === rescue.manifest.id ? rescue : failed,
    );
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue(emptyEventPage());
    vi.spyOn(dagApi, "rescueDagWorkflowRun").mockResolvedValue(rescue);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");

    render(<DagWorkflowConsole projectId="project-a" />);
    await userEvent.click(await screen.findByRole("button", { name: "Rescue as new run" }));

    expect(dagApi.rescueDagWorkflowRun).toHaveBeenCalledWith(
      "project-a",
      "wrun_failed",
      { requestId: "22222222-2222-4222-8222-222222222222" },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Created rescue run wrun_rescue with status queued",
    );
    await waitFor(() => expect(dagApi.listDagWorkflowRuns).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("wrun_rescue").length).toBeGreaterThan(0);
  });

  it("offers a proposal-only helper bound only to the selected stopped-run id", async () => {
    const blocked = runFixture("blocked", "wrun_blocked");
    blocked.state.lastError = {
      code: "EVIDENCE_GATE_BLOCKED",
      message: "Required artifact was not verified.",
      retryable: false,
    };
    blocked.state.diagnostics = [{
      code: "missing-artifact",
      message: "Expected report.json.",
      fatal: true,
      line: 4,
    }];
    vi.spyOn(dagApi, "listDagWorkflowRuns").mockResolvedValue([summaryFixture(blocked)]);
    vi.spyOn(dagApi, "readDagWorkflowRun").mockResolvedValue(blocked);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue({
      events: [{
        schemaVersion: 1,
        eventId: "event-gate-blocked",
        runId: blocked.manifest.id,
        seq: 7,
        ts: 1_800_000_000_007,
        type: "run_blocked",
        nodeId: "evidence-gate",
        attempt: 2,
        executionId: "dagx_gate_2",
      }],
      lastSeq: 7,
      hasMore: false,
      diagnostics: [],
    });

    render(<DagWorkflowConsole projectId="project-a" />);

    const helper = await screen.findByLabelText("Mock workflow rescue helper");
    expect(helper).toHaveAttribute("data-profile", "workflow-rescue");
    expect(helper).toHaveTextContent("run:wrun_blocked");
    expect(helper).not.toHaveTextContent(".kady/workflows");
    expect(screen.getByLabelText("Proposal-only workflow rescue")).toHaveTextContent(
      "this helper cannot apply, retry, or control anything",
    );
  });

  it.each(["succeeded", "cancelled"] as const)(
    "does not expose the rescue helper for a %s run",
    async (status) => {
    const completed = runFixture(status, `wrun_${status}`);
    vi.spyOn(dagApi, "listDagWorkflowRuns").mockResolvedValue([summaryFixture(completed)]);
    vi.spyOn(dagApi, "readDagWorkflowRun").mockResolvedValue(completed);
    vi.spyOn(dagApi, "pageDagWorkflowRunEvents").mockResolvedValue(emptyEventPage());

    render(<DagWorkflowConsole projectId="project-a" />);
    await screen.findByText(`wrun_${status}`);
    await waitFor(() => expect(dagApi.readDagWorkflowRun).toHaveBeenCalled());
    expect(screen.queryByLabelText("Proposal-only workflow rescue")).not.toBeInTheDocument();
  });
});
