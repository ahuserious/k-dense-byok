import { describe, expect, it } from "vitest";
import { INFRANODUS_NOT_CONFIGURED_MESSAGE } from "../src/integrations/infranodus.ts";
import {
  INFRANODUS_MAP_EMPTY_MESSAGE,
  INFRANODUS_MAP_TOPIC_REQUIRED_MESSAGE,
  INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE,
  REASONING_STYLE_NOT_CONFIGURED_CODE,
  personasFromInfranodusPayload,
  pickInfranodusMapTool,
  selectReasoningStylePersonas,
  type InfranodusMapQuery,
} from "../src/workflows/reasoning-style.ts";
import type { WorkflowNode } from "../src/workflows/schema.ts";

function node(
  overrides: Partial<Extract<WorkflowNode, { kind: "reasoning-style" }>>,
): Extract<WorkflowNode, { kind: "reasoning-style" }> {
  return {
    id: "style",
    name: "Style",
    kind: "reasoning-style",
    terminal: true,
    workspace: { isolation: "read-only", writePaths: [] },
    mode: "auto",
    ...overrides,
  };
}

function query(overrides: Partial<InfranodusMapQuery> = {}): InfranodusMapQuery {
  return {
    listTools: async () => ["mcp__infranodus__generate_knowledge_graph"],
    callTool: async () => ({
      mainConcepts: ["map-head-a", "map-head-b"],
    }),
    ...overrides,
  };
}

describe("reasoning-style selection", () => {
  it("auto-selects mimeograph personas and changes the council roster", async () => {
    const selected = await selectReasoningStylePersonas(node({
      mode: "auto",
      settings: {
        deliberation: {
          bestOfNPersonalityCount: 2,
          mimeographs: { mode: "auto", personalityRefs: ["genomics", "statistician", "theorist"] },
        },
      },
    }));
    expect(selected).toMatchObject({
      kind: "reasoning-style",
      mode: "auto",
      source: "mimeographs",
      personalityRefs: ["genomics", "statistician"],
    });
  });

  it("fails closed when InfraNodus is unset", async () => {
    await expect(
      selectReasoningStylePersonas(node({ mode: "infranodus", style: "topic" }), {}),
    ).rejects.toThrow(INFRANODUS_NOT_CONFIGURED_MESSAGE);
    try {
      await selectReasoningStylePersonas(node({ mode: "infranodus", style: "topic" }), {});
    } catch (error) {
      expect((error as { code?: string }).code).toBe(REASONING_STYLE_NOT_CONFIGURED_CODE);
    }
  });

  it("fails closed when the key is present but no map query is supplied", async () => {
    await expect(
      selectReasoningStylePersonas(
        node({ mode: "infranodus", style: "topic" }),
        { INFRANODUS_API_KEY: "present" },
      ),
    ).rejects.toThrow(INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE);
  });

  it("fails closed when InfraNodus advertises no map tools", async () => {
    await expect(
      selectReasoningStylePersonas(
        node({ mode: "infranodus", style: "topic" }),
        { INFRANODUS_API_KEY: "present" },
        query({ listTools: async () => [] }),
      ),
    ).rejects.toThrow(INFRANODUS_TOOLS_UNAVAILABLE_MESSAGE);
  });

  it("fails closed when the map returns no personas", async () => {
    await expect(
      selectReasoningStylePersonas(
        node({ mode: "infranodus", style: "topic" }),
        { INFRANODUS_API_KEY: "present" },
        query({ callTool: async () => ({ count: 0, empty: true }) }),
      ),
    ).rejects.toThrow(INFRANODUS_MAP_EMPTY_MESSAGE);
  });

  it("fails closed when infranodus mode has no map topic", async () => {
    await expect(
      selectReasoningStylePersonas(
        node({ mode: "infranodus" }),
        { INFRANODUS_API_KEY: "present" },
        query(),
      ),
    ).rejects.toThrow(INFRANODUS_MAP_TOPIC_REQUIRED_MESSAGE);
  });

  it("queries an InfraNodus map and uses the returned personas", async () => {
    const called: Array<{ name: string; args: Record<string, unknown> }> = [];
    const selected = await selectReasoningStylePersonas(
      node({ mode: "infranodus", style: "cancer-genomics" }),
      { INFRANODUS_API_KEY: "present" },
      query({
        callTool: async (name, args) => {
          called.push({ name, args });
          return { mainConcepts: ["map-head-a", "map-head-b"] };
        },
      }),
    );
    expect(called).toEqual([{
      name: "mcp__infranodus__generate_knowledge_graph",
      args: { text: "cancer-genomics" },
    }]);
    expect(selected).toMatchObject({
      kind: "reasoning-style",
      mode: "infranodus",
      source: "infranodus",
      personalityRefs: ["map-head-a", "map-head-b"],
    });
  });

  it("picks a discovered map tool and parses cluster names", () => {
    expect(pickInfranodusMapTool([
      "mcp__infranodus__generate_seo_report",
      "mcp__infranodus__analyze_existing_graph_by_name",
    ])).toBe("mcp__infranodus__analyze_existing_graph_by_name");
    expect(personasFromInfranodusPayload({
      mainTopicalClusters: [{ name: "theorist" }, { name: "experimentalist" }],
    })).toEqual(["theorist", "experimentalist"]);
  });
});
