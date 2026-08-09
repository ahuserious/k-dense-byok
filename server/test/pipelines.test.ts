import { describe, expect, it } from "vitest";
import { pipelineNodeBudgetHooks } from "../src/api/pipelines.ts";

describe("Tier A S4 pipeline NodeSpec extraction", () => {
  it("round-trips strict per-node budget and billing hooks", () => {
    const definition = JSON.parse(JSON.stringify({
      limits: { maxTokens: 10_000, maxCostUsd: 10 },
      nodes: [
        {
          id: "search",
          limits: { maxTokens: 4_000, maxCostUsd: 4 },
          settings: {
            billingMode: "api",
            budget: { maxTokens: 2_000, maxCostUsd: 1.5 },
          },
        },
        {
          id: "synthesis",
          settings: {
            billingMode: "subscription",
            budget: { maxTokens: 3_000, maxCostUsd: 8 },
          },
        },
      ],
    }));
    expect(pipelineNodeBudgetHooks({ workflow: definition })).toEqual([
      { nodeId: "search", maxTokens: 2_000, maxCostUsd: 1.5, billingMode: "api" },
      {
        nodeId: "synthesis",
        maxTokens: 3_000,
        maxCostUsd: 8,
        billingMode: "subscription",
      },
    ]);
  });

  it.each([
    { budget: { maxTokens: 100 }, message: /budget\.maxCostUsd/ },
    { budget: { maxTokens: 0, maxCostUsd: 1 }, message: /budget\.maxTokens/ },
  ])("fails closed on an invalid per-node budget hook", ({ budget, message }) => {
    expect(() => pipelineNodeBudgetHooks({
      nodes: [{ id: "bad", settings: { budget } }],
    })).toThrow(message);
  });
});
