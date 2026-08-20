import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import type { WorkflowGraphDocument } from "../src/workflows/schema.ts";

const app = await buildApp();

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

function request(
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) {
  return app.inject({
    method,
    url,
    headers: {
      "x-project-id": "default",
      ...(payload ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(payload ? { payload } : {}),
  });
}

function graph(id: string): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id,
    name: "Curator API workflow",
    entryNodeId: "research",
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
      maxIterations: 4,
      maxModelCalls: 8,
      maxParallelism: 2,
      maxSubagents: 2,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 2,
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
        id: "research",
        name: "Research",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Produce one bounded result.",
      },
    ],
    edges: [],
  };
}

async function seedAndSave(id: string): Promise<void> {
  const seeded = await request("POST", "/sandbox/init?remote=false");
  expect(seeded.statusCode).toBe(200);
  const saved = await request("PUT", `/dag-workflows/${id}`, graph(id), {
    "if-none-match": "*",
  });
  expect(saved.statusCode).toBe(201);
}

describe("F11 skill curator API", () => {
  it("lists loaded skills, applies curation, and returns saved readback", async () => {
    await seedAndSave("curator-api-workflow");

    const before = await request(
      "GET",
      "/skills/curator/workflows/curator-api-workflow",
    );
    expect(before.statusCode).toBe(200);
    const snapshot = before.json() as {
      definition: { revision: number };
      skills: Array<{ ref: string; featured: boolean }>;
      nodes: Array<{ id: string; skillRefs: string[] }>;
    };
    expect(snapshot.definition.revision).toBe(1);
    expect(snapshot.skills).toContainEqual(expect.objectContaining({
      ref: "autoresearch-graph-architect",
      featured: true,
    }));
    expect(snapshot.nodes[0]).toMatchObject({ id: "research", skillRefs: [] });

    const applied = await request(
      "POST",
      "/skills/curator/workflows/curator-api-workflow/apply",
      {
        expectedRevision: 1,
        nodeIds: ["research"],
        skillRefs: ["autoresearch-graph-architect"],
        skillsMode: "manual",
        writeMode: "replace",
      },
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      outcome: "updated",
      definition: {
        revision: 2,
        graph: {
          nodes: [
            {
              id: "research",
              settings: {
                skills: {
                  mode: "manual",
                  list: ["autoresearch-graph-architect"],
                },
              },
            },
          ],
        },
      },
    });

    const stored = await request("GET", "/dag-workflows/curator-api-workflow");
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({
      revision: 2,
      graph: {
        nodes: [
          {
            settings: {
              skills: { list: ["autoresearch-graph-architect"] },
            },
          },
        ],
      },
    });
  });

  it("publishes disabled F5 and frozen-RunState capability status", async () => {
    const response = await request("GET", "/skills/curator/capabilities");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      promptElevation: {
        available: false,
        interfaceDocument: "wave-f/interfaces/F5-elevate-to-dag.md",
        endpoint: null,
        reason: expect.stringMatching(/single elevation API has not landed/i),
      },
      runStateCritiques: {
        readsLiveRunState: true,
        persistedToRunState: false,
        reason: expect.stringMatching(/frozen contract/i),
      },
      durability: {
        available: false,
        settingsEndpoint: "/durability/settings",
        signalsEndpoint: "/durability/signals",
        ownsStore: false,
      },
      modelPresets: {
        available: false,
        endpoint: "/model-presets",
      },
    });
  });

  it("creates a real scientific specialist through the existing Agents API", async () => {
    const created = await request("PUT", "/agents/causal-methodologist", {
      description: "Review causal identification and sensitivity assumptions.",
      thinking: "high",
      tools: "read, grep, find, ls",
      systemPromptMode: "append",
      inheritProjectContext: true,
      inheritSkills: true,
      systemPrompt:
        "You are a causal methodology specialist. Cite inspected artifacts, challenge identification assumptions, and report uncertainty. Never read credentials or mutate files.",
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      agent: {
        name: "causal-methodologist",
        source: "project",
        thinking: "high",
        tools: "read, grep, find, ls",
      },
    });
    expect(
      (created.json() as { agent: { enabled?: boolean } }).agent.enabled,
    ).not.toBe(false);

    const listed = await request("GET", "/agents");
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { agents: Array<{ name: string; source: string }> }).agents)
      .toContainEqual(expect.objectContaining({
        name: "causal-methodologist",
        source: "project",
      }));
  });

  it("loads the InfraNodus skill while the single F12 connector fails closed when unconfigured", async () => {
    vi.stubEnv("INFRANODUS_API_KEY", "");
    try {
      const seeded = await request("POST", "/sandbox/init?remote=false");
      expect(seeded.statusCode).toBe(200);
      const skills = await request("GET", "/skills");
      expect(
        (skills.json() as Array<{ name: string }>).map((skill) => skill.name),
      ).toContain("infranodus-ontology-creator");

      const status = await request("GET", "/integrations");
      expect(status.statusCode).toBe(200);
      const infranodus = (
        status.json() as {
          integrations: Array<{
            id: string;
            configured: boolean;
            reaches: string;
            mcp?: { registered: boolean; disabled: boolean };
          }>;
        }
      ).integrations.find((entry) => entry.id === "infranodus");
      expect(infranodus).toMatchObject({
        configured: false,
        reaches: expect.stringMatching(/^Nothing\./),
        mcp: { registered: false, disabled: false },
      });

      const register = await request(
        "POST",
        "/integrations/infranodus/register",
      );
      expect(register.statusCode).toBe(503);
      expect(register.json()).toMatchObject({
        code: "NOT_CONFIGURED",
        envVar: "INFRANODUS_API_KEY",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects stale curation rather than overwriting a newer workflow", async () => {
    await seedAndSave("curator-conflict-workflow");
    const updatedGraph = graph("curator-conflict-workflow");
    updatedGraph.name = "Changed elsewhere";
    const update = await request(
      "PUT",
      "/dag-workflows/curator-conflict-workflow",
      updatedGraph,
      { "if-match": '"1"' },
    );
    expect(update.statusCode).toBe(200);

    const conflict = await request(
      "POST",
      "/skills/curator/workflows/curator-conflict-workflow/apply",
      {
        expectedRevision: 1,
        nodeIds: ["research"],
        skillRefs: ["autoresearch-squared"],
        skillsMode: "manual",
      },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      code: "WORKFLOW_REVISION_CONFLICT",
      detail: expect.stringMatching(/Reload and try again/),
      currentRevision: 2,
    });
  });
});
