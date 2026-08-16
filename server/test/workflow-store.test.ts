import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import {
  MAX_WORKFLOW_EVENT_LOG_BYTES,
  MAX_WORKFLOW_EVENT_PAGE_SIZE,
  WorkflowDefinitionConflictError,
  WorkflowStore,
  WorkflowStoreError,
  workflowRunFiles,
  type ModelRequest,
  type WorkflowGraphDocument,
  type WorkflowModelResolutionReceipt,
} from "../src/workflows/index.ts";

const PROJECT_ID = "workflow-store-test";

function exactModel(
  provider = "openrouter",
  model = "anthropic/claude-sonnet-4",
): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider,
      model,
      auth: { kind: provider === "ollama" ? "local" : "api-key" },
      reasoning: "high",
    },
    resolution: { mode: "exact" },
  };
}

function workflow(id = "stored-workflow"): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: "Stored workflow",
    entryNodeId: "start",
    defaultModel: exactModel(),
    limits: {
      maxIterations: 10,
      maxModelCalls: 20,
      maxParallelism: 4,
      maxSubagents: 4,
      timeoutMs: 60_000,
      maxTokens: 100_000,
      maxCostUsd: 10,
      maxRetries: 2,
    },
    evidence: {
      enabled: true,
      minimumIndependentSources: 1,
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
        prompt: "Produce a bounded result.",
      },
    ],
    edges: [],
  };
}

function gateWorkflow(id = "stored-gate-workflow"): WorkflowGraphDocument {
  const document = workflow(id);
  document.entryNodeId = "gate";
  document.evidence = {
    enabled: false,
    minimumIndependentSources: 0,
    requireArtifactReferences: false,
    onUnsupportedOutput: "fail",
  };
  document.nodes = [
    {
      id: "gate",
      name: "Gate",
      kind: "evidence-gate",
      terminal: false,
      workspace: { isolation: "read-only", writePaths: [] },
      checks: ["claim-support"],
      artifactIds: [],
      onUnsupportedOutput: "route",
    },
    {
      id: "supported",
      name: "Supported",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Continue after support.",
    },
    {
      id: "unsupported",
      name: "Unsupported",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Continue after unsupported evidence.",
    },
  ];
  document.edges = [
    {
      id: "gate-supported",
      from: "gate",
      to: "supported",
      condition: "evidence-supported",
    },
    {
      id: "gate-unsupported",
      from: "gate",
      to: "unsupported",
      condition: "evidence-unsupported",
    },
  ];
  return document;
}

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

function expectStoreError(action: () => unknown, code: WorkflowStoreError["code"]): void {
  try {
    action();
    throw new Error(`Expected WorkflowStoreError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowStoreError);
    expect((error as WorkflowStoreError).code).toBe(code);
  }
}

/**
 * Asserts a definition conflict and returns the revision the store captured
 * inside its mutation lock, which is the only revision a 409 ETag may use.
 */
function expectDefinitionConflict(
  action: () => unknown,
  expectedCurrentRevision: number | null,
): void {
  let caught: unknown = null;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkflowDefinitionConflictError);
  const conflict = caught as WorkflowDefinitionConflictError;
  expect(conflict.code).toBe("CONFLICT");
  expect(conflict.currentRevision).toBe(expectedCurrentRevision);
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow store race workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function definitionRaceWorker(args: {
  projectId: string;
  workflowId: string;
  graph: WorkflowGraphDocument;
  definitionFile: string;
  readyFile: string;
  renameReadyFile: string;
  peerRenameReadyFile: string;
  barrierFile: string;
}): Promise<string> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "workflows", "store.ts")).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { WorkflowStore } from ${JSON.stringify(moduleUrl)};
    const destination = path.resolve(${JSON.stringify(args.definitionFile)});
    const originalRenameSync = fs.renameSync.bind(fs);
    fs.renameSync = (source, target) => {
      if (path.resolve(String(target)) === destination) {
        fs.writeFileSync(${JSON.stringify(args.renameReadyFile)}, "ready\\n");
        const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 400;
        while (!fs.existsSync(${JSON.stringify(args.peerRenameReadyFile)}) && Date.now() < deadline) {
          Atomics.wait(waitBuffer, 0, 0, 5);
        }
      }
      return originalRenameSync(source, target);
    };
    fs.writeFileSync(${JSON.stringify(args.readyFile)}, "ready\\n");
    while (!fs.existsSync(${JSON.stringify(args.barrierFile)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      const saved = new WorkflowStore().saveDefinition(
        ${JSON.stringify(args.projectId)},
        ${JSON.stringify(args.workflowId)},
        ${JSON.stringify(args.graph)},
        { expectedRevision: 1 },
      );
      process.stdout.write("saved:" + saved.revision);
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
      else reject(new Error(`Workflow definition race worker exited ${String(code)}: ${stderr}`));
    });
  });
}

beforeEach(resetProjects);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("WorkflowStore definitions", () => {
  it("validates, revisions, and lists definitions with compare-and-swap", () => {
    const store = new WorkflowStore();
    const document = workflow();
    const first = store.saveDefinition(PROJECT_ID, document.id, document);
    expect(first.revision).toBe(1);
    expect(first.graph.rescue?.enabled).toBe(true);

    // A stale-identical retry no longer bypasses the precondition: revision 0
    // is evaluated against the revision-1 record before hash equality, so the
    // "response-lost autosave" shortcut is a conflict carrying the locked
    // revision.
    expectDefinitionConflict(
      () => store.saveDefinition(PROJECT_ID, document.id, document, {
        expectedRevision: 0,
      }),
      1,
    );
    expect(store.readDefinition(PROJECT_ID, document.id)).toEqual(first);

    // The trusted facade still repeats an identical setup save as a no-op.
    const retry = store.saveDefinition(PROJECT_ID, document.id, document);
    expect(retry).toEqual(first);

    const changed = structuredClone(document);
    changed.name = "Changed workflow";
    expectStoreError(
      () => store.saveDefinition(PROJECT_ID, document.id, changed),
      "CONFLICT",
    );
    const second = store.saveDefinition(PROJECT_ID, document.id, changed, {
      expectedRevision: 1,
    });
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.readDefinition(PROJECT_ID, document.id)).toEqual(second);
    expect(store.listDefinitions(PROJECT_ID).map((item) => item.id)).toEqual([
      document.id,
    ]);
  });

  it("evaluates the definition intent before hash equality for every outcome", () => {
    const store = new WorkflowStore();
    const document = workflow();
    const changed = structuredClone(document);
    changed.name = "Changed workflow";

    // create + absent -> created at revision 1.
    const created = store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, {
      kind: "create",
    });
    expect(created).toEqual({ outcome: "created", definition: expect.objectContaining({ revision: 1 }) });

    // create + existing, IDENTICAL body -> conflict. An identical hash must not
    // short-circuit the create precondition.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, { kind: "create" }),
      1,
    );
    // create + existing, changed body -> conflict from the same locked read.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, changed, { kind: "create" }),
      1,
    );

    // update + matching revision + identical body -> unchanged, revision held.
    const unchanged = store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, {
      kind: "update",
      expectedRevision: 1,
    });
    expect(unchanged.outcome).toBe("unchanged");
    expect(unchanged.definition.revision).toBe(1);

    // update + stale revision 0 + identical body -> conflict carrying revision 1.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, {
        kind: "update",
        expectedRevision: 0,
      }),
      1,
    );
    // update + stale revision 0 + changed body -> the same conflict.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, changed, {
        kind: "update",
        expectedRevision: 0,
      }),
      1,
    );

    // update + matching revision + changed body -> updated at revision 2.
    const updated = store.saveDefinitionWithIntent(PROJECT_ID, document.id, changed, {
      kind: "update",
      expectedRevision: 1,
    });
    expect(updated.outcome).toBe("updated");
    expect(updated.definition.revision).toBe(2);

    // update against a missing record -> conflict with a null current revision.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, "absent-workflow", workflow("absent-workflow"), {
        kind: "update",
        expectedRevision: 0,
      }),
      null,
    );
    expect(store.readDefinition(PROJECT_ID, "absent-workflow")).toBeNull();
  });

  it("keeps trusted upsert usable for repeated setup without a stale-identical bypass", () => {
    const store = new WorkflowStore();
    const document = workflow("upsert-workflow");
    const changed = structuredClone(document);
    changed.name = "Changed upsert workflow";

    // absent -> create, even without a supplied revision.
    expect(store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, { kind: "upsert" }))
      .toEqual({ outcome: "created", definition: expect.objectContaining({ revision: 1 }) });
    // existing identical -> unchanged.
    expect(
      store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, { kind: "upsert" }).outcome,
    ).toBe("unchanged");
    // existing changed without a revision -> conflict.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, changed, { kind: "upsert" }),
      1,
    );
    // a supplied upsert revision is compared to `current?.revision ?? 0`.
    expectDefinitionConflict(
      () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, changed, {
        kind: "upsert",
        expectedRevision: 0,
      }),
      1,
    );
    expect(
      store.saveDefinitionWithIntent(PROJECT_ID, document.id, changed, {
        kind: "upsert",
        expectedRevision: 1,
      }).outcome,
    ).toBe("updated");
    // absent + revision 0 upsert creates; that is the only creating precondition.
    const absent = workflow("upsert-absent");
    expect(
      store.saveDefinitionWithIntent(PROJECT_ID, absent.id, absent, {
        kind: "upsert",
        expectedRevision: 0,
      }).outcome,
    ).toBe("created");

    // The compatibility facade maps an omitted intent to upsert, never create,
    // and returns the bare StoredWorkflowDefinitionV1 that untouched callers
    // (the production context watcher, executor setup) still consume.
    const facade = store.saveDefinition(PROJECT_ID, absent.id, absent);
    expect(facade.revision).toBe(1);
    expect(facade.storageVersion).toBe(1);
    expect(facade.graphSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("leaves the definition file untouched when an identical update is unchanged", () => {
    const store = new WorkflowStore();
    const document = workflow("unchanged-no-write-workflow");
    expect(
      store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, { kind: "create" }).outcome,
    ).toBe("created");

    // Same location store.ts definitionPath() derives: <definitions>/<id>.json.
    const file = path.join(
      resolvePaths(PROJECT_ID).workflowDefinitionsDir,
      `${document.id}.json`,
    );
    // Backdate the timestamps first so the assertion cannot pass on filesystem
    // timestamp granularity alone: the store writes a temp file and renames it,
    // so any rewrite restamps mtime to now and changes the inode.
    const backdatedSeconds = 1_000_000;
    fs.utimesSync(file, backdatedSeconds, backdatedSeconds);
    const before = fs.statSync(file);
    const beforeBytes = fs.readFileSync(file);

    const unchanged = store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, {
      kind: "update",
      expectedRevision: 1,
    });
    expect(unchanged.outcome).toBe("unchanged");
    expect(unchanged.definition.revision).toBe(1);

    const after = fs.statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(file).equals(beforeBytes)).toBe(true);
  });

  it("rejects a definition precondition that is not a non-negative safe integer", () => {
    const store = new WorkflowStore();
    const document = workflow("bad-precondition-workflow");
    for (const expectedRevision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expectStoreError(
        () => store.saveDefinitionWithIntent(PROJECT_ID, document.id, document, {
          kind: "update",
          expectedRevision,
        }),
        "INVALID_DEFINITION",
      );
    }
    expect(store.readDefinition(PROJECT_ID, document.id)).toBeNull();
  });

  it("serializes definition CAS across independent processes", async () => {
    const store = new WorkflowStore();
    const original = workflow("concurrent-definition");
    store.saveDefinition(PROJECT_ID, original.id, original);
    const paths = resolvePaths(PROJECT_ID);
    const scratch = path.join(PROJECTS_ROOT, "definition-race-signals");
    fs.mkdirSync(scratch, { recursive: true });
    const barrierFile = path.join(scratch, "go");
    const readyFiles = [path.join(scratch, "a.ready"), path.join(scratch, "b.ready")];
    const renameReadyFiles = [
      path.join(scratch, "a.rename-ready"),
      path.join(scratch, "b.rename-ready"),
    ];
    const firstGraph = structuredClone(original);
    firstGraph.name = "Concurrent change A";
    const secondGraph = structuredClone(original);
    secondGraph.name = "Concurrent change B";
    const definitionFile = path.join(paths.workflowDefinitionsDir, `${original.id}.json`);
    const workers = [
      definitionRaceWorker({
        projectId: PROJECT_ID,
        workflowId: original.id,
        graph: firstGraph,
        definitionFile,
        readyFile: readyFiles[0],
        renameReadyFile: renameReadyFiles[0],
        peerRenameReadyFile: renameReadyFiles[1],
        barrierFile,
      }),
      definitionRaceWorker({
        projectId: PROJECT_ID,
        workflowId: original.id,
        graph: secondGraph,
        definitionFile,
        readyFile: readyFiles[1],
        renameReadyFile: renameReadyFiles[1],
        peerRenameReadyFile: renameReadyFiles[0],
        barrierFile,
      }),
    ];
    await waitForFiles(readyFiles);
    fs.writeFileSync(barrierFile, "go\n");

    expect((await Promise.all(workers)).sort()).toEqual(["CONFLICT", "saved:2"]);
    expect(store.readDefinition(PROJECT_ID, original.id)).toMatchObject({
      revision: 2,
      graph: { name: expect.stringMatching(/^Concurrent change [AB]$/) },
    });
    expect(fs.existsSync(path.join(
      paths.workflowDefinitionsDir,
      `.${original.id}.mutation.lock`,
    ))).toBe(false);
  }, 20_000);

  it("rejects mismatched graph ids, path traversal, and unsupported stored versions", () => {
    const store = new WorkflowStore();
    const document = workflow();
    expectStoreError(
      () => store.saveDefinition(PROJECT_ID, "different-workflow", document),
      "INVALID_DEFINITION",
    );
    expectStoreError(
      () => store.saveDefinition(PROJECT_ID, "../escape", document),
      "INVALID_ID",
    );

    store.saveDefinition(PROJECT_ID, document.id, document);
    const file = path.join(
      resolvePaths(PROJECT_ID).workflowDefinitionsDir,
      `${document.id}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    stored.storageVersion = 99;
    fs.writeFileSync(file, JSON.stringify(stored) + "\n", "utf-8");
    expectStoreError(() => store.listDefinitions(PROJECT_ID), "UNSUPPORTED_VERSION");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a workflow state directory symlinked outside the project sandbox",
    () => {
      const store = new WorkflowStore();
      const paths = resolvePaths(PROJECT_ID);
      const outside = path.join(PROJECTS_ROOT, "outside-workflow-state");
      fs.mkdirSync(paths.kadyDir, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, paths.workflowsDir, "dir");
      expectStoreError(
        () => store.saveDefinition(PROJECT_ID, "stored-workflow", workflow()),
        "INVALID_ID",
      );
    },
  );
});

describe("WorkflowStore runs and events", () => {
  it("creates an immutable graph snapshot and makes request creation idempotent", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const input = {
      workflowId: document.id,
      requestId: "request-1",
      requestedBy: "user" as const,
      sessionId: "chat-1",
      input: { goal: "Initial goal", variables: { sample: 7 } },
    };
    const first = store.createRun(PROJECT_ID, input);
    expect(first.workflowRevision).toBe(1);
    expect(fs.existsSync(workflowRunFiles(PROJECT_ID, first.id).manifest)).toBe(true);

    const changed = structuredClone(document);
    changed.name = "Definition changed later";
    store.saveDefinition(PROJECT_ID, document.id, changed, { expectedRevision: 1 });

    const retry = store.createRun(PROJECT_ID, input);
    expect(retry).toEqual(first);
    expect(retry.graph.name).toBe("Stored workflow");
    expectStoreError(
      () => store.createRun(PROJECT_ID, {
        ...input,
        input: { goal: "Different use of the same request id" },
      }),
      "CONFLICT",
    );

    const later = store.createRun(PROJECT_ID, { ...input, requestId: "request-2" });
    expect(later.workflowRevision).toBe(2);
    expect(later.graph.name).toBe("Definition changed later");
  });

  it("persists model receipts and projects dynamic executions by executionId", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "events-request",
      requestedBy: "api",
    });
    const receipt: WorkflowModelResolutionReceipt = {
      request: exactModel(),
      resolved: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        auth: { kind: "api-key" },
        reasoning: "high",
        runtime: "pi",
      },
      fallbackUsed: false,
    };
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "run-started",
      type: "run_started",
    }, 1);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "started-path-a-1",
      type: "node_started",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
    }, 2);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "slot-path-a-1",
      type: "model_call_declared",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: { modelCallSlot: { id: "agent", request: exactModel() } },
    }, 3);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "model-path-a-1",
      type: "model_resolved",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: { modelCallSlotId: "agent", receipt },
    }, 4);
    // Same semantic event is returned without appending, even with the old cursor.
    expect(store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "model-path-a-1",
      type: "model_resolved",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: { modelCallSlotId: "agent", receipt },
    }, 4).seq).toBe(5);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "evidence-slot-path-a-1",
      type: "model_call_declared",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: {
        modelCallSlot: {
          id: "evidence-policy-evaluator",
          request: exactModel(),
        },
      },
    }, 5);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "evidence-model-path-a-1",
      type: "model_resolved",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: {
        modelCallSlotId: "evidence-policy-evaluator",
        receipt,
      },
    }, 6);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "evidence-path-a-1",
      type: "evidence_checked",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: {
        supported: true,
        sourceIds: ["source-001"],
        artifacts: [{ path: "results/report.md", size: 12, sha256: "a".repeat(64) }],
        summary: "The persisted evidence field supports the result.",
      },
    }, 7);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "finished-path-a-1",
      type: "node_succeeded",
      executionId: "path-a-1",
      nodeId: "start",
      attempt: 1,
      branchId: "path-a",
      data: {
        routeCondition: "success",
        output: { evidence: "Persisted supporting source." },
        artifacts: [{ path: "results/report.md", size: 12, sha256: "a".repeat(64) }],
      },
    }, 8);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "run-finished",
      type: "run_succeeded",
    }, 9);

    const run = store.readRun(PROJECT_ID, manifest.id)!;
    expect(run.state.status).toBe("succeeded");
    expect(run.state.executions["path-a-1"]).toMatchObject({
      nodeId: "start",
      branchId: "path-a",
      status: "succeeded",
      modelReceipt: receipt,
      modelCallSlots: {
        agent: { id: "agent", request: exactModel(), receipt },
        "evidence-policy-evaluator": {
          id: "evidence-policy-evaluator",
          request: exactModel(),
          receipt,
        },
      },
    });
    expect(run.state.executions["path-a-1"].artifacts[0].path).toBe(
      "results/report.md",
    );
    const page = store.readRunEvents(PROJECT_ID, manifest.id, { after: 2, limit: 2 });
    expect(page.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(page.hasMore).toBe(true);
    expectStoreError(
      () => store.readRunEvents(PROJECT_ID, manifest.id, {
        limit: MAX_WORKFLOW_EVENT_PAGE_SIZE + 1,
      }),
      "LIMIT_REACHED",
    );
  });

  it("atomically repairs a torn final row and records the repair before appending", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "torn-request",
      requestedBy: "api",
    });
    const files = workflowRunFiles(PROJECT_ID, manifest.id);
    fs.appendFileSync(files.events, '{"schemaVersion":1,"eventId":"torn"');
    expect(store.readRunEvents(PROJECT_ID, manifest.id).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "torn-event-tail", fatal: true })]),
    );

    const appended = store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "after-repair",
      type: "run_started",
    }, 1);
    expect(appended.seq).toBe(3);
    const page = store.readRunEvents(PROJECT_ID, manifest.id);
    expect(page.diagnostics).toEqual([]);
    expect(page.events.map((event) => event.type)).toEqual([
      "run_queued",
      "store_repaired",
      "run_started",
    ]);
    expect(page.events[1].data).toMatchObject({ truncatedBytes: expect.any(Number) });
    expect(store.readRun(PROJECT_ID, manifest.id)!.state.diagnostics).toContainEqual(
      expect.objectContaining({ code: "event-log-repaired", fatal: false }),
    );
  });

  it("fails closed on malformed complete rows and unknown event versions", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const malformed = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "malformed-request",
      requestedBy: "api",
    });
    fs.appendFileSync(workflowRunFiles(PROJECT_ID, malformed.id).events, "{broken}\n");
    expect(store.readRun(PROJECT_ID, malformed.id)!.state.recoverable).toBe(false);
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, malformed.id, {
        eventId: "must-not-append",
        type: "run_started",
      }, 1),
      "CORRUPT",
    );

    const future = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "future-request",
      requestedBy: "api",
    });
    fs.appendFileSync(
      workflowRunFiles(PROJECT_ID, future.id).events,
      JSON.stringify({
        schemaVersion: 99,
        runId: future.id,
        eventId: "future-event",
        seq: 2,
        ts: Date.now(),
        type: "run_started",
      }) + "\n",
    );
    expect(store.readRun(PROJECT_ID, future.id)!.state.recoverable).toBe(false);
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, future.id, {
        eventId: "must-not-cross-version",
        type: "run_started",
      }, 1),
      "UNSUPPORTED_VERSION",
    );
  });

  it("rejects internal events, unknown graph nodes, and appends after termination", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "event-invariant-request",
      requestedBy: "api",
    });

    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "caller-repair",
        type: "store_repaired",
      } as never, 1),
      "CORRUPT",
    );
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "unknown-node",
        type: "node_started",
        executionId: "unknown-node-attempt",
        nodeId: "not-in-snapshot",
        attempt: 1,
        branchId: "entry",
      }, 1),
      "CONFLICT",
    );

    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "run-started",
      type: "run_started",
    }, 1);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-started",
      type: "node_started",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
    }, 2);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-model-slot",
      type: "model_call_declared",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: { modelCallSlot: { id: "agent", request: exactModel() } },
    }, 3);
    const receipt: WorkflowModelResolutionReceipt = {
      request: exactModel(),
      resolved: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        auth: { kind: "api-key" },
        reasoning: "high",
        runtime: "pi",
      },
      fallbackUsed: false,
    };
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-model-receipt",
      type: "model_resolved",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: { modelCallSlotId: "agent", receipt },
    }, 4);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-evidence-slot",
      type: "model_call_declared",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: {
        modelCallSlot: {
          id: "evidence-policy-evaluator",
          request: exactModel(),
        },
      },
    }, 5);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-evidence-receipt",
      type: "model_resolved",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: {
        modelCallSlotId: "evidence-policy-evaluator",
        receipt,
      },
    }, 6);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-evidence-decision",
      type: "evidence_checked",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: {
        supported: true,
        sourceIds: ["source-001"],
        artifacts: [],
        summary: "The persisted evidence field supports the result.",
      },
    }, 7);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-succeeded",
      type: "node_succeeded",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
      data: {
        routeCondition: "success",
        output: { evidence: "Persisted supporting source." },
      },
    }, 8);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "terminal",
      type: "run_succeeded",
    }, 9);
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "reopen",
        type: "run_started",
      }, 10),
      "CONFLICT",
    );
  });

  it("rejects torn, duplicate, and route-mismatched gate decisions before persistence", () => {
    const store = new WorkflowStore();
    const document = gateWorkflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "gate-event-invariants",
      requestedBy: "api",
    });
    const receipt: WorkflowModelResolutionReceipt = {
      request: exactModel(),
      resolved: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        auth: { kind: "api-key" },
        reasoning: "high",
        runtime: "pi",
      },
      fallbackUsed: false,
    };
    const identity = {
      executionId: "gate-attempt-1",
      nodeId: "gate",
      attempt: 1,
      branchId: "entry",
    } as const;

    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "gate-run-started",
      type: "run_started",
    }, 1);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "gate-node-started",
      type: "node_started",
      ...identity,
    }, 2);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "gate-model-slot",
      type: "model_call_declared",
      ...identity,
      data: {
        modelCallSlot: { id: "evidence-evaluator", request: exactModel() },
      },
    }, 3);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "gate-model-receipt",
      type: "model_resolved",
      ...identity,
      data: { modelCallSlotId: "evidence-evaluator", receipt },
    }, 4);
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "torn-gate-decision",
        type: "gate_evaluated",
        ...identity,
        data: { supported: true, summary: "Missing receipt arrays." },
      }, 5),
      "CONFLICT",
    );
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "forged-gate-source",
        type: "gate_evaluated",
        ...identity,
        data: {
          supported: true,
          sourceIds: ["source-001"],
          artifacts: [],
          summary: "No inbound observed output owns this source id.",
        },
      }, 5),
      "CONFLICT",
    );
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "gate-decision",
      type: "gate_evaluated",
      ...identity,
      data: {
        supported: true,
        sourceIds: [],
        artifacts: [],
        summary: "Bounded support decision.",
      },
    }, 5);
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "duplicate-gate-decision",
        type: "gate_evaluated",
        ...identity,
        data: {
          supported: true,
          sourceIds: [],
          artifacts: [],
          summary: "Duplicate decision.",
        },
      }, 6),
      "CONFLICT",
    );
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "mismatched-gate-route",
        type: "node_succeeded",
        ...identity,
        data: { routeCondition: "evidence-unsupported" },
      }, 6),
      "CONFLICT",
    );
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 20 }).events).toHaveLength(6);
    expect(store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "matching-gate-route",
      type: "node_succeeded",
      ...identity,
      data: { routeCondition: "evidence-supported" },
    }, 6).seq).toBe(7);

    const unsupported = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "gate-unsupported-without-decision",
      requestedBy: "api",
    });
    store.appendRunEvent(PROJECT_ID, unsupported.id, {
      eventId: "unsupported-run-started",
      type: "run_started",
    }, 1);
    store.appendRunEvent(PROJECT_ID, unsupported.id, {
      eventId: "unsupported-node-started",
      type: "node_started",
      ...identity,
    }, 2);
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, unsupported.id, {
        eventId: "unsupported-without-decision",
        type: "node_failed",
        ...identity,
        data: {
          error: {
            code: "EVIDENCE_UNSUPPORTED",
            message: "No durable decision exists.",
            retryable: false,
          },
          routeCondition: "failure",
        },
      }, 3),
      "CONFLICT",
    );
  });

  it("reconciles ambiguous running work to interrupted exactly once", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "restart-request",
      requestedBy: "agent",
    });
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "run-started",
      type: "run_started",
    }, 1);
    store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "node-started",
      type: "node_started",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
    }, 2);

    expect(store.reconcileInterruptedRuns(PROJECT_ID)).toEqual({
      interrupted: [manifest.id],
      active: [],
      errors: [],
    });
    expect(store.reconcileInterruptedRuns(PROJECT_ID)).toEqual({
      interrupted: [],
      active: [],
      errors: [],
    });
    const recovered = store.readRun(PROJECT_ID, manifest.id)!;
    expect(recovered.state.status).toBe("interrupted");
    expect(recovered.state.lastSeq).toBe(4);
    expect(recovered.state.executions["start-attempt-1"].status).toBe("interrupted");
    expect(recovered.state.lastError).toMatchObject({
      code: "SERVER_RESTART",
      retryable: true,
    });
  });

  it("serializes cross-process leases and fences stale owners on every append", () => {
    let now = 1_000;
    const firstStore = new WorkflowStore({
      now: () => now,
      randomOwnerToken: () => "a".repeat(64),
      defaultLeaseDurationMs: 1_000,
    });
    const secondStore = new WorkflowStore({
      now: () => now,
      randomOwnerToken: () => "b".repeat(64),
      defaultLeaseDurationMs: 1_000,
    });
    const document = workflow();
    firstStore.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = firstStore.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "lease-race-request",
      requestedBy: "api",
    });

    const firstLease = firstStore.acquireRunLease(PROJECT_ID, manifest.id);
    expectStoreError(
      () => secondStore.acquireRunLease(PROJECT_ID, manifest.id),
      "CONFLICT",
    );
    expectStoreError(
      () => secondStore.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "unfenced-start",
        type: "run_started",
      }, 1),
      "CONFLICT",
    );
    firstStore.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "leased-start",
      type: "run_started",
    }, 1, firstLease);
    expect(secondStore.reconcileInterruptedRuns(PROJECT_ID)).toEqual({
      interrupted: [],
      active: [manifest.id],
      errors: [],
    });

    now += 1_001;
    const secondLease = secondStore.acquireRunLease(PROJECT_ID, manifest.id);
    expect(secondLease.fence).toBe(firstLease.fence + 1);
    expectStoreError(
      () => firstStore.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "stale-owner-node",
        type: "node_started",
        executionId: "start-attempt-1",
        nodeId: "start",
        attempt: 1,
        branchId: "entry",
      }, 2, firstLease),
      "CONFLICT",
    );
    secondStore.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "new-owner-node",
      type: "node_started",
      executionId: "start-attempt-1",
      nodeId: "start",
      attempt: 1,
      branchId: "entry",
    }, 2, secondLease);
    secondStore.releaseRunLease(PROJECT_ID, secondLease);
    expect(secondStore.reconcileInterruptedRuns(PROJECT_ID)).toEqual({
      interrupted: [manifest.id],
      active: [],
      errors: [],
    });
  });

  it("does not steal an aged run mutation lock from a living owner and recovers a dead owner", () => {
    const store = new WorkflowStore();
    const document = workflow("mutation-lock-workflow");
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "mutation-lock-request",
      requestedBy: "api",
    });
    const lockFile = workflowRunFiles(PROJECT_ID, manifest.id).mutationLock;
    const old = Date.now() - 5 * 60_000;
    const livingOwner = {
      version: 1,
      token: "c".repeat(64),
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: old,
    };
    fs.writeFileSync(lockFile, `${JSON.stringify(livingOwner)}\n`);

    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "must-not-steal-live-lock",
        type: "run_started",
      }, 1),
      "CONFLICT",
    );
    expect(JSON.parse(fs.readFileSync(lockFile, "utf-8"))).toEqual(livingOwner);

    fs.unlinkSync(lockFile);
    const deadOwner = {
      version: 1,
      token: "d".repeat(64),
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: old,
    };
    fs.writeFileSync(lockFile, `${JSON.stringify(deadOwner)}\n`);
    expect(store.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "after-dead-lock-recovery",
      type: "run_started",
    }, 1).seq).toBe(2);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.existsSync(`${lockFile}.recovery`)).toBe(false);
  });

  it("persists idempotent cancellation intent that fences a live remote owner", () => {
    let now = 2_000;
    const ownerStore = new WorkflowStore({
      now: () => now,
      randomOwnerToken: () => "c".repeat(64),
      defaultLeaseDurationMs: 10_000,
    });
    const cancellingStore = new WorkflowStore({ now: () => now });
    const document = workflow("cancel-intent-workflow");
    ownerStore.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = ownerStore.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "cancel-intent-request",
      requestedBy: "api",
    });
    const lease = ownerStore.acquireRunLease(PROJECT_ID, manifest.id);
    ownerStore.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "cancel-intent-start",
      type: "run_started",
    }, 1, lease);

    expect(cancellingStore.requestRunCancellation(PROJECT_ID, manifest.id).state.status)
      .toBe("running");
    const firstIntent = cancellingStore.readRunCancellationIntent(PROJECT_ID, manifest.id);
    now += 100;
    expect(cancellingStore.requestRunCancellation(PROJECT_ID, manifest.id).state.status)
      .toBe("running");
    expect(cancellingStore.readRunCancellationIntent(PROJECT_ID, manifest.id))
      .toEqual(firstIntent);

    expectStoreError(
      () => ownerStore.appendRunEvent(PROJECT_ID, manifest.id, {
        eventId: "owner-continued-after-cancel",
        type: "node_started",
        executionId: "start-attempt-1",
        nodeId: "start",
        attempt: 1,
        branchId: "entry",
      }, 2, lease),
      "CANCEL_REQUESTED",
    );
    ownerStore.appendRunEvent(PROJECT_ID, manifest.id, {
      eventId: "owner-observed-cancel",
      type: "run_cancelled",
      data: {
        error: {
          code: "USER_CANCELLED",
          message: "Workflow execution was cancelled by the user.",
          retryable: false,
        },
      },
    }, 2, lease);
    expect(ownerStore.readRun(PROJECT_ID, manifest.id)!.state.status).toBe("cancelled");
    ownerStore.releaseRunLease(PROJECT_ID, lease);
  });

  it("cancels an unowned queued run immediately and idempotently", () => {
    const store = new WorkflowStore();
    const document = workflow("queued-cancel-workflow");
    store.saveDefinition(PROJECT_ID, document.id, document);
    const manifest = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "queued-cancel-request",
      requestedBy: "user",
    });

    expect(store.requestRunCancellation(PROJECT_ID, manifest.id).state.status)
      .toBe("cancelled");
    expect(store.requestRunCancellation(PROJECT_ID, manifest.id).state.status)
      .toBe("cancelled");
    expect(store.readRunEvents(PROJECT_ID, manifest.id, { limit: 20 }).events.filter(
      (event) => event.type === "run_cancelled",
    )).toHaveLength(1);
  });

  it("rejects oversized event rows and event-log files without trimming history", () => {
    const store = new WorkflowStore();
    const document = workflow();
    store.saveDefinition(PROJECT_ID, document.id, document);
    const oversized = store.createRun(PROJECT_ID, {
      workflowId: document.id,
      requestId: "oversized-event",
      requestedBy: "api",
    });
    expectStoreError(
      () => store.appendRunEvent(PROJECT_ID, oversized.id, {
        eventId: "large-event",
        type: "run_started",
        data: { preview: "x".repeat(70 * 1024) },
      }, 1),
      "TOO_LARGE",
    );

    fs.truncateSync(
      workflowRunFiles(PROJECT_ID, oversized.id).events,
      MAX_WORKFLOW_EVENT_LOG_BYTES + 1,
    );
    expectStoreError(
      () => store.readRunEvents(PROJECT_ID, oversized.id),
      "TOO_LARGE",
    );
  });
});
