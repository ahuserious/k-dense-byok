import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as dagWorkflows from "@/lib/dag-workflows";
import * as skillCurator from "@/lib/skill-curator";
import * as useProjects from "@/lib/use-projects";
import { AutoresearchMonitorPanel } from "./autoresearch-monitor-panel";

afterEach(() => vi.restoreAllMocks());

function mockProject() {
  vi.spyOn(useProjects, "useProjects").mockReturnValue({
    activeProjectId: "project-1",
    activeProject: { id: "project-1", name: "Project 1" },
  } as unknown as ReturnType<typeof useProjects.useProjects>);
}

function evaluation(
  mode: skillCurator.AutoresearchMonitorMode,
  terminal = false,
): skillCurator.AutoresearchEvaluation {
  return {
    runId: "wrun_test",
    mode,
    cycle: 1,
    maxEvaluations: mode === "interactive" ? 1 : 3,
    remainingEvaluations: mode === "interactive" ? 0 : 2,
    state: {
      status: terminal ? "succeeded" : "running",
      lastSeq: 7,
      recoverable: false,
      terminal,
      canStopRun: !terminal,
    },
    critiques: [
      {
        id: "critique-1",
        severity: "warning",
        title: "Unsupported claim observed",
        detail: "A persisted evidence gate rejected one claim.",
        source: {
          kind: "run-event",
          seq: 7,
          eventId: "event-7",
          eventType: "evidence_checked",
        },
      },
    ],
    nextAfterSeq: 7,
    needsUserInput: false,
    question: null,
    persistedToRunState: false,
    runStatePersistenceReason:
      "RunState v1 has no critique/evaluation event channel on this build.",
  };
}

describe("AutoresearchMonitorPanel", () => {
  it("runs one interactive evaluation against live RunState and uses the existing cancel path", async () => {
    mockProject();
    const evaluate = vi.spyOn(skillCurator, "evaluateAutoresearchRun")
      .mockResolvedValue(evaluation("interactive"));
    const cancel = vi.spyOn(dagWorkflows, "cancelDagWorkflowRun").mockResolvedValue({
      manifest: {} as never,
      state: {
        runId: "wrun_test",
        status: "cancelled",
        lastSeq: 8,
        executions: {},
        recoverable: false,
        diagnostics: [],
      },
    });

    render(<AutoresearchMonitorPanel />);
    await userEvent.type(screen.getByLabelText("Workflow run id"), "wrun_test");
    await userEvent.type(
      screen.getByLabelText("Interactive evaluation direction"),
      "Challenge the primary endpoint.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Evaluate with user" }));

    await waitFor(() =>
      expect(evaluate).toHaveBeenCalledWith(
        "wrun_test",
        {
          mode: "interactive",
          cycle: 1,
          maxEvaluations: 1,
          afterSeq: 0,
          userInput: "Challenge the primary endpoint.",
        },
        "project-1",
      )
    );
    expect(await screen.findByText("Unsupported claim observed")).toBeVisible();
    expect(
      screen.getByText(/RunState v1 has no critique\/evaluation event channel/),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("project-1", "wrun_test"));
    expect(await screen.findByText(/now reports cancelled/)).toBeVisible();
  });

  it("passes the user's explicit autonomous bound and stops at terminal state", async () => {
    mockProject();
    const evaluate = vi.spyOn(skillCurator, "evaluateAutoresearchRun")
      .mockResolvedValue(evaluation("autonomous", true));
    vi.spyOn(dagWorkflows, "cancelDagWorkflowRun");

    render(<AutoresearchMonitorPanel pollIntervalMs={1} />);
    await userEvent.type(screen.getByLabelText("Workflow run id"), "wrun_test");
    await userEvent.click(screen.getByRole("button", { name: "autonomous" }));
    const bound = screen.getByLabelText("Maximum autonomous evaluations");
    fireEvent.change(bound, { target: { value: "3" } });
    await userEvent.click(screen.getByRole("button", { name: "Start bounded monitor" }));

    await waitFor(() =>
      expect(evaluate).toHaveBeenCalledWith(
        "wrun_test",
        {
          mode: "autonomous",
          cycle: 1,
          maxEvaluations: 3,
          afterSeq: 0,
        },
        "project-1",
      )
    );
    expect(
      await screen.findByText(/stopped at its explicit evaluation bound or terminal state/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeDisabled();
    expect(screen.getByText(/authoritative run state is terminal/i)).toBeVisible();
  });
});
