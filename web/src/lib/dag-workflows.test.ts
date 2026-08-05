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

  it("reads ETags and sends revision compare-and-swap on saves", async () => {
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
        storageVersion: 1,
        id: "graph-a",
        revision: 4,
        createdAt: 1,
        updatedAt: 3,
        graphSha256: "def",
        graph,
      }, { headers: { ETag: '"4"' } }));

    const read = await readDagWorkflowDefinition("project-a", "graph-a");
    const saved = await saveDagWorkflowDefinition("project-a", "graph-a", graph, 3);

    expect(read.etag).toBe('"3"');
    expect(saved.definition.revision).toBe(4);
    const [, saveInit] = fetchMock.mock.calls[1];
    const headers = new Headers(saveInit?.headers);
    expect(headers.get("If-Match")).toBe('"3"');
    expect(headers.get("X-Project-Id")).toBe("project-a");
    expect(saveInit?.method).toBe("PUT");
  });

  it("preserves server error detail, code, and status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { code: "CONFLICT", detail: "Expected workflow revision 4, received 3." },
      { status: 409 },
    ));

    await expect(saveDagWorkflowDefinition("project-a", "graph-a", graph, 3))
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
