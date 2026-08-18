import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LivePromoteDialog } from "./live-promote-dialog";
import * as dagApi from "@/lib/dag-workflows";
import {
  emptySessionGraph,
  projectSessionGraph,
  type SessionFrame,
} from "@/lib/session-dag-projection";

const FRAMES: SessionFrame[] = [
  { seq: 1, type: "run_start", runId: "run-a" },
  { seq: 2, type: "turn_start" },
  {
    seq: 3,
    type: "message_start",
    role: "user",
    content: "Cluster the RNA-seq counts.\nReport the silhouette.",
  },
  {
    seq: 4,
    type: "tool_start",
    toolCallId: "call_a",
    toolName: "bash",
    args: { command: "head counts.tsv" },
  },
  { seq: 5, type: "tool_end", toolCallId: "call_a", toolName: "bash", isError: false },
  { seq: 6, type: "turn_end" },
  { seq: 7, type: "done" },
];

const PROJECTION = projectSessionGraph(emptySessionGraph("session-a"), FRAMES);

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <LivePromoteDialog
      open
      onOpenChange={onOpenChange}
      projectId="default"
      projectName="Genomics"
      sessionId="session-a"
      sessionTitle="RNA clustering"
      projection={PROJECTION}
      frames={FRAMES}
    />,
  );
  return onOpenChange;
}

beforeEach(() => {
  vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue({
    outcome: "created",
    definition: {
      storageVersion: 1,
      id: "chat-session-a",
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      graphSha256: "sha-promoted",
      graph: {} as dagApi.WorkflowGraphDocument,
    },
    etag: '"1"',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("promote-to-DAG dialog", () => {
  it("shows the whole plan before anything is created", async () => {
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");

    expect(within(dialog).getByLabelText("Workflow id")).toHaveValue("chat-session-a");
    expect(dialog.querySelector('[data-promoted-node-id="turn-1"]')).not.toBeNull();
    expect(dialog).toHaveTextContent("Cluster the RNA-seq counts.");
    expect(dialog).toHaveTextContent("read-only on every node");
    expect(dialog).toHaveTextContent("Kady Current");
    // The document itself is inspectable, not just described.
    expect(dialog).toHaveTextContent("The exact document that will be sent");
    expect(dagApi.saveDagWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("names each part it cannot represent, with the reason", async () => {
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    const tool = dialog.querySelector('[data-unrepresented-id="tool:call_a"]');
    expect(tool?.textContent).toContain("bash");
    expect(tool?.textContent).toMatch(/not a typed node kind/);
    expect(dialog).toHaveTextContent(/cannot become a node/i);
  });

  it("cancels without writing anything", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dagApi.saveDagWorkflowDefinition).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("creates through the typed route's create precondition and reports what came back", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledTimes(1);
    });
    const [projectId, workflowId, document, intent] = vi.mocked(
      dagApi.saveDagWorkflowDefinition,
    ).mock.calls[0];
    expect(projectId).toBe("default");
    expect(workflowId).toBe("chat-session-a");
    // A create, never an inferred update: `If-None-Match: *`.
    expect(intent).toEqual({ kind: "create" });
    expect(document.id).toBe(workflowId);
    expect(document.schemaVersion).toBe("1.0");

    expect(await screen.findByText(/The typed route accepted it/i)).toBeInTheDocument();
    expect(screen.getByText(/sha-promoted/)).toBeInTheDocument();
  });

  it("renders the validator's own issue list verbatim when the route refuses", async () => {
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockRejectedValue(
      new dagApi.DagWorkflowApiError(
        400,
        "/nodes/0/prompt: Expected string length greater or equal to 1; /limits/maxSubagents: agent requires a Pi-subagent execution slot",
        "INVALID_DEFINITION",
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The typed route rejected this document");
    expect(alert).toHaveTextContent("HTTP 400");
    expect(alert).toHaveTextContent("INVALID_DEFINITION");
    expect(alert).toHaveTextContent("/nodes/0/prompt");
    expect(alert).toHaveTextContent("/limits/maxSubagents");
    expect(alert).toHaveTextContent("Nothing was created");
    // No success claim anywhere on the surface.
    expect(screen.queryByText(/accepted it/i)).toBeNull();
  });

  it("refuses to send an id the server's own syntax rejects", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    const idInput = within(dialog).getByLabelText("Workflow id");
    await user.clear(idInput);
    await user.type(idInput, "Not A Valid Id");

    expect(idInput).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("button", { name: "Create workflow" })).toBeDisabled();
    expect(dagApi.saveDagWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("says why a session with no retained prompt cannot be promoted, and offers no create", async () => {
    const toolOnly: SessionFrame[] = [
      { seq: 1, type: "run_start", runId: "run-b" },
      { seq: 2, type: "tool_start", toolCallId: "c1", toolName: "bash", args: {} },
      { seq: 3, type: "done" },
    ];
    render(
      <LivePromoteDialog
        open
        onOpenChange={vi.fn()}
        projectId="default"
        projectName="Genomics"
        sessionId="session-b"
        sessionTitle="Silent chat"
        projection={projectSessionGraph(emptySessionGraph("session-b"), toolOnly)}
        frames={toolOnly}
      />,
    );
    const dialog = await screen.findByTestId("promote-dialog");
    expect(dialog).toHaveTextContent(/without inventing an instruction/);
    expect(within(dialog).getByRole("button", { name: "Create workflow" })).toBeDisabled();
  });
});
