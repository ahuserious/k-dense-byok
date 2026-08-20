import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { graphSha256 } from "../src/api/dag-workflows-validate.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import type { WorkflowGraphDocument } from "../src/workflows/schema.ts";
import {
  WorkflowStore,
  WorkflowStoreError,
  workflowRunFiles,
} from "../src/workflows/store.ts";
import { validateStoredWorkflowGraphDocument } from "../src/workflows/harness-stored-validation.ts";
import { validateWorkflowGraphDocument } from "../src/workflows/validate.ts";

const PROJECT_ID = "f2-stored-harness-compat";

function baseGraph(id: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: "Stored harness compatibility",
    entryNodeId: "step",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        auth: { kind: "api-key" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 4,
      maxModelCalls: 8,
      maxParallelism: 2,
      maxSubagents: 2,
      timeoutMs: 30_000,
      maxTokens: 8_000,
      maxCostUsd: 2,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [{
      id: "step",
      name: "Step",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Produce a bounded answer.",
    }],
    edges: [],
  };
}

function previouslyAcceptedGraph(id: string): WorkflowGraphDocument {
  const graph = baseGraph(id);
  graph.settings = { defaultHarness: "codex" };
  graph.nodes = [{
    id: "step",
    name: "Verify",
    kind: "lean4",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    goal: "Verify the theorem.",
    theorem: "theorem stored_compat : True := by trivial",
    mode: "verify",
    mathlib: false,
    skill: "byom-dag-fusion",
  }];
  return graph;
}

beforeEach(() => {
  fs.rmSync(path.join(PROJECTS_ROOT, PROJECT_ID), { recursive: true, force: true });
});

describe("stored graph harness compatibility", () => {
  it("reads old definitions and run snapshots while refusing the same graph on a new save", () => {
    const store = new WorkflowStore();
    const graph = baseGraph("stored-harness");
    store.saveDefinition(PROJECT_ID, graph.id, graph);
    const run = store.createRun(PROJECT_ID, {
      workflowId: graph.id,
      requestId: "stored-harness-run",
      requestedBy: "api",
      input: { goal: "Verify compatibility." },
    });

    const legacy = validateStoredWorkflowGraphDocument(
      previouslyAcceptedGraph(graph.id),
    );
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(validateWorkflowGraphDocument(legacy.document).ok).toBe(false);
    const legacyHash = graphSha256(legacy.document);

    const paths = resolvePaths(PROJECT_ID);
    const definitionFile = path.join(
      paths.workflowDefinitionsDir,
      `${graph.id}.json`,
    );
    const definition = JSON.parse(fs.readFileSync(definitionFile, "utf8"));
    definition.graph = legacy.document;
    definition.graphSha256 = legacyHash;
    fs.writeFileSync(definitionFile, `${JSON.stringify(definition)}\n`, "utf8");

    const runFile = workflowRunFiles(PROJECT_ID, run.id).manifest;
    const manifest = JSON.parse(fs.readFileSync(runFile, "utf8"));
    manifest.graph = legacy.document;
    manifest.graphSha256 = legacyHash;
    fs.writeFileSync(runFile, `${JSON.stringify(manifest)}\n`, "utf8");

    expect(store.readDefinition(PROJECT_ID, graph.id)?.graph.settings?.defaultHarness)
      .toBe("codex");
    expect(store.readRun(PROJECT_ID, run.id)?.manifest.graph.settings?.defaultHarness)
      .toBe("codex");

    let caught: unknown;
    try {
      store.saveDefinition(PROJECT_ID, graph.id, legacy.document);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowStoreError);
    expect((caught as WorkflowStoreError).code).toBe("INVALID_DEFINITION");
    expect((caught as Error).message).toContain("harness would be discarded");
  });
});
