/**
 * RAINDROP_BASE_URL has no default (NT-4).
 *
 * The Raindrop Workshop is an OPTIONAL external sibling checkout. While the config carried a
 * `http://localhost:5899` fallback, an install that had never been pointed at a Workshop still
 * made an outbound request from /raindrop/health to whatever happened to listen on that port of
 * the backend's host — and reported a foreign dev server back to the UI as a healthy Workshop.
 * These tests pin the two halves of the fix: unset performs NO fetch at all and answers with an
 * explicit unconfigured state, while a configured URL behaves exactly as it did before,
 * including the 2.5s timeout/abort.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalBaseUrl = process.env.RAINDROP_BASE_URL;

/**
 * config.ts reads the environment once at import, so both the config module and the route that
 * closed over it have to be loaded fresh per test with RAINDROP_BASE_URL already in place.
 */
async function buildRoutes(envBaseUrl: string | undefined) {
  if (envBaseUrl === undefined) delete process.env.RAINDROP_BASE_URL;
  else process.env.RAINDROP_BASE_URL = envBaseUrl;
  vi.resetModules();
  const { registerRaindropRoutes } = await import("../src/api/raindrop.ts");
  const app = Fastify();
  await registerRaindropRoutes(app);
  return app;
}

afterEach(async () => {
  if (originalBaseUrl === undefined) delete process.env.RAINDROP_BASE_URL;
  else process.env.RAINDROP_BASE_URL = originalBaseUrl;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("RAINDROP_BASE_URL", () => {
  it("is undefined when the environment does not set it (no localhost default)", async () => {
    delete process.env.RAINDROP_BASE_URL;
    vi.resetModules();
    const { RAINDROP_BASE_URL } = await import("../src/config.ts");
    expect(RAINDROP_BASE_URL).toBeUndefined();
  });

  it("treats a blank value as unset rather than as a URL", async () => {
    process.env.RAINDROP_BASE_URL = "   ";
    vi.resetModules();
    const { RAINDROP_BASE_URL } = await import("../src/config.ts");
    expect(RAINDROP_BASE_URL).toBeUndefined();
  });

  it("keeps a configured value verbatim apart from surrounding whitespace", async () => {
    process.env.RAINDROP_BASE_URL = "  http://127.0.0.1:7788  ";
    vi.resetModules();
    const { RAINDROP_BASE_URL } = await import("../src/config.ts");
    expect(RAINDROP_BASE_URL).toBe("http://127.0.0.1:7788");
  });
});

describe("GET /raindrop/health with no configured Workshop", () => {
  it("performs no outbound fetch at all", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes(undefined);

    const response = await app.inject({ url: "/raindrop/health" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ healthy: false, configured: false });
  });

  it("answers the unconfigured state rather than an error, so the tab keeps its native panel", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes(undefined);

    const response = await app.inject({ url: "/raindrop/health" });
    const body = response.json() as { healthy?: boolean; configured?: boolean };

    // raindropHealth() in the web client reads only `healthy`; false keeps the Workshop toggle
    // hidden and leaves the Raindrop view as the native session-trace panel.
    expect(Boolean(body.healthy)).toBe(false);
    expect(body.configured).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs no outbound fetch when the value is blank either", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes("  ");

    const response = await app.inject({ url: "/raindrop/health" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ healthy: false, configured: false });
  });
});

describe("GET /raindrop/health with a configured Workshop", () => {
  it("probes the configured URL and reports it healthy", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes("http://127.0.0.1:7788");

    const response = await app.inject({ url: "/raindrop/health" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:7788");
    expect(response.json()).toEqual({ healthy: true, configured: true });
  });

  it("reports a non-ok response as unhealthy", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes("http://127.0.0.1:7788");

    const response = await app.inject({ url: "/raindrop/health" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({ healthy: false, configured: true });
  });

  it("reports a refused connection as unhealthy instead of throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes("http://127.0.0.1:7788");

    const response = await app.inject({ url: "/raindrop/health" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ healthy: false, configured: true });
  });

  it("aborts a hanging probe after the 2.5s timeout and reports it unhealthy", async () => {
    // The fetch stub resolves only when its abort signal fires, so the response can only come
    // from the route's own timeout firing the AbortController.
    const abortReasons: unknown[] = [];
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortReasons.push(init.signal?.reason);
            reject(new Error("aborted"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildRoutes("http://127.0.0.1:7788");

    vi.useFakeTimers();
    const pending = app.inject({ url: "/raindrop/health" });
    await vi.advanceTimersByTimeAsync(2500);
    const response = await pending;

    expect(abortReasons).toHaveLength(1);
    expect(response.json()).toEqual({ healthy: false, configured: true });
  });
});
