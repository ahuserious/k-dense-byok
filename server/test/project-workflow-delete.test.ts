import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProjectRoutes } from "../src/api/projects.ts";
import type { DisposeWorkflowDelegationSessionOptions } from "../src/agent/workflow-delegation-session.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, getProject, resolvePaths } from "../src/projects.ts";
import { workflowStore, type WorkflowGraphDocument } from "../src/workflows/index.ts";

const quiesceProject = vi.fn(async (projectId: string) => ({
  projectId,
  cancellationRequested: [],
  drained: true,
}));
const releaseProjectQuiesce = vi.fn();
const disposeWorkflowSession = vi.fn(async (
  _projectId: string,
  _options: DisposeWorkflowDelegationSessionOptions = {},
) => {});
const assertHostedFusionProjectQuiescent = vi.fn((_projectId?: string) => {});
const app = Fastify();
await registerProjectRoutes(app, {
  workflowController: { quiesceProject, releaseProjectQuiesce },
  disposeWorkflowSession,
  assertHostedFusionProjectQuiescent,
});

function workflow(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "delete-race-workflow",
    name: "Delete race workflow",
    entryNodeId: "start",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        auth: { kind: "api-key" },
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
      maxTokens: 10_000,
      maxCostUsd: 1,
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
        prompt: "Return a bounded result.",
      },
    ],
    edges: [],
  };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createRunPausedBeforePublish(projectId: string, readyFile: string): Promise<string> {
  const storeModule = pathToFileURL(path.join(process.cwd(), "src", "workflows", "store.ts")).href;
  const workflowRunsDirectory = resolvePaths(projectId).workflowRunsDir;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { WorkflowStore } from ${JSON.stringify(storeModule)};
    const originalRenameSync = fs.renameSync.bind(fs);
    fs.renameSync = (source, target) => {
      if (
        path.dirname(path.resolve(String(target))) === ${JSON.stringify(path.resolve(workflowRunsDirectory))} &&
        path.basename(String(source)).startsWith(".creating-wrun_")
      ) {
        fs.writeFileSync(${JSON.stringify(readyFile)}, "ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      }
      return originalRenameSync(source, target);
    };
    try {
      new WorkflowStore().createRun(${JSON.stringify(projectId)}, {
        workflowId: "delete-race-workflow",
        requestId: "concurrent-create",
        requestedBy: "user",
      });
      process.stdout.write("created");
    } catch (error) {
      process.stdout.write(String(error?.code ?? error?.name ?? "error"));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Concurrent run worker exited ${String(code)}: ${stderr}`));
    });
  });
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  quiesceProject.mockReset();
  quiesceProject.mockImplementation(async (projectId: string) => ({
    projectId,
    cancellationRequested: [],
    drained: true,
  }));
  releaseProjectQuiesce.mockReset();
  disposeWorkflowSession.mockReset();
  disposeWorkflowSession.mockResolvedValue(undefined);
  assertHostedFusionProjectQuiescent.mockReset();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("project deletion owns the DAG lifecycle", () => {
  it("quiesces and drains workflow runs before removing project state", async () => {
    createProject({ name: "Delete me", projectId: "delete-me" });

    const response = await app.inject({
      method: "DELETE",
      url: "/projects/delete-me",
    });

    expect(response.statusCode).toBe(204);
    expect(quiesceProject).toHaveBeenCalledWith("delete-me");
    expect(releaseProjectQuiesce).toHaveBeenCalledWith("delete-me");
    expect(disposeWorkflowSession).toHaveBeenCalledWith("delete-me", {
      rejectIfOwnedLeaves: true,
    });
    expect(assertHostedFusionProjectQuiescent).toHaveBeenCalledWith("delete-me");
    expect(getProject("delete-me")).toBeNull();
  });

  it("preserves project state while a hosted Fusion provider session is quarantined", async () => {
    createProject({ name: "Hosted Fusion quarantine", projectId: "hosted-quarantine" });
    assertHostedFusionProjectQuiescent.mockImplementationOnce(() => {
      throw new Error(
        "Project hosted-quarantine owns 1 quarantined hosted Fusion session; deletion is blocked.",
      );
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/projects/hosted-quarantine",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/quarantined hosted Fusion session/);
    expect(getProject("hosted-quarantine")?.id).toBe("hosted-quarantine");
    expect(disposeWorkflowSession).not.toHaveBeenCalled();
  });

  it("preserves project state and its Pi owner while a DAG child is quarantined", async () => {
    createProject({ name: "Quarantined child", projectId: "quarantined-child" });
    disposeWorkflowSession.mockRejectedValueOnce(
      new Error(
        "Project quarantined-child has 1 quarantined DAG child execution; deletion is blocked until exact terminal acknowledgement.",
      ),
    );

    const response = await app.inject({
      method: "DELETE",
      url: "/projects/quarantined-child",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/quarantined DAG child/);
    expect(getProject("quarantined-child")?.id).toBe("quarantined-child");
    expect(disposeWorkflowSession).toHaveBeenCalledWith("quarantined-child", {
      rejectIfOwnedLeaves: true,
    });
  });

  it("preserves the project when a workflow owner does not drain in time", async () => {
    createProject({ name: "Still running", projectId: "still-running" });
    quiesceProject.mockResolvedValueOnce({
      projectId: "still-running",
      cancellationRequested: ["wrun_busy"],
      drained: false,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/projects/still-running",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/did not terminate/);
    expect(releaseProjectQuiesce).toHaveBeenCalledWith("still-running");
    expect(getProject("still-running")?.id).toBe("still-running");
  });

  it("does not delete a run another backend publishes after the process-local drain", async () => {
    createProject({ name: "Delete race", projectId: "delete-race" });
    workflowStore.saveDefinition("delete-race", "delete-race-workflow", workflow());
    const readyFile = path.join(PROJECTS_ROOT, "delete-race-worker-ready");
    const worker = createRunPausedBeforePublish("delete-race", readyFile);
    await waitForFile(readyFile);

    const response = await app.inject({
      method: "DELETE",
      url: "/projects/delete-race",
    });
    const workerResult = await worker;

    expect(workerResult).toBe("created");
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/created by another backend/);
    expect(getProject("delete-race")?.id).toBe("delete-race");
    expect(workflowStore.listCancellableRuns("delete-race")).toHaveLength(1);
  });
});
