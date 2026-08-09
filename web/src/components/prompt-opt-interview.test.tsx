import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/projects", () => ({
  apiFetch: mocks.apiFetch,
  useProjectScopeId: () => "project-a",
}));

import { PromptOptimizationInterview } from "./prompt-opt-interview";

const pendingState = {
  stateVersion: 1 as const,
  runId: "run-a",
  nodeId: "optimize-prompt",
  status: "pending" as const,
  deadlineAt: 60_000,
  questions: {
    title: "Optimization constraints",
    questions: [{ id: "audience", type: "text" as const, question: "Audience?" }],
  },
};

function response(state: unknown, ok = true) {
  return { ok, json: async () => ({ state }) };
}

describe("PromptOptimizationInterview polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.apiFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling through null -> pending -> answered", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(pendingState))
      .mockResolvedValueOnce(response({ ...pendingState, status: "answered" }));
    render(
      <PromptOptimizationInterview
        runId="run-a"
        nodeId="optimize-prompt"
        projectId="project-a"
        runActive
      />,
    );

    await act(async () => {});
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("Optimization constraints")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("Optimization interview answered.")).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
  });

  it("recovers from transient failure with bounded backoff and stops when the run terminates", async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue(response(pendingState));
    const view = render(
      <PromptOptimizationInterview
        runId="run-a"
        nodeId="optimize-prompt"
        projectId="project-a"
        runActive
      />,
    );

    await act(async () => {});
    expect(screen.getByText("temporary outage")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText("Optimization constraints")).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);

    view.rerender(
      <PromptOptimizationInterview
        runId="run-a"
        nodeId="optimize-prompt"
        projectId="project-a"
        runActive={false}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });
});
