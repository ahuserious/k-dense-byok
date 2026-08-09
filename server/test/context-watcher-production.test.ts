import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { ensureProjectExists } from "../src/projects.ts";
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

describe("ContextEngineeringProduction stopped-run source", () => {
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
});
