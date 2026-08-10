import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

/**
 * /pipelines proxy contract: the routes forward to the workflow engine at
 * PIPELINE_ENGINE_BASE_URL and degrade to 503 (engine:"down") when it is unreachable.
 * The engine is stubbed with a plain http server so this file needs no bun and
 * no vendored engine — it tests Kady's proxy, not the engine.
 */

// Every request the stub saw, so project-scope assertions can check the active
// sandbox identity was resolved before the workflow request reached the engine.
const stubRequests: { method: string; url: string; body: string }[] = [];

const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += String(chunk);
  });
  req.on("end", () => {
    stubRequests.push({ method: req.method ?? "", url: req.url ?? "", body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/api/health") {
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/codebases") {
      res.end(JSON.stringify([]));
      return;
    }
    if (req.method === "POST" && req.url === "/api/codebases") {
      const request = JSON.parse(body || "{}") as {
        path?: string;
        registrationMode?: string;
        name?: string;
      };
      res.end(JSON.stringify({ id: "stub-codebase", default_cwd: request.path }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/workflows?")) {
      res.end(JSON.stringify({ workflows: [{ name: "stub-flow" }], recommended: [] }));
      return;
    }
    if (req.method === "PUT" && req.url?.startsWith("/api/workflows/")) {
      res.end(JSON.stringify({ saved: true, echoed: JSON.parse(body || "null") }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: `stub has no route for ${req.method} ${req.url}` }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as AddressInfo).port;

// PIPELINE_ENGINE_BASE_URL is read at config.ts import time, so it must be set before
// the app module graph loads — hence the dynamic import below.
process.env.PIPELINE_ENGINE_BASE_URL = `http://127.0.0.1:${stubPort}`;
const { buildApp } = await import("../src/index.ts");
const app = await buildApp({ workflowController: null });

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("pipelines proxy (engine up)", () => {
  it("reports healthy:true when the engine answers /api/health", async () => {
    const res = await app.inject({ method: "GET", url: "/pipelines/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ healthy: true });
  });

  it("resolves and forwards the active project scope with the workflow list", async () => {
    const res = await app.inject({ method: "GET", url: "/pipelines" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workflows: [{ name: "stub-flow", codebaseId: "stub-codebase" }],
      recommended: [],
    });
    const seen = stubRequests.at(-1)!;
    expect(seen.method).toBe("GET");
    const workflowUrl = new URL(seen.url, "http://pipeline-engine.test");
    expect(workflowUrl.pathname).toBe("/api/workflows");
    expect(workflowUrl.searchParams.get("codebaseId")).toBe("stub-codebase");
    const registration = stubRequests.findLast(
      (request) => request.method === "POST" && request.url === "/api/codebases",
    );
    const resolvedCwd = (JSON.parse(registration?.body ?? "{}") as { path?: string }).path;
    expect(resolvedCwd).toMatch(/\/default\/sandbox$/);
    expect(JSON.parse(registration?.body ?? "{}")).toMatchObject({
      registrationMode: "workspace",
      name: "kady/default",
    });
    expect(workflowUrl.searchParams.get("cwd")).toBe(resolvedCwd);
  });

  it("preserves the save body while forwarding the active project scope", async () => {
    const definition = { name: "demo", nodes: [{ id: "n1", type: "agent" }] };
    const res = await app.inject({
      method: "PUT",
      url: "/pipelines/demo",
      payload: definition,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true, echoed: definition });
    const seen = stubRequests.at(-1)!;
    expect(seen.method).toBe("PUT");
    const workflowUrl = new URL(seen.url, "http://pipeline-engine.test");
    expect(workflowUrl.pathname).toBe("/api/workflows/demo");
    expect(workflowUrl.searchParams.get("codebaseId")).toBe("stub-codebase");
    const registration = stubRequests.findLast(
      (request) => request.method === "POST" && request.url === "/api/codebases",
    );
    const resolvedCwd = (JSON.parse(registration?.body ?? "{}") as { path?: string }).path;
    expect(resolvedCwd).toMatch(/\/default\/sandbox$/);
    expect(workflowUrl.searchParams.get("cwd")).toBe(resolvedCwd);
    expect(JSON.parse(seen.body)).toEqual(definition);
  });
});

describe("pipelines proxy (engine down)", () => {
  // Kill the stub once; the port then refuses connections, which is exactly
  // the "engine not running" case the proxy must map to healthy:false / 503.
  it("reports healthy:false when the engine is unreachable", async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    const res = await app.inject({ method: "GET", url: "/pipelines/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ healthy: false });
  });

  it("maps an unreachable engine to 503 with engine:'down'", async () => {
    const res = await app.inject({ method: "GET", url: "/pipelines" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { engine?: string; detail?: string };
    expect(body.engine).toBe("down");
    expect(body.detail).toContain("unreachable");
  });
});
