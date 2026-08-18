// Named for the `dag-workflows-validate*.test.ts` slot lane W3 owns; the
// subject is the run-document snapshot, which is the hard W3-R1 → W4-R2 gate.
//
// Lane W4 renders a DAG run's graph from the document the run ACTUALLY
// executed. Rendering the workflow's current definition instead would draw the
// wrong topology for any run of a since-edited workflow, and W4 cannot
// fabricate the missing data. These tests pin the three fields W4 reads off
// `GET /dag-workflow-runs/:runId` and — more importantly — pin that they are
// captured at enqueue and are immune to later edits.

import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import type { WorkflowGraphDocument } from "../src/workflows/index.ts";

const app = await buildApp({ workflowController: null });

function headers(extra: Record<string, string> = {}) {
  return { "x-project-id": "default", ...extra };
}

function graph(nodeName = "Start"): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "snapshot-workflow",
    name: "Snapshot workflow",
    entryNodeId: "start",
    defaultModel: {
      requested: {
        source: "kady-current",
        auth: { kind: "kady-current" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 4,
      maxModelCalls: 4,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 0,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "start",
        name: nodeName,
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        position: { x: 80, y: 120 },
        prompt: "Return one bounded result.",
      },
    ],
    edges: [],
  } as WorkflowGraphDocument;
}

async function createDefinition(document: WorkflowGraphDocument) {
  const response = await app.inject({
    method: "PUT",
    url: "/dag-workflows/snapshot-workflow",
    headers: headers({ "if-none-match": "*" }),
    payload: document as never,
  });
  expect(response.statusCode).toBe(201);
  return response.json().definition as { revision: number; graphSha256: string };
}

async function enqueueRun(requestId: string) {
  const response = await app.inject({
    method: "POST",
    url: "/dag-workflows/snapshot-workflow/runs",
    headers: headers(),
    payload: { requestId } as never,
  });
  expect(response.statusCode).toBe(202);
  return response.json().manifest.id as string;
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("GET /dag-workflow-runs/:runId run-document snapshot", () => {
  it("returns the executed document, its hash, and the workflow id", async () => {
    const definition = await createDefinition(graph());
    const runId = await enqueueRun("req-snapshot-1");

    const response = await app.inject({
      method: "GET",
      url: `/dag-workflow-runs/${runId}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    const { manifest } = response.json();
    expect(manifest.workflowId).toBe("snapshot-workflow");
    expect(manifest.workflowRevision).toBe(definition.revision);
    expect(manifest.graphSha256).toBe(definition.graphSha256);
    expect(manifest.graph).toMatchObject({
      id: "snapshot-workflow",
      nodes: [{ id: "start", name: "Start", position: { x: 80, y: 120 } }],
    });
  });

  it("keeps the snapshot frozen when the workflow is edited after the run is enqueued", async () => {
    const created = await createDefinition(graph("Start"));
    const runId = await enqueueRun("req-snapshot-2");

    const edited = await app.inject({
      method: "PUT",
      url: "/dag-workflows/snapshot-workflow",
      headers: headers({ "if-match": `"${created.revision}"` }),
      payload: graph("Renamed after the run started") as never,
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().definition.graphSha256).not.toBe(created.graphSha256);

    const run = await app.inject({
      method: "GET",
      url: `/dag-workflow-runs/${runId}`,
      headers: headers(),
    });

    const { manifest } = run.json();
    expect(manifest.graph.nodes[0].name).toBe("Start");
    expect(manifest.graphSha256).toBe(created.graphSha256);
    expect(manifest.workflowRevision).toBe(created.revision);
  });

  it("carries the snapshot on every run of the same workflow, including the run list's hash", async () => {
    const created = await createDefinition(graph());
    const firstRunId = await enqueueRun("req-snapshot-3a");
    const secondRunId = await enqueueRun("req-snapshot-3b");

    const list = await app.inject({
      method: "GET",
      url: "/dag-workflow-runs",
      headers: headers(),
    });
    const runs = list.json().runs as Array<{ id: string; graphSha256: string; workflowId: string }>;
    const listed = runs.filter((run) => run.id === firstRunId || run.id === secondRunId);

    expect(listed).toHaveLength(2);
    for (const run of listed) {
      expect(run.workflowId).toBe("snapshot-workflow");
      expect(run.graphSha256).toBe(created.graphSha256);
    }
  });
});
