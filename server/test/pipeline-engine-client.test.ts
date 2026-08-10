import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listWorkflows,
  PIPELINE_ENGINE_LIST_TIMEOUT_MS,
  PipelineEngineRequestAbortedError,
  PipelineEngineTimeoutError,
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
