import { describe, expect, it } from "vitest";
import { buildFusionModel, catalogueEntryFor } from "../src/agent/models.ts";

// Reasoning-effort suffixes ("...-xhigh", "...-high", …) are an OpenRouter
// routing form, not separate catalogue rows. Before the fix they missed the
// catalogue and resolved to $0 cost — silently disabling the project spend cap
// (this is why the opus-4.8-xhigh default's spend wasn't capped).
describe("catalogueEntryFor (reasoning-effort suffix pricing)", () => {
  it("prices a reasoning-effort-suffixed id as its base model (not $0)", () => {
    const base = catalogueEntryFor("anthropic/claude-opus-4.8");
    const xhigh = catalogueEntryFor("anthropic/claude-opus-4.8-xhigh");
    expect(base).toBeDefined();
    expect(xhigh).toBeDefined();
    expect(xhigh!.costInput).toBe(base!.costInput);
    expect(xhigh!.costOutput).toBe(base!.costOutput);
    expect(xhigh!.costInput).toBeGreaterThan(0);
  });

  it("does NOT strip -fast (a distinct catalogue model with its own pricing)", () => {
    const fast = catalogueEntryFor("anthropic/claude-opus-4.8-fast");
    const base = catalogueEntryFor("anthropic/claude-opus-4.8");
    expect(fast).toBeDefined();
    expect(base).toBeDefined();
    // -fast is its own model (pricier); it must not collapse to the base price.
    expect(fast!.costInput).not.toBe(base!.costInput);
  });

  it("returns undefined for an unknown model", () => {
    expect(catalogueEntryFor("nonexistent/model-xyz")).toBeUndefined();
  });
});

// A fusion turn bills N panel calls + 2 judge-model calls (structured analysis
// + the outer request that writes the final answer — both the judge model under
// the openrouter/fusion alias). Panel-only pricing under-ledgered every turn by
// two judge calls, eroding the spend cap.
describe("buildFusionModel (panel + judge pricing)", () => {
  const fusionConfig = (panel: string[], judge?: string) => ({
    model: "openrouter/fusion",
    plugins: [
      {
        id: "fusion",
        analysis_models: panel,
        ...(judge ? { model: judge } : {}),
      },
    ],
  });

  it("prices as the panel sum plus twice the judge", () => {
    const opus = catalogueEntryFor("anthropic/claude-opus-4.8")!;
    const gpt = catalogueEntryFor("openai/gpt-5.5")!;
    const model = buildFusionModel(
      fusionConfig(["anthropic/claude-opus-4.8", "openai/gpt-5.5"], "anthropic/claude-opus-4.8"),
    );
    expect(model.cost.input).toBeCloseTo(opus.costInput + gpt.costInput + 2 * opus.costInput);
    expect(model.cost.output).toBeCloseTo(opus.costOutput + gpt.costOutput + 2 * opus.costOutput);
  });

  it("still prices the panel when the judge is missing from the catalogue", () => {
    const opus = catalogueEntryFor("anthropic/claude-opus-4.8")!;
    const model = buildFusionModel(
      fusionConfig(["anthropic/claude-opus-4.8"], "nonexistent/judge-xyz"),
    );
    expect(model.cost.input).toBeCloseTo(opus.costInput);
  });

  it("prices a judge-only config (catalogue-priced judge, unpriceable panel)", () => {
    const opus = catalogueEntryFor("anthropic/claude-opus-4.8")!;
    const model = buildFusionModel(
      fusionConfig(["nonexistent/panelist-xyz"], "anthropic/claude-opus-4.8"),
    );
    expect(model.cost.input).toBeCloseTo(2 * opus.costInput);
  });

  it("throws when neither panel nor judge is priceable (never run at $0)", () => {
    expect(() => buildFusionModel(fusionConfig(["nonexistent/model-xyz"]))).toThrow(/\$0/);
  });
});
