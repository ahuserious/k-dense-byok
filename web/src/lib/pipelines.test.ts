import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "./projects";
import { listPipelines, pipelineHealth, runPipeline } from "./pipelines";

vi.mock("./projects", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("pipeline proxy client errors", () => {
  it.each([
    { status: 400, body: { error: "Invalid workflow name." }, detail: "Invalid workflow name." },
    { status: 502, body: { detail: "Upstream workflow failure." }, detail: "Upstream workflow failure." },
    { status: 503, body: { message: "Workflow engine unavailable." }, detail: "Workflow engine unavailable." },
  ])("runPipeline rejects HTTP $status with the parsed error body", async ({ status, body, detail }) => {
    apiFetchMock.mockResolvedValueOnce(errorResponse(status, body));

    await expect(runPipeline("microscopy-qc", "conversation-1", "Run it."))
      .rejects.toThrow(`Pipeline run failed (${status}): ${detail}`);
  });

  it("listPipelines rejects non-2xx responses instead of returning an empty library", async () => {
    apiFetchMock.mockResolvedValueOnce(errorResponse(502, { detail: "Bad gateway." }));

    await expect(listPipelines()).rejects.toThrow("Pipeline list failed (502): Bad gateway.");
  });

  it("pipelineHealth rejects non-2xx responses instead of reporting a healthy transport", async () => {
    apiFetchMock.mockResolvedValueOnce(errorResponse(503, { error: "Starting." }));

    await expect(pipelineHealth()).rejects.toThrow("Pipeline health check failed (503): Starting.");
  });
});
