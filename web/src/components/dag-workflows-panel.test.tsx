import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DagWorkflowsPanel } from "./dag-workflows-panel";
import * as dagApi from "@/lib/dag-workflows";
import { createDefaultWorkflowGraph } from "@/lib/dag-workflow-builder";

afterEach(() => vi.restoreAllMocks());

describe("DagWorkflowsPanel", () => {
  it("lists revision and graph counts, then opens the selected definition", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([
      {
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        schemaVersion: "1.0",
        name: "Fusion review",
        description: "Compare two bounded research paths",
        nodeCount: 4,
        edgeCount: 3,
      },
    ]);
    const selected: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"7"',
      definition: {
        storageVersion: 1,
        id: "fusion-review",
        revision: 7,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        graph: createDefaultWorkflowGraph("fusion-review", "Fusion review"),
      },
    };
    vi.spyOn(dagApi, "readDagWorkflowDefinition").mockResolvedValue(selected);
    const onOpenDefinition = vi.fn();

    render(
      <DagWorkflowsPanel
        projectId="project-a"
        onOpenDefinition={onOpenDefinition}
      />,
    );

    expect(await screen.findByText("Fusion review")).toBeInTheDocument();
    expect(screen.getByText("Revision 7")).toBeInTheDocument();
    expect(screen.getByText("4 nodes")).toBeInTheDocument();
    expect(screen.getByText("3 edges")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", {
      name: "Open Fusion review in DAG Builder",
    }));
    await waitFor(() => {
      expect(dagApi.readDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "fusion-review",
      );
      expect(onOpenDefinition).toHaveBeenCalledWith(selected);
    });
  });

  it("shows the server code and detail when the list fails", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockRejectedValue(
      new dagApi.DagWorkflowApiError(500, "Definition digest failed.", "CORRUPT"),
    );

    render(<DagWorkflowsPanel projectId="project-a" onOpenDefinition={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "CORRUPT: Definition digest failed.",
    );
  });

  it("creates a minimal bounded Pi (Kady) graph through the real definition PUT", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const created: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "new-research",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "new-sha",
        graph: createDefaultWorkflowGraph("new-research", "New research"),
      },
    };
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue(created);
    const onOpenDefinition = vi.fn();
    render(
      <DagWorkflowsPanel
        projectId="project-a"
        onOpenDefinition={onOpenDefinition}
      />,
    );

    await screen.findByText("No DAG workflows yet");
    await userEvent.click(screen.getByRole("button", { name: "New DAG workflow" }));
    await userEvent.type(screen.getByLabelText("New workflow id"), "new-research");
    await userEvent.type(screen.getByLabelText("New workflow name"), "New research");
    await userEvent.type(screen.getByLabelText("New workflow description"), "Private model study");
    await userEvent.click(screen.getByRole("button", { name: "Create and open" }));

    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "new-research",
        expect.objectContaining({
          id: "new-research",
          name: "New research",
          description: "Private model study",
          defaultModel: expect.objectContaining({
            requested: expect.objectContaining({ source: "kady-current" }),
            resolution: { mode: "exact" },
          }),
          rescue: expect.objectContaining({ enabled: true, maxAttempts: 2 }),
        }),
      );
      expect(onOpenDefinition).toHaveBeenCalledWith(created);
    });
  });

  it("creates the selected Machine Learning & AI template with best-of-2 and evidence routing", async () => {
    vi.spyOn(dagApi, "listDagWorkflowDefinitions").mockResolvedValue([]);
    const created: dagApi.VersionedDagWorkflowDefinition = {
      etag: '"1"',
      definition: {
        storageVersion: 1,
        id: "ml-model-selection-review",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "template-sha",
        graph: createDefaultWorkflowGraph(
          "ml-model-selection-review",
          "ML Model Selection Review",
        ),
      },
    };
    vi.spyOn(dagApi, "saveDagWorkflowDefinition").mockResolvedValue(created);
    const onOpenDefinition = vi.fn();
    render(
      <DagWorkflowsPanel
        projectId="project-a"
        onOpenDefinition={onOpenDefinition}
      />,
    );

    await screen.findByText("No DAG workflows yet");
    await userEvent.click(screen.getByRole("button", { name: "New DAG workflow" }));
    await userEvent.selectOptions(
      screen.getByLabelText("Workflow template"),
      "ml-model-selection-review",
    );

    expect(screen.getByLabelText("New workflow id")).toHaveValue(
      "ml-model-selection-review",
    );
    expect(screen.getByLabelText("New workflow name")).toHaveValue(
      "ML Model Selection Review",
    );
    expect(screen.getByText("Machine Learning & AI", { selector: "span" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create and open" }));

    await waitFor(() => {
      expect(dagApi.saveDagWorkflowDefinition).toHaveBeenCalledWith(
        "project-a",
        "ml-model-selection-review",
        expect.objectContaining({
          id: "ml-model-selection-review",
          name: "ML Model Selection Review",
          defaultModel: {
            requested: expect.objectContaining({ source: "kady-current" }),
            resolution: { mode: "exact" },
          },
          rescue: expect.objectContaining({ enabled: true }),
          evidence: expect.objectContaining({ enabled: true }),
          nodes: expect.arrayContaining([
            expect.objectContaining({
              kind: "best-of-n",
              candidateCount: 2,
            }),
            expect.objectContaining({
              kind: "evidence-gate",
              onUnsupportedOutput: "rescue",
            }),
          ]),
          edges: expect.arrayContaining([
            expect.objectContaining({ condition: "evidence-supported" }),
          ]),
        }),
      );
      expect(onOpenDefinition).toHaveBeenCalledWith(created);
    });
  });
});
