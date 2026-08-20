import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildPresetChatCompletionRequest,
  dispatchPresetCompletion,
} from "../src/agent/providers/dispatch.ts";
import {
  PROVIDER_GROUPS,
  directDispatchSupport,
  providerGroup,
} from "../src/agent/providers/registry.ts";
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
  it("reports direct as bound ONLY for the groups Kady can build the call for", () => {
    // The three API-key, OpenAI-shaped groups. Kady builds this request itself,
    // and `model-presets-binding` above asserts the values are on the wire.
    for (const groupId of ["groq", "cerebras", "openrouter"] as const) {
      const binding = presetBindingForSurface("direct", groupId);
      expect(binding.hyperparameters).toBe("bound");
      expect(binding.systemPromptOverride).toBe("bound");
      expect(binding.reason).toBeUndefined();
    }
  });

  it("reports direct as DROPPED, with a reason, for every group it cannot", () => {
    // Round 1 served `{hyperparameters: "bound"}` here for all eight groups.
    // These five have no path: the three OAuth groups have no API key to send
    // and (for openai/anthropic) do not speak openai-completions at all, Local
    // names a base URL rather than a credential, and Modal is a compute job.
    for (const groupId of ["openai", "anthropic", "xai", "local", "modal"] as const) {
      const binding = presetBindingForSurface("direct", groupId);
      expect(binding.hyperparameters).toBe("dropped");
      expect(binding.systemPromptOverride).toBe("dropped");
      expect(binding.reason).toBeTruthy();
      expect(binding.reason).not.toMatch(/\/(Users|home|tmp|var)\//);
    }
  });

  it("makes the direct verdict identical to what dispatch would do", () => {
    // The anti-drift assertion: the honesty block and the guard are the same
    // function, so a group can never be advertised as carrying values that
    // `dispatchPresetCompletion` would refuse.
    for (const group of PROVIDER_GROUPS) {
      const support = directDispatchSupport(group);
      const binding = presetBindingForSurface("direct", group.id);
      expect(binding.hyperparameters).toBe(support.supported ? "bound" : "dropped");
      if (!support.supported) expect(binding.reason).toBe(support.reason);
    }
  });

  it("reports every other surface as dropped, each with a reason", () => {
    const bindings = presetBindingBySurface("groq");
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

/**
 * The round-2 high, closed and pinned.
 *
 * Round 1's guard was `if (group.kind === "api-key" && !credentialVariablesPresent(...))`,
 * so it never fired for the three OAuth groups, whose `credentialVariableNames`
 * are empty. The header block then attached no `Authorization` at all and
 * `buildPresetChatCompletionRequest` unconditionally targeted
 * `${baseUrl}/chat/completions` with an OpenAI body. For an Anthropic preset
 * that meant an unauthenticated POST to `https://api.anthropic.com/chat/completions`.
 *
 * Every assertion below is on the EFFECT: whether `fetch` was called at all.
 */
describe("a group Kady cannot build a request for makes NO outbound request", () => {
  const CASES = [
    { groupId: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    {
      groupId: "openai",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    { groupId: "xai", api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
    { groupId: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
    { groupId: "modal", api: "openai-completions", baseUrl: "https://example.invalid/v1" },
  ] as const;

  for (const testCase of CASES) {
    it(`refuses a ${testCase.groupId} preset before fetch, naming why`, async () => {
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      // A fully populated environment, including the Local group's base-URL
      // variables and Modal's token pair — so the refusal cannot be mistaken
      // for "the credential happened to be missing".
      const env = {
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1234/v1",
        MODAL_TOKEN_ID: "present",
        MODAL_TOKEN_SECRET: "present",
        ANTHROPIC_API_KEY: "present",
        OPENAI_API_KEY: "present",
        XAI_API_KEY: "present",
      };

      await expect(
        dispatchPresetCompletion(
          {
            model: {
              ...modelFor(testCase.groupId, "some-model", testCase.baseUrl),
              api: testCase.api,
            },
            preset: { hyperparameters: { temperature: 0.2 } },
            groupId: testCase.groupId,
            prompt: "hi",
          },
          { fetch: fetchSpy as unknown as typeof globalThis.fetch, env },
        ),
      ).rejects.toThrow(/not|cannot|compute job|base-URL|API key/i);

      // The whole point. Not "it returned an empty result" — nothing was sent.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("never puts a base-URL variable in an Authorization header", async () => {
    // The Local group's `credentialVariableNames` are OLLAMA_BASE_URL and
    // OPENAI_COMPATIBLE_BASE_URL — addresses, not credentials. Round 1 sent
    // `Authorization: Bearer <that base URL>`.
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(
      dispatchPresetCompletion(
        {
          model: modelFor("ollama", "llama3", "http://127.0.0.1:11434/v1"),
          preset: {},
          groupId: "local",
          prompt: "hi",
        },
        {
          fetch: fetchSpy as unknown as typeof globalThis.fetch,
          env: { OLLAMA_BASE_URL: "http://127.0.0.1:11434" },
        },
      ),
    ).rejects.toThrow(/base-URL variable rather than an API-key credential/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an API-key group whose model speaks another API, before fetch", async () => {
    // Rule 2 of the predicate, on its own: Groq is dispatchable and configured,
    // but a model that is not `openai-completions` is not what this path builds.
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(
      dispatchPresetCompletion(
        {
          model: {
            ...modelFor("groq", "some-anthropic-shaped", "https://api.groq.com/openai/v1"),
            api: "anthropic-messages",
          },
          preset: {},
          groupId: "groq",
          prompt: "hi",
        },
        {
          fetch: fetchSpy as unknown as typeof globalThis.fetch,
          env: { GROQ_API_KEY: "present" },
        },
      ),
    ).rejects.toThrow(/openai-completions/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still sends, with the credential, for a configured API-key group", async () => {
    // The control case: the predicate is not simply "refuse everything".
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await dispatchPresetCompletion(
      {
        model: modelFor("groq", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1"),
        preset: { hyperparameters: { temperature: 0.15 } },
        groupId: "groq",
        prompt: "hi",
      },
      {
        fetch: fetchSpy as unknown as typeof globalThis.fetch,
        env: { GROQ_API_KEY: "gsk-not-a-real-key" },
      },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(String(init.body)).temperature).toBe(0.15);
    expect(result.status).toBe(200);
  });
});
