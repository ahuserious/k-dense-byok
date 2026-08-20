import { describe, expect, it } from "vitest";

import { buildFusionRequestBody } from "../../../server/src/agent/fusion-bridge";
import {
  DEFAULT_FUSION_CONFIGS,
  FUSION_DEFAULTS_VERSION,
  GPT_56_SOL_PRO_FUSION_ID,
  fusionPanelModels,
  mergeWithDefaults,
} from "./fusion-presets";

describe("Wave F F3 fusion defaults", () => {
  it("ships GPT-5.6 Sol Pro with no live GPT-5.5 model id", () => {
    const serializedDefaults = JSON.stringify(DEFAULT_FUSION_CONFIGS);
    expect(serializedDefaults).not.toMatch(/openai\/gpt-5\.5(?:-pro)?/i);

    const refreshedPanels = DEFAULT_FUSION_CONFIGS.filter((entry) =>
      fusionPanelModels(JSON.parse(entry.config) as Record<string, unknown>).includes(
        GPT_56_SOL_PRO_FUSION_ID,
      ),
    );
    expect(refreshedPanels).toHaveLength(4);
    expect(
      refreshedPanels.every((entry) => entry.name.includes("GPT-5.6 Sol Pro") || entry.id === "exaflop"),
    ).toBe(true);
  });

  it("labels every predecessor DRACO result unmeasured and carries no score", () => {
    for (const entry of DEFAULT_FUSION_CONFIGS) {
      expect(entry.note).toMatch(/DRACO: unmeasured/i);
      expect(entry.note).not.toMatch(/\d+(?:\.\d+)?%/);
    }
  });

  it("migrates the former built-in ids while preserving user configs", () => {
    expect(FUSION_DEFAULTS_VERSION).toBe(5);
    const user = {
      id: "user-panel",
      name: "User panel",
      config: JSON.stringify({ model: "openrouter/fusion", plugins: [] }),
    };
    const merged = mergeWithDefaults([
      {
        id: "fable5-gpt55",
        name: "Former built-in",
        config: "{}",
      },
      user,
    ]);

    expect(merged.some((entry) => entry.id === "fable5-gpt55")).toBe(false);
    expect(merged).toContainEqual(user);
    expect(merged.some((entry) => entry.id === "fable5-gpt56-sol-pro")).toBe(true);
  });

  it("delivers a shipped refreshed panel to the outbound router payload", () => {
    const shipped = DEFAULT_FUSION_CONFIGS.find(
      (entry) => entry.id === "fable5-gpt56-sol-pro",
    );
    expect(shipped).toBeDefined();
    const config = JSON.parse(shipped!.config) as Record<string, unknown>;
    const outbound = buildFusionRequestBody(
      {
        model: "placeholder",
        messages: [{ role: "user", content: "test" }],
        tools: [{ type: "function", function: { name: "read" } }],
      },
      config,
    );
    const plugin = (outbound.plugins as Array<Record<string, unknown>>)[0];

    expect(outbound.model).toBe("openrouter/fusion");
    expect(outbound.tool_choice).toBe("required");
    expect(plugin.analysis_models).toEqual(
      (config.plugins as Array<Record<string, unknown>>)[0].analysis_models,
    );
    expect(plugin.analysis_models).toContain(GPT_56_SOL_PRO_FUSION_ID);
    expect(plugin.model).toBe("anthropic/claude-opus-4.8");
  });
});
