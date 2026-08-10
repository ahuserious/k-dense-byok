import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getWorkflow,
  listWorkflows,
  PIPELINE_ENGINE_LIST_TIMEOUT_MS,
  PipelineEngineRequestAbortedError,
  PipelineEngineTimeoutError,
  registerCodebase,
  runWorkflow,
  saveWorkflow,
} from "../src/agent/pipeline-engine/client.ts";

function installStalledSidecarFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  observed: { aborted: boolean; signal?: AbortSignal };
} {
  const observed: { aborted: boolean; signal?: AbortSignal } = { aborted: false };
  const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    observed.signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = (): void => {
        observed.aborted = true;
        reject(new Error("stalled sidecar observed request cancellation"));
      };
      if (observed.signal?.aborted) onAbort();
      else observed.signal?.addEventListener("abort", onAbort, { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, observed };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pipeline engine workflow-list cancellation", () => {
  it("registers a Kady sandbox as a normal named git codebase", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        id: "codebase-a",
        default_cwd: "/projects/a/sandbox",
      }), { status: 201 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await registerCodebase("/projects/a/sandbox", {
      name: "kady/project-a",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe("/api/codebases");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      path: "/projects/a/sandbox",
      name: "kady/project-a",
    });
  });

  it("keeps different Kady project workflow lists isolated by cwd and codebase id", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ workflows: [] }), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await listWorkflows({ cwd: "/projects/a/sandbox", codebaseId: "codebase-a" });
    await listWorkflows({ cwd: "/projects/b/sandbox", codebaseId: "codebase-b" });

    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { cwd: "/projects/a/sandbox", codebaseId: "codebase-a" },
      { cwd: "/projects/b/sandbox", codebaseId: "codebase-b" },
    ]);
  });

  it("round-trips a stable workflow id and project scope through get, edit, and run", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ accepted: true, status: "queued" }), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const workflowId = "workflow_11111111111111111111111111111111";
    const scope = { cwd: "/projects/a/sandbox", codebaseId: "codebase-a" };

    await getWorkflow(workflowId, scope);
    await saveWorkflow(workflowId, { definition: { name: "Edited workflow" } }, scope);
    await runWorkflow(workflowId, { conversationId: "conversation-a", message: "Run" }, scope);

    const getUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const editUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    const runUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(getUrl.pathname).toBe(`/api/workflows/${workflowId}`);
    expect(editUrl.pathname).toBe(`/api/workflows/${workflowId}`);
    expect(runUrl.pathname).toBe(`/api/workflows/${workflowId}/run`);
    expect(Object.fromEntries(getUrl.searchParams)).toEqual(scope);
    expect(Object.fromEntries(editUrl.searchParams)).toEqual(scope);
    expect(Object.fromEntries(runUrl.searchParams)).toEqual(scope);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      definition: { name: "Edited workflow" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      workflowId,
      cwd: scope.cwd,
      codebaseId: scope.codebaseId,
    });
  });

  it("aborts a stalled sidecar fetch at the client-owned timeout", async () => {
    vi.useFakeTimers();
    const { fetchMock, observed } = installStalledSidecarFetch();

    const request = listWorkflows();
    const rejection = expect(request).rejects.toMatchObject({
      constructor: PipelineEngineTimeoutError,
      message: expect.stringContaining(
        `timed out after ${PIPELINE_ENGINE_LIST_TIMEOUT_MS}ms`,
      ),
    });
    await vi.advanceTimersByTimeAsync(PIPELINE_ENGINE_LIST_TIMEOUT_MS);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observed.signal).toBeInstanceOf(AbortSignal);
    expect(observed.signal?.aborted).toBe(true);
    expect(observed.aborted).toBe(true);
  });

  it("aborts a stalled sidecar fetch when the optional external signal fires", async () => {
    const { fetchMock, observed } = installStalledSidecarFetch();
    const externalController = new AbortController();

    const request = listWorkflows(externalController.signal);
    const rejection = expect(request).rejects.toBeInstanceOf(
      PipelineEngineRequestAbortedError,
    );
    externalController.abort();

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observed.signal).not.toBe(externalController.signal);
    expect(observed.signal?.aborted).toBe(true);
    expect(observed.aborted).toBe(true);
  });
});
