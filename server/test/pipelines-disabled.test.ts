import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineReconciliationWorker,
  queryEngineRunByAdmissionId,
} from "../src/api/pipelines.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("disabled pipeline engine admission guards", () => {
  it("does not fetch admission state when the launcher disabled the engine", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryEngineRunByAdmissionId(
      "default",
      "kadypipe_disabled0000000000000000000000",
      true,
    )).rejects.toThrow("Pipeline engine is disabled by the launcher");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not inspect projects or admissions when reconciliation is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const projects = vi.fn(() => [{ id: "default" }]);
    const admissions = vi.fn(() => []);
    const queryAdmission = vi.fn(async () => ({ status: "unknown" as const }));
    const getRun = vi.fn(async () => ({}));
    const worker = new PipelineReconciliationWorker({
      engineDisabled: true,
      projects,
      admissions,
      queryAdmission,
      getRun,
    });

    await worker.runOnce();

    expect(projects).not.toHaveBeenCalled();
    expect(admissions).not.toHaveBeenCalled();
    expect(queryAdmission).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
