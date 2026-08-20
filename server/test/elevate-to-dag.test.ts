import fs from "node:fs";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import { registerElevateToDagRoutes } from "../src/api/elevate-to-dag.ts";
import {
  elevatePromptToDag,
  elevateWorkflowId,
} from "../src/workflows/elevate-to-dag.ts";
import { expandWorkflowRefs } from "../src/workflows/workflow-ref-expand.ts";
import {
  WorkflowStore,
  validateWorkflowGraphDocument,
  type ModelRequest,
  type WorkflowGraphDocument,
} from "../src/workflows/index.ts";

const PROJECT_ID = "elevate-to-dag-test";

function exactModel(): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "ollama",
      model: "qwen3:32b",
      auth: { kind: "local" },
      reasoning: "off",
    },
    resolution: { mode: "exact" },
  };
}

function agentGraph(id: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: id,
    entryNodeId: "start",
    defaultModel: exactModel(),
    limits: {
      maxIterations: 4,
      maxModelCalls: 8,
      maxParallelism: 2,
      maxSubagents: 2,
      timeoutMs: 30_000,
      maxTokens: 8_000,
      maxCostUsd: 1,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "route",
    },
    nodes: [
      {
        id: "start",
        name: "Start",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Answer briefly.",
      },
    ],
    edges: [],
  };
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(PROJECT_ID);
});

afterAll(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("elevate-to-dag engine", () => {
  it("validates and saves a research-until-goal graph from a prompt", () => {
    const result = elevatePromptToDag({
      projectId: PROJECT_ID,
      prompt: "Map the causal evidence for X.",
      name: "Causal map",
      defaultModel: exactModel(),
      save: true,
    });

    expect(result.saved).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.graph.nodes[0]).toMatchObject({
      kind: "research-until-goal",
      goal: "Map the causal evidence for X.",
    });
    expect(validateWorkflowGraphDocument(result.graph)).toMatchObject({ ok: true });

    const stored = new WorkflowStore().readDefinition(PROJECT_ID, result.workflowId);
    expect(stored?.graph.entryNodeId).toBe("research");
  });

  it("derives a stable workflow id from the prompt", () => {
    expect(elevateWorkflowId("same prompt")).toBe(elevateWorkflowId("same prompt"));
    expect(elevateWorkflowId("same prompt")).not.toBe(elevateWorkflowId("other prompt"));
  });
});

describe("elevate-to-dag API", () => {
  it("saves through POST /elevate-to-dag and names the next action on a bad body", async () => {
    const app = Fastify();
    app.addHook("onRequest", (_request, _reply, done) => {
      withActiveProject(PROJECT_ID, () => done());
    });
    registerElevateToDagRoutes(app);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/elevate-to-dag",
      payload: {
        prompt: "Build a DAG for a literature review.",
        defaultModel: exactModel(),
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { workflowId: string; saved: boolean; nodeCount: number };
    expect(body.saved).toBe(true);
    expect(body.nodeCount).toBe(1);

    const refused = await app.inject({
      method: "POST",
      url: "/elevate-to-dag",
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      code: "ELEVATE_INVALID_REQUEST",
      next: "Correct the prompt or model and retry elevate-to-dag.",
    });
    await app.close();
  });
});

describe("workflow-ref expansion", () => {
  it("namespaces embedded nodes, stamps compositeOf, and refuses cycles", () => {
    const child = agentGraph("child-workflow");
    const expanded = expandWorkflowRefs(
      {
        ...agentGraph("parent-workflow"),
        entryNodeId: "ref",
        nodes: [
          {
            id: "ref",
            name: "Child",
            kind: "workflow-ref",
            terminal: true,
            workspace: { isolation: "read-only", writePaths: [] },
            workflowId: "child-workflow",
          },
        ],
      },
      (workflowId) => workflowId === "child-workflow"
        ? {
          id: child.id,
          revision: 1,
          graphSha256: "a".repeat(64),
          graph: child,
        }
        : null,
    );

    expect(expanded.nodes.map((node) => node.id)).toEqual(["ref__start"]);
    expect(expanded.entryNodeId).toBe("ref__start");
    expect(expanded.nodes[0]?.meta?.compositeOf).toMatchObject({
      kind: "workflow-ref",
      sourceId: "child-workflow",
      sourceGraphSha256: "a".repeat(64),
    });

    expect(() =>
      expandWorkflowRefs(
        {
          ...child,
          id: "child-workflow",
          nodes: [
            {
              id: "loop",
              name: "Loop",
              kind: "workflow-ref",
              terminal: true,
              workspace: { isolation: "read-only", writePaths: [] },
              workflowId: "parent-workflow",
            },
          ],
        },
        (workflowId) => ({
          id: workflowId,
          revision: 1,
          graphSha256: "b".repeat(64),
          graph: {
            ...agentGraph(workflowId),
            nodes: [
              {
                id: "back",
                name: "Back",
                kind: "workflow-ref",
                terminal: true,
                workspace: { isolation: "read-only", writePaths: [] },
                workflowId: "child-workflow",
              },
            ],
          },
        }),
        ["parent-workflow"],
      )
    ).toThrow(/already on the expansion stack/);
  });

  it("expands a saved reference into the run manifest", () => {
    const store = new WorkflowStore();
    const child = agentGraph("child-workflow");
    const parent: WorkflowGraphDocument = {
      ...agentGraph("parent-workflow"),
      entryNodeId: "ref",
      nodes: [
        {
          id: "ref",
          name: "Child",
          kind: "workflow-ref",
          terminal: true,
          workspace: { isolation: "read-only", writePaths: [] },
          workflowId: "child-workflow",
        },
      ],
    };
    store.saveDefinition(PROJECT_ID, child.id, child);
    store.saveDefinition(PROJECT_ID, parent.id, parent);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: parent.id,
      requestId: "expand-ref",
      requestedBy: "api",
    });
    expect(manifest.graph.nodes.map((node) => node.kind)).toEqual(["agent"]);
    expect(manifest.graph.nodes[0]?.id).toBe("ref__start");
    expect(manifest.graph.nodes[0]?.meta?.compositeOf?.sourceId).toBe("child-workflow");
  });
});
