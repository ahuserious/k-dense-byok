import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Model } from "./model-selector";
import { DagGraphInspector, DagNodeInspector } from "./dag-builder-inspector";
import {
  DEFAULT_WORKFLOW_EVIDENCE,
  DEFAULT_WORKFLOW_RESCUE,
  createKadyPanelFusionConfiguration,
  createDefaultWorkflowGraph,
  createDefaultWorkflowNode,
  createOpenRouterFusionConfiguration,
  exactFixedModel,
  exactKadyCurrentModel,
} from "@/lib/dag-workflow-builder";
import type {
  AgentWorkflowNode,
  BestOfNWorkflowNode,
  CouncilWorkflowNode,
  EvidenceGateWorkflowNode,
  FusionWorkflowNode,
  Lean4WorkflowNode,
  WorkflowPanelMember,
} from "@/lib/dag-workflows";

function panelMember(id: string): WorkflowPanelMember {
  return { id, role: `Role ${id}`, model: exactKadyCurrentModel() };
}

function discoveredModel(
  id: string,
  label: string,
  provider: string,
  sourceLabel: string,
): Model {
  return {
    id,
    label,
    provider,
    sourceLabel,
    tier: "mid",
    context_length: 32_000,
    pricing: { prompt: 0, completion: 0 },
    modality: "text->text",
    description: label,
    available: true,
  };
}

describe("DagNodeInspector", () => {
  it("keeps evidence gates nonterminal while allowing an invalid legacy gate to be repaired", () => {
    const graph = createDefaultWorkflowGraph("evidence-gate", "Evidence gate");
    const node = createDefaultWorkflowNode(
      "evidence-gate",
      "gate",
      { x: 320, y: 120 },
    ) as EvidenceGateWorkflowNode;
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();
    const { rerender } = render(
      <DagNodeInspector graph={graph} node={node} onChange={onChange} onRemove={vi.fn()} />,
    );

    const terminalCheckbox = screen.getByRole("checkbox", { name: "Terminal node" });
    expect(terminalCheckbox).not.toBeChecked();
    expect(terminalCheckbox).toBeDisabled();
    expect(screen.getByText(/require an evidence-supported outgoing route/)).toBeInTheDocument();

    const invalidLegacyNode: EvidenceGateWorkflowNode = { ...node, terminal: true };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [invalidLegacyNode] }}
        node={invalidLegacyNode}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    const legacyTerminalCheckbox = screen.getByRole("checkbox", { name: "Terminal node" });
    expect(legacyTerminalCheckbox).toBeEnabled();
    fireEvent.click(legacyTerminalCheckbox);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ terminal: false }));
  });

  it("calls the hosted OpenRouter Fusion judge field Final judge model in the UI", () => {
    const graph = createDefaultWorkflowGraph("hosted-fusion", "Hosted Fusion");
    const node: FusionWorkflowNode = {
      ...(createDefaultWorkflowNode("fusion", "fusion", { x: 320, y: 120 }) as FusionWorkflowNode),
      fusion: createOpenRouterFusionConfiguration(),
    };
    graph.nodes.push(node);

    const { rerender } = render(
      <DagNodeInspector
        graph={graph}
        node={node}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Final judge model")).toHaveLength(1);
    expect(screen.queryByText("Judge model")).not.toBeInTheDocument();
    expect(node.fusion.mode).toBe("openrouter-router");
    expect(node.fusion).toHaveProperty("judge");

    const kadyPanelNode: FusionWorkflowNode = {
      ...node,
      fusion: createKadyPanelFusionConfiguration(),
    };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [kadyPanelNode] }}
        node={kadyPanelNode}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Synthesizer model")).toHaveLength(1);
    expect(screen.queryByText("Final judge model")).not.toBeInTheDocument();
  });

  it("adds, removes, and edits stable Council member identities within the 2-16 bound", () => {
    const graph = createDefaultWorkflowGraph("council-members", "Council members");
    const node = createDefaultWorkflowNode(
      "council",
      "council",
      { x: 320, y: 120 },
    ) as CouncilWorkflowNode;
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();
    const { rerender } = render(
      <DagNodeInspector graph={graph} node={node} onChange={onChange} onRemove={vi.fn()} />,
    );

    expect(screen.getAllByRole("button", { name: /Remove Council member/ }))
      .toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: /Remove Council member/ })) {
      expect(button).toBeDisabled();
    }

    fireEvent.change(screen.getByLabelText("Member 1 ID"), {
      target: { value: "primary-review" },
    });
    expect((onChange.mock.lastCall?.[0] as CouncilWorkflowNode).members[0]).toMatchObject({
      id: "primary-review",
      role: node.members[0].role,
    });

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Add Council member" }));
    const added = onChange.mock.lastCall?.[0] as CouncilWorkflowNode;
    expect(added.members).toHaveLength(3);
    expect(added.members[2]).toMatchObject({ id: "perspective-3", role: "Council member 3" });
    expect(added.members[2].model).toEqual(node.members[1].model);
    expect(added.members[2].model).not.toBe(node.members[1].model);

    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [added] }}
        node={added}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", {
      name: "Remove Council member perspective-3",
    }));
    expect((onChange.mock.lastCall?.[0] as CouncilWorkflowNode).members).toHaveLength(2);

    const maximumNode: CouncilWorkflowNode = {
      ...node,
      members: Array.from({ length: 16 }, (_, index) => panelMember(`perspective-${index + 1}`)),
    };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [maximumNode] }}
        node={maximumNode}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Add Council member" })).toBeDisabled();
  });

  it("enforces hosted 8-member and Kady 32-member Fusion bounds with explicit add/remove", () => {
    const graph = createDefaultWorkflowGraph("fusion-members", "Fusion members");
    const base = createDefaultWorkflowNode(
      "fusion",
      "fusion",
      { x: 320, y: 120 },
    ) as FusionWorkflowNode;
    const hosted: FusionWorkflowNode = {
      ...base,
      fusion: createOpenRouterFusionConfiguration(),
    };
    graph.nodes = [hosted];
    graph.entryNodeId = hosted.id;
    const onChange = vi.fn();
    const { rerender } = render(
      <DagNodeInspector graph={graph} node={hosted} onChange={onChange} onRemove={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Hosted Fusion member" }));
    const hostedAdded = onChange.mock.lastCall?.[0] as FusionWorkflowNode;
    expect(hostedAdded.fusion.members).toHaveLength(3);
    expect(hostedAdded.fusion.members[2].id).toBe("panel-3");
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [hostedAdded] }}
        node={hostedAdded}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", {
      name: "Remove Hosted Fusion member panel-3",
    }));
    expect((onChange.mock.lastCall?.[0] as FusionWorkflowNode).fusion.members).toHaveLength(2);

    const hostedMaximum: FusionWorkflowNode = {
      ...hosted,
      fusion: {
        ...hosted.fusion,
        members: Array.from({ length: 8 }, (_, index) => panelMember(`panel-${index + 1}`)),
      },
    };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [hostedMaximum] }}
        node={hostedMaximum}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Add Hosted Fusion member" })).toBeDisabled();

    const kady = { ...base, fusion: createKadyPanelFusionConfiguration() };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [kady] }}
        node={kady}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Add Kady Fusion member" }));
    const kadyAdded = onChange.mock.lastCall?.[0] as FusionWorkflowNode;
    expect(kadyAdded.fusion.members).toHaveLength(3);
    expect(kadyAdded.fusion.members[2].id).toBe("analyst-3");

    const kadyMaximum: FusionWorkflowNode = {
      ...kady,
      fusion: {
        ...kady.fusion,
        members: Array.from({ length: 32 }, (_, index) => panelMember(`analyst-${index + 1}`)),
      },
    };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [kadyMaximum] }}
        node={kadyMaximum}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Add Kady Fusion member" })).toBeDisabled();
  });

  it("renders each workflow rescue trigger once", () => {
    const graph = createDefaultWorkflowGraph("rescue-fields", "Rescue fields");

    render(<DagGraphInspector graph={graph} onChange={vi.fn()} />);

    expect(screen.getByText(/also capped by the workflow or node Retry ceiling/i))
      .toBeInTheDocument();
    for (const trigger of DEFAULT_WORKFLOW_RESCUE.triggers) {
      expect(screen.getAllByText(trigger, { exact: true })).toHaveLength(1);
    }
  });

  it("authors partial node-limit overrides bounded by workflow ceilings", () => {
    const graph = createDefaultWorkflowGraph("node-limits", "Node limits");
    const node = createDefaultWorkflowNode(
      "agent",
      "bounded-agent",
      { x: 320, y: 120 },
    ) as AgentWorkflowNode;
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();
    const { rerender } = render(
      <DagNodeInspector graph={graph} node={node} onChange={onChange} onRemove={vi.fn()} />,
    );

    expect(screen.getByLabelText("Node Model calls")).toBeDisabled();
    expect(screen.getByLabelText("Node Model calls")).toHaveAttribute(
      "max",
      String(graph.limits.maxModelCalls),
    );
    fireEvent.click(screen.getByLabelText("Override Model calls"));
    expect(onChange).toHaveBeenLastCalledWith({
      ...node,
      limits: { maxModelCalls: graph.limits.maxModelCalls },
    });

    const limitedNode: AgentWorkflowNode = {
      ...node,
      limits: { maxModelCalls: 12 },
    };
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [limitedNode] }}
        node={limitedNode}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Node Model calls"), {
      target: { value: "10" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...limitedNode,
      limits: { maxModelCalls: 10 },
    });
    fireEvent.click(screen.getByLabelText("Override Model calls"));
    expect(onChange).toHaveBeenLastCalledWith(node);
  });

  it("keeps Best-of-N repeated and explicit models mutually exclusive with count parity", () => {
    const graph = createDefaultWorkflowGraph("best-models", "Best models");
    const node = createDefaultWorkflowNode(
      "best-of-n",
      "best",
      { x: 320, y: 120 },
    ) as BestOfNWorkflowNode;
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();
    const { rerender } = render(
      <DagNodeInspector graph={graph} node={node} onChange={onChange} onRemove={vi.fn()} />,
    );

    expect(screen.queryByText("Node model override")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Candidate model mode"), {
      target: { value: "explicit" },
    });
    const explicit = onChange.mock.lastCall?.[0] as BestOfNWorkflowNode;
    expect(explicit.candidateCount).toBe(2);
    expect(explicit.candidateModels).toEqual([
      graph.defaultModel,
      graph.defaultModel,
    ]);
    expect(explicit).not.toHaveProperty("model");

    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [explicit] }}
        node={explicit}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Add candidate model" }));
    const threeCandidates = onChange.mock.lastCall?.[0] as BestOfNWorkflowNode;
    expect(threeCandidates.candidateModels).toHaveLength(3);
    expect(threeCandidates.candidateCount).toBe(3);
    expect(threeCandidates).not.toHaveProperty("model");

    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [threeCandidates] }}
        node={threeCandidates}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove candidate model 2" }));
    const removedCandidate = onChange.mock.lastCall?.[0] as BestOfNWorkflowNode;
    expect(removedCandidate.candidateModels).toHaveLength(2);
    expect(removedCandidate.candidateCount).toBe(2);

    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Candidate model mode"), {
      target: { value: "repeated" },
    });
    const repeated = onChange.mock.lastCall?.[0] as BestOfNWorkflowNode;
    expect(repeated).not.toHaveProperty("candidateModels");
    expect(repeated.model).toEqual(threeCandidates.candidateModels?.[0]);
    expect(repeated.candidateCount).toBe(3);
  });

  it("repairs ambiguous Best-of-N models without hiding the conflict", () => {
    const graph = createDefaultWorkflowGraph("best-conflict", "Best conflict");
    const node: BestOfNWorkflowNode = {
      ...(createDefaultWorkflowNode(
        "best-of-n",
        "best",
        { x: 320, y: 120 },
      ) as BestOfNWorkflowNode),
      model: exactKadyCurrentModel("low"),
      candidateCount: 3,
      candidateModels: [exactKadyCurrentModel(), exactKadyCurrentModel()],
    };
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();

    render(
      <DagNodeInspector graph={graph} node={node} onChange={onChange} onRemove={vi.fn()} />,
    );

    expect(screen.getByText(/both repeated and explicit candidate models/i)).toBeInTheDocument();
    expect(screen.getByText(/candidate count must equal/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove conflicting repeated model" }));
    const repaired = onChange.mock.lastCall?.[0] as BestOfNWorkflowNode;
    expect(repaired).not.toHaveProperty("model");
    expect(repaired.candidateCount).toBe(2);
    expect(repaired.candidateModels).toHaveLength(2);
  });

  it("selects discovered fixed models without rewriting explicit auth, reasoning, or fallback", () => {
    const graph = createDefaultWorkflowGraph("model-inventory", "Model inventory");
    const request = exactFixedModel("custom-provider", "private-model", "custom", "xhigh");
    request.requested = {
      source: "fixed",
      provider: "custom-provider",
      model: "private-model",
      auth: { kind: "custom", profile: "private-lab" },
      reasoning: "xhigh",
    };
    request.resolution = {
      mode: "explicit-fallback",
      alternatives: [exactKadyCurrentModel("high").requested],
      reason: "Only the visible approved alternative may run.",
    };
    const node: AgentWorkflowNode = {
      ...(createDefaultWorkflowNode(
        "agent",
        "inventory-agent",
        { x: 320, y: 120 },
      ) as AgentWorkflowNode),
      model: request,
    };
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();
    const inventory = [
      discoveredModel("ollama/qwen3:8b", "Qwen 3 8B", "Ollama", "Local (Ollama)"),
      { ...discoveredModel("fusion/preset", "Fusion preset", "Fusion", "Fusion"), isFusion: true },
    ];

    render(
      <DagNodeInspector
        graph={graph}
        node={node}
        modelInventory={inventory}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByRole("option", { name: /Fusion preset/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Discovered model"), {
      target: { value: "ollama/qwen3:8b" },
    });
    const changed = onChange.mock.lastCall?.[0] as AgentWorkflowNode;
    expect(changed.model?.requested).toEqual({
      source: "fixed",
      provider: "ollama",
      model: "qwen3:8b",
      auth: { kind: "custom", profile: "private-lab" },
      reasoning: "xhigh",
    });
    expect(changed.model?.resolution).toEqual(request.resolution);
  });

  it("describes workflow evaluator precedence as model-assisted support checking", () => {
    const graph = createDefaultWorkflowGraph("workflow-evidence", "Workflow evidence");
    const onChange = vi.fn();

    render(<DagGraphInspector graph={graph} onChange={onChange} />);

    expect(screen.getByText(/model-assisted support checking; this is not proof of truth/i))
      .toBeInTheDocument();
    expect(screen.getByText(/workflow evidence evaluator, then graph default model/i))
      .toBeInTheDocument();

    fireEvent.click(screen.getByText("Add workflow evidence evaluator"));

    expect(onChange).toHaveBeenCalledWith({
      ...graph,
      evidence: {
        ...graph.evidence,
        evaluator: exactKadyCurrentModel(),
      },
    });
  });

  it("keeps the workflow evaluator in the fallback chain for node overrides", () => {
    const graph = createDefaultWorkflowGraph("node-evidence", "Node evidence");
    const node: AgentWorkflowNode = {
      ...(createDefaultWorkflowNode("agent", "review", { x: 320, y: 120 }) as AgentWorkflowNode),
      evidence: { ...DEFAULT_WORKFLOW_EVIDENCE },
    };
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();

    render(
      <DagNodeInspector
        graph={graph}
        node={node}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText(
      /node evidence evaluator, workflow evidence evaluator, then graph default model/i,
    )).toBeInTheDocument();

    fireEvent.click(screen.getByText("Add node evidence evaluator"));

    expect(onChange).toHaveBeenCalledWith({
      ...node,
      evidence: {
        ...node.evidence,
        evaluator: exactKadyCurrentModel(),
      },
    });
  });

  it("points explicit gates to their authoritative evaluator without adding a policy call", () => {
    const graph = createDefaultWorkflowGraph("gate-evidence", "Gate evidence");
    const node: EvidenceGateWorkflowNode = {
      ...(createDefaultWorkflowNode(
        "evidence-gate",
        "gate",
        { x: 320, y: 120 },
      ) as EvidenceGateWorkflowNode),
      evidence: {
        ...DEFAULT_WORKFLOW_EVIDENCE,
        evaluator: exactKadyCurrentModel(),
      },
    };
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();

    render(
      <DagNodeInspector
        graph={graph}
        node={node}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText(/explicit evidence gates use the gate evaluator configured above/i))
      .toBeInTheDocument();
    expect(screen.getByText(/do not run or consume an extra model call/i))
      .toBeInTheDocument();
    expect(screen.queryByText("Node evidence evaluator")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Remove ignored node policy evaluator"));

    expect(onChange).toHaveBeenCalledWith({
      ...node,
      evidence: { ...DEFAULT_WORKFLOW_EVIDENCE },
    });
  });

  it("distinguishes exact solve propositions from reviewed source and warns about authority", () => {
    const graph = createDefaultWorkflowGraph("lean-contract", "Lean contract");
    const node = {
      ...(createDefaultWorkflowNode("lean4", "proof", { x: 320, y: 120 }) as Lean4WorkflowNode),
      mode: "solve" as const,
      theorem: "∀ n : Nat, n + 0 = n",
      solverModel: exactKadyCurrentModel(),
    };
    graph.nodes = [node];
    graph.entryNodeId = node.id;
    const onChange = vi.fn();

    const { rerender } = render(
      <DagNodeInspector graph={graph} node={node} onChange={onChange} onRemove={vi.fn()} />,
    );

    expect(screen.getByText("Exact proposition to prove")).toBeInTheDocument();
    expect(screen.getByText(/model may propose a proof body but cannot rewrite/i)).toBeInTheDocument();
    expect(screen.getByText(/OS-user filesystem and network authority/i)).toBeInTheDocument();
    expect(screen.getByText(/not a security sandbox/i)).toBeInTheDocument();

    const reviewedNode: Lean4WorkflowNode = {
      ...node,
      mode: "verify",
      theorem: "theorem reflexive (n : Nat) : n = n := rfl",
    };
    delete reviewedNode.solverModel;
    rerender(
      <DagNodeInspector
        graph={{ ...graph, nodes: [reviewedNode] }}
        node={reviewedNode}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("Reviewed Lean source")).toBeInTheDocument();
  });
});
