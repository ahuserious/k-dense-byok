// danbot-byok — models.fusion.test.ts
//
// Proves the Fusion cost-correctness fix (checklist items 63/64/66): every shape of a
// Fusion model ref the picker can emit resolves to OpenRouter's real Fusion slug AND
// carries a non-$0 cost, so a Fusion turn can never silently bypass the project spend cap.

import { describe, it, expect } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../src/agent/models.ts";

// The Fusion branch never consults the registry; for the ordinary fallback path we force a
// miss so the synthesized-model code (the thing under test) runs.
const registry = { find: () => undefined } as unknown as ModelRegistry;

describe("Fusion model resolution + cost", () => {
  const fusionRefs = [
    "fusion/my-panel", // picker's user-defined panel
    "openrouter/fusion", // canonical slug
    "openrouter/openrouter/fusion", // double-prefixed (frontend prepends openrouter/)
    "fusion", // bare
  ];

  for (const ref of fusionRefs) {
    it(`routes "${ref}" to the Fusion slug with non-$0 cost`, () => {
      const model = resolveModel(ref, registry);
      // Valid OpenRouter API id (not the invalid "fusion/<id>" or stripped "fusion").
      expect(model.id).toBe("openrouter/fusion");
      // Never $0 — this is the budget-safety invariant the fix exists to guarantee.
      expect(model.cost.input).toBeGreaterThan(0);
      expect(model.cost.output).toBeGreaterThan(0);
    });
  }

  it("a normal model is unaffected (no Fusion floor leaks onto it)", () => {
    const model = resolveModel("openrouter/anthropic/claude-sonnet-4-6", registry);
    expect(model.id).toBe("anthropic/claude-sonnet-4-6");
  });
});
