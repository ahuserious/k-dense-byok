import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  applyPresetToPiProviderPayload,
  applyPresetToProviderPayload,
  CHAT_SESSION_PRESET_EXTENSION_INSTALLED,
  makeModelPresetExtension,
  presetBindingBySurface,
  presetBindingForSurface,
  setSessionModelPreset,
} from "../src/agent/model-presets.ts";
import { createModelPreset } from "../src/agent/model-presets-store.ts";
import {
  WORKFLOW_PRESET_PROVIDER_ID,
  expandWorkflowPresetCandidate,
  resolveWorkflowModel,
} from "../src/agent/workflow-model-resolution.ts";
import type { ProjectPaths } from "../src/projects.ts";
import type { ModelRequest, RequestedModel } from "../src/workflows/schema.ts";

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

describe("the chat-session extension binds one run and clears cleanly", () => {
  it("replaces the turn system prompt and maps OpenRouter controls onto the provider payload", async () => {
    const handlers = new Map<string, (event: any, context: any) => unknown>();
    const extension = makeModelPresetExtension("project", () => "session");
    extension({
      on: (event: string, handler: (event: any, context: any) => unknown) => {
        handlers.set(event, handler);
      },
    } as never);
    setSessionModelPreset("project", "session", {
      presetId: "mp_1",
      name: "Careful",
      ref: "openrouter/openai/gpt-5.6-sol-pro",
      providerId: "openrouter",
      modelId: "openai/gpt-5.6-sol-pro",
      hyperparameters: {
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 700,
        reasoningEffort: "xhigh",
        seed: 7,
      },
      systemPromptOverride: "Use only verified evidence.",
      parameterSupport: providerGroup("openrouter")!.parameterSupport,
      surface: "chat-session",
      // The dest-rebased tree reports chat-session dropped. This test is the
      // extension itself: prove it applies controls when the stashed binding
      // says they are bound.
      binding: { hyperparameters: "bound", systemPromptOverride: "bound" },
      bindingBySurface: presetBindingBySurface("openrouter"),
    });

    try {
      const startResult = await handlers.get("before_agent_start")!(
        { systemPrompt: "Kady default" },
        {},
      );
      expect(startResult).toEqual({ systemPrompt: "Use only verified evidence." });

      const providerResult = await handlers.get("before_provider_request")!(
        {
          payload: {
            model: "openai/gpt-5.6-sol-pro",
            messages: [{ role: "user", content: "hello" }],
            max_tokens: 8_192,
          },
        },
        {
          model: {
            ...modelFor(
              "openrouter",
              "openai/gpt-5.6-sol-pro",
              "https://openrouter.ai/api/v1",
            ),
            compat: { thinkingFormat: "openrouter" },
          },
        },
      ) as Record<string, unknown>;
      expect(providerResult).toMatchObject({
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 700,
        seed: 7,
        reasoning: { effort: "xhigh" },
      });
    } finally {
      setSessionModelPreset("project", "session", null);
    }

    const passThrough = { model: "openai/gpt-5.6-sol-pro" };
    expect(
      await handlers.get("before_provider_request")!(
        { payload: passThrough },
        { model: GROQ_MODEL },
      ),
    ).toBe(passThrough);
  });

  it("maps Responses output caps without emitting a Chat Completions max_tokens key", () => {
    const bound = applyPresetToPiProviderPayload(
      { model: "gpt-5.6-sol-pro", max_output_tokens: 8_192 },
      {
        hyperparameters: { maxTokens: 512, reasoningEffort: "high" },
        parameterSupport: providerGroup("openai")!.parameterSupport,
      },
      {
        api: "openai-codex-responses",
        provider: "openai-codex",
        compat: undefined,
      },
    );
    expect(bound.max_output_tokens).toBe(512);
    expect(bound).not.toHaveProperty("max_tokens");
    expect(bound.reasoning).toEqual({ effort: "high" });
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

  it("reports chat bindings as dropped until the session builder installs the extension", () => {
    expect(CHAT_SESSION_PRESET_EXTENSION_INSTALLED).toBe(false);
    const openRouter = presetBindingForSurface("chat-session", "openrouter");
    expect(openRouter.hyperparameters).toBe("dropped");
    expect(openRouter.systemPromptOverride).toBe("dropped");
    expect(openRouter.reason).toMatch(/session builder/);
    expect(openRouter.reason).not.toMatch(/\/(Users|home|tmp|var)\//);

    const anthropic = presetBindingForSurface("chat-session", "anthropic");
    expect(anthropic.hyperparameters).toBe("dropped");
    expect(anthropic.systemPromptOverride).toBe("dropped");
    expect(anthropic.reason).toMatch(/session builder/);

    const modal = presetBindingForSurface("chat-session", "modal");
    expect(modal.hyperparameters).toBe("dropped");
    expect(modal.systemPromptOverride).toBe("dropped");
    expect(modal.reason).toMatch(/compute job/);
  });

  it("reports the still-unwired typed-workflow surfaces as dropped, each with a reason", () => {
    const bindings = presetBindingBySurface("groq");
    for (const surface of [
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
    expect(bindings["workflow-node"].reason).toMatch(/provider "preset"/);
    expect(bindings["hosted-fusion-supervised"].reason).toMatch(/no durable preset id/);
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

describe("workflow nodes can name a preset id without looking live for dropped controls", () => {
  let storeFile: string;
  let previousStore: string | undefined;

  beforeEach(() => {
    storeFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kady-f1-workflow-preset-")),
      "model-presets.json",
    );
    previousStore = process.env.KADY_MODEL_PRESETS_FILE;
    process.env.KADY_MODEL_PRESETS_FILE = storeFile;
  });

  afterEach(() => {
    if (previousStore === undefined) delete process.env.KADY_MODEL_PRESETS_FILE;
    else process.env.KADY_MODEL_PRESETS_FILE = previousStore;
    fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
  });

  function paths(): ProjectPaths {
    return { id: "workflow-preset" } as ProjectPaths;
  }

  function exact(requested: RequestedModel): ModelRequest {
    return { requested, resolution: { mode: "exact" } };
  }

  it("expands provider preset + model <id> to the stored provider and model", () => {
    const preset = createModelPreset({
      name: "Fast summariser",
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
      hyperparameters: { temperature: 0.2 },
      systemPromptOverride: "Be terse.",
    });
    const expanded = expandWorkflowPresetCandidate({
      source: "fixed",
      provider: WORKFLOW_PRESET_PROVIDER_ID,
      model: preset.id,
      auth: { kind: "api-key" },
      reasoning: "high",
    });
    expect(expanded).toEqual({
      source: "fixed",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      auth: { kind: "api-key" },
      reasoning: "high",
    });
  });

  it("refuses a Modal preset on the workflow path before any model call", async () => {
    const preset = createModelPreset({
      name: "Weights",
      providerId: "modal",
      modelId: "meta-llama/Llama-3.3-70B-Instruct",
      modal: {
        huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
        gpuCount: 1,
      },
    });
    const resolveFixedModel = vi.fn();
    const authenticateModel = vi.fn();
    await expect(
      resolveWorkflowModel(
        exact({
          source: "fixed",
          provider: WORKFLOW_PRESET_PROVIDER_ID,
          model: preset.id,
          auth: { kind: "api-key" },
          reasoning: "off",
        }),
        { manifest: { projectId: "workflow-preset" }, paths: paths() },
        { resolveFixedModel, authenticateModel },
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
      message: expect.stringMatching(/compute job/),
    });
    expect(resolveFixedModel).not.toHaveBeenCalled();
    expect(authenticateModel).not.toHaveBeenCalled();
  });

  it("refuses a raw modal provider as a workflow chat model", async () => {
    const resolveFixedModel = vi.fn();
    await expect(
      resolveWorkflowModel(
        exact({
          source: "fixed",
          provider: "modal",
          model: "meta-llama/Llama-3.3-70B-Instruct",
          auth: { kind: "api-key" },
          reasoning: "off",
        }),
        { manifest: { projectId: "workflow-preset" }, paths: paths() },
        { resolveFixedModel },
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
      message: expect.stringMatching(/compute job/),
    });
    expect(resolveFixedModel).not.toHaveBeenCalled();
  });

  it("resolves a Groq workflow node through the expanded preset id", async () => {
    const preset = createModelPreset({
      name: "Fast summariser",
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
    });
    const resolveFixedModel = vi.fn((requested: { provider: string; model: string }) => ({
      ...modelFor(requested.provider, requested.model, "https://api.groq.com/openai/v1"),
      thinkingLevelMap: { off: "off", high: "high", xhigh: "xhigh", max: "max" },
    }));
    const resolved = await resolveWorkflowModel(
      exact({
        source: "fixed",
        provider: WORKFLOW_PRESET_PROVIDER_ID,
        model: preset.id,
        auth: { kind: "api-key" },
        reasoning: "high",
      }),
      { manifest: { projectId: "workflow-preset" }, paths: paths() },
      {
        resolveFixedModel,
        authenticateModel: async () => {},
      },
    );
    expect(resolveFixedModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        auth: { kind: "api-key" },
      }),
    );
    expect(resolved.model.provider).toBe("groq");
    expect(resolved.model.id).toBe("llama-3.3-70b-versatile");
    expect(resolved.receipt.resolved.provider).toBe("groq");
  });
});
