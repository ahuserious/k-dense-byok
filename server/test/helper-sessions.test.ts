import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import {
  createSession,
  disposeProjectSessions,
  getSession,
  readSessionProfileBinding,
  sessionProfileBindingPath,
  sessionProfileMigrationMarkerPath,
} from "../src/agent/session-registry.ts";
import { workflowStore, type WorkflowGraphDocument } from "../src/workflows/index.ts";

const app = await buildApp({ workflowController: null });

function headers(projectId = "default") {
  return { "x-project-id": projectId };
}

function graph(id = "helper-workflow", name = "Helper workflow"): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name,
    entryNodeId: "start",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "ollama",
        model: "qwen3:32b",
        auth: { kind: "local" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 2,
      maxModelCalls: 2,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 4_000,
      maxCostUsd: 0,
      maxRetries: 0,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [{
      id: "start",
      name: "Start",
      kind: "agent",
      terminal: true,
      workspace: { isolation: "read-only", writePaths: [] },
      prompt: "Return one bounded result.",
    }],
    edges: [],
  };
}

function failedRun(requestId: string): string {
  const manifest = workflowStore.createRun("default", {
    workflowId: "helper-workflow",
    requestId,
    requestedBy: "user",
  });
  workflowStore.appendRunEvent("default", manifest.id, {
    eventId: `${requestId}-started`,
    type: "run_started",
  }, 1);
  workflowStore.appendRunEvent("default", manifest.id, {
    eventId: `${requestId}-failed`,
    type: "run_failed",
    data: {
      error: { code: "TEST_FAILURE", message: `Failure for ${requestId}`, retryable: false },
    },
  }, 2);
  return manifest.id;
}

function persistLegacySession(name: string): string {
  const paths = ensureProjectExists("default");
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const manager = SessionManager.create(paths.sandbox, paths.sessionsDir);
  manager.appendSessionInfo(name);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Legacy chat" }],
    timestamp: Date.now(),
  } as never);
  const file = manager.getSessionFile()!;
  fs.writeFileSync(
    file,
    [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return manager.getSessionId();
}

beforeEach(() => {
  disposeProjectSessions("default");
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
  workflowStore.saveDefinition("default", "helper-workflow", graph());
});

afterAll(async () => {
  disposeProjectSessions("default");
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("dedicated helper Pi sessions", () => {
  it("binds Builder to an exact saved revision with no tools, packages, MCP, or sandbox-visible identity", async () => {
    const paths = ensureProjectExists("default");
    const piDir = path.join(paths.sandbox, ".pi");
    const sentinel = path.join(paths.root, "package-resolution-ran");
    const fakeNpm = path.join(paths.root, "fake-npm.mjs");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      fakeNpm,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinel)}, "ran"); process.exit(1);\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({
        npmCommand: [process.execPath, fakeNpm],
        packages: ["npm:must-never-resolve-for-helper"],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(piDir, "mcp.json"),
      JSON.stringify({ malicious: { command: process.execPath, args: [fakeNpm] } }),
      "utf8",
    );

    const first = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: { kind: "workflow", id: "helper-workflow@1" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      profile: "dag-builder",
      source: { kind: "workflow", id: "helper-workflow@1" },
      name: "Kady DAG Builder",
      readOnlyTools: [],
    });
    expect(fs.existsSync(sentinel)).toBe(false);
    const sessionId = first.json().id as string;
    const session = await getSession("default", paths, sessionId);
    expect(session?.getActiveToolNames()).toEqual([]);
    expect(session?.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(session?.resourceLoader.getSkills().skills).toEqual([]);
    disposeProjectSessions("default");
    const coldReopened = await getSession("default", paths, sessionId);
    expect(coldReopened?.getActiveToolNames()).toEqual([]);
    expect(coldReopened?.resourceLoader.getExtensions().extensions).toEqual([]);

    const bindingFile = sessionProfileBindingPath(paths, sessionId);
    expect(bindingFile.startsWith(paths.sandbox)).toBe(false);
    expect(readSessionProfileBinding(paths, sessionId)).toMatchObject({
      profile: "dag-builder",
      source: { kind: "workflow", id: "helper-workflow@1" },
    });
    const escapedRead = await app.inject({
      method: "GET",
      url: `/sandbox/file?path=${encodeURIComponent(`../.kady-session-profiles/${sessionId}.json`)}`,
      headers: headers(),
    });
    expect(escapedRead.statusCode).toBe(403);
    const escapedWrite = await app.inject({
      method: "PUT",
      url: `/sandbox/file?path=${encodeURIComponent(`../.kady-session-profiles/${sessionId}.json`)}`,
      headers: { ...headers(), "content-type": "application/octet-stream" },
      payload: Buffer.from("tamper"),
    });
    expect(escapedWrite.statusCode).toBe(403);

    const same = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: { kind: "workflow", id: "helper-workflow@1" },
    });
    expect(same.json().id).toBe(sessionId);

    workflowStore.saveDefinition(
      "default",
      "helper-workflow",
      graph("helper-workflow", "Revision two"),
      { expectedRevision: 1 },
    );
    const staleRun = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/run`,
      headers: headers(),
      payload: { message: "Review the selected saved revision." },
    });
    expect(staleRun.statusCode).toBe(409);
    expect(staleRun.json()).toMatchObject({ code: "CONFLICT" });
    const nextRevision = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: { kind: "workflow", id: "helper-workflow@2" },
    });
    expect(nextRevision.statusCode).toBe(200);
    expect(nextRevision.json().id).not.toBe(sessionId);

    const ordinarySessions = await app.inject({
      method: "GET",
      url: "/sessions",
      headers: headers(),
    });
    expect(ordinarySessions.json()).toEqual([]);
  });

  it("uses source-scoped Raindrop histories and rejects binding/name tamper on cold reopen", async () => {
    const paths = ensureProjectExists("default");
    const ordinary = await createSession("default", paths);
    ordinary.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Saved ordinary chat" }],
      timestamp: Date.now(),
    } as never);
    fs.writeFileSync(
      ordinary.sessionFile!,
      [ordinary.sessionManager.getHeader(), ...ordinary.sessionManager.getEntries()]
        .map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );
    const runId = workflowStore.createRun("default", {
      workflowId: "helper-workflow",
      requestId: "raindrop-run",
      requestedBy: "user",
    }).id;

    const chatHelper = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop",
      headers: headers(),
      payload: { kind: "session", id: ordinary.sessionId },
    });
    const runHelper = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop",
      headers: headers(),
      payload: { kind: "run", id: runId },
    });
    expect(chatHelper.statusCode).toBe(200);
    expect(runHelper.statusCode).toBe(200);
    expect(runHelper.json().id).not.toBe(chatHelper.json().id);
    expect(chatHelper.json().readOnlyTools).toEqual([]);

    const helperId = chatHelper.json().id as string;
    const helper = await getSession("default", paths, helperId);
    helper!.setSessionName("Mutable display name");
    disposeProjectSessions("default");
    await expect(getSession("default", paths, helperId)).rejects.toMatchObject({
      code: "MISMATCH",
    });

    const runHelperId = runHelper.json().id as string;
    fs.writeFileSync(
      sessionProfileBindingPath(paths, runHelperId),
      JSON.stringify({
        version: 1,
        projectId: "default",
        sessionId: runHelperId,
        profile: "main",
        source: null,
      }),
      "utf8",
    );
    await expect(getSession("default", paths, runHelperId)).rejects.toMatchObject({
      code: "MISMATCH",
    });
  });

  it("isolates Workflow Rescue per failed run and rejects bypass payloads and non-failed state", async () => {
    const firstRunId = failedRun("rescue-one");
    const secondRunId = failedRun("rescue-two");
    const create = (runId: string) => app.inject({
      method: "POST",
      url: "/helper-sessions/workflow-rescue",
      headers: headers(),
      payload: { kind: "run", id: runId },
    });
    const first = await create(firstRunId);
    const sameFirst = await create(firstRunId);
    const second = await create(secondRunId);
    expect(first.statusCode).toBe(200);
    expect(first.json().readOnlyTools).toEqual(["read"]);
    expect(sameFirst.json().id).toBe(first.json().id);
    expect(second.json().id).not.toBe(first.json().id);

    const rescueSession = await getSession(
      "default",
      ensureProjectExists("default"),
      first.json().id as string,
    );
    expect(rescueSession?.getActiveToolNames()).toEqual(["read"]);
    expect(rescueSession?.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(rescueSession?.resourceLoader.getSkills().skills).toEqual([]);
    disposeProjectSessions("default");
    const reopenedRescueSession = await getSession(
      "default",
      ensureProjectExists("default"),
      first.json().id as string,
    );
    expect(reopenedRescueSession?.getActiveToolNames()).toEqual(["read"]);

    const queuedRunId = workflowStore.createRun("default", {
      workflowId: "helper-workflow",
      requestId: "not-stopped",
      requestedBy: "user",
    }).id;
    const queued = await create(queuedRunId);
    expect(queued.statusCode).toBe(409);
    expect(queued.json()).toMatchObject({ code: "CONFLICT" });

    const helperId = first.json().id as string;
    const injected = await app.inject({
      method: "POST",
      url: `/sessions/${helperId}/run`,
      headers: headers(),
      payload: { message: "Diagnose it", context: "client-controlled" },
    });
    expect(injected.statusCode).toBe(400);
    const malformedQuestion = await app.inject({
      method: "POST",
      url: `/sessions/${helperId}/run`,
      headers: headers(),
      payload: { message: { text: "not a string" } },
    });
    expect(malformedQuestion.statusCode).toBe(400);
    const options = await app.inject({
      method: "POST",
      url: `/sessions/${helperId}/run`,
      headers: headers(),
      payload: { message: "Diagnose it", model: "fusion/untrusted", computeTarget: "gpu" },
    });
    expect(options.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      url: `/sessions/${helperId}/run`,
      headers: headers(),
      payload: { message: "x".repeat(16 * 1024 + 1) },
    });
    expect(oversized.statusCode).toBe(413);
    const steer = await app.inject({
      method: "POST",
      url: `/sessions/${helperId}/steer`,
      headers: headers(),
      payload: { message: "bypass" },
    });
    expect(steer.statusCode).toBe(403);
    const notebook = await app.inject({
      method: "GET",
      url: `/sessions/${helperId}/notebook`,
      headers: headers(),
    });
    expect(notebook.statusCode).toBe(403);
  });

  it("migrates legacy ordinary chats once, leaves reserved legacy helpers unbound, and fails closed after marker", async () => {
    const paths = ensureProjectExists("default");
    const legacyMainId = persistLegacySession("Legacy user chat");
    const legacyHelperId = persistLegacySession("Kady DAG Builder");

    const migrated = await getSession("default", paths, legacyMainId);
    expect(migrated).not.toBeNull();
    expect(readSessionProfileBinding(paths, legacyMainId).profile).toBe("main");
    expect(fs.existsSync(sessionProfileMigrationMarkerPath(paths))).toBe(true);
    await expect(getSession("default", paths, legacyHelperId)).rejects.toMatchObject({
      code: "MISSING",
    });

    disposeProjectSessions("default");
    fs.rmSync(sessionProfileBindingPath(paths, legacyMainId));
    await expect(getSession("default", paths, legacyMainId)).rejects.toMatchObject({
      code: "MISSING",
    });
  });
});
