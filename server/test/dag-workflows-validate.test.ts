import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { VALIDATE_REQUEST_BODY_LIMIT_BYTES } from "../src/api/dag-workflows-validate.ts";
import type { WorkflowGraphDocument } from "../src/workflows/index.ts";
import {
  GRAPH_HASH_PARITY_DOCUMENT,
  GRAPH_HASH_PARITY_SHA256,
} from "../../web/src/lib/typed-canvas-adapter.fixture.ts";

const app = await buildApp({ workflowController: null });

function headers(projectId = "default", extra: Record<string, string> = {}) {
  return { "x-project-id": projectId, ...extra };
}

function graph(overrides: Partial<WorkflowGraphDocument> = {}): WorkflowGraphDocument {
  return {
    schemaVersion: "1.0",
    id: "validate-workflow",
    name: "Validate workflow",
    entryNodeId: "start",
    defaultModel: {
      requested: {
        source: "kady-current",
        auth: { kind: "kady-current" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    limits: {
      maxIterations: 4,
      maxModelCalls: 4,
      maxParallelism: 1,
      maxSubagents: 1,
      timeoutMs: 60_000,
      maxTokens: 20_000,
      maxCostUsd: 0,
      maxRetries: 1,
    },
    evidence: {
      enabled: false,
      minimumIndependentSources: 0,
      requireArtifactReferences: false,
      onUnsupportedOutput: "fail",
    },
    nodes: [
      {
        id: "start",
        name: "Start",
        kind: "agent",
        terminal: true,
        workspace: { isolation: "read-only", writePaths: [] },
        prompt: "Return one bounded result.",
      },
    ],
    edges: [],
    ...overrides,
  } as WorkflowGraphDocument;
}

function validate(payload: unknown, projectId = "default") {
  return app.inject({
    method: "POST",
    url: "/dag-workflows/validate",
    headers: headers(projectId),
    payload: payload as never,
  });
}

/**
 * Every managed file under the project root, with its bytes. The
 * "writes nothing" assertion has to cover the whole tree rather than one
 * definition file: a route that wrote a lock, an index, or a run record would
 * still be writing.
 */
function projectTreeSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      snapshot[path.relative(PROJECTS_ROOT, absolute)] = fs.readFileSync(absolute, "utf-8");
    }
  };
  walk(PROJECTS_ROOT);
  return snapshot;
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("POST /dag-workflows/validate", () => {
  it("normalizes a valid document and returns its graph hash with no warnings", async () => {
    const response = await validate({ document: graph() });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(body.graphSha256).toMatch(/^[0-9a-f]{64}$/);
    // Normalization is visible in the returned document: absent defaults are
    // filled in, so the client hashes exactly what the store will hash.
    expect(body.document.artifacts).toEqual([]);
    expect(body.document.rescue).toMatchObject({ enabled: true, maxAttempts: 2 });
  });

  it("answers an invalid document with 200 ok:false and per-path issues", async () => {
    const response = await validate({
      document: graph({ entryNodeId: "missing-node" }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) {
      expect(issue.severity).toBe("error");
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
    expect(body).not.toHaveProperty("document");
  });

  it("is hash-stable under key reordering", async () => {
    const document = graph();
    const reordered = Object.fromEntries(
      Object.entries(document as unknown as Record<string, unknown>).reverse(),
    ) as unknown as WorkflowGraphDocument;

    const first = await validate({ document });
    const second = await validate({ document: reordered });

    expect(first.json().graphSha256).toBe(second.json().graphSha256);
  });

  it("mints the same graph hash the definition store mints", async () => {
    const document = graph();
    const validated = await validate({ document });
    const saved = await app.inject({
      method: "PUT",
      url: "/dag-workflows/validate-workflow",
      headers: headers("default", { "if-none-match": "*" }),
      payload: document as never,
    });

    expect(saved.statusCode).toBe(201);
    // The store canonicalizes with its own private implementation. If the two
    // ever diverge, "validate then save" would report two identities for one
    // document and CAS retries would chase a hash the store never wrote.
    expect(validated.json().graphSha256).toBe(saved.json().definition.graphSha256);
  });

  it("agrees with the browser canonicalizer on the shared parity fixture", async () => {
    const document = GRAPH_HASH_PARITY_DOCUMENT as unknown as WorkflowGraphDocument;
    const validated = await validate({ document });
    expect(validated.json().ok).toBe(true);
    expect(validated.json().graphSha256).toBe(GRAPH_HASH_PARITY_SHA256);

    const saved = await app.inject({
      method: "PUT",
      url: `/dag-workflows/${GRAPH_HASH_PARITY_DOCUMENT.id}`,
      headers: headers("default", { "if-none-match": "*" }),
      payload: document as never,
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().definition.graphSha256).toBe(GRAPH_HASH_PARITY_SHA256);
  });

  it("accepts the additive optional provenance / meta fields and preserves them", async () => {
    const response = await validate({
      document: GRAPH_HASH_PARITY_DOCUMENT as unknown as WorkflowGraphDocument,
    });

    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.document.provenance).toMatchObject({ source: "library-template" });
    expect(body.document.nodes[0].settings).toEqual({ harness: "codex" });
    expect(body.document.nodes[1].meta).toMatchObject({
      compositeOf: { kind: "dag-workflow", sourceId: "reporting-tail" },
    });
  });

  // Round 1 carried a document-level `ui.viewport`. It was stored and never
  // read, so it bought a rollback constraint and no behaviour and was dropped.
  // This pins the removal: a schema that quietly re-accepted `ui` would let the
  // inert field back into every persisted document without anyone noticing.
  it("rejects a document-level ui object, which no longer exists in the schema", async () => {
    const response = await validate({
      document: {
        ...(GRAPH_HASH_PARITY_DOCUMENT as unknown as WorkflowGraphDocument),
        ui: { viewport: { x: -120, y: 40, zoom: 0.75 } },
      } as unknown as WorkflowGraphDocument,
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body.issues)).toContain("additional properties");
  });

  it("writes nothing", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/dag-workflows/validate-workflow",
      headers: headers("default", { "if-none-match": "*" }),
      payload: graph() as never,
    });
    expect(created.statusCode).toBe(201);
    const before = projectTreeSnapshot();

    const mutated = await validate({
      document: graph({ name: "A different name entirely" }),
    });
    expect(mutated.json().ok).toBe(true);
    const invalid = await validate({ document: graph({ entryNodeId: "nope" }) });
    expect(invalid.json().ok).toBe(false);

    expect(projectTreeSnapshot()).toEqual(before);
  });

  it("rejects an unparseable or malformed request body with 400 and nothing else", async () => {
    const notJson = await app.inject({
      method: "POST",
      url: "/dag-workflows/validate",
      headers: headers("default", { "content-type": "application/json" }),
      payload: "{ this is not json",
    });
    expect(notJson.statusCode).toBe(400);

    for (const payload of [{}, { document: null }, { document: "a string" }, { document: [] }]) {
      const response = await validate(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_VALIDATE_REQUEST");
    }

    const badOptions = await validate({ document: graph(), options: "flatten" });
    expect(badOptions.statusCode).toBe(400);
  });

  it("answers a body over the 1 MiB cap with 413", async () => {
    const oversized = graph({
      description: "x".repeat(VALIDATE_REQUEST_BODY_LIMIT_BYTES + 1024),
    });

    const response = await validate({ document: oversized });

    expect(response.statusCode).toBe(413);
  });

  it("scopes identically to the definition PUT it guards", async () => {
    // Same project-scope hook, same answer: a write-shaped request naming an
    // unknown project is refused before the handler runs.
    const validated = await validate({ document: graph() }, "no-such-project");
    const written = await app.inject({
      method: "PUT",
      url: "/dag-workflows/validate-workflow",
      headers: headers("no-such-project", { "if-none-match": "*" }),
      payload: graph() as never,
    });

    expect(validated.statusCode).toBe(404);
    expect(written.statusCode).toBe(404);
    expect(validated.json().reason).toBe("unknown_project");
  });
});
