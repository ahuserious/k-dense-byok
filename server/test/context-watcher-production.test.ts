import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { ensureProjectExists, type ProjectPaths } from "../src/projects.ts";
import { installDagFusionCompactionAudit } from
  "../pi-packages/dag-fusion-drive/compaction-audit.ts";
import { ContextEngineeringProduction } from
  "../src/workflows/context-watcher-production.ts";
import type { WorkflowRunController } from "../src/workflows/controller.ts";
import type { WorkflowStore } from "../src/workflows/store.ts";

const productions: ContextEngineeringProduction[] = [];

afterEach(() => {
  for (const production of productions.splice(0)) production.close();
});

function persistCompactionRecord(paths: ProjectPaths, childRunId: string): void {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as Pick<ExtensionAPI, "on">;
  installDagFusionCompactionAudit(pi, {
    sandboxRoot: paths.sandbox,
    env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUN_ID: childRunId },
  });
  handlers.get("session_before_compact")!({
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-production",
      messagesToSummarize: [{ role: "user", content: "Preserve the verified goal." }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 },
    },
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  } as unknown as SessionBeforeCompactEvent);
  handlers.get("session_compact")!({
    type: "session_compact",
    compactionEntry: {
      firstKeptEntryId: "entry-production",
      summary: "Preserve the verified goal.",
      tokensBefore: 1_000,
    },
    fromExtension: false,
    reason: "threshold",
    willRetry: false,
  } as unknown as SessionCompactEvent);
}

function sourceRun(
  runId: string,
  status: "running" | "interrupted",
  recoverable: boolean,
) {
  return {
    manifest: {
      id: runId,
      workflowId: "workflow-context",
      workflowRevision: 1,
      graphSha256: "a".repeat(64),
      graph: { id: "workflow-context", marker: "revision-1" },
      input: { goal: "Preserve the verified goal.", variables: {} },
    },
    state: {
      status,
      recoverable,
      lastSeq: 9,
    },
  };
}

describe("ContextEngineeringProduction", () => {
  it("feeds an exact recoverable interrupted run into watcher-owned restart", async () => {
    const projectId = "context-stopped-feed";
    ensureProjectExists(projectId);
    const run = {
      manifest: {
        id: "wrun_11111111111111111111111111111111",
        graphSha256: "a".repeat(64),
      },
      state: {
        status: "interrupted",
        recoverable: true,
        lastSeq: 9,
      },
    };
    const store = {
      listRuns: (candidate: string) => candidate === projectId ? [run] : [],
      readRun: (candidate: string, runId: string) =>
        candidate === projectId && runId === run.manifest.id ? run : null,
    } as unknown as WorkflowStore;
    const resume = vi.fn();
    const controller = { resume } as unknown as WorkflowRunController;
    const production = new ContextEngineeringProduction(controller, {
      store,
      completeJson: vi.fn(),
    });
    productions.push(production);

    await production.scanStoppedRuns();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(projectId, run.manifest.id);
  });

  it("consumes the durable bridge record through the mockable semantic model", async () => {
    const projectId = "context-compaction-feed";
    const paths = ensureProjectExists(projectId);
    const runId = "wrun_22222222222222222222222222222222";
    const childRunId = "child-production-feed";
    persistCompactionRecord(paths, childRunId);
    const source = { manifest: { id: runId }, state: {} };
    const store = {
      readRun: (candidate: string, candidateRunId: string) =>
        candidate === projectId && candidateRunId === runId ? source : null,
    } as unknown as WorkflowStore;
    const completeJson = vi.fn().mockResolvedValue({
      verdict: "clean",
      hallucinations: [],
      missedTodos: [],
      promptDeviations: [],
    });
    const production = new ContextEngineeringProduction(null, { store, completeJson });
    productions.push(production);

    await production.handleDagFusionCompaction({
      ownerRunId: runId,
      nodeId: "analysis",
      childRunId,
    });

    expect(completeJson).toHaveBeenCalledOnce();
    expect(completeJson).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      input: expect.objectContaining({ childRunId }),
    }));
  });

  it("aborts as retryable when the definition revision changes during repair", async () => {
    const projectId = "context-stale-definition";
    const paths = ensureProjectExists(projectId);
    const runId = "wrun_33333333333333333333333333333333";
    const childRunId = "child-stale-definition";
    persistCompactionRecord(paths, childRunId);
    const source = sourceRun(runId, "interrupted", true);
    let definition = {
      id: "workflow-context",
      revision: 1,
      graph: { id: "workflow-context", marker: "revision-1" },
    };
    const saveDefinition = vi.fn();
    const createRun = vi.fn();
    const store = {
      readRun: (candidate: string, candidateRunId: string) =>
        candidate === projectId && candidateRunId === runId ? source : null,
      readDefinition: () => definition,
      saveDefinition,
      createRun,
    } as unknown as WorkflowStore;
    const completeJson = vi.fn()
      .mockResolvedValueOnce({
        verdict: "context-rot",
        hallucinations: ["invented completion"],
        missedTodos: [],
        promptDeviations: [],
      })
      .mockImplementationOnce(async () => {
        definition = {
          id: "workflow-context",
          revision: 2,
          graph: { id: "workflow-context", marker: "newer-user-revision" },
        };
        return { id: "workflow-context", marker: "model-repair" };
      });
    const production = new ContextEngineeringProduction(null, { store, completeJson });
    productions.push(production);

    await expect(production.handleDagFusionCompaction({
      ownerRunId: runId,
      nodeId: "analysis",
      childRunId,
    })).rejects.toMatchObject({ code: "REDEPLOY_REJECTED" });

    expect(saveDefinition).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    const operationDirectory = path.join(paths.workflowsDir, "context-watcher");
    const operation = fs.readdirSync(operationDirectory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(operationDirectory, name), "utf8")))[0];
    expect(operation).toMatchObject({
      phase: "repair-failed",
      detail: expect.stringContaining("changed from revision 1 to 2"),
    });
  });

  it("emits a proposal and creates no replacement without verified source recovery", async () => {
    const projectId = "context-replacement-proposal";
    const paths = ensureProjectExists(projectId);
    const runId = "wrun_44444444444444444444444444444444";
    const childRunId = "child-replacement-proposal";
    persistCompactionRecord(paths, childRunId);
    const source = sourceRun(runId, "running", false);
    const readDefinition = vi.fn();
    const saveDefinition = vi.fn();
    const createRun = vi.fn();
    const store = {
      readRun: (candidate: string, candidateRunId: string) =>
        candidate === projectId && candidateRunId === runId ? source : null,
      readDefinition,
      saveDefinition,
      createRun,
    } as unknown as WorkflowStore;
    const completeJson = vi.fn().mockResolvedValue({
      verdict: "context-rot",
      hallucinations: ["invented completion"],
      missedTodos: [],
      promptDeviations: [],
    });
    const start = vi.fn();
    const production = new ContextEngineeringProduction(
      { start } as unknown as WorkflowRunController,
      { store, completeJson },
    );
    productions.push(production);

    await expect(production.handleDagFusionCompaction({
      ownerRunId: runId,
      nodeId: "analysis",
      childRunId,
    })).resolves.toBeUndefined();

    expect(completeJson).toHaveBeenCalledOnce();
    expect(readDefinition).not.toHaveBeenCalled();
    expect(saveDefinition).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    const proposalDirectory = path.join(paths.workflowsDir, "context-watcher", "proposals");
    const proposalFiles = fs.readdirSync(proposalDirectory)
      .filter((name) => name.endsWith(".json"));
    expect(proposalFiles).toHaveLength(1);
    const operationDirectory = path.join(paths.workflowsDir, "context-watcher");
    const operation = fs.readdirSync(operationDirectory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(operationDirectory, name), "utf8")))[0];
    expect(operation).toMatchObject({
      phase: "proposal",
      proposalId: path.basename(proposalFiles[0], ".json"),
    });
  });

  it("starts a replacement only while the verified source proof still matches", async () => {
    const projectId = "context-replacement-verified";
    const paths = ensureProjectExists(projectId);
    const runId = "wrun_55555555555555555555555555555555";
    const replacementRunId = "wrun_66666666666666666666666666666666";
    const childRunId = "child-replacement-verified";
    persistCompactionRecord(paths, childRunId);
    const source = sourceRun(runId, "interrupted", true);
    const definition = {
      id: "workflow-context",
      revision: 1,
      graph: { id: "workflow-context", marker: "revision-1" },
    };
    let replacement: unknown;
    const saveDefinition = vi.fn().mockReturnValue({
      ...definition,
      revision: 2,
      graph: { id: "workflow-context", marker: "model-repair" },
    });
    const createRun = vi.fn().mockImplementation((_projectId, input) => {
      replacement = {
        manifest: {
          id: replacementRunId,
          workflowRevision: 2,
          input: input.input,
        },
        state: { status: "queued" },
      };
      return (replacement as { manifest: unknown }).manifest;
    });
    const store = {
      readRun: (candidate: string, candidateRunId: string) => {
        if (candidate !== projectId) return null;
        if (candidateRunId === runId) return source;
        if (candidateRunId === replacementRunId) return replacement;
        return null;
      },
      readDefinition: () => definition,
      saveDefinition,
      createRun,
    } as unknown as WorkflowStore;
    const completeJson = vi.fn()
      .mockResolvedValueOnce({
        verdict: "context-rot",
        hallucinations: ["invented completion"],
        missedTodos: [],
        promptDeviations: [],
      })
      .mockResolvedValueOnce({ id: "workflow-context", marker: "model-repair" });
    const start = vi.fn();
    const production = new ContextEngineeringProduction(
      { start } as unknown as WorkflowRunController,
      { store, completeJson },
    );
    productions.push(production);

    await expect(production.handleDagFusionCompaction({
      ownerRunId: runId,
      nodeId: "analysis",
      childRunId,
    })).resolves.toBeUndefined();

    expect(saveDefinition).toHaveBeenCalledWith(
      projectId,
      "workflow-context",
      { id: "workflow-context", marker: "model-repair" },
      { expectedRevision: 1 },
    );
    expect(createRun).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(projectId, replacementRunId);
  });
});
