import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PipelineReconciliationWorker,
  queryEngineRunByAdmissionId,
} from "../src/api/pipelines.ts";
import { createProject, getProject } from "../src/projects.ts";

beforeEach(() => {
  fs.mkdirSync(process.env.KADY_PROJECTS_ROOT!, { recursive: true });
  if (!getProject("default")) {
    createProject({ name: "Default", projectId: "default", spendLimitUsd: 20 });
  }
});

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

  it("inspects local admissions but performs no engine traffic when reconciliation is disabled", async () => {
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

    expect(projects).toHaveBeenCalledOnce();
    expect(admissions).toHaveBeenCalledOnce();
    expect(queryAdmission).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
