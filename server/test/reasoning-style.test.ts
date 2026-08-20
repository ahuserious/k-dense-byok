import { describe, expect, it } from "vitest";
import { INFRANODUS_NOT_CONFIGURED_MESSAGE } from "../src/integrations/infranodus.ts";
import {
  REASONING_STYLE_NOT_CONFIGURED_CODE,
  selectReasoningStylePersonas,
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

describe("reasoning-style selection", () => {
  it("auto-selects mimeograph personas and changes the council roster", () => {
    const selected = selectReasoningStylePersonas(node({
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

  it("fails closed when InfraNodus is unset", () => {
    expect(() =>
      selectReasoningStylePersonas(node({ mode: "infranodus" }), {}),
    ).toThrow(INFRANODUS_NOT_CONFIGURED_MESSAGE);
    try {
      selectReasoningStylePersonas(node({ mode: "infranodus" }), {});
    } catch (error) {
      expect((error as { code?: string }).code).toBe(REASONING_STYLE_NOT_CONFIGURED_CODE);
    }
  });

  it("uses authored refs when InfraNodus is configured", () => {
    const selected = selectReasoningStylePersonas(
      node({ mode: "infranodus", personalityRefs: ["map-head-a", "map-head-b"] }),
      { INFRANODUS_API_KEY: "present" },
    );
    expect(selected.personalityRefs).toEqual(["map-head-a", "map-head-b"]);
    expect(selected.source).toBe("infranodus");
  });
});
