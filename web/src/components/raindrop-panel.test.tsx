import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_A = `wrun_${"a".repeat(32)}`;
const RUN_B = `wrun_${"b".repeat(32)}`;
const SESSION_DEFAULT = "session-default";
const SESSION_HISTORY = "session-history";
const mocks = vi.hoisted(() => ({
  listDagWorkflowRuns: vi.fn(),
  listRaindropChatSessions: vi.fn(),
  loadRaindropContext: vi.fn(),
}));

vi.mock("@/lib/dag-workflows", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dag-workflows")>();
  return { ...original, listDagWorkflowRuns: mocks.listDagWorkflowRuns };
});

vi.mock("@/lib/raindrop", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/raindrop")>();
  return {
    ...original,
    listRaindropChatSessions: mocks.listRaindropChatSessions,
    loadRaindropContext: mocks.loadRaindropContext,
  };
});

vi.mock("@/components/helper-agent-chat", () => ({
  HelperAgentChat: ({
    contextReference,
  }: {
    contextReference?: { kind: string; id: string };
  }) => (
    <div data-testid="helper-context">
      {contextReference ? `${contextReference.kind}:${contextReference.id}` : "no-context"}
    </div>
  ),
}));

import { parseSavedRaindropState, RaindropPanel } from "./raindrop-panel";

function run(id: string, status: "failed" | "succeeded", workflowId: string) {
  return {
    id,
    workflowId,
    workflowRevision: 1,
    graphSha256: "0".repeat(64),
    sessionId: null,
    createdAt: 1,
    requestedBy: "user" as const,
    status,
    lastSeq: 2,
    startedAt: 1,
    finishedAt: 2,
    interruptedAt: null,
    recoverable: false,
    lastError: status === "failed" ? { code: "FAILED", message: "boom" } : null,
    diagnostics: [],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.listDagWorkflowRuns.mockResolvedValue([
    run(RUN_B, "failed", "new-workflow"),
    run(RUN_A, "succeeded", "old-workflow"),
  ]);
  mocks.listRaindropChatSessions.mockResolvedValue([{
    id: SESSION_HISTORY,
    title: "Stored analysis chat",
    created: 1,
    modified: 2,
    messageCount: 4,
  }]);
  mocks.loadRaindropContext.mockImplementation(async (
    _projectId: string,
    source: { kind: "run" | "session"; id: string },
  ) => ({
    source,
    context: `validated:${source.kind}:${source.id}`,
    truncated: false,
    observedEntries: 2,
    totalEntries: 2,
  }));
});

describe("RaindropPanel", () => {
  it("migrates the run-only sidecar and sanitizes typed run/session references", () => {
    expect(parseSavedRaindropState("not json")).toEqual({
      version: 2,
      references: [],
      selectedReference: null,
    });
    expect(parseSavedRaindropState(JSON.stringify({
      version: 1,
      runIds: [RUN_A, "../escape", RUN_A],
      selectedRunId: "../escape",
    }))).toEqual({
      version: 2,
      references: [{ kind: "run", id: RUN_A }],
      selectedReference: { kind: "run", id: RUN_A },
    });
    expect(parseSavedRaindropState(JSON.stringify({
      version: 2,
      references: [
        { kind: "session", id: SESSION_DEFAULT },
        { kind: "run", id: RUN_A },
        { kind: "session", id: "../escape" },
        { kind: "run", id: RUN_A, path: "/tmp/escape" },
      ],
      selectedReference: { kind: "session", id: SESSION_DEFAULT },
    }))).toEqual({
      version: 2,
      references: [
        { kind: "session", id: SESSION_DEFAULT },
        { kind: "run", id: RUN_A },
      ],
      selectedReference: { kind: "session", id: SESSION_DEFAULT },
    });
  });

  it("autosaves open/resumed and stored chats beside DAG runs and loads validated context", async () => {
    window.localStorage.setItem(
      "kady:raindrop:project-a:v2",
      JSON.stringify({
        version: 2,
        references: [{ kind: "run", id: RUN_A }],
        selectedReference: { kind: "run", id: RUN_A },
      }),
    );
    render(
      <RaindropPanel
        projectId="project-a"
        active={false}
        openChatSessions={[{
          id: SESSION_DEFAULT,
          title: "Default resumed chat",
          active: true,
        }]}
      />,
    );

    await screen.findByText("2 chat sessions · 2 DAG runs");
    await waitFor(() => {
      expect(screen.getByTestId("helper-context")).toHaveTextContent(`run:${RUN_A}`);
    });
    expect(mocks.loadRaindropContext).toHaveBeenCalledWith(
      "project-a",
      { kind: "run", id: RUN_A },
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByTitle(SESSION_DEFAULT));
    await waitFor(() => {
      expect(screen.getByTestId("helper-context")).toHaveTextContent(`session:${SESSION_DEFAULT}`);
    });
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem("kady:raindrop:project-a:v2") ?? "{}",
      ) as {
        selectedReference?: { kind: string; id: string };
        references?: Array<{ kind: string; id: string }>;
      };
      expect(saved.selectedReference).toEqual({ kind: "session", id: SESSION_DEFAULT });
      expect(saved.references).toEqual(expect.arrayContaining([
        { kind: "session", id: SESSION_DEFAULT },
        { kind: "session", id: SESSION_HISTORY },
        { kind: "run", id: RUN_A },
        { kind: "run", id: RUN_B },
      ]));
    });
  });
});
