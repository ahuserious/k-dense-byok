import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DagWorkflowDefinitionSummary, WorkflowGraphDocument } from "./dag-workflows";
import { apiFetch } from "./projects";
import {
  buildScientificPipelineRegistry,
  listVendoredWorkflowRegistrySources,
  typedWorkflowRegistrySource,
  vendoredPipelineEngineHealth,
  vendoredWorkflowRegistrySource,
  workflowRouteForEngine,
} from "./scientific-pipeline-registry";

vi.mock("./projects", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  apiFetchMock.mockReset();
});

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
    }, { codebaseId: "codebase-a" });

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
    }, { codebaseId: "codebase-a" });
    const differentNameSameStructure = vendoredWorkflowRegistrySource({
      name: "Another Workflow",
      description: "Same topology, different identity",
      nodes: [
        { id: "collect", prompt: "Collect evidence." },
        { id: "review", depends_on: ["collect"], prompt: "Review evidence." },
      ],
    }, { codebaseId: "codebase-a" });

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
    }, { codebaseId: "codebase-a" });
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

  it("routes normalized display-name collisions independently by stable filename", () => {
    const padded = vendoredWorkflowRegistrySource({
      name: " foo ",
      nodes: [{ id: "collect", prompt: "Collect evidence." }],
    }, { codebaseId: "codebase-a", origin: "project", filename: "padded.yaml" });
    const plain = vendoredWorkflowRegistrySource({
      name: "foo",
      nodes: [{ id: "collect", prompt: "Collect evidence." }],
    }, { codebaseId: "codebase-a", origin: "catalogue", filename: "plain.yaml" });

    const registry = buildScientificPipelineRegistry([], [padded!, plain!]);

    expect(registry).toHaveLength(2);
    expect(registry.map((entry) => workflowRouteForEngine(entry, "vendored").workflowId))
      .toEqual(["padded.yaml", "plain.yaml"]);
    expect(padded?.sourceId).toContain("origin=project");
    expect(padded?.sourceId).toContain("filename=padded.yaml");
    expect(plain?.sourceId).toContain("origin=catalogue");
    for (const entry of registry) {
      expect(entry.routingAmbiguities).toBeUndefined();
    }
  });

  it("fails closed when the engine returns a genuinely duplicate stable workflow id", () => {
    const first = vendoredWorkflowRegistrySource({
      name: "First display name",
      nodes: [{ id: "collect" }],
    }, { codebaseId: "codebase-a", origin: "project", filename: "duplicate.yaml" });
    const second = vendoredWorkflowRegistrySource({
      name: "Second display name",
      nodes: [{ id: "review" }],
    }, { codebaseId: "codebase-a", origin: "project", filename: "duplicate.yaml" });

    const registry = buildScientificPipelineRegistry([], [first!, second!]);

    expect(registry).toHaveLength(2);
    for (const entry of registry) {
      expect(entry.vendoredRouting).toEqual(expect.objectContaining({
        routable: false,
        projectScopeVerified: true,
      }));
      expect(entry.routingAmbiguities?.[0]).toEqual(expect.objectContaining({
        engine: "vendored",
        identifiers: ["duplicate.yaml", "duplicate.yaml"],
      }));
      expect(() => workflowRouteForEngine(entry, "vendored"))
        .toThrow("duplicate stable identifier");
    }
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

  it.each([
    {
      operation: "health check",
      path: "/pipelines/health",
      invoke: () => vendoredPipelineEngineHealth("project-a", 25),
    },
    {
      operation: "list",
      path: "/pipelines",
      invoke: () => listVendoredWorkflowRegistrySources("project-a", 25),
    },
  ])("bounds and aborts a hung vendored workflow $operation", async ({ path, invoke }) => {
    apiFetchMock.mockReturnValue(new Promise<Response>(() => {}));

    await expect(invoke()).rejects.toThrow("timed out after 25ms");

    expect(apiFetchMock).toHaveBeenCalledWith(
      path,
      { signal: expect.any(AbortSignal) },
      "project-a",
    );
    const signal = apiFetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it("includes list origin and filename metadata in vendored source identity", async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({
      workflows: [{
        workflow: { name: "source-aware", nodes: [{ id: "collect" }] },
        source: "project",
        filename: "source-aware.yaml",
        codebaseId: "codebase-a",
      }],
    }), { status: 200 }));

    const [source] = await listVendoredWorkflowRegistrySources("project-a");

    expect(source).toMatchObject({
      workflowName: "source-aware",
      displayName: "source-aware",
      origin: "project",
      filename: "source-aware.yaml",
      codebaseId: "codebase-a",
    });
    expect(source.sourceId).toContain("origin=project");
    expect(source.sourceId).toContain("filename=source-aware.yaml");
  });

  it("routes duplicate names independently by the stable ids from the scoped engine list", async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({
      workflows: [
        {
          workflow: {
            name: "duplicate-name",
            description: "First record",
            nodes: [{ id: "collect" }],
          },
          source: "project",
          filename: "first.yaml",
          workflowId: "workflow_11111111111111111111111111111111",
          codebaseId: "codebase-a",
        },
        {
          workflow: {
            name: "duplicate-name",
            description: "Second record",
            nodes: [{ id: "collect" }],
          },
          source: "project",
          filename: "second.yaml",
          workflowId: "workflow_22222222222222222222222222222222",
          codebaseId: "codebase-a",
        },
        {
          workflow: {
            name: "distinct-name",
            description: "Unique record",
            nodes: [{ id: "review" }],
          },
          source: "project",
          filename: "distinct.yaml",
          workflowId: "workflow_33333333333333333333333333333333",
          codebaseId: "codebase-a",
        },
      ],
    }), { status: 200 }));

    const sources = await listVendoredWorkflowRegistrySources("project-a");
    const registry = buildScientificPipelineRegistry([], sources);
    const duplicates = registry.filter(
      (entry) => entry.vendored?.workflowName === "duplicate-name",
    );
    const distinct = registry.find(
      (entry) => entry.vendored?.workflowName === "distinct-name",
    );

    expect(sources[0].sourceId).not.toBe(sources[1].sourceId);
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((entry) => entry.id)).size).toBe(2);
    for (const entry of duplicates) {
      expect(entry.vendoredRouting).toEqual({
        routable: true,
        projectScopeVerified: true,
      });
    }
    expect(distinct?.vendoredRouting).toEqual({
      routable: true,
      projectScopeVerified: true,
    });
    expect(duplicates.map((entry) => workflowRouteForEngine(entry, "vendored").workflowId))
      .toEqual([
        "workflow_11111111111111111111111111111111",
        "workflow_22222222222222222222222222222222",
      ]);
    expect(workflowRouteForEngine(distinct!, "vendored").workflowId)
      .toBe("workflow_33333333333333333333333333333333");
  });

  it("keeps the timeout active while a vendored response body is stalled", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: () => new Promise<unknown>(() => {}),
    } as Response);

    await expect(listVendoredWorkflowRegistrySources("project-a", 25))
      .rejects.toThrow("timed out after 25ms");

    const signal = apiFetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });
});
