import { afterEach, describe, expect, it, vi } from "vitest";

import { casConflictActions, copyWorkflowId } from "@/components/builder/cas-conflict";
import {
  DagWorkflowApiError,
  saveDagWorkflowDefinition,
  type WorkflowGraphDocument,
} from "@/lib/dag-workflows";

function document(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "conflict-workflow",
    name: "Conflict workflow",
    entryNodeId: "start",
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
        name: "Start",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Return one bounded result.",
      },
    ],
    edges: [],
  };
}

function conflictResponse(etag: string | null): Response {
  return new Response(
    JSON.stringify({ code: "CONFLICT", detail: "Workflow is revision 4; expected 1." }),
    {
      status: 409,
      headers: etag === null
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "application/json", ETag: etag },
    },
  );
}

async function saveExpectingFailure(response: Response): Promise<unknown> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  try {
    await saveDagWorkflowDefinition("default", "conflict-workflow", document(), {
      kind: "update",
      expectedRevision: 1,
    });
  } catch (error) {
    return error;
  }
  throw new Error("The save was expected to fail.");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("casConflictActions", () => {
  it("offers a conditional overwrite when the server published the compared revision", async () => {
    const error = await saveExpectingFailure(conflictResponse('"4"'));

    expect(casConflictActions(error)).toEqual({
      detail: "Workflow is revision 4; expected 1.",
      overwriteRevision: 4,
    });
  });

  it("withholds the overwrite when the server published no revision", async () => {
    const error = await saveExpectingFailure(conflictResponse(null));

    // Reload and save-as-copy remain available to the caller; an overwrite does
    // not, because there is no revision to make the retry conditional with.
    expect(casConflictActions(error)?.overwriteRevision).toBeNull();
  });

  it("withholds the overwrite when the published ETag is not a revision this route mints", async () => {
    for (const etag of ['W/"4"', "4", '"04"', '"-1"', '"abc"']) {
      const error = await saveExpectingFailure(conflictResponse(etag));
      expect(casConflictActions(error)?.overwriteRevision, etag).toBeNull();
    }
  });

  it("is not a conflict when the write failed for any other reason", () => {
    expect(casConflictActions(new DagWorkflowApiError(500, "Server exploded."))).toBeNull();
    expect(casConflictActions(new DagWorkflowApiError(400, "Bad precondition."))).toBeNull();
    expect(casConflictActions(new Error("network down"))).toBeNull();
    expect(casConflictActions(null)).toBeNull();
  });
});

describe("copyWorkflowId", () => {
  it("suffixes a copy and keeps the result inside the schema's id limit", () => {
    expect(copyWorkflowId("microscopy-qc")).toBe("microscopy-qc-copy");
    const long = "a".repeat(64);
    expect(copyWorkflowId(long)).toHaveLength(64);
    expect(copyWorkflowId(long).endsWith("-copy")).toBe(true);
  });
});
