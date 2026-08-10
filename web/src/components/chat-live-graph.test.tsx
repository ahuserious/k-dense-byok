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
