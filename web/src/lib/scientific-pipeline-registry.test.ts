import { describe, expect, it } from "vitest";

import type { DagWorkflowDefinitionSummary, WorkflowGraphDocument } from "./dag-workflows";
import {
  buildScientificPipelineRegistry,
  typedWorkflowRegistrySource,
  vendoredWorkflowRegistrySource,
  workflowRouteForEngine,
} from "./scientific-pipeline-registry";

function typedSummary(
  id: string,
  name: string,
  graphSha256 = `${id}-sha`,
): DagWorkflowDefinitionSummary {
  return {
    id,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    graphSha256,
    schemaVersion: "1.0",
    name,
    description: `${name} description`,
    nodeCount: 2,
    edgeCount: 1,
  };
}

function typedGraph(name: string, edgeTo = "review"): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "shared-workflow",
    name,
    entryNodeId: "collect",
    limits: {
      maxIterations: 2,
      maxModelCalls: 4,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 4_000,
      maxCostUsd: 1,
      maxRetries: 1,
    },
    evidence: {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "collect",
        name: "Collect",
        kind: "agent",
        prompt: "Collect evidence.",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
      },
      {
        id: edgeTo,
        name: "Review",
        kind: "agent",
        prompt: "Review evidence.",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
      },
    ],
    edges: [{ id: "collect-review", from: "collect", to: edgeTo }],
  };
}

describe("scientific pipeline registry", () => {
  it("deduplicates cross-engine workflows with the same normalized name and structure", () => {
    const typed = typedWorkflowRegistrySource(
      typedSummary("shared-workflow", "  Shared   Workflow "),
      typedGraph("Shared Workflow"),
    );
    const vendored = vendoredWorkflowRegistrySource({
      name: "shared workflow",
      description: "Vendored description",
      nodes: [
        { id: "review", depends_on: ["collect"], prompt: "Review evidence." },
        { id: "collect", prompt: "Collect evidence." },
      ],
    });

    expect(vendored).not.toBeNull();
    const registry = buildScientificPipelineRegistry([typed], [vendored!]);

    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      normalizedName: "shared workflow",
      typed: { sourceId: "typed:shared-workflow" },
      vendored: { sourceId: "vendored:shared%20workflow" },
    });
  });

  it("keeps workflows distinct when either the normalized name or structure differs", () => {
    const sameNameDifferentStructure = vendoredWorkflowRegistrySource({
      name: "Shared Workflow",
      description: "Different topology",
      nodes: [
        { id: "collect", prompt: "Collect evidence." },
        { id: "publish", depends_on: ["collect"], prompt: "Publish evidence." },
      ],
    });
    const differentNameSameStructure = vendoredWorkflowRegistrySource({
      name: "Another Workflow",
      description: "Same topology, different identity",
      nodes: [
        { id: "collect", prompt: "Collect evidence." },
        { id: "review", depends_on: ["collect"], prompt: "Review evidence." },
      ],
    });

    const registry = buildScientificPipelineRegistry(
      [typedWorkflowRegistrySource(
        typedSummary("shared-workflow", "Shared Workflow"),
        typedGraph("Shared Workflow"),
      )],
      [sameNameDifferentStructure!, differentNameSameStructure!],
    );

    expect(registry).toHaveLength(3);
    expect(new Set(registry.map((entry) => entry.id)).size).toBe(3);
  });

  it("resolves each merged entry to its engine-namespaced backing identifier", () => {
    const typed = typedWorkflowRegistrySource(
      typedSummary("shared-workflow", "Shared Workflow"),
      typedGraph("Shared Workflow"),
    );
    const vendored = vendoredWorkflowRegistrySource({
      name: "Shared Workflow",
      description: "Vendored description",
      nodes: [
        { id: "collect", prompt: "Collect evidence." },
        { id: "review", depends_on: ["collect"], prompt: "Review evidence." },
      ],
    });
    const [entry] = buildScientificPipelineRegistry([typed], [vendored!]);

    expect(workflowRouteForEngine(entry, "typed")).toMatchObject({
      engine: "typed",
      workflowId: "shared-workflow",
    });
    expect(workflowRouteForEngine(entry, "vendored")).toMatchObject({
      engine: "vendored",
      workflowName: "Shared Workflow",
    });
  });

  it("keeps same-engine identifier collisions independently runnable", () => {
    const registry = buildScientificPipelineRegistry([
      typedWorkflowRegistrySource(
        typedSummary("shared-workflow-a", "Shared Workflow", "same-sha"),
        typedGraph("Shared Workflow"),
      ),
      typedWorkflowRegistrySource(
        typedSummary("shared-workflow-b", "Shared Workflow", "same-sha"),
        typedGraph("Shared Workflow"),
      ),
    ], []);

    expect(registry).toHaveLength(2);
    expect(registry.map((entry) => workflowRouteForEngine(entry, "typed").workflowId))
      .toEqual(["shared-workflow-a", "shared-workflow-b"]);
  });
});
