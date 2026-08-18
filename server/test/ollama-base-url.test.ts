/**
 * OLLAMA_BASE_URL has no default (#64).
 *
 * This is the same defect as #57 (see server/test/openai-compatible-base-url.test.ts) with a
 * larger blast radius. While the config carried a `http://localhost:11434` fallback,
 * /ollama/models fetched `${OLLAMA_BASE_URL}/api/tags` unconditionally and carried no
 * `configured` field at all — not even the decorative one #57 had. An install that had never
 * named a daemon therefore answered `available: true` and enumerated the real models of whatever
 * Ollama happened to be running on the backend's host, and agent/models.ts registered the
 * `ollama` provider at the same default, so those entries were not merely displayed but
 * selectable and dispatchable.
 *
 * These tests pin three things: unset performs NO outbound fetch at all; the route now reports a
 * first-class unconfigured state in the same `{available, configured, models}` shape
 * /openai-compatible/models uses; and a configured daemon behaves exactly as it did before —
 * same `/api/tags` probe, same 2s timeout/abort, same available / unavailable reporting.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalBaseUrl = process.env.OLLAMA_BASE_URL;
// The registration tests below clear the sibling variable too, and vitest shares
// process.env across every test file in a worker — so this file has to put it back.
const originalOpenAICompatibleBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;

/**
 * config.ts reads the environment once at import, so both the config module and the route that
 * closed over it have to be loaded fresh per test with OLLAMA_BASE_URL already in place.
 */
async function buildRoutes(envBaseUrl: string | undefined) {
  if (envBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = envBaseUrl;
  vi.resetModules();
  const { registerSystemRoutes } = await import("../src/api/system.ts");
  const app = Fastify();
  await registerSystemRoutes(app);
  return app;
}

/** A fetch stub that records every call, so "no fetch" is an assertion and not an inference. */
function stubFetch(
  implementation: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<Response> | Promise<never>,
) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function tagsResponse(names: string[]): Response {
  return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = originalBaseUrl;
  if (originalOpenAICompatibleBaseUrl === undefined) {
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  } else {
    process.env.OPENAI_COMPATIBLE_BASE_URL = originalOpenAICompatibleBaseUrl;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("OLLAMA_BASE_URL", () => {
  it("is undefined when the environment does not set it (no localhost default)", async () => {
    delete process.env.OLLAMA_BASE_URL;
    vi.resetModules();
    const { OLLAMA_BASE_URL } = await import("../src/config.ts");
    expect(OLLAMA_BASE_URL).toBeUndefined();
  });

  it("treats a blank value as unset rather than as a URL", async () => {
    process.env.OLLAMA_BASE_URL = "";
    vi.resetModules();
    const { OLLAMA_BASE_URL } = await import("../src/config.ts");
    expect(OLLAMA_BASE_URL).toBeUndefined();
  });

  it("treats a whitespace-only value as unset rather than as a URL", async () => {
    process.env.OLLAMA_BASE_URL = "   ";
    vi.resetModules();
    const { OLLAMA_BASE_URL } = await import("../src/config.ts");
    expect(OLLAMA_BASE_URL).toBeUndefined();
  });

  it("keeps a configured value verbatim apart from surrounding whitespace", async () => {
    process.env.OLLAMA_BASE_URL = "  http://127.0.0.1:11434  ";
    vi.resetModules();
    const { OLLAMA_BASE_URL } = await import("../src/config.ts");
    expect(OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
  });
});

describe("GET /ollama/models with no configured daemon", () => {
  it("performs no outbound fetch at all", async () => {
    const fetchMock = stubFetch(async () => tagsResponse(["someone-elses-model"]));
    const app = await buildRoutes(undefined);

    const response = await app.inject({ url: "/ollama/models" });

    // The whole point of #64: unset must suppress the probe, not merely fail to label it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    await app.close();
  });

  it("performs no outbound fetch when the value is blank either", async () => {
    const fetchMock = stubFetch(async () => tagsResponse(["someone-elses-model"]));
    const app = await buildRoutes("");

    const response = await app.inject({ url: "/ollama/models" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    await app.close();
  });

  it("performs no outbound fetch when the value is whitespace either", async () => {
    const fetchMock = stubFetch(async () => tagsResponse(["someone-elses-model"]));
    const app = await buildRoutes("   ");

    const response = await app.inject({ url: "/ollama/models" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    await app.close();
  });

  it("never puts a stranger's daemon into the picker", async () => {
    // Reproduces the reported failure directly: a real Ollama IS running on the default port.
    // Before the fix the route connected to it and reported `available: true` with its five real
    // model names; now the address was never named, so the daemon is not consulted.
    const fetchMock = stubFetch(async () =>
      tagsResponse(["qwen3-embedding:8b", "nomic-embed-text:latest"]),
    );
    const app = await buildRoutes(undefined);

    const body = (await app.inject({ url: "/ollama/models" })).json() as {
      available: boolean;
      models: unknown[];
    };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.available).toBe(false);
    expect(body.models).toEqual([]);
    await app.close();
  });

  it("answers with the shape a web client that ignores `configured` still handles", async () => {
    // `configured` is additive. use-models.ts reads only `available` and `models` off this route,
    // and the picker's always-present "Local (Ollama)" section renders
    // {available:false, models:[]} as "not running" — exactly what a stopped daemon has always
    // produced. Nothing on the web side has to change for this response to keep working.
    const fetchMock = stubFetch(async () => tagsResponse([]));
    const app = await buildRoutes(undefined);

    const response = await app.inject({ url: "/ollama/models" });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(body.available).toBe(false);
    expect(body.models).toEqual([]);
    expect(body.configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /ollama/models with a configured daemon", () => {
  it("probes the configured URL's /api/tags and maps the picker's model shape", async () => {
    const fetchMock = stubFetch(async () => tagsResponse(["qwen3:14b"]));
    const app = await buildRoutes("http://127.0.0.1:11434");

    const response = await app.inject({ url: "/ollama/models" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/tags");
    expect(response.json()).toEqual({
      available: true,
      configured: true,
      models: [
        {
          id: "ollama/qwen3:14b",
          label: "qwen3:14b",
          provider: "Ollama",
          tier: "budget",
          context_length: 0,
          pricing: { prompt: 0, completion: 0 },
          modality: "text->text",
          description: "Local Ollama model: qwen3:14b",
        },
      ],
    });
    await app.close();
  });

  it("still strips a trailing slash from the configured URL", async () => {
    const fetchMock = stubFetch(async () => tagsResponse([]));
    const app = await buildRoutes("http://127.0.0.1:11434///");

    await app.inject({ url: "/ollama/models" });

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/tags");
    await app.close();
  });

  it("reports a running daemon with no models pulled as available and empty", async () => {
    stubFetch(async () => tagsResponse([]));
    const app = await buildRoutes("http://127.0.0.1:11434");

    const response = await app.inject({ url: "/ollama/models" });

    expect(response.json()).toEqual({ available: true, configured: true, models: [] });
    await app.close();
  });

  it("reports a non-ok response as unavailable but still configured", async () => {
    const fetchMock = stubFetch(async () => new Response("nope", { status: 503 }));
    const app = await buildRoutes("http://127.0.0.1:11434");

    const response = await app.inject({ url: "/ollama/models" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({ available: false, configured: true, models: [] });
    await app.close();
  });

  it("reports a refused connection as unavailable instead of throwing", async () => {
    const fetchMock = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = await buildRoutes("http://127.0.0.1:11434");

    const response = await app.inject({ url: "/ollama/models" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, configured: true, models: [] });
    await app.close();
  });

  it("aborts a hanging probe after the 2s timeout and reports it unavailable", async () => {
    // The fetch stub settles only when its abort signal fires, so the response can only come
    // from the route's own timeout tripping the AbortController.
    const abortReasons: unknown[] = [];
    const fetchMock = stubFetch(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortReasons.push(init.signal?.reason);
            reject(new Error("aborted"));
          });
        }),
    );
    const app = await buildRoutes("http://127.0.0.1:11434");

    vi.useFakeTimers();
    const pending = app.inject({ url: "/ollama/models" });
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortReasons).toHaveLength(1);
    expect(response.json()).toEqual({ available: false, configured: true, models: [] });
    vi.useRealTimers();
    await app.close();
  });
});

describe("provider registration (agent/models.ts) does not resurrect the default", () => {
  /** A minimal ModelRuntime double: only registerProvider / setRuntimeApiKey are exercised. */
  function fakeRuntime() {
    const registered: { id: string; baseUrl: string }[] = [];
    return {
      registered,
      registerProvider(id: string, options: { baseUrl: string }) {
        registered.push({ id, baseUrl: options.baseUrl });
      },
      async setRuntimeApiKey() {},
    };
  }

  it("registers neither local provider when neither base URL is set", async () => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    vi.resetModules();
    const { setupModelRuntime } = await import("../src/agent/models.ts");
    const runtime = fakeRuntime();

    await setupModelRuntime(runtime as never);

    // Registration is what makes a persisted or hand-typed `ollama/…` ref dispatchable, so
    // leaving it in place would keep the defect alive below the discovery route.
    expect(runtime.registered.map((entry) => entry.id)).not.toContain("ollama");
    expect(runtime.registered.map((entry) => entry.id)).not.toContain("openai-compatible");
  });

  it("registers the ollama provider at the configured URL when one is set", async () => {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/";
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    vi.resetModules();
    const { setupModelRuntime } = await import("../src/agent/models.ts");
    const runtime = fakeRuntime();

    await setupModelRuntime(runtime as never);

    expect(runtime.registered).toContainEqual({
      id: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(runtime.registered.map((entry) => entry.id)).not.toContain("openai-compatible");
  });

  it("registers the openai-compatible provider at the configured URL when one is set", async () => {
    delete process.env.OLLAMA_BASE_URL;
    process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/";
    vi.resetModules();
    const { setupModelRuntime } = await import("../src/agent/models.ts");
    const runtime = fakeRuntime();

    await setupModelRuntime(runtime as never);

    expect(runtime.registered).toContainEqual({
      id: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(runtime.registered.map((entry) => entry.id)).not.toContain("ollama");
  });

  it("gives an unconfigured local model an unroutable base URL rather than a port guess", async () => {
    delete process.env.OLLAMA_BASE_URL;
    vi.resetModules();
    const { resolveModel } = await import("../src/agent/models.ts");
    // An `ollama/` ref never consults the registry — it goes straight to the local builder — so
    // a stub keeps this off session-registry.ts's very slow import graph.
    const registry = { find: () => undefined };

    const model = resolveModel("ollama/qwen3:14b", registry as never);

    // `.invalid` is reserved by RFC 6761 §6.4 and can never resolve, so even a caller that
    // bypassed the unregistered provider could not reach localhost:11434.
    expect(model.baseUrl).toBe("http://unconfigured.invalid/v1");
    expect(model.baseUrl).not.toContain("11434");
    expect(model.baseUrl).not.toContain("localhost");
  });
});
