/**
 * OPENAI_COMPATIBLE_BASE_URL has no default (#57).
 *
 * The local OpenAI-compatible server (LM Studio, vLLM, text-generation-webui, …) is optional and
 * has to be pointed at explicitly. While the config carried a `http://localhost:1234` fallback,
 * /openai-compatible/models read OPENAI_COMPATIBLE_CONFIGURED into the *response* and then
 * fetched unconditionally anyway — so the flag shaped the answer and suppressed nothing. An
 * install that had never named a server replied `{available:false, configured:false, models:[]}`
 * while the process had already resolved `localhost` and connected to :1234, reading whatever
 * unrelated dev server happened to be listening there. Identical in shape to NT-4, which this
 * lane already fixed for RAINDROP_BASE_URL; see server/test/raindrop-base-url.test.ts.
 *
 * These tests pin both halves: unconfigured performs NO fetch at all and answers an explicit
 * unconfigured state, while a configured URL behaves exactly as it did before — same `/v1/models`
 * probe, same 2s timeout/abort, same available / unavailable / refused / timed-out reporting.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;

/**
 * config.ts reads the environment once at import, so both the config module and the route that
 * closed over it have to be loaded fresh per test with OPENAI_COMPATIBLE_BASE_URL already in
 * place.
 */
async function buildRoutes(envBaseUrl: string | undefined) {
  if (envBaseUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  else process.env.OPENAI_COMPATIBLE_BASE_URL = envBaseUrl;
  vi.resetModules();
  const { registerSystemRoutes } = await import("../src/api/system.ts");
  const app = Fastify();
  await registerSystemRoutes(app);
  return app;
}

/** A fetch stub that fails loudly if the route ever reaches it. */
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

function modelsListResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  if (originalBaseUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("OPENAI_COMPATIBLE_BASE_URL", () => {
  it("is undefined when the environment does not set it (no localhost default)", async () => {
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    vi.resetModules();
    const { OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_CONFIGURED } = await import(
      "../src/config.ts"
    );
    expect(OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
    expect(OPENAI_COMPATIBLE_CONFIGURED).toBe(false);
  });

  it("treats a blank value as unset rather than as a URL", async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "";
    vi.resetModules();
    const { OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_CONFIGURED } = await import(
      "../src/config.ts"
    );
    expect(OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
    expect(OPENAI_COMPATIBLE_CONFIGURED).toBe(false);
  });

  it("treats a whitespace-only value as unset rather than as a URL", async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "   ";
    vi.resetModules();
    const { OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_CONFIGURED } = await import(
      "../src/config.ts"
    );
    expect(OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
    expect(OPENAI_COMPATIBLE_CONFIGURED).toBe(false);
  });

  it("keeps a configured value verbatim apart from surrounding whitespace", async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "  http://127.0.0.1:7799  ";
    vi.resetModules();
    const { OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_CONFIGURED } = await import(
      "../src/config.ts"
    );
    expect(OPENAI_COMPATIBLE_BASE_URL).toBe("http://127.0.0.1:7799");
    expect(OPENAI_COMPATIBLE_CONFIGURED).toBe(true);
  });
});

describe("GET /openai-compatible/models with no configured server", () => {
  it("performs no outbound fetch at all", async () => {
    const fetchMock = stubFetch(async () => modelsListResponse(["someone-elses-model"]));
    const app = await buildRoutes(undefined);

    const response = await app.inject({ url: "/openai-compatible/models" });

    // The whole point of #57: the flag must suppress the probe, not just label it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    await app.close();
  });

  it("performs no outbound fetch when the value is blank either", async () => {
    const fetchMock = stubFetch(async () => modelsListResponse(["someone-elses-model"]));
    const app = await buildRoutes("");

    const response = await app.inject({ url: "/openai-compatible/models" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    await app.close();
  });

  it("performs no outbound fetch when the value is whitespace either", async () => {
    const fetchMock = stubFetch(async () => modelsListResponse(["someone-elses-model"]));
    const app = await buildRoutes("   ");

    const response = await app.inject({ url: "/openai-compatible/models" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    await app.close();
  });

  it("never lists models belonging to whatever happens to answer on the old default port", async () => {
    // Reproduces the reported failure directly: something IS listening on :1234 and speaks the
    // OpenAI shape. Before the fix the route connected to it and the stub's models could reach
    // the response; now the address was never named, so the server is not consulted.
    const fetchMock = stubFetch(async () => modelsListResponse(["a-stranger/model-7b"]));
    const app = await buildRoutes(undefined);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json() as {
      available: boolean;
      models: unknown[];
    };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.available).toBe(false);
    expect(body.models).toEqual([]);
    await app.close();
  });

  it("answers the unconfigured state as a normal 200, which is the shape the picker already handles", async () => {
    // use-models.ts falls back to exactly {available:false, configured:false, models:[]} on a
    // failed request, and hides the section unless `available` or `configured` holds — so this
    // body needs no client change.
    const fetchMock = stubFetch(async () => modelsListResponse([]));
    const app = await buildRoutes(undefined);

    const response = await app.inject({ url: "/openai-compatible/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, configured: false, models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /openai-compatible/models with a configured server", () => {
  it("probes the configured URL's /v1/models and maps the picker's model shape", async () => {
    const fetchMock = stubFetch(async () => modelsListResponse(["qwen/qwen3-8b"]));
    const app = await buildRoutes("http://127.0.0.1:7799");

    const response = await app.inject({ url: "/openai-compatible/models" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:7799/v1/models");
    expect(response.json()).toEqual({
      available: true,
      configured: true,
      models: [
        {
          id: "openai-compatible/qwen/qwen3-8b",
          label: "qwen/qwen3-8b",
          provider: "OpenAI-Compatible",
          tier: "budget",
          context_length: 0,
          pricing: { prompt: 0, completion: 0 },
          modality: "text->text",
          description: "Local OpenAI-compatible model: qwen/qwen3-8b",
        },
      ],
    });
    await app.close();
  });

  it("still strips a trailing slash from the configured URL", async () => {
    const fetchMock = stubFetch(async () => modelsListResponse([]));
    const app = await buildRoutes("http://127.0.0.1:7799///");

    await app.inject({ url: "/openai-compatible/models" });

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:7799/v1/models");
    await app.close();
  });

  it("reports a non-ok response as unavailable but still configured", async () => {
    const fetchMock = stubFetch(async () => new Response("nope", { status: 503 }));
    const app = await buildRoutes("http://127.0.0.1:7799");

    const response = await app.inject({ url: "/openai-compatible/models" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({ available: false, configured: true, models: [] });
    await app.close();
  });

  it("reports a refused connection as unavailable instead of throwing", async () => {
    const fetchMock = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = await buildRoutes("http://127.0.0.1:7799");

    const response = await app.inject({ url: "/openai-compatible/models" });

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
    const app = await buildRoutes("http://127.0.0.1:7799");

    vi.useFakeTimers();
    const pending = app.inject({ url: "/openai-compatible/models" });
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortReasons).toHaveLength(1);
    expect(response.json()).toEqual({ available: false, configured: true, models: [] });
    vi.useRealTimers();
    await app.close();
  });
});
