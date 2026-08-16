import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelDagWorkflowRun,
  createDagWorkflowRun,
  listDagWorkflowDefinitions,
  listDagWorkflowRuns,
  pageDagWorkflowRunEvents,
  readDagWorkflowDefinition,
  readDagWorkflowRun,
  readDagWorkflowRunBudget,
  rescueDagWorkflowRun,
  resumeDagWorkflowRun,
  saveDagWorkflowDefinition,
  type WorkflowGraphDocument,
} from "./dag-workflows";
import { createDefaultWorkflowGraph } from "./dag-workflow-builder";

const graph: WorkflowGraphDocument = createDefaultWorkflowGraph("graph-a", "Graph A");

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

describe("DAG workflow client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("reads ETags and sends an explicit update compare-and-swap on saves", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        storageVersion: 1,
        id: "graph-a",
        revision: 3,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        graph,
      }, { headers: { ETag: '"3"' } }))
      .mockResolvedValueOnce(jsonResponse({
        outcome: "updated",
        definition: {
          storageVersion: 1,
          id: "graph-a",
          revision: 4,
          createdAt: 1,
          updatedAt: 3,
          graphSha256: "def",
          graph,
        },
      }, { headers: { ETag: '"4"' } }));

    const read = await readDagWorkflowDefinition("project-a", "graph-a");
    const saved = await saveDagWorkflowDefinition("project-a", "graph-a", graph, {
      kind: "update",
      expectedRevision: 3,
    });

    expect(read.etag).toBe('"3"');
    expect(saved.outcome).toBe("updated");
    expect(saved.definition.revision).toBe(4);
    expect(saved.etag).toBe('"4"');
    const [, saveInit] = fetchMock.mock.calls[1];
    const headers = new Headers(saveInit?.headers);
    expect(headers.get("If-Match")).toBe('"3"');
    expect(headers.get("If-None-Match")).toBeNull();
    expect(headers.get("X-Project-Id")).toBe("project-a");
    expect(saveInit?.method).toBe("PUT");
  });

  it("sends If-None-Match: * and unwraps the created envelope on an explicit create", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      outcome: "created",
      definition: {
        storageVersion: 1,
        id: "graph-a",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        graphSha256: "abc",
        graph,
      },
    }, { status: 201, headers: { ETag: '"1"' } }));

    const created = await saveDagWorkflowDefinition("project-a", "graph-a", graph, {
      kind: "create",
    });

    expect(created).toEqual({
      outcome: "created",
      definition: expect.objectContaining({ id: "graph-a", revision: 1 }),
      etag: '"1"',
    });
    const [, createInit] = fetchMock.mock.calls[0];
    const headers = new Headers(createInit?.headers);
    expect(headers.get("If-None-Match")).toBe("*");
    expect(headers.get("If-Match")).toBeNull();
  });

  it("unwraps an unchanged 200 without inventing a new revision", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      outcome: "unchanged",
      definition: {
        storageVersion: 1,
        id: "graph-a",
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        graphSha256: "abc",
        graph,
      },
    }, { headers: { ETag: '"2"' } }));

    const unchanged = await saveDagWorkflowDefinition("project-a", "graph-a", graph, {
      kind: "update",
      expectedRevision: 2,
    });

    expect(unchanged.outcome).toBe("unchanged");
    expect(unchanged.definition.revision).toBe(2);
    expect(unchanged.etag).toBe('"2"');
  });

  it("accepts every non-negative safe integer update revision, including 0", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { code: "CONFLICT", detail: "Workflow graph-a does not exist at revision 0." },
      { status: 409 },
    ));

    // 0 is a legal precondition that reaches the server's missing-record
    // conflict; the client must never reinterpret it as a create.
    await expect(saveDagWorkflowDefinition("project-a", "graph-a", graph, {
      kind: "update",
      expectedRevision: 0,
    })).rejects.toMatchObject({ name: "DagWorkflowApiError", status: 409 });
    const [, zeroInit] = fetchMock.mock.calls[0];
    expect(new Headers(zeroInit?.headers).get("If-Match")).toBe('"0"');
    expect(new Headers(zeroInit?.headers).get("If-None-Match")).toBeNull();
  });

  it("rejects an invalid update revision before making a request", async () => {
    for (const expectedRevision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(saveDagWorkflowDefinition("project-a", "graph-a", graph, {
        kind: "update",
        expectedRevision,
      })).rejects.toThrow("Expected revision must be a non-negative safe integer.");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves server error detail, code, and status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { code: "CONFLICT", detail: "Expected workflow revision 4, received 3." },
      { status: 409 },
    ));

    await expect(saveDagWorkflowDefinition("project-a", "graph-a", graph, {
      kind: "update",
      expectedRevision: 3,
    }))
      .rejects.toMatchObject({
        name: "DagWorkflowApiError",
        status: 409,
        code: "CONFLICT",
        detail: "Expected workflow revision 4, received 3.",
      });
  });

  it("covers the read-only run and bounded event routes without an event writer", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ workflows: [] }))
      .mockResolvedValueOnce(jsonResponse({ manifest: { id: "wrun_1" }, state: { status: "queued" } }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ runs: [] }))
      .mockResolvedValueOnce(jsonResponse({ manifest: { id: "wrun_1" }, state: { status: "queued" } }))
      .mockResolvedValueOnce(jsonResponse({
        runId: "wrun_1",
        reservationCount: 0,
        ceilings: null,
      }))
      .mockResolvedValueOnce(jsonResponse({ events: [], lastSeq: 0, hasMore: false, diagnostics: [] }));

    await listDagWorkflowDefinitions("project-a");
    await createDagWorkflowRun("project-a", "graph-a", { requestId: "request-1" });
    await listDagWorkflowRuns("project-a", 17);
    await readDagWorkflowRun("project-a", "wrun_1");
    await readDagWorkflowRunBudget("project-a", "wrun_1");
    await pageDagWorkflowRunEvents("project-a", "wrun_1", { after: 12, limit: 25 });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]))
      .toEqual([
        ["http://localhost:8000/dag-workflows", "GET"],
        ["http://localhost:8000/dag-workflows/graph-a/runs", "POST"],
        ["http://localhost:8000/dag-workflow-runs?limit=17", "GET"],
        ["http://localhost:8000/dag-workflow-runs/wrun_1", "GET"],
        ["http://localhost:8000/dag-workflow-runs/wrun_1/budget", "GET"],
        ["http://localhost:8000/dag-workflow-runs/wrun_1/events?after=12&limit=25", "GET"],
      ]);
    expect(fetchMock.mock.calls.every(([, init]) => (
      new Headers(init?.headers).get("X-Project-Id") === "project-a"
    ))).toBe(true);
  });

  it("posts typed cancel, resume, and rescue controls to project-scoped run routes", async () => {
    const runBody = { manifest: { id: "wrun_1" }, state: { status: "running" } };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(runBody))
      .mockResolvedValueOnce(jsonResponse(runBody, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({
        manifest: { id: "wrun_rescue" },
        state: { status: "queued" },
      }, { status: 202 }));

    await cancelDagWorkflowRun("project-a", "wrun/1");
    await resumeDagWorkflowRun("project-a", "wrun/1");
    await rescueDagWorkflowRun("project-a", "wrun/1", { requestId: "rescue-request" });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body]))
      .toEqual([
        ["http://localhost:8000/dag-workflow-runs/wrun%2F1/cancel", "POST", undefined],
        ["http://localhost:8000/dag-workflow-runs/wrun%2F1/resume", "POST", undefined],
        [
          "http://localhost:8000/dag-workflow-runs/wrun%2F1/rescue",
          "POST",
          JSON.stringify({ requestId: "rescue-request" }),
        ],
      ]);
    expect(fetchMock.mock.calls.every(([, init]) => (
      new Headers(init?.headers).get("X-Project-Id") === "project-a"
    ))).toBe(true);
  });

  it("rejects an oversized run goal before making a request", async () => {
    await expect(createDagWorkflowRun("project-a", "graph-a", {
      requestId: "request-oversized",
      input: { goal: "x".repeat(32_769) },
    })).rejects.toThrow("Workflow run goal must be at most 32768 characters");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
