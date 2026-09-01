import { describe, expect, it } from "vitest";

import {
  WORKFLOW_NODE_KINDS,
  addDefaultNode,
  addWorkflowEdge,
  createDefaultWorkflowGraph,
  createDefaultWorkflowNode,
  nodeRemovalBlocker,
  removeWorkflowNode,
  updateNodePosition,
  validateNewEdge,
} from "./dag-workflow-builder";

describe("DAG workflow builder utilities", () => {
  it("creates a valid bounded Pi (Kady) workflow starting point", () => {
    const graph = createDefaultWorkflowGraph(
      "private-research",
      "Private research",
      "Keep data local",
    );

    expect(graph).toMatchObject({
      schemaVersion: "1.0",
      id: "private-research",
      name: "Private research",
      description: "Keep data local",
      entryNodeId: "start",
      defaultModel: {
        requested: {
          source: "kady-current",
          auth: { kind: "kady-current" },
          reasoning: "high",
        },
        resolution: { mode: "exact" },
      },
      rescue: { enabled: true, maxAttempts: 2 },
      evidence: { enabled: true, onUnsupportedOutput: "rescue" },
    });
    expect(graph.limits).toEqual({
      maxIterations: 20,
      maxModelCalls: 80,
      maxParallelism: 4,
      maxSubagents: 8,
      timeoutMs: 600_000,
      maxTokens: 1_000_000,
      maxCostUsd: 50,
      maxRetries: 2,
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: "start",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
    });
  });

  it("provides schema-shaped, positioned defaults for every supported node kind", () => {
    const nodes = WORKFLOW_NODE_KINDS.map((kind, index) => (
      createDefaultWorkflowNode(kind, `node-${index}`, { x: index * 10, y: index * 20 })
    ));

    expect(nodes.map((node) => node.kind)).toEqual(WORKFLOW_NODE_KINDS);
    for (const [index, node] of nodes.entries()) {
      expect(node).toMatchObject({
        id: `node-${index}`,
        terminal: node.kind !== "evidence-gate",
        position: { x: index * 10, y: index * 20 },
        workspace: { isolation: "read-only", writePaths: [] },
      });
    }
    expect(nodes.find((node) => node.kind === "research-until-goal")).toMatchObject({
      limits: { maxIterations: 8, maxSubagents: 4 },
      completionCriteria: expect.any(Array),
    });
    expect(nodes.find((node) => node.kind === "council")).toMatchObject({
      rounds: 2,
      members: [{ id: "perspective-a" }, { id: "perspective-b" }],
    });
    expect(nodes.find((node) => node.kind === "fusion")).toMatchObject({
      fusion: { mode: "kady-panel", rounds: 1 },
    });
    expect(nodes.find((node) => node.kind === "best-of-n")).toMatchObject({
      candidateCount: 2,
    });
    expect(nodes.find((node) => node.kind === "lean4")).toMatchObject({
      mode: "verify",
      skill: "byom-dag-fusion",
      evidence: {
        enabled: true,
        minimumIndependentSources: 0,
        requireArtifactReferences: true,
        onUnsupportedOutput: "rescue",
      },
    });
  });

  it("adds explicit edge conditions while rejecting duplicates and cycles", () => {
    let graph = createDefaultWorkflowGraph("edge-test", "Edge test");
    graph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, terminal: false })),
    };
    const second = addDefaultNode(graph, "agent");
    graph = second.graph;
    graph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === second.nodeId ? { ...node, terminal: false } : node),
    };
    const third = addDefaultNode(graph, "agent");
    graph = third.graph;

    let result = addWorkflowEdge(graph, {
      from: "start",
      to: second.nodeId,
      condition: "always",
    });
    expect(result.error).toBeNull();
    graph = result.graph;
    result = addWorkflowEdge(graph, {
      from: second.nodeId,
      to: third.nodeId,
      condition: "success",
    });
    expect(result.error).toBeNull();
    graph = result.graph;

    expect(validateNewEdge(graph, {
      from: "start",
      to: second.nodeId,
      condition: "always",
    })).toContain("already exist");
    expect(validateNewEdge(graph, {
      from: "start",
      to: third.nodeId,
      condition: "failure",
    })).toContain("not both");
    expect(validateNewEdge(graph, {
      from: third.nodeId,
      to: second.nodeId,
      condition: "always",
    })).toContain("Terminal");

    graph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === third.nodeId ? { ...node, terminal: false } : node),
    };
    expect(validateNewEdge(graph, {
      from: third.nodeId,
      to: second.nodeId,
      condition: "always",
    })).toContain("cycle");
  });

  it("enforces evidence-gate edge semantics", () => {
    let graph = createDefaultWorkflowGraph("gate-test", "Gate test");
    graph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, terminal: false })),
    };
    const gateResult = addDefaultNode(graph, "evidence-gate");
    graph = gateResult.graph;
    expect(graph.nodes.find((node) => node.id === gateResult.nodeId)?.terminal).toBe(false);
    const finalResult = addDefaultNode(graph, "agent");
    graph = finalResult.graph;

    expect(validateNewEdge(graph, {
      from: gateResult.nodeId,
      to: finalResult.nodeId,
      condition: "always",
    })).toContain("Evidence-routed nodes require");
    expect(validateNewEdge(graph, {
      from: gateResult.nodeId,
      to: finalResult.nodeId,
      condition: "evidence-supported",
    })).toBeNull();
    expect(validateNewEdge(graph, {
      from: gateResult.nodeId,
      to: finalResult.nodeId,
      condition: "evidence-unsupported",
    })).toContain("policy to route");
    expect(validateNewEdge(graph, {
      from: "start",
      to: gateResult.nodeId,
      condition: "evidence-supported",
    })).toContain("Only evidence-routed nodes");
  });

  it("offers evidence routes for a non-gate node with an effective route policy", () => {
    let graph = createDefaultWorkflowGraph("policy-route-test", "Policy route test");
    const second = addDefaultNode(graph, "agent");
    graph = second.graph;
    const third = addDefaultNode(graph, "agent");
    graph = third.graph;
    graph = {
      ...graph,
      evidence: {
        ...graph.evidence,
        enabled: true,
        onUnsupportedOutput: "route",
      },
      nodes: graph.nodes.map((node) => (
        node.id === "start" ? { ...node, terminal: false } : node
      )),
    };

    expect(validateNewEdge(graph, {
      from: "start",
      to: second.nodeId,
      condition: "always",
    })).toContain("Evidence-routed nodes require");
    expect(validateNewEdge(graph, {
      from: "start",
      to: second.nodeId,
      condition: "evidence-supported",
    })).toBeNull();
    expect(validateNewEdge(graph, {
      from: "start",
      to: third.nodeId,
      condition: "evidence-unsupported",
    })).toBeNull();
  });

  it("updates positions immutably and blocks unsafe node removal", () => {
    let graph = createDefaultWorkflowGraph("removal-test", "Removal test");
    const added = addDefaultNode(graph, "agent");
    graph = added.graph;
    const moved = updateNodePosition(graph, added.nodeId, { x: 440, y: 275 });

    expect(moved).not.toBe(graph);
    expect(moved.nodes.find((node) => node.id === added.nodeId)?.position).toEqual({ x: 440, y: 275 });
    expect(graph.nodes.find((node) => node.id === added.nodeId)?.position).not.toEqual({ x: 440, y: 275 });
    expect(nodeRemovalBlocker(graph, "start")).toContain("entry");

    graph = {
      ...graph,
      artifacts: [{
        id: "report",
        name: "Report",
        kind: "report",
        writerNodeId: added.nodeId,
      }],
    };
    expect(removeWorkflowNode(graph, added.nodeId).error).toContain("artifacts");
  });
});
