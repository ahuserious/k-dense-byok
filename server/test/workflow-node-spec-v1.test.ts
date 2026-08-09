import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  DEFAULT_NODE_SPEC_V1,
  NODE_SPEC_V1_VERSION,
  NodeSpecV1Schema,
  deriveWorkflowNodeDemand,
  resolveNodeSpecV1,
  validateWorkflowGraphDocument,
  workflowModelCallSlotsForNode,
  type ModelRequest,
  type WorkflowGraphDocument,
} from "../src/workflows/index.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const WORKFLOW_FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "workflows");

function jsonFixtureCandidates(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return jsonFixtureCandidates(entryPath);
    const fixtureNamedPath = /(?:fixture|workflow)/i.test(entryPath);
    return entry.isFile() && entry.name.endsWith(".json") && fixtureNamedPath
      ? [entryPath]
      : [];
  }).sort();
}

function persistedWorkflowFixturePaths(): string[] {
  return jsonFixtureCandidates(REPO_ROOT).filter((fixturePath) => {
    const value = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    return value.schemaVersion === "1.0" &&
      Array.isArray(value.nodes) && Array.isArray(value.edges);
  });
}

function foundationFixture(): WorkflowGraphDocument {
  return JSON.parse(
    fs.readFileSync(
      path.join(WORKFLOW_FIXTURES_DIR, "foundation-v1.json"),
      "utf8",
    ),
  ) as WorkflowGraphDocument;
}

function fixedModel(model: string, reasoning: "low" | "high" = "high"): ModelRequest {
  return {
    requested: {
      source: "fixed",
      provider: "openrouter",
      model,
      auth: { kind: "api-key" },
      reasoning,
    },
    resolution: { mode: "exact" },
  };
}

describe("NodeSpec v1 contract", () => {
  it("loads every persisted workflow fixture without NodeSpec fields", () => {
    const fixturePaths = persistedWorkflowFixturePaths();
    expect(fixturePaths.length).toBeGreaterThan(0);

    for (const fixturePath of fixturePaths) {
      const persisted = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      const validation = validateWorkflowGraphDocument(persisted);
      expect(validation, fixturePath).toMatchObject({ ok: true });
      if (!validation.ok) continue;
      expect(validation.document.settings).toBeUndefined();
      expect(validation.document.nodes.every((node) => node.settings === undefined)).toBe(true);
    }
  });

  it("accepts the frozen optional field set and resolves workflow defaults", () => {
    const document = foundationFixture();
    document.settings = {
      version: NODE_SPEC_V1_VERSION,
      defaultHarness: "codex",
      databases: ["arxiv"],
    };
    document.nodes[0].settings = {
      version: NODE_SPEC_V1_VERSION,
      model: document.defaultModel,
      reasoningEffort: "xhigh",
      hyperparameters: {
        temperature: 0.2,
        top_p: 0.9,
        sampling: { seed: 7, deterministic: true },
      },
      conditions: { when: "inputs.ready", exists: ["inputs/data.csv"] },
      databases: ["pubmed", "arxiv"],
      skills: { mode: "auto-manual", list: ["database-lookup"] },
      subagents: { mode: "auto-manual" },
      autonomy: "loose",
      deliberation: {
        personalityStoreRef: "scientific-agents/v1",
        bestOfNPersonalityCount: 4,
        mimeographs: { mode: "manual", personalityRefs: ["skeptical-reviewer"] },
      },
      billingMode: "subscription",
      budget: { maxTokens: 2_000, maxCostUsd: 0.5 },
    };

    expect(Value.Check(NodeSpecV1Schema, document.nodes[0].settings)).toBe(true);
    const validation = validateWorkflowGraphDocument(document);
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) return;

    const resolved = resolveNodeSpecV1(validation.document, validation.document.nodes[0]);
    expect(resolved).toMatchObject({
      version: 1,
      reasoningEffort: "xhigh",
      harness: "codex",
      databases: ["arxiv", "pubmed"],
      skills: { mode: "auto-manual", list: ["database-lookup"] },
      subagents: { mode: "auto-manual" },
      autonomy: "loose",
      billingMode: "subscription",
      budget: { maxTokens: 2_000, maxCostUsd: 0.5 },
    });
    expect(deriveWorkflowNodeDemand(
      validation.document.nodes[0],
      validation.document,
    )).toMatchObject({ maxTokens: 2_000, maxCostUsd: 0.5 });
  });

  it("applies fail-closed defaults without mutating an old document", () => {
    const document = foundationFixture();
    const before = structuredClone(document);
    const resolved = resolveNodeSpecV1(document, document.nodes[0]);

    expect(resolved).toMatchObject(DEFAULT_NODE_SPEC_V1);
    expect(resolved.budget).toEqual({ maxTokens: 100_000, maxCostUsd: 10 });
    expect(document).toEqual(before);
  });

  it("rejects NodeSpec caps above the workflow admission envelope", () => {
    const document = foundationFixture();
    document.nodes[0].settings = { budget: { maxTokens: 100_001 } };
    const validation = validateWorkflowGraphDocument(document);

    expect(validation).toMatchObject({ ok: false });
    if (validation.ok) return;
    expect(validation.issues).toContainEqual(expect.objectContaining({
      code: "node-budget-exceeds-workflow-limit",
      path: "/nodes/0/settings/budget/maxTokens",
    }));
  });

  it("uses a conflicting NodeSpec model and reasoning in the executable slot", () => {
    const document = foundationFixture();
    const settingsModel = fixedModel("settings-only-model", "low");
    document.nodes[0].settings = {
      model: settingsModel,
      reasoningEffort: "xhigh",
    };

    const validation = validateWorkflowGraphDocument(document);
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) return;
    const node = validation.document.nodes[0];
    const resolved = resolveNodeSpecV1(validation.document, node);
    const slots = workflowModelCallSlotsForNode(validation.document, node);

    expect(resolved.model?.requested).toMatchObject({
      model: "settings-only-model",
      reasoning: "xhigh",
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].request).toEqual(resolved.model);
  });

  it("validates and constructs a slot from settings only", () => {
    const document = foundationFixture();
    delete document.defaultModel;
    document.nodes[0].settings = {
      model: fixedModel("settings-without-legacy", "low"),
      reasoningEffort: "xhigh",
    };

    const validation = validateWorkflowGraphDocument(document);
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) return;
    const slots = workflowModelCallSlotsForNode(
      validation.document,
      validation.document.nodes[0],
    );

    expect(slots).toHaveLength(1);
    expect(slots[0].request.requested).toMatchObject({
      model: "settings-without-legacy",
      reasoning: "xhigh",
    });
  });

  it("keeps legacy-only executable model behavior unchanged", () => {
    const document = foundationFixture();
    const legacyModel = structuredClone(document.defaultModel!);
    const validation = validateWorkflowGraphDocument(document);
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) return;

    expect(workflowModelCallSlotsForNode(
      validation.document,
      validation.document.nodes[0],
    )).toEqual([{ id: "agent", request: legacyModel }]);
  });
});
