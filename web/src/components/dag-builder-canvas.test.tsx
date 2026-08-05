import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DagBuilderCanvas } from "./dag-builder-canvas";
import {
  createDefaultWorkflowGraph,
  createDefaultWorkflowNode,
  createOpenRouterFusionConfiguration,
} from "@/lib/dag-workflow-builder";
import type { FusionWorkflowNode } from "@/lib/dag-workflows";

describe("DagBuilderCanvas", () => {
  it("renders edges and selectable nodes with both distinct fusion modes", async () => {
    const graph = createDefaultWorkflowGraph("fusion-visual", "Fusion visual");
    const kadyFusion = createDefaultWorkflowNode(
      "fusion",
      "local-fusion",
      { x: 380, y: 60 },
    ) as FusionWorkflowNode;
    const hostedFusion: FusionWorkflowNode = {
      ...createDefaultWorkflowNode("fusion", "hosted-fusion", { x: 700, y: 320 }) as FusionWorkflowNode,
      name: "Hosted Fusion",
      fusion: createOpenRouterFusionConfiguration(),
    };
    kadyFusion.name = "Private Local Fusion";
    graph.nodes = [
      { ...graph.nodes[0], terminal: false },
      kadyFusion,
      hostedFusion,
    ];
    graph.edges = [
      { id: "edge-1", from: "start", to: "local-fusion", condition: "always" },
      { id: "edge-2", from: "start", to: "hosted-fusion", condition: "success" },
    ];
    const onSelectNode = vi.fn();

    const { container } = render(
      <DagBuilderCanvas
        graph={graph}
        selectedNodeId="local-fusion"
        onSelectNode={onSelectNode}
        onMoveNode={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-edge-id="edge-1"]')).toBeInTheDocument();
    expect(screen.getByText("always")).toBeInTheDocument();
    expect(container.querySelector('[data-fusion-mode="kady-panel"]')).toHaveTextContent("Kady-owned panel");
    expect(container.querySelector('[data-fusion-mode="kady-panel"]')).toHaveTextContent("Panel synthesizer");
    expect(container.querySelector('[data-fusion-mode="openrouter-router"]')).toHaveTextContent("OpenRouter hosted router");
    expect(container.querySelector('[data-fusion-mode="openrouter-router"]')).toHaveTextContent("Final judge");
    expect(container.querySelector('[data-fusion-mode="openrouter-router"]')).toHaveTextContent("openrouter/openrouter/fusion");

    await userEvent.click(screen.getByRole("button", {
      name: "Hosted Fusion, Fusion node",
    }));
    expect(onSelectNode).toHaveBeenCalledWith("hosted-fusion");
  });

  it("reports pointer dragging as a persisted graph position update", () => {
    const graph = createDefaultWorkflowGraph("drag-test", "Drag test");
    const onMoveNode = vi.fn();
    render(
      <DagBuilderCanvas
        graph={graph}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );
    const node = screen.getByRole("button", { name: "Start, Agent node" });

    fireEvent.pointerDown(node, { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { pointerId: 3, clientX: 155, clientY: 135 });
    fireEvent.pointerUp(node, { pointerId: 3 });

    expect(onMoveNode).toHaveBeenCalledWith("start", { x: 135, y: 135 });
  });
});
