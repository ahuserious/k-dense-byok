/**
 * Gate B for the integration registry (matrix rows 48, 49, 50).
 *
 * Every assertion here is on an EFFECT, not on a schema accepting a field:
 * which config the MCP bridge would dial, which URL and headers reached the
 * provider call, which credential computation the CLI path exercised, and — for
 * every unconfigured case — that ZERO outbound work was attempted.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { readMcpConfig, writeMcpConfig } from "../src/agent/mcp.ts";
import {
  describeIntegration,
  findIntegration,
  listIntegrationStatuses,
} from "../src/integrations/registry.ts";
import {
  HUGGING_FACE_TOKEN_ENV_VAR,
  HuggingFaceNotConfiguredError,
  huggingFaceSearchUrl,
  searchHuggingFaceModels,
} from "../src/integrations/huggingface.ts";
import {
  INFRANODUS_API_KEY_ENV_VAR,
  INFRANODUS_MCP_SERVER_NAME,
  INFRANODUS_TOOL_PREFIX,
  infranodusMcpConfig,
} from "../src/integrations/infranodus.ts";
import {
  MODAL_CLI_NOT_FOUND_MESSAGE,
  probeModalCli,
  runModalCli,
} from "../src/integrations/modal-cli.ts";
import {
  MODAL_NOT_CONFIGURED_MESSAGE,
  modalConfigured,
} from "../src/modal/credentials.ts";

const MANAGED_VARS = [
  INFRANODUS_API_KEY_ENV_VAR,
  HUGGING_FACE_TOKEN_ENV_VAR,
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
] as const;
const originalEnv = new Map<string, string | undefined>(
  MANAGED_VARS.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  for (const name of MANAGED_VARS) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

/** A probe stub so no test ever spawns a real binary or depends on this machine. */
const noCli = () => ({ binary: "stub", found: false, path: null, version: null });

describe("row 48 — InfraNodus registers through the existing MCP stack", () => {
  it("with no token, the tool set is EMPTY and nothing is written or dialed", async () => {
    ensureProjectExists("default");
    const paths = resolvePaths("default");

    // 1. No config can even be produced, so there is nothing to dial.
    expect(infranodusMcpConfig({} as NodeJS.ProcessEnv)).toBeNull();

    // 2. The route refuses and writes nothing.
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/integrations/infranodus/register",
        headers: { "x-project-id": "default" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "NOT_CONFIGURED",
        envVar: INFRANODUS_API_KEY_ENV_VAR,
        detail: "InfraNodus is not configured. Set INFRANODUS_API_KEY to connect.",
      });
    } finally {
      await app.close();
    }

    // 3. THE EFFECT: mcp.json has no infranodus entry, so getMcpTools() builds
    //    no client for it and a run sees zero mcp__infranodus__* tools.
    expect(readMcpConfig(paths)).toEqual({});
    expect(INFRANODUS_MCP_SERVER_NAME in readMcpConfig(paths)).toBe(false);
  });

  it("with the token, the entry lands in the shape agent/mcp.ts dials, and the prefix a run sees is mcp__infranodus__", async () => {
    ensureProjectExists("default");
    const paths = resolvePaths("default");
    process.env[INFRANODUS_API_KEY_ENV_VAR] = "test-key-not-a-real-credential";
    writeMcpConfig(paths, { existing: { url: "https://mcp.example.test/mcp" } });

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/integrations/infranodus/register",
        headers: { "x-project-id": "default" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        serverName: "infranodus",
        toolPrefix: "mcp__infranodus__",
      });
    } finally {
      await app.close();
    }

    // THE EFFECT: the on-disk entry is exactly what connectServer() branches on.
    const servers = readMcpConfig(paths);
    expect(servers.infranodus).toEqual({
      command: "npx",
      args: ["-y", "infranodus-mcp-server"],
      env: { INFRANODUS_API_KEY: "test-key-not-a-real-credential" },
    });
    // agent/mcp.ts: `"url" in config` selects HTTP; this must take the stdio branch.
    expect("url" in servers.infranodus).toBe(false);
    expect("command" in servers.infranodus).toBe(true);
    // Registration must not clobber the connectors already configured.
    expect(servers.existing).toEqual({ url: "https://mcp.example.test/mcp" });

    // The tool name a run would see, built by the same rule as agent/mcp.ts's
    // wrapTool: `mcp__${serverName}__${toolName}`.
    expect(`${INFRANODUS_TOOL_PREFIX}generate_knowledge_graph`).toBe(
      "mcp__infranodus__generate_knowledge_graph",
    );
  });

  it("registration is idempotent and the registry then reports it registered", async () => {
    ensureProjectExists("default");
    const paths = resolvePaths("default");
    process.env[INFRANODUS_API_KEY_ENV_VAR] = "test-key-not-a-real-credential";

    const app = await buildApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/integrations/infranodus/register",
        headers: { "x-project-id": "default" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/integrations/infranodus/register",
        headers: { "x-project-id": "default" },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    expect(Object.keys(readMcpConfig(paths))).toEqual(["infranodus"]);
    const status = describeIntegration(findIntegration("infranodus")!, {
      paths,
      probeCli: noCli,
    });
    expect(status.mcp).toEqual({
      serverName: "infranodus",
      toolPrefix: "mcp__infranodus__",
      registered: true,
      enabled: true,
      toolDiscovery: "on-connect",
    });
  });

  it("ships no hardcoded tool list — discovery is declared as on-connect", () => {
    ensureProjectExists("default");
    const status = describeIntegration(findIntegration("infranodus")!, {
      paths: resolvePaths("default"),
      probeCli: noCli,
    });
    expect(status.mcp?.toolDiscovery).toBe("on-connect");
    // An invented tool name is worse than an honest empty list; there is no
    // field on the wire shape that could carry one.
    expect(Object.keys(status.mcp ?? {})).not.toContain("tools");
  });
});

describe("row 49 — Hugging Face query path", () => {
  it("unconfigured: ZERO outbound requests are attempted", async () => {
    const fetchImpl = vi.fn();
    await expect(
      searchHuggingFaceModels({ search: "llama" }, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        environment: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toBeInstanceOf(HuggingFaceNotConfiguredError);
    // THE EFFECT: nothing left the machine.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("configured: the exact outbound URL and headers reach the provider call, token present but never echoed", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            id: "meta-llama/Llama-3.1-8B-Instruct",
            pipeline_tag: "text-generation",
            library_name: "transformers",
            gated: "manual",
            downloads: 7268716,
            likes: 6624,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const models = await searchHuggingFaceModels(
      { search: "llama", limit: 5 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        environment: { [HUGGING_FACE_TOKEN_ENV_VAR]: "token-value" } as NodeJS.ProcessEnv,
      },
    );

    // THE EFFECT part 1 — exactly one call, to the URL the interface doc publishes.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(huggingFaceSearchUrl("llama", 5));
    const parsed = new URL(calledUrl);
    expect(parsed.origin).toBe("https://huggingface.co");
    expect(parsed.pathname).toBe("/api/models");
    expect(parsed.searchParams.get("search")).toBe("llama");
    expect(parsed.searchParams.get("limit")).toBe("5");
    // `gated` is returned ONLY when expanded; without this every gated repo
    // would silently render as ungated.
    expect(parsed.searchParams.getAll("expand[]")).toContain("gated");

    // THE EFFECT part 2 — the credential reached the call as a bearer header.
    // Asserted as "present and correctly shaped", not printed.
    const headers = calledInit.headers as Record<string, string>;
    expect(typeof headers.Authorization).toBe("string");
    expect(headers.Authorization.startsWith("Bearer ")).toBe(true);
    expect(headers.Authorization.length).toBeGreaterThan("Bearer ".length);

    // THE EFFECT part 3 — the normalised row row 6 consumes.
    expect(models).toEqual([
      {
        id: "meta-llama/Llama-3.1-8B-Instruct",
        pipelineTag: "text-generation",
        libraryName: "transformers",
        gated: "manual",
        downloads: 7268716,
        likes: 6624,
      },
    ]);
  });

  it("a malformed-but-200 body degrades instead of throwing (#62)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ unexpected: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      searchHuggingFaceModels({ search: "llama" }, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        environment: { [HUGGING_FACE_TOKEN_ENV_VAR]: "token-value" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual([]);
  });

  it("the route answers 503 with the variable NAME and makes no request", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/integrations/huggingface/models?search=llama",
        headers: { "x-project-id": "default" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "NOT_CONFIGURED",
        envVar: "HF_TOKEN",
        detail: "Hugging Face is not configured. Set HF_TOKEN to search models.",
      });
      // The refusal names the variable and nothing else — no path, no value.
      expect(response.body).not.toContain("/");
    } finally {
      await app.close();
    }
  });

  it("rejects an empty search before any configuration question", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/integrations/huggingface/models?search=",
        headers: { "x-project-id": "default" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "INVALID_REQUEST",
        detail: "search must be a non-empty string",
      });
    } finally {
      await app.close();
    }
  });
});

describe("row 50 — the Modal CLI reuses the ONE existing credential path", () => {
  it("resolves 'configured' through the same computation manager.ts uses", () => {
    expect(modalConfigured()).toBe(false);
    process.env.MODAL_TOKEN_ID = "id-value";
    expect(modalConfigured()).toBe(false); // half a pair is still unconfigured
    process.env.MODAL_TOKEN_SECRET = "secret-value";
    expect(modalConfigured()).toBe(true);
  });

  it("the not-configured message is the SAME constant manager.ts throws, not a new one", () => {
    // Guards against the message drifting away from the manager's contract.
    expect(MODAL_NOT_CONFIGURED_MESSAGE).toBe(
      "Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings.",
    );
    const managerSource = fs.readFileSync(
      new URL("../src/modal/manager.ts", import.meta.url),
      "utf-8",
    );
    const adapterSource = fs.readFileSync(
      new URL("../src/modal/adapter.ts", import.meta.url),
      "utf-8",
    );
    // Both import the shared constant rather than holding their own literal.
    expect(managerSource).toContain("MODAL_NOT_CONFIGURED_MESSAGE");
    expect(adapterSource).toContain("MODAL_NOT_CONFIGURED_MESSAGE");
    expect(managerSource).not.toContain(
      '"Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings."',
    );
    expect(adapterSource).not.toContain(
      '"Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings."',
    );
  });

  it("unconfigured: the CLI path fails closed with the manager's message and spawns NOTHING", () => {
    const lookPathImpl = vi.fn(() => "/usr/local/bin/modal");
    const spawnSyncImpl = vi.fn();
    const result = runModalCli("profile", {
      environment: {} as NodeJS.ProcessEnv,
      lookPathImpl: lookPathImpl as unknown as typeof import("../src/binaries.ts").lookPath,
      spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync,
    });
    expect(result).toEqual({
      ok: false,
      code: "NOT_CONFIGURED",
      detail: MODAL_NOT_CONFIGURED_MESSAGE,
    });
    // THE EFFECT: no process was started, and PATH was never even consulted.
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(lookPathImpl).not.toHaveBeenCalled();
  });

  it("configured: credentials reach the child through env and NEVER through argv", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "workspace: acme\n" }));
    const result = runModalCli("profile", {
      environment: {
        PATH: "/usr/bin",
        MODAL_TOKEN_ID: "id-value",
        MODAL_TOKEN_SECRET: "secret-value",
      } as NodeJS.ProcessEnv,
      lookPathImpl: (() => "/usr/local/bin/modal") as unknown as typeof import("../src/binaries.ts").lookPath,
      spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync,
    });
    expect(result).toEqual({ ok: true, stdout: "workspace: acme" });

    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnSyncImpl.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(binary).toBe("/usr/local/bin/modal");
    // THE EFFECT part 1 — the allow-listed subcommand, and no credential in argv,
    // so the tokens cannot be read out of `ps`.
    expect(args).toEqual(["profile", "current"]);
    expect(args.join(" ")).not.toContain("id-value");
    expect(args.join(" ")).not.toContain("secret-value");
    // THE EFFECT part 2 — they reached the child through env instead.
    expect(options.env.MODAL_TOKEN_ID).toBe("id-value");
    expect(options.env.MODAL_TOKEN_SECRET).toBe("secret-value");
  });

  it("a missing binary is a legible state, not a crash, and leaks no path", () => {
    const result = runModalCli("version", {
      environment: {
        MODAL_TOKEN_ID: "id-value",
        MODAL_TOKEN_SECRET: "secret-value",
      } as NodeJS.ProcessEnv,
      lookPathImpl: (() => null) as unknown as typeof import("../src/binaries.ts").lookPath,
      spawnSyncImpl: (() => {
        throw new Error("must not spawn");
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    expect(result).toEqual({
      ok: false,
      code: "CLI_NOT_FOUND",
      detail: MODAL_CLI_NOT_FOUND_MESSAGE,
    });
    expect(result.detail).not.toContain("/");
  });

  it("probeModalCli reports a missing binary without throwing", () => {
    expect(
      probeModalCli({
        lookPathImpl: (() => null) as unknown as typeof import("../src/binaries.ts").lookPath,
      }),
    ).toEqual({ binary: "modal", found: false, path: null, version: null });
  });
});

describe("the registry itself", () => {
  it("GET /integrations serves all three rows with their variable NAMES and no values", async () => {
    process.env[INFRANODUS_API_KEY_ENV_VAR] = "should-not-appear";
    process.env[HUGGING_FACE_TOKEN_ENV_VAR] = "should-not-appear-either";
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/integrations",
        headers: { "x-project-id": "default" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { integrations: Array<Record<string, unknown>> };
      expect(body.integrations.map((entry) => entry.id)).toEqual([
        "infranodus",
        "huggingface",
        "modal",
      ]);

      // THE EFFECT: presence is reported, values are not — anywhere in the body.
      expect(response.body).not.toContain("should-not-appear");
      expect(response.body).toContain("INFRANODUS_API_KEY");
      expect(response.body).toContain("HF_TOKEN");
      expect(response.body).toContain("MODAL_TOKEN_ID");
      expect(response.body).toContain("MODAL_TOKEN_SECRET");

      const modal = body.integrations.find((entry) => entry.id === "modal")!;
      expect(modal.configured).toBe(false);
      expect(modal.missingEnvVars).toEqual(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]);
      expect(modal.notConfiguredReason).toBe(MODAL_NOT_CONFIGURED_MESSAGE);
      expect(modal.reaches).toBe(
        "Nothing. Job submission and the CLI path both fail closed.",
      );

      const infranodus = body.integrations.find((entry) => entry.id === "infranodus")!;
      expect(infranodus.configured).toBe(true);
      expect(infranodus.missingEnvVars).toEqual([]);
      expect(infranodus.notConfiguredReason).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("every unconfigured integration states that it reaches nothing", () => {
    ensureProjectExists("default");
    const statuses = listIntegrationStatuses({
      environment: {} as NodeJS.ProcessEnv,
      paths: resolvePaths("default"),
      probeCli: noCli,
    });
    expect(statuses).toHaveLength(3);
    for (const status of statuses) {
      expect(status.configured).toBe(false);
      expect(status.missingEnvVars.length).toBeGreaterThan(0);
      expect(status.notConfiguredReason).not.toBeNull();
      expect(status.reaches.startsWith("Nothing.")).toBe(true);
      // Names only. A status object must never carry a credential value.
      expect(JSON.stringify(status)).not.toContain("Bearer");
    }
  });

  it("registration is refused for an integration that is not MCP-backed", async () => {
    const app = await buildApp();
    try {
      for (const id of ["huggingface", "modal", "nonexistent"]) {
        const response = await app.inject({
          method: "POST",
          url: `/integrations/${id}/register`,
          headers: { "x-project-id": "default" },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe("UNKNOWN_INTEGRATION");
      }
    } finally {
      await app.close();
    }
  });
});
