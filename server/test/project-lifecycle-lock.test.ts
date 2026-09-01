import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  ProjectLifecycleLockError,
  withProjectLifecycleLock,
} from "../src/project-lifecycle-lock.ts";
import {
  WorkflowStore,
  WorkflowStoreError,
  type WorkflowGraphDocument,
} from "../src/workflows/index.ts";

const PROJECT_ID = "lifecycle-lock-test";
const LOCK_DIRECTORY = path.join(PROJECTS_ROOT, ".locks", "project-lifecycle");
const LOCK_FILE = path.join(LOCK_DIRECTORY, `${PROJECT_ID}.lock`);

function workflow(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "locked-workflow",
    name: "Locked workflow",
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

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function writeLock(value: unknown): void {
  fs.mkdirSync(LOCK_DIRECTORY, { recursive: true });
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

beforeEach(resetProjects);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("project lifecycle lock", () => {
  it("blocks a second WorkflowStore instance from creating a run until the holder releases", () => {
    const store = new WorkflowStore({
      projectLifecycleLock: { waitMs: 20, staleMs: 1_000 },
    });
    store.saveDefinition(PROJECT_ID, "locked-workflow", workflow());

    withProjectLifecycleLock(PROJECT_ID, () => {
      expect(() => store.createRun(PROJECT_ID, {
        workflowId: "locked-workflow",
        requestId: "blocked-request",
        requestedBy: "user",
      })).toThrowError(expect.objectContaining<Partial<WorkflowStoreError>>({
        code: "CONFLICT",
      }));
      expect(store.listRuns(PROJECT_ID)).toHaveLength(0);
    });

    const created = store.createRun(PROJECT_ID, {
      workflowId: "locked-workflow",
      requestId: "released-request",
      requestedBy: "user",
    });
    expect(store.readRun(PROJECT_ID, created.id)?.state.status).toBe("queued");
  });

  it("recovers only a fenced, stale lock whose local owner is dead", () => {
    writeLock({
      version: 1,
      token: "a".repeat(64),
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: 0,
    });

    let entered = false;
    withProjectLifecycleLock(
      PROJECT_ID,
      () => { entered = true; },
      { waitMs: 50, staleMs: 1_000 },
    );

    expect(entered).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
    expect(fs.existsSync(`${LOCK_FILE}.recovery`)).toBe(false);
  });

  it("fails closed for stale locks owned on another host", () => {
    writeLock({
      version: 1,
      token: "b".repeat(64),
      pid: 999_999,
      hostname: `${os.hostname()}-remote`,
      createdAt: 0,
    });

    expect(() => withProjectLifecycleLock(
      PROJECT_ID,
      () => undefined,
      { waitMs: 20, staleMs: 1_000 },
    )).toThrowError(expect.objectContaining<Partial<ProjectLifecycleLockError>>({
      code: "CONFLICT",
    }));
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
  });

  it("fails closed instead of stealing malformed ownership metadata", () => {
    writeLock({ version: 1, token: "not-a-token" });

    expect(() => withProjectLifecycleLock(
      PROJECT_ID,
      () => undefined,
      { waitMs: 20, staleMs: 1_000 },
    )).toThrowError(expect.objectContaining<Partial<ProjectLifecycleLockError>>({
      code: "CORRUPT",
    }));
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
  });
});
