import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { MAX_RAINDROP_CONTEXT_BYTES } from "../src/agent/raindrop-context.ts";
import {
  createSession,
  disposeProjectSessions,
  PROFILE_SYSTEM_PROMPTS,
  readSessionProfileBinding,
} from "../src/agent/session-registry.ts";
import { findSessionFile } from "../src/agent/session-export.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import type { WorkflowGraphDocument } from "../src/workflows/schema.ts";
import { workflowStore } from "../src/workflows/store.ts";

const app = await buildApp({ workflowController: null });

function headers(projectId = "default") {
  return { "x-project-id": projectId };
}

function graph(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "raindrop-workflow",
    name: "Raindrop workflow",
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

function compoundGraph(): WorkflowGraphDocument {
  const document = graph();
  document.limits.maxModelCalls = 4;
  document.id = "builder-compound";
  document.name = "Compound Builder workflow";
  document.entryNodeId = "fusion";
  document.nodes = [{
    id: "fusion",
    name: "Private model council",
    kind: "fusion",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    goal: "Synthesize two private analyses.",
    fusion: {
      mode: "kady-panel",
      members: [{
        id: "local-scientist",
        role: "independent scientist",
        model: {
          requested: {
            source: "fixed",
            provider: "ollama",
            model: "deepseek-r1:32b",
            auth: { kind: "local" },
            reasoning: "high",
          },
          resolution: { mode: "exact" },
        },
      }, {
        id: "local-reviewer",
        role: "independent reviewer",
        model: structuredClone(document.defaultModel!),
      }],
      synthesizer: structuredClone(document.defaultModel!),
      rounds: 1,
    },
    preserveMinorityReports: true,
  }];
  return document;
}

async function persistOrdinaryChat(
  projectId = "default",
  extraMessageCount = 0,
): Promise<string> {
  const paths = ensureProjectExists(projectId);
  const session = await createSession(projectId, paths);
  session.sessionManager.appendSessionInfo("Resumed default chat");
  session.sessionManager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "Investigate the stopped analysis." },
      { type: "image", data: "private-base64-payload", mimeType: "image/png" },
    ],
    timestamp: 1_000,
  } as never);

  for (let index = 0; index < extraMessageCount; index += 1) {
    session.sessionManager.appendMessage({
      role: "user",
      content: [{
        type: "text",
        text: `bounded-message-${index}:${"x".repeat(5_000)}`,
      }],
      timestamp: 3_000 + index,
    } as never);
  }
  session.sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Check the first failed tool call." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "results/report.txt", apiKey: "sk-super-secret-value-123456789" } },
      { type: "text", text: "The report was unavailable after the read failed." },
    ],
    stopReason: "toolUse",
    timestamp: 2_000,
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as never);
  session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "read",
    content: [{ type: "text", text: "ENOENT: results/report.txt" }],
    isError: true,
    timestamp: 2_100,
  } as never);

  const sessionFile = session.sessionManager.getSessionFile() ??
    path.join(paths.sessionsDir, `${session.sessionId}.jsonl`);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return session.sessionId;
}

beforeEach(() => {
  disposeProjectSessions("default");
  disposeProjectSessions("other-project");
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
});

afterAll(async () => {
  disposeProjectSessions("default");
  disposeProjectSessions("other-project");
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("Raindrop bounded log context", () => {
  it("projects exact compound Builder revisions and redacts adversarial Rescue fields", async () => {
    workflowStore.saveDefinition("default", "builder-compound", compoundGraph());
    const builder = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound@1" },
    });
    expect(builder.statusCode).toBe(200);
    expect(builder.json()).toMatchObject({
      source: { kind: "workflow", id: "builder-compound@1" },
      truncated: false,
    });
    const builderProjection = builder.json().context as string;
    expect(Buffer.byteLength(builderProjection, "utf8")).toBeLessThanOrEqual(MAX_RAINDROP_CONTEXT_BYTES);
    expect(builderProjection).toContain('"mode": "kady-panel"');
    expect(builderProjection).toContain('"model": "deepseek-r1:32b"');
    expect(builderProjection).toContain('"reasoning": "high"');
    expect(builderProjection).toContain('"auth": {');
    expect(builderProjection).toContain('"kind": "local"');
    expect(builderProjection).not.toContain("[nested value omitted]");

    workflowStore.saveDefinition(
      "default",
      "builder-compound",
      { ...compoundGraph(), name: "Revision two" },
      { expectedRevision: 1 },
    );
    const stale = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound@1" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CONFLICT" });

    const manifest = workflowStore.createRun("default", {
      workflowId: "builder-compound",
      requestId: "rescue-secret-redaction",
      requestedBy: "user",
      input: {
        variables: {
          OPENROUTER_API_KEY: "plain-openrouter-sensitive-value",
          db_password: "plain-database-sensitive-value",
          github_token: "plain-github-sensitive-value",
          client_secret: "plain-client-sensitive-value",
          authorization_header: "plain-authorization-sensitive-value",
          clientSecret: "plain-camel-secret-value",
          accessToken: "plain-access-token-value",
          refreshToken: "plain-refresh-token-value",
          authorizationHeader: "plain-camel-authorization-value",
          passwordHash: "plain-password-hash-value",
          githubToken: "plain-camel-github-token-value",
          privateKey: "plain-private-key-value",
          private_key: "plain-snake-private-key-value",
          serviceCredential: "plain-credential-value",
          tokenCount: 17,
        },
      },
    });
    workflowStore.appendRunEvent("default", manifest.id, {
      eventId: "redaction-started",
      type: "run_started",
    }, 1);
    workflowStore.appendRunEvent("default", manifest.id, {
      eventId: "redaction-failed",
      type: "run_failed",
      data: {
        error: { code: "PRIVATE_FAILURE", message: "Stopped safely", retryable: false },
      },
    }, 2);
    const rescue = await app.inject({
      method: "POST",
      url: "/helper-sessions/workflow-rescue/context",
      headers: headers(),
      payload: { kind: "run", id: manifest.id },
    });
    expect(rescue.statusCode).toBe(200);
    const rescueProjection = rescue.json().context as string;
    expect(rescueProjection).toContain('"tokenCount": 17');
    expect(rescueProjection).toContain("[redacted]");
    for (const sensitive of [
      "plain-openrouter-sensitive-value",
      "plain-database-sensitive-value",
      "plain-github-sensitive-value",
      "plain-client-sensitive-value",
      "plain-authorization-sensitive-value",
      "plain-camel-secret-value",
      "plain-access-token-value",
      "plain-refresh-token-value",
      "plain-camel-authorization-value",
      "plain-password-hash-value",
      "plain-camel-github-token-value",
      "plain-private-key-value",
      "plain-snake-private-key-value",
      "plain-credential-value",
    ]) {
      expect(rescueProjection).not.toContain(sensitive);
    }
    const pathInput = await app.inject({
      method: "POST",
      url: "/helper-sessions/workflow-rescue/context",
      headers: headers(),
      payload: { kind: "run", id: manifest.id, path: "/tmp/foreign.jsonl" },
    });
    expect(pathInput.statusCode).toBe(400);

    const cancelled = workflowStore.createRun("default", {
      workflowId: "builder-compound",
      requestId: "rescue-cancelled-rejected",
      requestedBy: "user",
    });
    expect(workflowStore.requestRunCancellation("default", cancelled.id).state.status)
      .toBe("cancelled");
    const rejectedCancelled = await app.inject({
      method: "POST",
      url: "/helper-sessions/workflow-rescue/context",
      headers: headers(),
      payload: { kind: "run", id: cancelled.id },
    });
    expect(rejectedCancelled.statusCode).toBe(409);
  });

  it("projects an ordinary resumed chat by id without binary data, secrets, or path input", async () => {
    const sessionId = await persistOrdinaryChat();
    const paths = ensureProjectExists("default");
    fs.writeFileSync(
      path.join(paths.sessionsDir, `000-decoy-${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "session", id: "decoy-session", cwd: paths.sandbox }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "DECOY_SUFFIX_SESSION_PAYLOAD" }],
          },
        }),
      ].join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    const response = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: sessionId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      source: { kind: "session", id: sessionId },
      truncated: false,
      totalEntries: 2,
    });
    const context = response.json().context as string;
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(MAX_RAINDROP_CONTEXT_BYTES);
    expect(context).toContain("Resumed default chat");
    expect(context).toContain("Investigate the stopped analysis.");
    expect(context).toContain("ENOENT: results/report.txt");
    expect(context).toContain("[redacted]");
    expect(context).not.toContain("private-base64-payload");
    expect(context).not.toContain("sk-super-secret-value");
    expect(context).not.toContain("DECOY_SUFFIX_SESSION_PAYLOAD");

    const historyResponse = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/history`,
      headers: headers(),
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(JSON.stringify(historyResponse.json())).toContain("Investigate the stopped analysis.");
    expect(JSON.stringify(historyResponse.json())).not.toContain("DECOY_SUFFIX_SESSION_PAYLOAD");

    const exportResponse = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/export?format=md`,
      headers: headers(),
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.body).toContain("Investigate the stopped analysis.");
    expect(exportResponse.body).not.toContain("DECOY_SUFFIX_SESSION_PAYLOAD");

    const traversal = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: "../outside" },
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json()).toMatchObject({ code: "INVALID_REFERENCE" });

    const pathInput = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: sessionId, path: "/tmp/outside.jsonl" },
    });
    expect(pathInput.statusCode).toBe(400);
    expect(pathInput.json()).toMatchObject({ code: "INVALID_REFERENCE" });
  });

  it("rejects symlinked session logs and truncates large projections", async () => {
    const paths = ensureProjectExists("default");
    const symlinkedSessionId = await persistOrdinaryChat();
    const sessionFile = findSessionFile(paths, symlinkedSessionId);
    expect(sessionFile).not.toBeNull();
    const outsideLog = path.join(PROJECTS_ROOT, "outside-session.jsonl");
    fs.copyFileSync(sessionFile!, outsideLog);
    fs.unlinkSync(sessionFile!);
    fs.symlinkSync(outsideLog, sessionFile!);

    const symlinked = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: symlinkedSessionId },
    });
    expect(symlinked.statusCode).toBe(404);

    disposeProjectSessions("default");
    fs.unlinkSync(sessionFile!);
    const largeSessionId = await persistOrdinaryChat("default", 160);
    const large = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: largeSessionId },
    });
    expect(large.statusCode).toBe(200);
    expect(large.json()).toMatchObject({
      source: { kind: "session", id: largeSessionId },
      truncated: true,
      observedEntries: 120,
      totalEntries: 162,
    });
    expect(Buffer.byteLength(large.json().context, "utf8"))
      .toBeLessThanOrEqual(MAX_RAINDROP_CONTEXT_BYTES);
  });

  it("projects only a current-project native DAG run and rejects helper or foreign ids", async () => {
    const savedRaindropWorkflow = await app.inject({
      method: "PUT",
      url: "/dag-workflows/raindrop-workflow",
      headers: { ...headers(), "if-none-match": "*" },
      payload: graph(),
    });
    expect(savedRaindropWorkflow.statusCode).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/dag-workflows/raindrop-workflow/runs",
      headers: headers(),
      payload: { requestId: "raindrop-context-run" },
    });
    const runId = created.json().manifest.id as string;
    const context = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "run", id: runId },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      source: { kind: "run", id: runId },
      observedEntries: 1,
      totalEntries: 1,
    });
    expect(context.json().context).toContain('"type": "run_queued"');
    expect(context.json().context).toContain('"status": "queued"');

    const helper = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: { kind: "workflow", id: "raindrop-workflow@1" },
    });
    const helperContext = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: helper.json().id },
    });
    expect(helperContext.statusCode).toBe(404);

    ensureProjectExists("other-project");
    const foreignSessionId = await persistOrdinaryChat("other-project");
    const foreign = await app.inject({
      method: "POST",
      url: "/helper-sessions/raindrop/context",
      headers: headers(),
      payload: { kind: "session", id: foreignSessionId },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("opens a DAG Builder session on a project with no saved workflow and says so", async () => {
    const noWorkflows = await app.inject({
      method: "GET",
      url: "/dag-workflows",
      headers: headers(),
    });
    expect(noWorkflows.statusCode).toBe(200);
    expect(noWorkflows.json().workflows).toEqual([]);

    // The first-run case: nothing to point at, because the user opened the chat
    // precisely to build their first workflow.
    const context = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: {},
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      source: null,
      truncated: false,
      observedEntries: 0,
      totalEntries: 0,
    });
    const projection = context.json().context as string;
    expect(Buffer.byteLength(projection, "utf8")).toBeLessThanOrEqual(MAX_RAINDROP_CONTEXT_BYTES);
    // The absence has to be stated, not implied by an omitted key.
    expect(projection).toContain("KADY_DAG_BUILDER_NO_WORKFLOW_CONTEXT_V1");
    expect(projection).toContain("source=none");
    expect(projection).toContain("No saved workflow revision is bound to this helper session");
    expect(projection).toContain("An absent workflow is not an empty workflow");
    expect(projection).toContain('"savedWorkflowCount": 0');
    expect(projection).toContain('"savedWorkflows": []');
    // No fabricated empty workflow: the graph keys must be absent entirely.
    expect(projection).not.toContain('"definition"');
    expect(projection).not.toContain('"nodes"');
    expect(projection).not.toContain('"edges"');
    expect(projection).not.toContain('"entryNodeId"');

    const session = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: {},
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      profile: "dag-builder",
      source: null,
      name: "Kady DAG Builder",
      readOnlyTools: [],
    });
    const sessionId = session.json().id as string;
    expect(readSessionProfileBinding(ensureProjectExists("default"), sessionId))
      .toMatchObject({ profile: "dag-builder", source: null });

    // The pointer-free session is one session, not a new one per request.
    const reopened = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: {},
    });
    expect(reopened.json().id).toBe(sessionId);

    // Every other helper profile still requires its exact typed pointer.
    for (const profile of ["raindrop", "workflow-rescue"]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/helper-sessions/${profile}/context`,
        headers: headers(),
        payload: {},
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ code: "INVALID_REFERENCE" });
    }
  });

  it("keeps a pointed DAG Builder session bound to its exact saved revision", async () => {
    workflowStore.saveDefinition("default", "builder-compound", compoundGraph());
    const context = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound@1" },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      source: { kind: "workflow", id: "builder-compound@1" },
      truncated: false,
      observedEntries: 1,
      totalEntries: 1,
    });
    const projection = context.json().context as string;
    expect(projection).toContain("KADY_DAG_BUILDER_CONTEXT_V1");
    expect(projection).toContain("source.id=builder-compound@1");
    expect(projection).toContain('"mode": "kady-panel"');
    expect(projection).not.toContain("KADY_DAG_BUILDER_NO_WORKFLOW_CONTEXT_V1");

    const pointed = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound@1" },
    });
    expect(pointed.statusCode).toBe(200);
    expect(pointed.json()).toMatchObject({
      source: { kind: "workflow", id: "builder-compound@1" },
    });

    // A pointer-free session is a DIFFERENT session from a pointed one, and it
    // lists what the project has without disclosing any graph contents.
    const pointerFree = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder",
      headers: headers(),
      payload: {},
    });
    expect(pointerFree.statusCode).toBe(200);
    expect(pointerFree.json().id).not.toBe(pointed.json().id);
    const listing = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: {},
    });
    expect(listing.json()).toMatchObject({ observedEntries: 1, totalEntries: 1 });
    expect(listing.json().context).toContain('"id": "builder-compound"');
    expect(listing.json().context).toContain('"revision": 1');
    expect(listing.json().context).not.toContain('"mode": "kady-panel"');

    // A stale pointer is still a conflict, and a bad one is still a 400.
    workflowStore.saveDefinition(
      "default",
      "builder-compound",
      { ...compoundGraph(), name: "Revision two" },
      { expectedRevision: 1 },
    );
    const stale = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound@1" },
    });
    expect(stale.statusCode).toBe(409);
    const malformed = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound" },
    });
    expect(malformed.statusCode).toBe(400);
    const pathInput = await app.inject({
      method: "POST",
      url: "/helper-sessions/dag-builder/context",
      headers: headers(),
      payload: { kind: "workflow", id: "builder-compound@2", path: "/tmp/foreign.yaml" },
    });
    expect(pathInput.statusCode).toBe(400);
  });

  it("promises no canvas apply in the DAG Builder prompt but still specifies the graph shape", () => {
    const prompt = PROFILE_SYSTEM_PROMPTS["dag-builder"];
    // Lane W3 owns the Builder apply bridge and it is not merged, so the model
    // must not be told to hand changes over for the canvas to apply.
    expect(prompt).not.toMatch(/\bappl(y|ies|ied)\b/i);
    expect(prompt).not.toMatch(/\bvisual\b/i);
    expect(prompt).not.toContain("Return proposed changes for the visual Builder");
    expect(prompt).toContain("nothing you produce reaches it by");
    expect(prompt).toContain("the user copies or saves for themselves");

    // Honest is not the same as useless: the prompt must still pin the exact
    // WorkflowGraphDocument shape from server/src/workflows/schema.ts.
    expect(prompt).toContain("WorkflowGraphDocument");
    expect(prompt).toContain("server/src/workflows/schema.ts");
    for (const requiredField of [
      "schemaVersion",
      "entryNodeId",
      "maxIterations",
      "maxCostUsd",
      "minimumIndependentSources",
      "onUnsupportedOutput",
      "terminal",
      "workspace",
    ]) {
      expect(prompt).toContain(requiredField);
    }
    for (const nodeKind of [
      "agent",
      "research-until-goal",
      "council",
      "fusion",
      "best-of-n",
      "prompt-optimization",
      "evidence-gate",
      "lean4",
    ]) {
      expect(prompt).toContain(nodeKind);
    }
    // Both context envelopes must be named so the model can tell them apart.
    expect(prompt).toContain("KADY_DAG_BUILDER_CONTEXT_V1");
    expect(prompt).toContain("KADY_DAG_BUILDER_NO_WORKFLOW_CONTEXT_V1");
  });
});
