// danbot-byok — archon-cost.test.ts
// Proves the Archon cost-bridge reconciler (checklist 89 logic): sumRunCost walks a run's
// JSON and totals the per-node cost_usd + token figures Archon reports, defaulting to zero
// when nothing is reported (which is "no usage reported", not "free").

import { describe, it, expect } from "vitest";
import { sumRunCost } from "../src/agent/archon/client.ts";

describe("Archon cost reconciliation (sumRunCost)", () => {
  it("sums cost_usd + tokens across a nested run JSON (snake & camel case)", () => {
    const run = {
      status: "completed",
      events: [
        { node: "a", cost_usd: 0.01, tokensIn: 100, tokensOut: 50 },
        { node: "b", details: { cost_usd: 0.02, input_tokens: 200, output_tokens: 80 } },
      ],
    };
    const totals = sumRunCost(run);
    expect(totals.costUsd).toBeCloseTo(0.03, 6);
    expect(totals.tokensIn).toBe(300);
    expect(totals.tokensOut).toBe(130);
  });

  it("returns zeros when the run reports no usage", () => {
    expect(sumRunCost({ status: "completed", events: [] })).toEqual({
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it("ignores non-finite / non-numeric cost values", () => {
    const totals = sumRunCost({ cost_usd: "n/a", events: [{ cost_usd: Infinity }, { cost_usd: 0.5 }] });
    expect(totals.costUsd).toBeCloseTo(0.5, 6);
  });
});
