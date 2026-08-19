import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModels } from "./use-models";

/**
 * The picker's view of the two new API-key providers and of saved presets.
 *
 * Sits beside the existing `use-models*.test.tsx` files rather than inside
 * them: those pin the OAuth/local/NVIDIA merges and must keep failing for their
 * own reasons.
 */

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let groqConfigured = true;

const GROQ_GROUP = {
  id: "groq",
  label: "Groq",
  kind: "api-key",
  projectsFrom: "none",
  runtimeProviderIds: ["groq"],
  credentialVariableNames: ["GROQ_API_KEY"],
  parameterSupport: {
    temperature: true,
    topP: true,
    maxTokens: true,
    reasoningEffort: false,
    seed: true,
  },
  dispatchableAsChatModel: true,
  configured: true,
};

beforeEach(() => {
  groqConfigured = true;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/model-presets")) {
      return json({
        presets: [
          {
            id: "mp_1",
            name: "Fast summariser",
            providerId: "groq",
            modelId: "llama-3.3-70b-versatile",
            ref: "groq/llama-3.3-70b-versatile",
            hyperparameters: { temperature: 0.2, maxTokens: 400 },
            systemPromptOverride: "Be terse.",
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:00.000Z",
          },
        ],
        groups: [{ ...GROQ_GROUP, configured: groqConfigured }],
        bindings: {
          direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
          "chat-session": { hyperparameters: "dropped", systemPromptOverride: "dropped" },
          "workflow-node": { hyperparameters: "dropped", systemPromptOverride: "dropped" },
          "hosted-fusion-supervised": {
            hyperparameters: "dropped",
            systemPromptOverride: "dropped",
          },
        },
      });
    }
    if (url.endsWith("/groq/models")) {
      return json({
        configured: groqConfigured,
        credentialVariableName: "GROQ_API_KEY",
        models: groqConfigured
          ? [
              {
                id: "groq/llama-3.3-70b-versatile",
                label: "Llama 3.3 70B",
                provider: "Groq",
                sourceId: "groq",
                sourceLabel: "Groq",
                tier: "mid",
                context_length: 131_072,
                pricing: { prompt: 0.59, completion: 0.79 },
                modality: "text->text",
                description: "Groq",
                reasoning: false,
                billingMode: "payg",
                available: true,
              },
            ]
          : [],
      });
    }
    if (url.endsWith("/cerebras/models")) {
      return json({
        configured: false,
        credentialVariableName: "CEREBRAS_API_KEY",
        models: [],
      });
    }
    if (url.endsWith("/ollama/models")) return json({ available: false, models: [] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: true } });
    if (url.endsWith("/model-providers/models")) return json({ models: [] });
    if (url.endsWith("/model-providers")) return json({ providers: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useModels — Groq, Cerebras and saved presets", () => {
  it("merges Groq entries once its variable is configured", async () => {
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.apiKeyProviderConfigured.groq).toBe(true),
    );
    expect(result.current.apiKeyProviderModels.groq).toHaveLength(1);
    expect(
      result.current.models.some(
        (model) => model.id === "groq/llama-3.3-70b-versatile",
      ),
    ).toBe(true);
    // Groq bills per token, so the picker must not present it as subscription
    // spend the project cap ignores.
    expect(
      result.current.models.find(
        (model) => model.id === "groq/llama-3.3-70b-versatile",
      )?.billingMode,
    ).toBe("payg");
  });

  it("reports Cerebras unconfigured without hiding the fact", async () => {
    const { result } = renderHook(() => useModels());
    // "checking" until discovery settles, then "unavailable" — never a silent
    // "available" that would let a dispatch be attempted against no key.
    expect(result.current.modelAvailability({ id: "cerebras/llama3.1-8b" })).toBe(
      "checking",
    );
    await waitFor(() =>
      expect(result.current.modelAvailability({ id: "cerebras/llama3.1-8b" })).toBe(
        "unavailable",
      ),
    );
    expect(result.current.apiKeyProviderConfigured.cerebras).toBe(false);
    expect(result.current.apiKeyProviderModels.cerebras).toEqual([]);
  });

  it("exposes each saved preset as a preset/<id> picker entry", async () => {
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.presetModels).toHaveLength(1));
    const [preset] = result.current.presetModels;
    expect(preset.id).toBe("preset/mp_1");
    expect(preset.label).toBe("Fast summariser");
    expect(preset.sourceId).toBe("model-presets");
    expect(preset.available).toBe(true);
    // The row states what it resolves to and what it will and will not carry.
    expect(preset.description).toContain("groq/llama-3.3-70b-versatile");
    expect(preset.description).toContain("temp 0.2");
    expect(preset.description).toContain("system prompt override");
    // Presets lead the merged list.
    expect(result.current.models[0].id).toBe("preset/mp_1");
  });

  it("marks a preset unavailable when its provider is not configured", async () => {
    groqConfigured = false;
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.presetModels).toHaveLength(1));
    expect(result.current.presetModels[0].available).toBe(false);
  });
});
