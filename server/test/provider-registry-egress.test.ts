import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setupModelRuntime } from "../src/agent/models.ts";
import {
  ProviderAuthManager,
  type ProviderAuthRuntime,
} from "../src/agent/provider-auth.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";
import {
  PresetDispatchError,
  dispatchPresetCompletion,
} from "../src/agent/providers/dispatch.ts";

/**
 * Egress hygiene, asserted on the EFFECT.
 *
 * #44 (RAINDROP_BASE_URL), #57 (OPENAI_COMPATIBLE_BASE_URL) and #64
 * (OLLAMA_BASE_URL) all established one rule: an unconfigured provider fails
 * closed and reaches nothing. These tests assert that no outbound request is
 * MADE — not merely that an empty list comes back. Returning `[]` after a 401
 * would satisfy a list assertion and would still have contacted a third party.
 */

function groqModel(id = "llama-3.3-70b-versatile"): Model<Api> {
  return {
    provider: "groq",
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 131_072,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});

describe("Groq and Cerebras registration is gated on the credential NAME", () => {
  function fakeModelRuntime() {
    return {
      registerProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async () => {}),
    } as unknown as ModelRuntime & {
      registerProvider: ReturnType<typeof vi.fn>;
      setRuntimeApiKey: ReturnType<typeof vi.fn>;
    };
  }

  it("registers NEITHER provider when neither variable is set", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OR_API_KEY", "");
    const runtime = fakeModelRuntime();

    await setupModelRuntime(runtime);

    const registeredProviders = runtime.setRuntimeApiKey.mock.calls.map(
      ([providerId]) => providerId,
    );
    expect(registeredProviders).not.toContain("groq");
    expect(registeredProviders).not.toContain("cerebras");
    // Registration is what makes a ref dispatchable — leaving it out is what
    // makes Pi refuse the dispatch instead of contacting an address.
    expect(
      runtime.registerProvider.mock.calls.map(([providerId]) => providerId),
    ).not.toContain("groq");
  });

  it("registers only the provider whose variable is set, and never an address", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-only-groq-key");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OR_API_KEY", "");
    const runtime = fakeModelRuntime();

    await setupModelRuntime(runtime);

    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("groq", "test-only-groq-key");
    expect(
      runtime.setRuntimeApiKey.mock.calls.map(([providerId]) => providerId),
    ).not.toContain("cerebras");
    // A credential, never a base URL: registerProvider (which takes an address)
    // is not used for either provider.
    for (const [providerId] of runtime.registerProvider.mock.calls) {
      expect(["groq", "cerebras"]).not.toContain(providerId);
    }
  });

  it("treats a whitespace-only key as unset", async () => {
    vi.stubEnv("GROQ_API_KEY", "   ");
    vi.stubEnv("CEREBRAS_API_KEY", "   ");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OR_API_KEY", "");
    const runtime = fakeModelRuntime();

    await setupModelRuntime(runtime);

    expect(
      runtime.setRuntimeApiKey.mock.calls.map(([providerId]) => providerId),
    ).toEqual([]);
  });
});

describe("the unconfigured discovery route makes no outbound request", () => {
  function runtimeSpy() {
    const getAvailable = vi.fn(async () => [groqModel()]);
    return {
      runtime: {
        login: vi.fn(),
        logout: vi.fn(async () => {}),
        checkAuth: vi.fn(async () => undefined),
        getAuth: vi.fn(async () => undefined),
        listCredentials: vi.fn(async () => []),
        getAvailable,
        getProvider: vi.fn(() => undefined),
      } as unknown as ProviderAuthRuntime,
      getAvailable,
    };
  }

  async function appWith(runtime: ProviderAuthRuntime) {
    const app = Fastify();
    apps.push(app);
    await registerModelProviderRoutes(app, {
      runtime,
      manager: new ProviderAuthManager(runtime),
    });
    return app;
  }

  it.each([
    ["groq", "GROQ_API_KEY"],
    ["cerebras", "CEREBRAS_API_KEY"],
  ])(
    "%s returns not-configured naming its variable, without calling getAvailable",
    async (providerId, variableName) => {
      vi.stubEnv(variableName, "");
      const { runtime, getAvailable } = runtimeSpy();
      const app = await appWith(runtime);

      const response = await app.inject({ method: "GET", url: `/${providerId}/models` });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        configured: boolean;
        credentialVariableName: string;
        detail: string;
        models: unknown[];
      };
      expect(body.configured).toBe(false);
      expect(body.models).toEqual([]);
      expect(body.credentialVariableName).toBe(variableName);
      expect(body.detail).toContain(variableName);
      // THE assertion: model discovery — the only thing on this route that
      // would leave the machine — was never reached.
      expect(getAvailable).not.toHaveBeenCalled();
    },
  );

  it("lists models once the variable is set, and never echoes its value", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-only-groq-key");
    const { runtime, getAvailable } = runtimeSpy();
    const app = await appWith(runtime);

    const response = await app.inject({ method: "GET", url: "/groq/models" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      configured: boolean;
      models: Array<{ id: string; sourceId: string; billingMode: string }>;
    };
    expect(body.configured).toBe(true);
    expect(getAvailable).toHaveBeenCalledWith("groq");
    expect(body.models[0].id).toBe("groq/llama-3.3-70b-versatile");
    expect(body.models[0].sourceId).toBe("groq");
    // Groq bills per token in USD, so its picker entries must count toward the
    // project cap — matching billingForProvider's default branch.
    expect(body.models[0].billingMode).toBe("payg");
    expect(response.body).not.toContain("test-only-groq-key");
  });
});

describe("the unconfigured adapter builds no request at all", () => {
  it("throws before fetch is called when the credential variable is unset", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    await expect(
      dispatchPresetCompletion(
        {
          model: groqModel(),
          preset: { hyperparameters: { temperature: 0.2 } },
          groupId: "groq",
          prompt: "hello",
        },
        { fetch: fetchSpy, env: {} },
      ),
    ).rejects.toBeInstanceOf(PresetDispatchError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a Modal preset as a completion rather than inventing an endpoint", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    await expect(
      dispatchPresetCompletion(
        {
          model: groqModel(),
          preset: {},
          groupId: "modal",
          prompt: "hello",
        },
        { fetch: fetchSpy, env: { MODAL_TOKEN_ID: "a", MODAL_TOKEN_SECRET: "b" } },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_DISPATCHABLE" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends to the provider's own address, never to a Kady-invented default", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await dispatchPresetCompletion(
      {
        model: groqModel(),
        preset: {},
        groupId: "groq",
        prompt: "hello",
      },
      { fetch: fetchSpy, env: { GROQ_API_KEY: "test-only-groq-key" } },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    // The address came from the resolved Pi model, not from a constant here.
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(url).not.toContain("localhost");
    expect(url).not.toContain("127.0.0.1");
    expect(result.status).toBe(200);
    expect(result.text).toBe("ready");
    // The returned request object carries the header NAME, never its value.
    expect(result.request.authHeaderName).toBe("Authorization");
    expect(JSON.stringify(result.request)).not.toContain("test-only-groq-key");
  });

  it("does not leak the provider's error body back to the user", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: "invalid api key sk-test-only-groq-key-12345" }),
          { status: 401 },
        ),
    );

    let raised: unknown;
    try {
      await dispatchPresetCompletion(
        { model: groqModel(), preset: {}, groupId: "groq", prompt: "hello" },
        { fetch: fetchSpy, env: { GROQ_API_KEY: "test-only-groq-key" } },
      );
    } catch (error) {
      raised = error;
    }
    const message = (raised as Error | undefined)?.message ?? "";
    expect(message).toMatch(/HTTP 401/);
    // The upstream body quoted a credential; ours must not repeat it (#71).
    expect(message).not.toContain("sk-test-only-groq-key-12345");
    expect(message).toContain("GROQ_API_KEY");
  });
});
