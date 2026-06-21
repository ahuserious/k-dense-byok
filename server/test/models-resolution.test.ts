// danbot-byok — models-resolution.test.ts
// Proves the core model-resolution contract (checklist 24/27/28 + ollama 26): an
// OpenRouter ref resolves to the bare slug with catalogue-derived (non-$0) pricing, an
// unknown model resolves without crashing, and an ollama/ ref routes to the local provider.

import { describe, it, expect } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../src/agent/models.ts";

// Force registry misses so the synthesized-model path (the code under test) runs.
const registry = { find: () => undefined } as unknown as ModelRegistry;

describe("model resolution", () => {
  it("routes openrouter/<vendor>/<model> to the bare slug [24]", () => {
    const model = resolveModel("openrouter/anthropic/claude-opus-4.7", registry);
    expect(model.provider).toBe("openrouter");
    expect(model.id).toBe("anthropic/claude-opus-4.7");
  });

  it("synthesizes non-$0 pricing for a known catalogue model [27]", () => {
    const model = resolveModel("openrouter/anthropic/claude-opus-4.7", registry);
    expect(model.cost.input).toBeGreaterThan(0);
    expect(model.cost.output).toBeGreaterThan(0);
  });

  it("an unknown model resolves without crashing [28]", () => {
    const model = resolveModel("openrouter/some/unknown-model-xyz", registry);
    expect(model.provider).toBe("openrouter");
    expect(model.id).toBe("some/unknown-model-xyz");
  });

  it("ollama/ refs route to the local provider [26]", () => {
    const model = resolveModel("ollama/llama3", registry);
    expect(model.provider).toBe("ollama");
    expect(model.id).toBe("llama3");
  });
});
