import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  ensureProjectExists,
  resolvePaths,
  type ProjectPaths,
} from "../src/projects.ts";
import {
  disposeAllWorkflowDelegationSessions,
  disposeWorkflowDelegationSession,
  getOrCreateWorkflowDelegationSession,
  workflowDelegationSessionCount,
  workflowDelegationSessionSnapshot,
} from "../src/agent/workflow-delegation-session.ts";
import { dagFusionPackageDir } from "../src/agent/dag-fusion-bridge.ts";
import {
  disposeProjectSessions,
  getOrCreateProfileSession,
} from "../src/agent/session-registry.ts";
import {
  WorkflowModelResolutionError,
  resolveWorkflowModel,
  type WorkflowModelResolutionDependencies,
} from "../src/agent/workflow-model-resolution.ts";
import type { ModelRequest, RequestedModel } from "../src/workflows/schema.ts";

const PROJECT_ID = "workflow-delegation-test";

beforeEach(async () => {
  await disposeAllWorkflowDelegationSessions();
  disposeProjectSessions(PROJECT_ID);
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterEach(async () => {
  await disposeAllWorkflowDelegationSessions();
  disposeProjectSessions(PROJECT_ID);
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function piModel(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "http://127.0.0.1.invalid/v1",
    reasoning,
    ...(reasoning
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  };
}

type FixedModel = Extract<RequestedModel, { source: "fixed" }>;

function fixed(
  provider: string,
  model: string,
  auth: FixedModel["auth"]["kind"],
  reasoning: FixedModel["reasoning"] = "high",
  profile?: string,
): FixedModel {
  return {
    source: "fixed",
    provider,
    model,
    auth: { kind: auth, ...(profile ? { profile } : {}) },
    reasoning,
  };
}

function exact(requested: RequestedModel): ModelRequest {
  return { requested, resolution: { mode: "exact" } };
}

function context(paths: ProjectPaths, sessionId?: string) {
  return {
    manifest: { projectId: paths.id, ...(sessionId ? { sessionId } : {}) },
    paths,
  };
}

function dependencies(
  overrides: Partial<WorkflowModelResolutionDependencies> = {},
): WorkflowModelResolutionDependencies {
  return {
    resolveFixedModel: (requested) => piModel(requested.provider, requested.model),
    resolveConfiguredDefaultModel: () => piModel("openrouter", "default/model"),
    authenticateModel: async () => {},
    loadMainKadySessionModel: async () => piModel("openrouter", "session/model"),
    ...overrides,
  };
}

describe("dedicated workflow delegation session", () => {
  it("keeps one headless in-memory Pi host per project and disposes it deterministically", async () => {
    const paths = ensureProjectExists(PROJECT_ID);
    const [first, second] = await Promise.all([
      getOrCreateWorkflowDelegationSession(PROJECT_ID, paths),
      getOrCreateWorkflowDelegationSession(PROJECT_ID, paths),
    ]);

    expect(second).toBe(first);
    expect(workflowDelegationSessionCount()).toBe(1);
    expect(first.session.sessionManager.isPersisted()).toBe(false);
    expect(first.session.sessionFile).toBeUndefined();
    expect(first.session.getActiveToolNames()).toEqual([]);
    expect(first.host.snapshot().pending).toEqual([]);
    await expect(workflowDelegationSessionSnapshot(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      disposed: false,
      host: { pending: [], quarantined: [] },
    });

    const loadedPaths = first.session.resourceLoader
      .getExtensions()
      .extensions.map((extension) => extension.resolvedPath);
    expect(loadedPaths.some((entry) => /pi-subagents/.test(entry))).toBe(true);
    expect(loadedPaths.some((entry) => /dag-fusion-drive/.test(entry))).toBe(true);

    await first.dispose();
    await first.dispose();
    expect(first.disposed).toBe(true);
    expect(workflowDelegationSessionCount()).toBe(0);
    expect(first.host.snapshot().disposed).toBe(true);
    await expect(workflowDelegationSessionSnapshot(PROJECT_ID)).resolves.toBeUndefined();

    const replacement = await getOrCreateWorkflowDelegationSession(PROJECT_ID, paths);
    expect(replacement).not.toBe(first);
    await disposeWorkflowDelegationSession(PROJECT_ID);
    expect(replacement.disposed).toBe(true);
  });

  it("rejects mismatched project paths before registering a host", async () => {
    const wrongPaths = ensureProjectExists("workflow-delegation-other");
    await expect(
      getOrCreateWorkflowDelegationSession(PROJECT_ID, wrongPaths),
    ).rejects.toThrow(/does not match paths/);
    expect(workflowDelegationSessionCount()).toBe(0);
  });

  it("fails before creating a host when project package settings are malformed", async () => {
    const paths = ensureProjectExists(PROJECT_ID);
    const piDir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "settings.json"), "{not-json");

    await expect(
      getOrCreateWorkflowDelegationSession(PROJECT_ID, paths),
    ).rejects.toThrow(/missing or malformed/);
    expect(workflowDelegationSessionCount()).toBe(0);
  });

  it("accepts an already-present canonical child package registration", async () => {
    const paths = ensureProjectExists(PROJECT_ID);
    const piDir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({ packages: [dagFusionPackageDir()] }),
    );

    const session = await getOrCreateWorkflowDelegationSession(PROJECT_ID, paths);
    expect(session.host.snapshot().disposed).toBe(false);
    const settings = JSON.parse(
      fs.readFileSync(path.join(piDir, "settings.json"), "utf8"),
    ) as { packages: unknown[] };
    expect(settings.packages).toContain(dagFusionPackageDir());
  });

  it("honours an explicit project distrust decision before creating a host", async () => {
    const paths = ensureProjectExists(PROJECT_ID);
    const trustStore = new ProjectTrustStore(getAgentDir());
    trustStore.set(paths.sandbox, false);
    try {
      await expect(
        getOrCreateWorkflowDelegationSession(PROJECT_ID, paths),
      ).rejects.toThrow(/project resources are not trusted/);
      expect(workflowDelegationSessionCount()).toBe(0);
    } finally {
      trustStore.set(paths.sandbox, null);
    }
  });
});

describe("strict workflow model resolution", () => {
  it.each([
    ["openrouter", "anthropic/claude-sonnet-4", "api-key", "pi"],
    ["nvidia", "meta/llama-3.3-70b-instruct", "api-key", "pi"],
    ["ollama", "qwen3:32b", "local", "local"],
    ["openai-compatible", "lab/model", "custom", "custom"],
    ["openai-codex", "gpt-5.4", "oauth", "pi"],
  ] as const)(
    "resolves exact %s ownership without changing model or reasoning",
    async (provider, modelId, auth, runtime) => {
      const paths = resolvePaths(PROJECT_ID);
      const request = exact(fixed(provider, modelId, auth, "xhigh"));
      const resolved = await resolveWorkflowModel(
        request,
        context(paths),
        dependencies(),
      );

      expect(resolved.model).toMatchObject({ provider, id: modelId });
      expect(resolved.receipt).toEqual({
        request,
        resolved: {
          provider,
          model: modelId,
          auth: { kind: auth },
          reasoning: "xhigh",
          runtime,
        },
        fallbackUsed: false,
      });
    },
  );

  it.each([
    ["ollama", "qwen3:32b", "local"],
    ["openai-compatible", "lab/model", "custom"],
  ] as const)(
    "rejects exact non-reasoning %s requests before authentication",
    async (provider, modelId, auth) => {
      const paths = resolvePaths(PROJECT_ID);
      const authenticateModel = vi.fn(async () => {});

      await expect(
        resolveWorkflowModel(
          exact(fixed(provider, modelId, auth, "high")),
          context(paths),
          dependencies({
            resolveFixedModel: () => piModel(provider, modelId, false),
            authenticateModel,
          }),
        ),
      ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_UNSUPPORTED_REQUEST" });
      expect(authenticateModel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ollama", "qwen3:32b", "local", "local"],
    ["openai-compatible", "lab/model", "custom", "custom"],
  ] as const)(
    "resolves exact non-reasoning %s requests when reasoning is explicitly off",
    async (provider, modelId, auth, runtime) => {
      const paths = resolvePaths(PROJECT_ID);
      const authenticateModel = vi.fn(async () => {});
      const request = exact(fixed(provider, modelId, auth, "off"));

      const resolved = await resolveWorkflowModel(
        request,
        context(paths),
        dependencies({
          resolveFixedModel: () => piModel(provider, modelId, false),
          authenticateModel,
        }),
      );

      expect(authenticateModel).toHaveBeenCalledOnce();
      expect(resolved.receipt).toMatchObject({
        request,
        fallbackUsed: false,
        resolved: { provider, model: modelId, reasoning: "off", runtime },
      });
    },
  );

  it("skips an unsupported primary only for a declared, reasoning-compatible fallback", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const primary = fixed("ollama", "primary-local", "local", "high");
    const fallback = fixed("openai-compatible", "fallback-local", "custom", "off");
    const request: ModelRequest = {
      requested: primary,
      resolution: {
        mode: "explicit-fallback",
        alternatives: [fallback],
        reason: "Use the explicitly non-reasoning local fallback.",
      },
    };
    const authenticateModel = vi.fn(async () => {});

    const resolved = await resolveWorkflowModel(
      request,
      context(paths),
      dependencies({
        resolveFixedModel: (candidate) => piModel(
          candidate.provider,
          candidate.model,
          false,
        ),
        authenticateModel,
      }),
    );

    expect(authenticateModel).toHaveBeenCalledOnce();
    expect(resolved.model).toMatchObject({
      provider: "openai-compatible",
      id: "fallback-local",
    });
    expect(resolved.receipt).toMatchObject({
      fallbackUsed: true,
      resolutionReason: request.resolution.reason,
      resolved: { reasoning: "off", runtime: "custom" },
    });
  });

  it("uses only an explicitly declared fallback and records why", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const primary = fixed("openrouter", "primary/model", "api-key", "high");
    const fallback = fixed("ollama", "qwen3:32b", "local", "low");
    const request: ModelRequest = {
      requested: primary,
      resolution: {
        mode: "explicit-fallback",
        alternatives: [fallback],
        reason: "Use the private model if hosted auth is unavailable.",
      },
    };
    const authenticateModel = vi.fn(async (model: Model<Api>) => {
      if (model.provider === "openrouter") throw new Error("not connected");
    });

    const resolved = await resolveWorkflowModel(
      request,
      context(paths),
      dependencies({ authenticateModel }),
    );

    expect(authenticateModel).toHaveBeenCalledTimes(2);
    expect(resolved.model).toMatchObject({ provider: "ollama", id: "qwen3:32b" });
    expect(resolved.receipt).toMatchObject({
      fallbackUsed: true,
      resolutionReason: request.resolution.reason,
      resolved: { reasoning: "low", runtime: "local" },
    });
  });

  it("does not invent a fallback for an exact unauthenticated request", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const request = exact(fixed("openrouter", "primary/model", "api-key"));
    const resolveFixedModel = vi.fn(
      (requested: FixedModel) => piModel(requested.provider, requested.model),
    );

    await expect(
      resolveWorkflowModel(
        request,
        context(paths),
        dependencies({
          resolveFixedModel,
          authenticateModel: async () => {
            throw new Error("not connected");
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE",
    });
    expect(resolveFixedModel).toHaveBeenCalledOnce();
  });

  it("rejects resolver model drift instead of falling back", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const request: ModelRequest = {
      requested: fixed("openrouter", "requested/model", "api-key"),
      resolution: {
        mode: "explicit-fallback",
        alternatives: [fixed("ollama", "fallback", "local")],
        reason: "Declared fallback",
      },
    };
    const authenticateModel = vi.fn(async () => {});

    await expect(
      resolveWorkflowModel(
        request,
        context(paths),
        dependencies({
          resolveFixedModel: () => piModel("openrouter", "different/model"),
          authenticateModel,
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_RESOLVER_MISMATCH" });
    expect(authenticateModel).not.toHaveBeenCalled();
  });

  it("rejects auth profiles and provider/auth mismatches before attempting a model", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const resolveFixedModel = vi.fn(
      (requested: FixedModel) => piModel(requested.provider, requested.model),
    );

    await expect(
      resolveWorkflowModel(
        exact(fixed("openrouter", "model", "api-key", "high", "lab-key")),
        context(paths),
        dependencies({ resolveFixedModel }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM" });
    await expect(
      resolveWorkflowModel(
        exact(fixed("openai-codex", "gpt-5.4", "api-key")),
        context(paths),
        dependencies({ resolveFixedModel }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM" });
    expect(resolveFixedModel).not.toHaveBeenCalled();
  });

  it("still fails closed for an unknown provider after nvidia joined the claim table", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const resolveFixedModel = vi.fn(
      (requested: FixedModel) => piModel(requested.provider, requested.model),
    );

    await expect(
      resolveWorkflowModel(
        exact(fixed("definitely-not-a-provider", "some/model", "api-key")),
        context(paths),
        dependencies({ resolveFixedModel }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM" });
    expect(resolveFixedModel).not.toHaveBeenCalled();
  });

  it("binds Kady Current to the manifest session model and preserves requested reasoning", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const loadMainKadySessionModel = vi.fn(
      async () => piModel("openai-codex", "gpt-5.4"),
    );
    const resolveConfiguredDefaultModel = vi.fn(
      () => piModel("openrouter", "wrong/default"),
    );
    const request = exact({
      source: "kady-current",
      auth: { kind: "kady-current" },
      reasoning: "max",
    });

    const resolved = await resolveWorkflowModel(
      request,
      context(paths, "main-session-id"),
      dependencies({ loadMainKadySessionModel, resolveConfiguredDefaultModel }),
    );

    expect(loadMainKadySessionModel).toHaveBeenCalledWith(
      PROJECT_ID,
      paths,
      "main-session-id",
    );
    expect(resolveConfiguredDefaultModel).not.toHaveBeenCalled();
    expect(resolved.receipt.resolved).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      auth: { kind: "oauth" },
      reasoning: "max",
      runtime: "pi",
    });
  });

  it("uses the configured Kady default only when the manifest has no session id", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const loadMainKadySessionModel = vi.fn(
      async () => piModel("openai-codex", "wrong/session"),
    );
    const resolveConfiguredDefaultModel = vi.fn(
      () => piModel("openai-compatible", "private-default"),
    );
    const request = exact({
      source: "kady-current",
      auth: { kind: "kady-current" },
      reasoning: "off",
    });

    const resolved = await resolveWorkflowModel(
      request,
      context(paths),
      dependencies({ loadMainKadySessionModel, resolveConfiguredDefaultModel }),
    );

    expect(loadMainKadySessionModel).not.toHaveBeenCalled();
    expect(resolveConfiguredDefaultModel).toHaveBeenCalledOnce();
    expect(resolved.receipt.resolved).toMatchObject({
      provider: "openai-compatible",
      model: "private-default",
      auth: { kind: "custom" },
      reasoning: "off",
      runtime: "custom",
    });
  });

  it("rejects unsupported Kady Current reasoning before authentication", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const authenticateModel = vi.fn(async () => {});

    await expect(
      resolveWorkflowModel(
        exact({
          source: "kady-current",
          auth: { kind: "kady-current" },
          reasoning: "high",
        }),
        context(paths),
        dependencies({
          resolveConfiguredDefaultModel: () => piModel(
            "openai-compatible",
            "private-default",
            false,
          ),
          authenticateModel,
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_UNSUPPORTED_REQUEST" });
    expect(authenticateModel).not.toHaveBeenCalled();
  });

  it("rejects a manifest reference to a helper Pi session as Kady Current", async () => {
    const paths = ensureProjectExists(PROJECT_ID);
    const helper = await getOrCreateProfileSession(
      PROJECT_ID,
      paths,
      "dag-builder",
      { kind: "workflow", id: "resolver-helper@1" },
    );

    await expect(
      resolveWorkflowModel(
        exact({
          source: "kady-current",
          auth: { kind: "kady-current" },
          reasoning: "high",
        }),
        context(paths, helper.sessionId),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MODEL_SESSION_NOT_MAIN" });
  });

  it("never replaces a missing manifest session with the configured default", async () => {
    const paths = resolvePaths(PROJECT_ID);
    const resolveConfiguredDefaultModel = vi.fn(
      () => piModel("openrouter", "wrong/default"),
    );
    const missing = new WorkflowModelResolutionError(
      "WORKFLOW_MODEL_SESSION_NOT_FOUND",
      "missing",
    );

    await expect(
      resolveWorkflowModel(
        exact({
          source: "kady-current",
          auth: { kind: "kady-current" },
          reasoning: "high",
        }),
        context(paths, "missing-session"),
        dependencies({
          loadMainKadySessionModel: async () => {
            throw missing;
          },
          resolveConfiguredDefaultModel,
        }),
      ),
    ).rejects.toBe(missing);
    expect(resolveConfiguredDefaultModel).not.toHaveBeenCalled();
  });
});
