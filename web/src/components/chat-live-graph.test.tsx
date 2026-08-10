import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatLiveGraph,
  ChatLiveGraphTabs,
  parseRunStateV1Projection,
  startChatRunStatePolling,
  type RunStateV1Projection,
} from "./chat-live-graph";

function validProjection(
  overrides: Partial<RunStateV1Projection> = {},
): RunStateV1Projection {
  return {
    schemaVersion: 1,
    runId: "wrun_11111111111111111111111111111111",
    workflowId: "live-graph",
    workflowRevision: 3,
    status: "running",
    nodes: [
      {
        id: "prepare",
        status: "succeeded",
        progress: { completed: 1, total: 1, message: "prepared" },
        executionId: "execution-prepare",
      },
      {
        id: "analyze",
        status: "running",
        progress: { completed: 2, total: 5, message: "reading samples" },
        executionId: "execution-analyze",
      },
    ],
    topology: {
      nodes: [{ id: "prepare" }, { id: "analyze" }],
      edges: [{ id: "prepare-analyze", from: "prepare", to: "analyze" }],
    },
    backgroundAgentTrailingNode: {
      slotId: "background-agent",
      agentId: "rescue-agent",
      nodeId: "analyze",
      status: "running",
    },
    updatedAt: 1_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatLiveGraph", () => {
  it("renders a synthetic valid RunState graph with progress and a trailing agent", () => {
    const projection = parseRunStateV1Projection(validProjection());
    render(<ChatLiveGraph projection={projection} />);

    expect(screen.getByText("prepare")).toBeInTheDocument();
    expect(screen.getByText("analyze")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "analyze progress" }),
    ).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByText("rescue-agent")).toBeInTheDocument();
    expect(screen.getByText("analyze → background agent")).toBeInTheDocument();
    expect(
      document.querySelector("[data-trailing-node='background-agent']"),
    ).toHaveAttribute("data-attached-to", "analyze");
  });

  it("surfaces the Scientific DAG tab when RunState carries chat error routing", () => {
    const projection = validProjection({
      status: "failed",
      nodes: [
        {
          id: "prepare",
          status: "succeeded",
          progress: { completed: 1, total: 1 },
        },
        {
          id: "analyze",
          status: "failed",
          progress: { completed: 1, total: 1 },
        },
      ],
      backgroundAgentTrailingNode: undefined,
      errorRouting: {
        source: "chat-stream",
        surface: true,
        nodeId: "analyze",
        error: {
          code: "CHAT_STREAM_ERROR",
          message: "provider disconnected",
          retryable: true,
        },
      },
    });
    render(
      <ChatLiveGraphTabs
        projection={parseRunStateV1Projection(projection)}
        conversation={<div>Conversation transcript</div>}
      />,
    );

    expect(screen.getByRole("tab", { name: "Scientific DAG" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "provider disconnected",
    );
    expect(
      screen.queryByText("Conversation transcript"),
    ).not.toBeInTheDocument();
  });

  it("rejects invalid projections instead of making them renderable", () => {
    const invalid = validProjection();
    invalid.nodes[1].progress.completed = 6;
    expect(() => parseRunStateV1Projection(invalid)).toThrow(/node progress/);
  });
});

describe("chat RunState polling", () => {
  it("keeps polling an interrupted run and renders its resumed update", async () => {
    vi.useFakeTimers();
    const interrupted = parseRunStateV1Projection(
      validProjection({
        status: "interrupted",
        nodes: [
          {
            id: "prepare",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
          {
            id: "analyze",
            status: "interrupted",
            progress: { completed: 1, total: 1 },
          },
        ],
        backgroundAgentTrailingNode: undefined,
      }),
    );
    const resumed = parseRunStateV1Projection(validProjection());
    const terminal = parseRunStateV1Projection(
      validProjection({
        status: "succeeded",
        nodes: [
          {
            id: "prepare",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
          {
            id: "analyze",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
        ],
        backgroundAgentTrailingNode: undefined,
      }),
    );
    const fetchProjection = vi
      .fn()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(resumed)
      .mockResolvedValueOnce(terminal);
    const onProjection = vi.fn();
    const stop = startChatRunStatePolling({
      fetchProjection,
      onProjection,
      intervalMs: 10,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onProjection).toHaveBeenLastCalledWith(interrupted);
    await vi.advanceTimersByTimeAsync(10);
    expect(onProjection).toHaveBeenLastCalledWith(resumed);
    await vi.advanceTimersByTimeAsync(10);
    expect(onProjection).toHaveBeenLastCalledWith(terminal);
    expect(fetchProjection).toHaveBeenCalledTimes(3);
    stop();
  });

  it("waits for durable error routing before surfacing a terminal DAG", async () => {
    vi.useFakeTimers();
    const terminalWithoutRouting = parseRunStateV1Projection(
      validProjection({
        status: "failed",
        nodes: [
          {
            id: "prepare",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
          {
            id: "analyze",
            status: "failed",
            progress: { completed: 1, total: 1 },
          },
        ],
        backgroundAgentTrailingNode: undefined,
      }),
    );
    const terminalWithRouting = parseRunStateV1Projection({
      ...terminalWithoutRouting,
      updatedAt: terminalWithoutRouting.updatedAt + 1,
      errorRouting: {
        source: "chat-stream",
        surface: true,
        nodeId: "analyze",
        error: {
          code: "CHAT_STREAM_ERROR",
          message: "persisted provider failure",
          retryable: true,
        },
      },
    });
    const fetchProjection = vi
      .fn()
      .mockResolvedValueOnce(terminalWithoutRouting)
      .mockResolvedValueOnce(terminalWithRouting);
    const onProjection = vi.fn();
    const stop = startChatRunStatePolling({
      fetchProjection,
      onProjection,
      intervalMs: 10,
      awaitErrorRouting: true,
      finalizationWindowMs: 100,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onProjection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onProjection).toHaveBeenCalledWith(terminalWithRouting);

    render(
      <ChatLiveGraphTabs
        projection={onProjection.mock.calls[0][0]}
        conversation={<div>Conversation transcript</div>}
      />,
    );
    expect(screen.getByRole("tab", { name: "Scientific DAG" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "persisted provider failure",
    );
    stop();
  });

  it("keeps polling past an old terminal association until a new run appears", async () => {
    vi.useFakeTimers();
    const oldTerminal = parseRunStateV1Projection(
      validProjection({
        status: "succeeded",
        nodes: [
          {
            id: "prepare",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
          {
            id: "analyze",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
        ],
        backgroundAgentTrailingNode: undefined,
      }),
    );
    const replacementRunId = "wrun_22222222222222222222222222222222";
    const newRunning = parseRunStateV1Projection(
      validProjection({ runId: replacementRunId }),
    );
    const newTerminal = parseRunStateV1Projection(
      validProjection({
        runId: replacementRunId,
        status: "succeeded",
        nodes: [
          {
            id: "prepare",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
          {
            id: "analyze",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
        ],
        backgroundAgentTrailingNode: undefined,
      }),
    );
    const fetchProjection = vi
      .fn()
      .mockResolvedValueOnce(oldTerminal)
      .mockResolvedValueOnce(oldTerminal)
      .mockResolvedValueOnce(newRunning)
      .mockResolvedValueOnce(newTerminal);
    const onProjection = vi.fn();
    const stop = startChatRunStatePolling({
      fetchProjection,
      onProjection,
      intervalMs: 10,
      launchWindowMs: 100,
      waitForReplacementOfRunId: oldTerminal.runId,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchProjection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchProjection).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(onProjection).toHaveBeenLastCalledWith(newRunning);
    await vi.advanceTimersByTimeAsync(10);
    expect(onProjection).toHaveBeenLastCalledWith(newTerminal);
    expect(fetchProjection).toHaveBeenCalledTimes(4);
    stop();
  });

  it("stops scheduling polls after a terminal projection", async () => {
    const terminal = parseRunStateV1Projection(
      validProjection({
        status: "succeeded",
        nodes: [
          {
            id: "prepare",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
          {
            id: "analyze",
            status: "succeeded",
            progress: { completed: 1, total: 1 },
          },
        ],
        backgroundAgentTrailingNode: {
          slotId: "background-agent",
          agentId: "rescue-agent",
          nodeId: "analyze",
          status: "succeeded",
        },
      }),
    );
    const fetchProjection = vi.fn().mockResolvedValue(terminal);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const stop = startChatRunStatePolling({
      fetchProjection,
      onProjection: vi.fn(),
      intervalMs: 10,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchProjection).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    stop();
  });
});
