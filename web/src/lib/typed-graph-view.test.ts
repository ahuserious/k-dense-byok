import { describe, expect, it } from "vitest";

import type { WorkflowGraphDocument } from "@/lib/dag-workflows";
import {
  GRAPH_VIEW_EDITABLE_FIELDS,
  GRAPH_VIEW_MODEL_VERSION,
  nodeSpecDigest,
  typedToView,
  viewNodeIds,
} from "@/lib/typed-graph-view";

/**
 * A document that carries one of everything the iframe must never see:
 * credentials in a model request, skills, databases, subagents, autonomy, and
 * a prompt body.
 */
function secretBearingDocument(): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "egress-workflow",
    name: "Egress workflow",
    description: "Carries every field the canvas must not receive.",
    entryNodeId: "research",
    defaultModel: {
      requested: {
        source: "fixed",
        provider: "openrouter",
        model: "some/model",
        auth: { kind: "api-key", profile: "team-openrouter-profile" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 12,
      maxModelCalls: 12,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 0,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    ui: { viewport: { x: 12, y: -8, zoom: 0.9 } },
    nodes: [
      {
        id: "research",
        name: "Review Provided Context",
        description: "Inventory the provided material.",
        kind: "research-until-goal",
        terminal: false,
        workspace: { isolation: "read-only", writePaths: [] },
        position: { x: 80, y: 120 },
        goal: "SECRET-GOAL-BODY inventory everything provided.",
        completionCriteria: ["SECRET-CRITERION gaps are explicit."],
        settings: {
          harness: "codex",
          databases: ["postgres://production-analytics"],
          skills: { mode: "manual", list: ["internal-only-skill"] },
          subagents: { mode: "auto" },
          autonomy: "loose",
        },
      },
      {
        id: "report",
        name: "Report Analysis Plan",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "SECRET-PROMPT-BODY report the bounded plan.",
      },
    ],
    edges: [{ id: "research-to-report", from: "research", to: "report", condition: "always" }],
  };
}

describe("typedToView", () => {
  it("projects nodes, edges, and the viewport the canvas needs", () => {
    const view = typedToView(secretBearingDocument(), { graphSha256: "abc123" });

    expect(view.version).toBe(GRAPH_VIEW_MODEL_VERSION);
    expect(view.documentId).toBe("egress-workflow");
    expect(view.entryNodeId).toBe("research");
    expect(view.graphSha256).toBe("abc123");
    expect(view.mode).toBe("typed");
    expect(viewNodeIds(view)).toEqual(["research", "report"]);
    expect(view.nodes[0]).toMatchObject({
      label: "Review Provided Context",
      kind: "research-until-goal",
      harness: "codex",
      terminal: false,
      position: { x: 80, y: 120 },
      editableFields: GRAPH_VIEW_EDITABLE_FIELDS,
    });
    expect(view.edges).toEqual([
      { id: "research-to-report", from: "research", to: "report", condition: "always" },
    ]);
    expect(view.viewport).toEqual({ x: 12, y: -8, zoom: 0.9 });
  });

  it("carries no credential, skill, database, subagent, autonomy, or prompt field across the origin", () => {
    const serialized = JSON.stringify(typedToView(secretBearingDocument()));

    for (const forbidden of [
      "SECRET-GOAL-BODY",
      "SECRET-CRITERION",
      "SECRET-PROMPT-BODY",
      "team-openrouter-profile",
      "production-analytics",
      "internal-only-skill",
      "api-key",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Key form, not bare word: `glyph: "prompt"` is a legitimate rendering hint.
    for (const forbiddenKey of [
      "\"prompt\":",
      "\"goal\":",
      "\"skills\":",
      "\"databases\":",
      "\"subagents\":",
      "\"autonomy\":",
      "\"auth\":",
      "\"settings\":",
      "\"model\":",
      "\"workspace\":",
      "\"completionCriteria\":",
    ]) {
      expect(serialized).not.toContain(forbiddenKey);
    }
  });

  it("keeps every projected node field on the allowlist", () => {
    const view = typedToView(secretBearingDocument());
    const allowed = new Set([
      "id",
      "label",
      "kind",
      "glyph",
      "summary",
      "harness",
      "terminal",
      "position",
      "specDigest",
      "editableFields",
      "unrendered",
      "status",
    ]);

    for (const node of view.nodes) {
      for (const key of Object.keys(node)) expect(allowed).toContain(key);
    }
  });

  it("overlays run status without touching the projection otherwise", () => {
    const document = secretBearingDocument();
    const plain = typedToView(document);
    const overlaid = typedToView(document, {
      statusByNodeId: { research: "running", report: "pending" },
    });

    expect(overlaid.nodes.map((node) => node.status)).toEqual(["running", "pending"]);
    expect(plain.nodes.map((node) => node.status)).toEqual([undefined, undefined]);
    expect(overlaid.nodes.map((node) => node.specDigest)).toEqual(
      plain.nodes.map((node) => node.specDigest),
    );
  });

  it("changes a node's digest when any typed field changes, including invisible ones", () => {
    const document = secretBearingDocument();
    const before = nodeSpecDigest(document.nodes[0]);

    const movedOnly = structuredClone(document);
    movedOnly.nodes[0].position = { x: 81, y: 120 };
    const secretChanged = structuredClone(document);
    secretChanged.nodes[0].settings = {
      ...secretChanged.nodes[0].settings,
      autonomy: "strict",
    };

    expect(nodeSpecDigest(movedOnly.nodes[0])).not.toBe(before);
    // The digest covers fields the canvas never receives; that is the point —
    // a delta computed against a node whose hidden state moved is stale.
    expect(nodeSpecDigest(secretChanged.nodes[0])).not.toBe(before);
  });

  it("is insensitive to key order", () => {
    const document = secretBearingDocument();
    const reorderedNode = Object.fromEntries(
      Object.entries(document.nodes[0] as unknown as Record<string, unknown>).reverse(),
    ) as unknown as (typeof document.nodes)[number];

    expect(nodeSpecDigest(reorderedNode)).toBe(nodeSpecDigest(document.nodes[0]));
  });
});
