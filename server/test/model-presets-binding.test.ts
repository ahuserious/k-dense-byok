import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildPresetChatCompletionRequest,
  dispatchPresetCompletion,
} from "../src/agent/providers/dispatch.ts";
import { providerGroup } from "../src/agent/providers/registry.ts";
import {
  applyPresetToProviderPayload,
  presetBindingBySurface,
  presetBindingForSurface,
} from "../src/agent/model-presets.ts";

/**
 * Gate B for matrix rows 4 (hyperparameters) and 5 (system-prompt override).
 *
 * Every assertion here is on the OUTBOUND REQUEST — the body that leaves the
 * process — not on the schema accepting a field. #54 and #55 are both cases of
 * a value that validated cleanly and then reached nothing, so "the schema
 * validates it" is explicitly not evidence.
 */

function modelFor(provider: string, id: string, baseUrl: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const GROQ_MODEL = modelFor(
  "groq",
  "llama-3.3-70b-versatile",
  "https://api.groq.com/openai/v1",
);

function jsonResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("row 4 — a preset's hyperparameters reach the provider call", () => {
  it("puts every supported hyperparameter on the outbound request body", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());

    await dispatchPresetCompletion(
      {
        model: GROQ_MODEL,
        preset: {
          hyperparameters: {
            temperature: 0.15,
            topP: 0.85,
            maxTokens: 512,
            seed: 4242,
          },
        },
        groupId: "groq",
        prompt: "summarise this",
      },
      { fetch: fetchSpy, env: { GROQ_API_KEY: "test-only-groq-key" } },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(sent.model).toBe("llama-3.3-70b-versatile");
    expect(sent.temperature).toBe(0.15);
    expect(sent.top_p).toBe(0.85);
    expect(sent.max_tokens).toBe(512);
    expect(sent.seed).toBe(4242);
  });

  it("omits a parameter the provider does not accept instead of sending it", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());

    // Groq's group declares reasoningEffort unsupported, which is the same data
    // the editor renders the control disabled from. A value that arrived anyway
    // must not be forwarded — a control that cannot act must not act.
    expect(providerGroup("groq")?.parameterSupport.reasoningEffort).toBe(false);
    await dispatchPresetCompletion(
      {
        model: GROQ_MODEL,
        preset: {
          hyperparameters: { temperature: 0.3, reasoningEffort: "high" },
        },
        groupId: "groq",
        prompt: "summarise this",
      },
      { fetch: fetchSpy, env: { GROQ_API_KEY: "test-only-groq-key" } },
    );

    const [, init] = fetchSpy.mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent.temperature).toBe(0.3);
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  it("sends no sampling keys at all when the preset sets none", () => {
    const request = buildPresetChatCompletionRequest({
      model: GROQ_MODEL,
      preset: {},
      group: providerGroup("groq")!,
      prompt: "hello",
    });
    expect(request.body).not.toHaveProperty("temperature");
    expect(request.body).not.toHaveProperty("top_p");
    expect(request.body).not.toHaveProperty("max_tokens");
    expect(request.body).not.toHaveProperty("seed");
  });

  it("carries a reasoning level for a provider that does accept one", () => {
    const request = buildPresetChatCompletionRequest({
      model: modelFor("openrouter", "anthropic/claude-opus-4.8", "https://openrouter.ai/api/v1"),
      preset: { hyperparameters: { reasoningEffort: "xhigh" } },
      group: providerGroup("openrouter")!,
      prompt: "hello",
    });
    expect(request.body.reasoning_effort).toBe("xhigh");
  });
});

describe("row 5 — the override IS the system prompt actually sent", () => {
  it("sends the override as the one and only system message", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());
    const override = "You are a terse assistant. Answer in one sentence.";

    await dispatchPresetCompletion(
      {
        model: GROQ_MODEL,
        preset: { systemPromptOverride: override },
        groupId: "groq",
        prompt: "what is a preset?",
      },
      { fetch: fetchSpy, env: { GROQ_API_KEY: "test-only-groq-key" } },
    );

    const [, init] = fetchSpy.mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };

    const systemMessages = sent.messages.filter((message) => message.role === "system");
    // Exactly one system message, and it is the override verbatim — not the
    // override appended alongside a Kady default.
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe(override);
    expect(sent.messages[0]).toEqual({ role: "system", content: override });
    expect(sent.messages[1]).toEqual({ role: "user", content: "what is a preset?" });
  });

  it("sends no system message at all when there is no override", () => {
    const request = buildPresetChatCompletionRequest({
      model: GROQ_MODEL,
      preset: {},
      group: providerGroup("groq")!,
      prompt: "hello",
    });
    expect(request.body.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("the Pi payload binder replaces rather than appends", () => {
  const support = providerGroup("openrouter")!.parameterSupport;

  it("replaces an existing system message with the override", () => {
    const bound = applyPresetToProviderPayload(
      {
        model: "anthropic/claude-opus-4.8",
        messages: [
          { role: "system", content: "the session's own system prompt" },
          { role: "user", content: "hi" },
        ],
      },
      {
        hyperparameters: { temperature: 0.4, maxTokens: 100 },
        systemPromptOverride: "OVERRIDE",
        parameterSupport: support,
      },
    );

    expect(bound.messages).toEqual([
      { role: "system", content: "OVERRIDE" },
      { role: "user", content: "hi" },
    ]);
    expect(bound.temperature).toBe(0.4);
    expect(bound.max_tokens).toBe(100);
  });

  it("never overwrites the keys that belong to Pi", () => {
    const original = {
      model: "anthropic/claude-opus-4.8",
      tools: ["read"],
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const bound = applyPresetToProviderPayload(original, {
      hyperparameters: { temperature: 0.9 },
      parameterSupport: support,
    });
    expect(bound.model).toBe("anthropic/claude-opus-4.8");
    expect(bound.tools).toEqual(["read"]);
    expect(bound.stream).toBe(true);
    expect(bound.messages).toEqual([{ role: "user", content: "hi" }]);
    // The input payload is not mutated in place.
    expect(original).not.toHaveProperty("temperature");
  });
});

describe("the binding block tells the truth about each surface", () => {
  it("reports the surface Kady builds the request for as bound", () => {
    const binding = presetBindingForSurface("direct");
    expect(binding.hyperparameters).toBe("bound");
    expect(binding.systemPromptOverride).toBe("bound");
    expect(binding.reason).toBeUndefined();
  });

  it("reports every other surface as dropped, each with a reason", () => {
    const bindings = presetBindingBySurface();
    for (const surface of [
      "chat-session",
      "workflow-node",
      "hosted-fusion-supervised",
    ] as const) {
      expect(bindings[surface].hyperparameters).toBe("dropped");
      expect(bindings[surface].systemPromptOverride).toBe("dropped");
      // A dropped value without a stated reason is exactly the silent discard
      // this block exists to prevent.
      expect(bindings[surface].reason).toBeTruthy();
      expect(bindings[surface].reason).not.toMatch(/\/(Users|home|tmp|var)\//);
    }
  });
});
