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

  it("cancels without writing anything before a create is pressed", async () => {
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

  it("sends the reader to the surface the promoted workflow is actually in", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const result = await screen.findByLabelText("Promotion result");
    // Scientific Pipelines → Workflow registry → `Details & run` — the labels
    // dag-workflows-panel.tsx actually renders.
    expect(result).toHaveTextContent("Scientific Pipelines");
    expect(result).toHaveTextContent("Workflow registry");
    expect(result).toHaveTextContent("Details & run");
    // NOT the workspace tab called "Builder": that is the vendored
    // pipeline-engine iframe and it cannot open a typed WorkflowGraphDocument.
    expect(result).not.toHaveTextContent(/Builder/);
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
    expect(alert).toHaveTextContent("The typed route rejected the create of");
    expect(alert).toHaveTextContent("chat-session-a");
    expect(alert).toHaveTextContent("HTTP 400");
    expect(alert).toHaveTextContent("INVALID_DEFINITION");
    expect(alert).toHaveTextContent("/nodes/0/prompt");
    expect(alert).toHaveTextContent("/limits/maxSubagents");
    expect(alert).toHaveTextContent("Nothing was created");
    // No success claim anywhere on the surface.
    expect(screen.queryByText(/accepted it/i)).toBeNull();
  });

  it("stays usable after a refusal: the reader can change the id and create again", async () => {
    // The exact 409 the store returns for a create against an id that exists.
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockRejectedValueOnce(
      new dagApi.DagWorkflowApiError(
        409,
        "Workflow chat-session-a already exists at revision 1; create requires absence.",
        "CONFLICT",
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    const create = within(dialog).getByRole("button", { name: "Create workflow" });

    await user.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists at revision 1");

    // The refusal asked for a different id. The button that sends it must work.
    expect(create).toBeEnabled();
    const idInput = within(dialog).getByLabelText("Workflow id");
    await user.clear(idInput);
    await user.type(idInput, "chat-session-a-2");
    expect(create).toBeEnabled();

    await user.click(create);
    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledTimes(2);
    });
    const [, retriedId, , retriedIntent] = vi.mocked(dagApi.saveDagWorkflowDefinition).mock
      .calls[1];
    expect(retriedId).toBe("chat-session-a-2");
    // Still a create, never an update smuggled in by the retry.
    expect(retriedIntent).toEqual({ kind: "create" });
    expect(await screen.findByText(/The typed route accepted it/i)).toBeInTheDocument();
  });

  it("does not claim nothing was created when the route never answered", async () => {
    // A transport failure is not a refusal. The write may or may not have
    // reached the store, so the surface must not assert either way — and it
    // must say why retrying is nevertheless safe. It also does not claim the
    // route never answered: this branch is every non-DagWorkflowApiError, and a
    // body that dies mid-read got a status this surface never holds.
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ended without an answer this surface could read");
    expect(alert).toHaveTextContent("cannot say whether anything was written");
    expect(alert).toHaveTextContent("Failed to fetch");
    // The claim the HTTP branch is entitled to make and this one is not.
    expect(alert).not.toHaveTextContent("Nothing was created");
    // No invented status code.
    expect(alert).not.toHaveTextContent(/HTTP/);
    // And it is still a retryable surface.
    expect(within(dialog).getByRole("button", { name: "Create workflow" })).toBeEnabled();
  });

  it("does not call an accepted write a refusal when the answer was unreadable", async () => {
    // MALFORMED_SAVE_RESPONSE is thrown AFTER parseResponse has let the response
    // through, so it is reachable only on a 2xx: the store took the write and
    // the client could not read what it said back. "Nothing was created" would
    // be false — the workflow may well exist at revision 1.
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockRejectedValueOnce(
      new dagApi.DagWorkflowApiError(
        201,
        "The workflow definition write returned no valid {outcome, definition} envelope.",
        "MALFORMED_SAVE_RESPONSE",
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("accepted the create of");
    expect(alert).toHaveTextContent("cannot say whether the workflow now exists");
    expect(alert).toHaveTextContent("HTTP 201");
    expect(alert).toHaveTextContent("MALFORMED_SAVE_RESPONSE");
    // The two claims a 2xx cannot support.
    expect(alert).not.toHaveTextContent("rejected");
    expect(alert).not.toHaveTextContent("Nothing was created");
    // Nor is it success: no definition came back, so nothing may point the
    // reader at a workflow as if it were there.
    expect(screen.queryByText(/accepted it/i)).toBeNull();
    // And it is still a retryable surface.
    expect(within(dialog).getByRole("button", { name: "Create workflow" })).toBeEnabled();
  });

  it("does not call a route failure a refusal", async () => {
    // A 5xx is not a decision. It can arrive from an intermediary after the
    // origin already committed the write, so which side of the commit it
    // failed on is not something this surface can read off the status.
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockRejectedValueOnce(
      new dagApi.DagWorkflowApiError(502, "Bad gateway"),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("failed on the create of");
    expect(alert).toHaveTextContent("cannot say whether the workflow was created");
    expect(alert).toHaveTextContent("HTTP 502");
    expect(alert).not.toHaveTextContent("rejected");
    expect(alert).not.toHaveTextContent("Nothing was created");
    expect(within(dialog).getByRole("button", { name: "Create workflow" })).toBeEnabled();
  });

  it("keeps a refusal true after the reader retypes, by naming the id it was refused for", async () => {
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockRejectedValue(
      new dagApi.DagWorkflowApiError(
        409,
        "Workflow chat-session-a already exists at revision 1; create requires absence.",
        "CONFLICT",
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));
    await screen.findByRole("alert");

    const idInput = within(dialog).getByLabelText("Workflow id");
    await user.clear(idInput);
    await user.type(idInput, "chat-session-a-2");

    // The banner still refers to the attempt that happened, not to whatever is
    // in the input now — the message never becomes a claim about the new id.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("chat-session-a already exists");
    expect(alert.textContent).not.toMatch(/rejected the create of\s*chat-session-a-2/);
  });

  it("disables create only while a write is actually in flight", async () => {
    let release: (() => void) | undefined;
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({
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
      }),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    const create = within(dialog).getByRole("button", { name: "Create workflow" });

    await user.click(create);
    const creating = await within(dialog).findByRole("button", { name: "Creating…" });
    expect(creating).toBeDisabled();

    release?.();
    expect(await screen.findByText(/The typed route accepted it/i)).toBeInTheDocument();
    // Exactly one write, never a second from a double press.
    expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledTimes(1);
  });

  it("refuses every exit while a create is in flight, so no write can outlive the dialog", async () => {
    // The write cannot be recalled once sent — `saveDagWorkflowDefinition`
    // takes no AbortSignal — so a dialog that could be dismissed mid-flight
    // would let a create commit into an unmounted tree, where the `setOutcome`
    // reporting it is discarded and no surface ever names the workflow. Every
    // exit is therefore gated on the same phase Create is.
    let release: (() => void) | undefined;
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({
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
      }),
    );
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));
    await within(dialog).findByRole("button", { name: "Creating…" });

    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    // The header's close control is removed rather than left inert, and
    // Escape — which Radix routes through the same onOpenChange — is ignored.
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    // It says why the exit is closed instead of looking broken.
    expect(dialog).toHaveTextContent(/cannot be recalled/i);

    release?.();
    expect(await screen.findByText(/The typed route accepted it/i)).toBeInTheDocument();
    // One write, and the surface is dismissable again the moment the route
    // has answered — the gate is on the flight, not on the dialog.
    expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("makes the browser's own exits confirm while a create is in flight, and only then", async () => {
    // `canDismiss` reaches every exit on this dialog and none of the two the
    // browser owns: a reload, and a Back that leaves the app (the workspace
    // writes its deep links with `replaceState`, so there is one history
    // entry to go back past). Both destroy the document with the PUT still on
    // the wire, and the workflow that commits is named on no surface. Nothing
    // here can recall that write, so the guard does the one thing left — it
    // makes the exit ask instead of happening silently. A cancelled
    // `beforeunload` is exactly what the browser reads as "prompt the reader".
    const exitWouldPrompt = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    let release: (() => void) | undefined;
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({
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
      }),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    // Reviewing a plan is not a write; there is nothing to stand in front of.
    expect(exitWouldPrompt()).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));
    await within(dialog).findByRole("button", { name: "Creating…" });
    expect(exitWouldPrompt()).toBe(true);

    release?.();
    expect(await screen.findByText(/The typed route accepted it/i)).toBeInTheDocument();
    // The route has answered and the surface has reported it, so the reader is
    // no longer walking away from an unreported write. The guard is removed
    // rather than left armed over a page they are done with.
    await waitFor(() => {
      expect(exitWouldPrompt()).toBe(false);
    });
  });

  it("does not print a graph digest the save answer never carried", async () => {
    // `isSavedDefinitionEnvelope` validates `outcome`, `id` and `revision` and
    // trusts the rest, so `graphSha256` reaches this banner unread. Printing it
    // is a claim, and "graph sha256 " followed by nothing is a claim about a
    // digest nobody checked. The route is accepted either way — this is about
    // what the surface then says it knows.
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockResolvedValue({
      outcome: "created",
      definition: {
        storageVersion: 1,
        id: "chat-session-a",
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
        graphSha256: undefined as unknown as string,
        graph: {} as dagApi.WorkflowGraphDocument,
      },
      etag: '"1"',
    });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const result = await screen.findByLabelText("Promotion result");
    // The create itself is still reported — the answer named an id and a
    // revision, and those were validated.
    expect(result).toHaveTextContent(/The typed route accepted it/i);
    expect(result).toHaveTextContent(/no readable graph sha256/i);
    expect(result).not.toHaveTextContent(/graph sha256 [0-9a-f]/i);
  });

  it("prints the graph digest when the answer carried a readable one", async () => {
    vi.mocked(dagApi.saveDagWorkflowDefinition).mockResolvedValue({
      outcome: "created",
      definition: {
        storageVersion: 1,
        id: "chat-session-a",
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
        graphSha256: "a".repeat(64),
        graph: {} as dagApi.WorkflowGraphDocument,
      },
      etag: '"1"',
    });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByTestId("promote-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create workflow" }));

    const result = await screen.findByLabelText("Promotion result");
    expect(result).toHaveTextContent(`graph sha256 ${"a".repeat(64)}`);
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
