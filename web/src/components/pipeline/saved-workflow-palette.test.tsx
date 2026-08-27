import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  createDefaultWorkflowGraph,
  insertSavedWorkflowAsReference,
} from "@/lib/dag-workflow-builder";
import type { DagWorkflowDefinitionSummary } from "@/lib/dag-workflows";

import * as paletteModule from "./saved-workflow-palette";
import { SavedWorkflowPalette } from "./saved-workflow-palette";

const childWorkflow: DagWorkflowDefinitionSummary = {
  id: "child-workflow",
  revision: 4,
  createdAt: 1,
  updatedAt: 2,
  graphSha256: "a".repeat(64),
  schemaVersion: "1.0",
  name: "Child workflow",
  description: null,
  nodeCount: 2,
  edgeCount: 1,
};

describe("BLD-01 · saved-workflow palette inserts a workflow-ref", () => {
  it("retires the stale disable reason and keeps 'as reference' a live control", () => {
    expect(paletteModule).not.toHaveProperty("REFERENCE_INSERT_DISABLED_REASON");

    render(
      <SavedWorkflowPalette
        workflows={[childWorkflow]}
        onAddPhase={() => undefined}
        onInsertReference={() => undefined}
        canAddPhase
      />,
    );

    const referenceControl = screen.getByTestId("saved-workflow-reference-child-workflow");
    expect(referenceControl).toBeEnabled();
    expect(screen.queryByText(/typed runtime has no workflow-reference/i)).toBeNull();
  });

  it("clicking 'as reference' reports the snapshot payload the host must author", async () => {
    const onInsertReference = vi.fn();
    render(
      <SavedWorkflowPalette
        workflows={[childWorkflow]}
        onAddPhase={() => undefined}
        onInsertReference={onInsertReference}
        canAddPhase
      />,
    );

    await userEvent.click(screen.getByTestId("saved-workflow-reference-child-workflow"));

    expect(onInsertReference).toHaveBeenCalledTimes(1);
    const target = onInsertReference.mock.calls[0]![0] as DagWorkflowDefinitionSummary;
    expect({
      kind: "workflow-ref",
      workflowId: target.id,
      expectedRevision: target.revision,
      name: target.name,
    }).toEqual({
      kind: "workflow-ref",
      workflowId: "child-workflow",
      expectedRevision: 4,
      name: "Child workflow",
    });
  });

  it("insertSavedWorkflowAsReference authors a reachable workflow-ref pinned to the listed revision", () => {
    const host = createDefaultWorkflowGraph("host-workflow", "Host workflow");
    const { graph, nodeId } = insertSavedWorkflowAsReference(host, {
      id: "child-workflow",
      revision: 4,
      name: "Child workflow",
    });

    const referenceNode = graph.nodes.find((node) => node.id === nodeId);
    expect(referenceNode).toMatchObject({
      id: nodeId,
      kind: "workflow-ref",
      workflowId: "child-workflow",
      expectedRevision: 4,
      name: "Child workflow",
      terminal: true,
    });
    expect(graph.nodes.find((node) => node.id === "start")?.terminal).toBe(false);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: "start", to: nodeId, condition: "always" }),
    );
  });
});

describe("B48 · palette vertical contract (jsdom cannot prove pixel heights)", () => {
  it("keeps the list a fixed max-h-40 box and the add-row a two-line flex column", () => {
    // Seat B measured live rows 26.5px → 43.5px inside ul.max-h-40 (160px),
    // dropping visible rows 5 → 3. jsdom reports clientHeight 0 for everything,
    // so pixel heights stay NOT VERIFIED here; the class contract is what this
    // environment can pin.
    const { container } = render(
      <SavedWorkflowPalette
        workflows={[childWorkflow]}
        onAddPhase={() => undefined}
        onInsertReference={() => undefined}
        canAddPhase
      />,
    );

    const list = container.querySelector("ul");
    expect(list?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["max-h-40", "overflow-y-auto"]),
    );
    const add = screen.getByTestId("saved-workflow-add-child-workflow");
    expect(add.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
    expect(add.clientHeight).toBe(0);
  });
});

describe("B49 · add-as-phase confirmation", () => {
  it("states the stitch and save boundary before invoking the add handler", async () => {
    const user = userEvent.setup();
    const onAddPhase = vi.fn();
    render(
      <SavedWorkflowPalette
        workflows={[childWorkflow]}
        onAddPhase={onAddPhase}
        onInsertReference={() => undefined}
        canAddPhase
      />,
    );

    await user.click(screen.getByTestId("saved-workflow-add-child-workflow"));

    const dialog = screen.getByRole("dialog", {
      name: "Add “Child workflow” as a phase?",
    });
    expect(dialog).toHaveTextContent("revision 4");
    expect(dialog).toHaveTextContent("connect the loaded workflow's handover nodes");
    expect(dialog).toHaveTextContent("nothing is stored until you save the workflow");
    expect(onAddPhase).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onAddPhase).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("saved-workflow-add-child-workflow"));
    await user.click(screen.getByTestId("saved-workflow-add-phase-confirm"));
    expect(onAddPhase).toHaveBeenCalledTimes(1);
    expect(onAddPhase).toHaveBeenCalledWith("child-workflow");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
