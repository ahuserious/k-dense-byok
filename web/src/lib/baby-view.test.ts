// danbot-byok — web/src/lib/baby-view.test.ts
//
// Row 18's Gate B evidence, at the only tier this lane can reach.
//
// This lane's writable set contains NO `server/` path, so a server test is not
// something F9 can write. What these tests do prove is the client-side binding
// the row actually names — "the preview renders the ACTUAL current pipeline,
// not a placeholder": every node id, label and terminal flag the rail draws is
// traced back to a `WorkflowGraphDocument` that came out of a read, and the
// resolver is driven with the exact document shapes the store serves.
//
// They also nail down the #62 containment: a malformed-but-200 body must not
// throw, here or in render.

import { describe, expect, it, vi } from "vitest";

import {
  isDrawableDocument,
  previewSummaryLine,
  projectPipelinePreview,
  resolveCurrentPipeline,
  MAX_PREVIEW_NODES,
  NO_PIPELINE_REASON,
  PIPELINE_READ_ERROR,
  type CurrentPipelineReaders,
} from "./baby-view";
import type { WorkflowGraphDocument } from "./dag-workflows";

/**
 * The document shape the store actually serves, copied from the graph the e2e
 * fixture returns for `GET /dag-workflows/:id` (`e2e/fixtures.ts:137-173`) and
 * widened to three nodes so the layout has something to lay out.
 */
function realDocument(id: string, name: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name,
    description: "Deterministic E2E workflow",
    entryNodeId: "prepare",
    limits: {
      maxIterations: 6,
      maxModelCalls: 8,
      maxParallelism: 2,
      maxSubagents: 2,
      timeoutMs: 300_000,
      maxTokens: 50_000,
      maxCostUsd: 5,
      maxRetries: 2,
    },
    evidence: {
      enabled: true,
      minimumIndependentSources: 1,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "prepare",
        name: "Prepare counts",
        kind: "agent",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Prepare the counts matrix.",
      },
      {
        id: "analyze",
        name: "Analyze",
        kind: "agent",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Analyze the supplied evidence.",
      },
      {
        id: "report",
        name: "Write the report",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Write the report.",
      },
    ],
    edges: [
      { id: "prepare-analyze", from: "prepare", to: "analyze" },
      { id: "analyze-report", from: "analyze", to: "report" },
    ],
  };
}

function storedFor(document: WorkflowGraphDocument, revision = 4) {
  return {
    definition: {
      storageVersion: 1 as const,
      id: document.id,
      revision,
      createdAt: 1,
      updatedAt: 2,
      graphSha256: "sha",
      graph: document,
    },
    etag: `"${revision}"`,
  };
}

function summaryFor(id: string, updatedAt: number) {
  return {
    id,
    revision: 4,
    createdAt: 1,
    updatedAt,
    graphSha256: "sha",
    schemaVersion: "1.0",
    name: id,
    description: null,
    nodeCount: 3,
    edgeCount: 2,
  };
}

function readers(overrides: Partial<CurrentPipelineReaders>): CurrentPipelineReaders {
  return {
    readSessionLink: vi.fn(async () => null),
    listDefinitions: vi.fn(async () => []),
    readDefinition: vi.fn(async () => {
      throw new Error("unexpected read");
    }),
    ...overrides,
  } as CurrentPipelineReaders;
}

describe("resolveCurrentPipeline", () => {
  it("prefers the workflow this chat session is delegated to, and says so", async () => {
    const document = realDocument("chat-e2e-workflow", "Chat pipeline");
    const readDefinition = vi.fn(async () => storedFor(document, 7));

    const result = await resolveCurrentPipeline(
      "default",
      "session-e2e",
      readers({
        readSessionLink: vi.fn(async () => ({
          runId: "wrun_1",
          workflowId: "chat-e2e-workflow",
          status: "running",
        })),
        readDefinition,
        // The linked workflow is NOT the most recently updated one, so a
        // resolver that merely sorted by date would pick the wrong document.
        listDefinitions: vi.fn(async () => [
          summaryFor("some-other", 99),
          summaryFor("chat-e2e-workflow", 1),
        ]),
      }),
    );

    expect(result).toMatchObject({
      kind: "pipeline",
      source: "session-link",
      workflowId: "chat-e2e-workflow",
      revision: 7,
    });
    // Exactly one definition read, and it is the linked one.
    expect(readDefinition).toHaveBeenCalledTimes(1);
    expect(readDefinition).toHaveBeenCalledWith("default", "chat-e2e-workflow");
  });

  it("never asks for a definition the registry does not list", async () => {
    // A session outliving its workflow: the link still names it, the registry
    // no longer carries it. Asking anyway would turn a stale link into an error
    // the reader cannot act on, so the rail falls back and relabels instead.
    const readDefinition = vi.fn(async () => storedFor(realDocument("survivor", "Survivor")));
    const result = await resolveCurrentPipeline(
      "default",
      "session-e2e",
      readers({
        readSessionLink: vi.fn(async () => ({
          runId: "wrun_1",
          workflowId: "deleted-workflow",
          status: "succeeded",
        })),
        listDefinitions: vi.fn(async () => [summaryFor("survivor", 5)]),
        readDefinition,
      }),
    );

    expect(result).toMatchObject({ kind: "pipeline", source: "project-recent", workflowId: "survivor" });
    expect(readDefinition).toHaveBeenCalledTimes(1);
    expect(readDefinition).not.toHaveBeenCalledWith("default", "deleted-workflow");
  });

  it("falls back to the most recently updated project workflow, labelled as such", async () => {
    const document = realDocument("newest", "Newest pipeline");
    const result = await resolveCurrentPipeline(
      "default",
      "session-e2e",
      readers({
        readSessionLink: vi.fn(async () => null),
        listDefinitions: vi.fn(async () => [
          summaryFor("older", 10),
          summaryFor("newest", 40),
          summaryFor("middle", 20),
        ]),
        readDefinition: vi.fn(async () => storedFor(document)),
      }),
    );

    expect(result).toMatchObject({ kind: "pipeline", source: "project-recent", workflowId: "newest" });
  });

  it("reports a designed empty state when the project has no pipeline", async () => {
    const result = await resolveCurrentPipeline("default", null, readers({}));
    expect(result).toEqual({ kind: "none", reason: NO_PIPELINE_REASON });
  });

  it("survives #62 — a malformed-but-200 list body resolves to an error, not a throw", async () => {
    // The exact defect: `listDagWorkflowDefinitions` ends in `return
    // body.workflows`, a cast rather than a check, so a 200 without that array
    // hands `undefined` to the caller.
    const result = await resolveCurrentPipeline(
      "default",
      null,
      readers({
        listDefinitions: vi.fn(async () => undefined as unknown as []),
      }),
    );
    expect(result).toEqual({ kind: "error", message: PIPELINE_READ_ERROR });
  });

  it("refuses a linked document whose graph is malformed rather than previewing another one", async () => {
    const result = await resolveCurrentPipeline(
      "default",
      "session-e2e",
      readers({
        readSessionLink: vi.fn(async () => ({ runId: "r", workflowId: "broken", status: "running" })),
        listDefinitions: vi.fn(async () => [summaryFor("broken", 5)]),
        readDefinition: vi.fn(async () => ({
          definition: { storageVersion: 1, id: "broken", revision: 1, createdAt: 1, updatedAt: 1, graphSha256: "s", graph: { id: "broken", name: "Broken", nodes: null, edges: null } },
          etag: null,
        }) as never),
      }),
    );
    expect(result).toEqual({ kind: "error", message: PIPELINE_READ_ERROR });
  });

  it("does not leak a filesystem path in any reader-facing string (#71)", async () => {
    const result = await resolveCurrentPipeline(
      "default",
      null,
      readers({ listDefinitions: vi.fn(async () => { throw new Error("EACCES: /Users/someone/sandbox/db.sqlite"); }) }),
    );
    expect(result.kind).toBe("error");
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/\//);
  });
});

describe("isDrawableDocument", () => {
  it("rejects the shapes that would throw in render phase", () => {
    expect(isDrawableDocument(null)).toBe(false);
    expect(isDrawableDocument({ id: "a", name: "b" })).toBe(false);
    expect(isDrawableDocument({ id: "a", name: "b", nodes: {}, edges: [] })).toBe(false);
    expect(isDrawableDocument({ id: "a", name: "b", nodes: [], edges: [] })).toBe(true);
  });
});

describe("projectPipelinePreview", () => {
  it("draws the document's own nodes — ids, names and terminal flag all come from it", () => {
    const preview = projectPipelinePreview(realDocument("w", "Chat pipeline"));

    expect(preview.name).toBe("Chat pipeline");
    expect(preview.nodes.map((node) => node.id)).toEqual(["prepare", "analyze", "report"]);
    expect(preview.nodes.map((node) => node.label)).toEqual([
      "Prepare counts",
      "Analyze",
      "Write the report",
    ]);
    expect(preview.nodes.map((node) => node.terminal)).toEqual([false, false, true]);
    expect(preview.nodes.map((node) => node.index)).toEqual([1, 2, 3]);
    expect(preview.edgeCount).toBe(2);
    expect(preview.droppedNodeCount).toBe(0);
  });

  it("lays a chain out left to right and fits every node inside the unit square", () => {
    const preview = projectPipelinePreview(realDocument("w", "Chain"));
    const xs = preview.nodes.map((node) => node.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    for (const node of preview.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(1);
    }
  });

  it("fans two successors into one column so a DAG does not draw as a chain", () => {
    const document = realDocument("w", "Fan");
    document.edges = [
      { id: "e1", from: "prepare", to: "analyze" },
      { id: "e2", from: "prepare", to: "report" },
    ];
    const preview = projectPipelinePreview(document);
    const analyze = preview.nodes.find((node) => node.id === "analyze");
    const report = preview.nodes.find((node) => node.id === "report");
    expect(analyze?.x).toBe(report?.x);
    expect(analyze?.y).not.toBe(report?.y);
  });

  it("terminates on a cyclic document instead of hanging the rail", () => {
    const document = realDocument("w", "Cycle");
    document.edges = [
      { id: "e1", from: "prepare", to: "analyze" },
      { id: "e2", from: "analyze", to: "report" },
      { id: "e3", from: "report", to: "prepare" },
    ];
    const preview = projectPipelinePreview(document);
    expect(preview.nodeCount).toBe(3);
  });

  it("drops edges whose endpoints are not drawn, so no line points at nothing", () => {
    const document = realDocument("w", "Dangling");
    document.edges = [
      { id: "e1", from: "prepare", to: "analyze" },
      { id: "ghost", from: "analyze", to: "not-a-node" },
    ];
    const preview = projectPipelinePreview(document);
    expect(preview.edges.map((edge) => edge.id)).toEqual(["e1"]);
  });

  it("counts every node it did not draw, whether malformed or past the cap", () => {
    const malformed = realDocument("w", "Malformed");
    // A node with no id cannot be an edge endpoint and is not drawable.
    (malformed.nodes as unknown[]).push({ name: "No id", kind: "agent", terminal: false });
    expect(projectPipelinePreview(malformed).droppedNodeCount).toBe(1);

    const huge = realDocument("w", "Huge");
    huge.nodes = Array.from({ length: MAX_PREVIEW_NODES + 5 }, (_unused, index) => ({
      id: `n${index}`,
      name: `Node ${index}`,
      kind: "agent" as const,
      terminal: false,
      workspace: { isolation: "read-only" as const, writePaths: [] },
      prompt: "x",
    }));
    huge.edges = [];
    const preview = projectPipelinePreview(huge);
    expect(preview.nodeCount).toBe(MAX_PREVIEW_NODES);
    expect(preview.droppedNodeCount).toBe(5);
  });
});

describe("previewSummaryLine", () => {
  it("states counts as text so no numeric fact depends on reading the drawing", () => {
    const preview = projectPipelinePreview(realDocument("w", "Chain"));
    expect(previewSummaryLine(preview, 7)).toBe("3 nodes · 2 edges · rev 7");
  });

  it("says out loud when the drawing is not the whole document", () => {
    const document = realDocument("w", "Partial");
    (document.nodes as unknown[]).push({ name: "No id", kind: "agent", terminal: false });
    const preview = projectPipelinePreview(document);
    expect(previewSummaryLine(preview, 2)).toBe("3 nodes · 2 edges · rev 2 · 1 not shown");
  });
});
