import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerModelPresetRoutes } from "../src/api/model-presets.ts";
import {
  MODEL_PRESET_REF_PREFIX,
  getModelPreset,
  listModelPresets,
  presetForSelectorRef,
} from "../src/agent/model-presets-store.ts";
import { resolveModel } from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";

/**
 * The preset API and the resolution rule.
 *
 * The load-bearing assertion is the last describe block: selecting a preset
 * anywhere a model is chosen must resolve to that preset's provider and model.
 * `resolveModel` is the single funnel every dispatch path in the server goes
 * through (`/run` at api/sessions.ts, the workflow resolver, any persisted
 * selection), so asserting there asserts the effect rather than the schema.
 */

let storeFile: string;
let env: NodeJS.ProcessEnv;
const apps: ReturnType<typeof Fastify>[] = [];

function model(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

async function buildApp(
  overrides: Parameters<typeof registerModelPresetRoutes>[1] = {},
) {
  const app = Fastify();
  apps.push(app);
  await registerModelPresetRoutes(app, {
    env,
    hasSubscriptionLogin: async () => false,
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
    resolveModelForRef: (ref) => model("groq", String(ref).split("/").slice(1).join("/")),
    ...overrides,
  });
  return app;
}

beforeEach(() => {
  storeFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "kady-f1-presets-")),
    "model-presets.json",
  );
  env = { KADY_MODEL_PRESETS_FILE: storeFile };
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("row 3 — the preset section covers all eight provider groups", () => {
  it("lists every group with its configured state and the binding table", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/model-presets" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      presets: unknown[];
      groups: Array<{ id: string; configured: boolean; notConfiguredReason?: string }>;
      bindingsByGroup: Record<
        string,
        Record<string, { hyperparameters: string; reason?: string }>
      >;
    };
    expect(body.presets).toEqual([]);
    expect(body.groups.map((group) => group.id)).toEqual([
      "cerebras",
      "openai",
      "openrouter",
      "anthropic",
      "groq",
      "xai",
      "local",
      "modal",
    ]);
    // Unconfigured is visible-and-disabled, never hidden.
    for (const group of body.groups) {
      expect(group.configured).toBe(false);
      expect(group.notConfiguredReason).toBeTruthy();
    }
    // `direct` is per group and is derived from the dispatch predicate, not
    // asserted: Kady builds the call for Groq and cannot build it for Anthropic.
    expect(body.bindingsByGroup.groq.direct.hyperparameters).toBe("bound");
    expect(body.bindingsByGroup.anthropic.direct.hyperparameters).toBe("dropped");
    expect(body.bindingsByGroup.anthropic.direct.reason).toBeTruthy();
    expect(body.bindingsByGroup.local.direct.hyperparameters).toBe("dropped");
    expect(body.bindingsByGroup.groq["chat-session"].hyperparameters).toBe("dropped");
    expect(body.bindingsByGroup.groq["chat-session"].reason).toBeTruthy();
  });

  it("creates, updates, lists and deletes a preset, persisting it", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Fast summariser",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        hyperparameters: { temperature: 0.2, maxTokens: 400 },
        systemPromptOverride: "Be terse.",
      },
    });
    expect(created.statusCode).toBe(201);
    const preset = created.json() as { id: string; ref: string; name: string };
    expect(preset.ref).toBe("groq/llama-3.3-70b-versatile");

    // Persisted, not just held in memory.
    expect(JSON.parse(fs.readFileSync(storeFile, "utf8")).presets).toHaveLength(1);
    expect(getModelPreset(preset.id, env)?.name).toBe("Fast summariser");

    const patched = await app.inject({
      method: "PATCH",
      url: `/model-presets/${preset.id}`,
      payload: { name: "Faster summariser" },
    });
    expect(patched.statusCode).toBe(200);
    const updated = patched.json() as {
      name: string;
      hyperparameters: { temperature: number };
      systemPromptOverride: string;
    };
    expect(updated.name).toBe("Faster summariser");
    // A partial PATCH must not blank the fields it did not mention.
    expect(updated.hyperparameters.temperature).toBe(0.2);
    expect(updated.systemPromptOverride).toBe("Be terse.");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/model-presets/${preset.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(listModelPresets(env)).toEqual([]);
  });

  it("refuses a preset for an unknown provider", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "x", providerId: "deepseek", modelId: "y" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { detail: string }).detail).toContain("deepseek");
  });

  it("requires a local model id to name its server", async () => {
    const app = await buildApp();
    const bad = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "local", providerId: "local", modelId: "llama3" },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "local", providerId: "local", modelId: "ollama/llama3" },
    });
    expect(good.statusCode).toBe(201);
    expect((good.json() as { ref: string }).ref).toBe("ollama/llama3");
  });

  it("refuses a parameter the chosen provider does not accept", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "seeded claude",
        providerId: "anthropic",
        modelId: "claude-opus-4-8",
        hyperparameters: { seed: 7 },
      },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { detail: string }).detail).toContain("Anthropic");
  });
});

describe("row 6 — a Modal preset carries a Hugging Face model and a GPU count", () => {
  it("stores the HF id and GPU count, validating the id by shape only", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Llama on H200",
        providerId: "modal",
        modelId: "meta-llama/Llama-3.3-70B-Instruct",
        modal: {
          huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
          gpuCount: 4,
          instanceId: "h200",
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const preset = response.json() as {
      modal: { huggingFaceModelId: string; gpuCount: number; instanceId: string };
    };
    expect(preset.modal).toEqual({
      huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
      gpuCount: 4,
      instanceId: "h200",
    });
  });

  it("rejects a Hugging Face id that is not org/name", async () => {
    const app = await buildApp();
    for (const huggingFaceModelId of ["llama", "a/b/c", "", " /x"]) {
      const response = await app.inject({
        method: "POST",
        url: "/model-presets",
        payload: {
          name: "bad hf",
          providerId: "modal",
          modelId: "x",
          modal: { huggingFaceModelId, gpuCount: 1 },
        },
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { detail: string }).detail).toContain("org/name");
    }
  });

  it("rejects a GPU count that is not a whole number of 1 or more", async () => {
    const app = await buildApp();
    for (const gpuCount of [0, -1, 1.5]) {
      const response = await app.inject({
        method: "POST",
        url: "/model-presets",
        payload: {
          name: "bad gpu",
          providerId: "modal",
          modelId: "x",
          modal: { huggingFaceModelId: "org/name", gpuCount },
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("bounds the GPU count by the EXISTING Modal instance catalogue", async () => {
    const app = await buildApp();
    // a10g's maxGpuCount is 4 in server/src/modal/catalog.ts — read, not forked.
    const tooMany = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "too many",
        providerId: "modal",
        modelId: "x",
        modal: { huggingFaceModelId: "org/name", gpuCount: 5, instanceId: "a10g" },
      },
    });
    expect(tooMany.statusCode).toBe(400);
    expect((tooMany.json() as { detail: string }).detail).toContain("at most 4");

    const unknown = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "unknown instance",
        providerId: "modal",
        modelId: "x",
        modal: { huggingFaceModelId: "org/name", gpuCount: 1, instanceId: "nope" },
      },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("refuses modal settings on a non-Modal preset", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "confused",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        modal: { huggingFaceModelId: "org/name", gpuCount: 1 },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("resolve fails closed", () => {
  it("404s an unknown preset id with a legible message", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/model-presets/mp_missing/resolve",
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { detail: string }).detail).toContain("mp_missing");
  });

  it("409s a preset whose provider is unconfigured, naming the variable", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "g", providerId: "groq", modelId: "llama-3.3-70b-versatile" },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/resolve`,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { detail: string }).detail).toContain("GROQ_API_KEY");
  });

  it("returns the values and the per-surface binding once configured", async () => {
    env.GROQ_API_KEY = "test-only-groq-key";
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "g",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        hyperparameters: { temperature: 0.25 },
        systemPromptOverride: "Be terse.",
      },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/resolve`,
      payload: { surface: "chat-session" },
    });

    expect(response.statusCode).toBe(200);
    const resolved = response.json() as {
      ref: string;
      providerId: string;
      modelId: string;
      hyperparameters: { temperature: number };
      systemPromptOverride: string;
      surface: string;
      binding: { hyperparameters: string; reason?: string };
      bindingBySurface: Record<string, { hyperparameters: string }>;
    };
    expect(resolved.ref).toBe("groq/llama-3.3-70b-versatile");
    expect(resolved.providerId).toBe("groq");
    expect(resolved.modelId).toBe("llama-3.3-70b-versatile");
    expect(resolved.hyperparameters.temperature).toBe(0.25);
    expect(resolved.systemPromptOverride).toBe("Be terse.");
    expect(resolved.surface).toBe("chat-session");
    expect(resolved.binding.hyperparameters).toBe("dropped");
    expect(resolved.binding.reason).toBeTruthy();
    expect(resolved.bindingBySurface.direct.hyperparameters).toBe("bound");
    expect(response.body).not.toContain("test-only-groq-key");
  });

  it("rejects an unknown surface rather than silently defaulting", async () => {
    env.GROQ_API_KEY = "test-only-groq-key";
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "g", providerId: "groq", modelId: "llama-3.3-70b-versatile" },
    });
    const { id } = created.json() as { id: string };
    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/resolve`,
      payload: { surface: "somewhere-else" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("the test route puts the preset's values on the wire", () => {
  it("sends the hyperparameters and the override, and echoes what it sent", async () => {
    env.GROQ_API_KEY = "test-only-groq-key";
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = await buildApp({ fetch: fetchSpy });
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "g",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        hyperparameters: { temperature: 0.11, maxTokens: 64 },
        systemPromptOverride: "Answer with one word.",
      },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/test`,
      payload: { prompt: "ping" },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.model).toBe("llama-3.3-70b-versatile");
    expect(sent.temperature).toBe(0.11);
    expect(sent.max_tokens).toBe(64);
    expect(sent.messages[0]).toEqual({
      role: "system",
      content: "Answer with one word.",
    });
    // The credential travelled in a header, never in the body or the response.
    expect(String(init?.body)).not.toContain("test-only-groq-key");
    expect(response.body).not.toContain("test-only-groq-key");
  });

  it("refuses to send a Modal preset as a completion", async () => {
    // Modal's configured state comes from `modalConfigured()` in config.ts —
    // the SAME single credential path the Modal panel already uses, read from
    // the real environment rather than duplicated here. Two credential paths to
    // one service would be the bug; stubbing the process env is the way to
    // exercise the one path.
    vi.stubEnv("MODAL_TOKEN_ID", "test-only-modal-id");
    vi.stubEnv("MODAL_TOKEN_SECRET", "test-only-modal-secret");
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    const app = await buildApp({ fetch: fetchSpy });
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "m",
        providerId: "modal",
        modelId: "org/name",
        modal: { huggingFaceModelId: "org/name", gpuCount: 2, instanceId: "h100" },
      },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({ method: "POST", url: `/model-presets/${id}/test` });

    expect(response.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("THE RESOLUTION RULE — a selected preset resolves to its provider and model", () => {
  const registry = getModelRegistry();

  it("resolves preset/<id> to the preset's provider and model id", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Fast summariser",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        hyperparameters: { temperature: 0.2 },
      },
    });
    const { id } = created.json() as { id: string };

    // This is the exact call /run makes with the picker's selection
    // (api/sessions.ts resolves body.model through resolveModel), so the
    // assertion is on the dispatch target, not on the schema.
    const previous = process.env.KADY_MODEL_PRESETS_FILE;
    process.env.KADY_MODEL_PRESETS_FILE = storeFile;
    try {
      const resolved = resolveModel(`${MODEL_PRESET_REF_PREFIX}${id}`, registry);
      expect(resolved.provider).toBe("groq");
      expect(resolved.id).toBe("llama-3.3-70b-versatile");
      // Pi's own catalogue supplied the address; nothing here invented one.
      expect(resolved.baseUrl).toContain("groq.com");
    } finally {
      if (previous === undefined) delete process.env.KADY_MODEL_PRESETS_FILE;
      else process.env.KADY_MODEL_PRESETS_FILE = previous;
    }
  });

  it("resolves a local preset to its own server's provider", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "local", providerId: "local", modelId: "ollama/llama3" },
    });
    const { id } = created.json() as { id: string };

    const previous = process.env.KADY_MODEL_PRESETS_FILE;
    process.env.KADY_MODEL_PRESETS_FILE = storeFile;
    try {
      const resolved = resolveModel(`${MODEL_PRESET_REF_PREFIX}${id}`, registry);
      expect(resolved.provider).toBe("ollama");
      expect(resolved.id).toBe("llama3");
    } finally {
      if (previous === undefined) delete process.env.KADY_MODEL_PRESETS_FILE;
      else process.env.KADY_MODEL_PRESETS_FILE = previous;
    }
  });

  it("fails closed on a deleted preset instead of falling back to a default", () => {
    const previous = process.env.KADY_MODEL_PRESETS_FILE;
    process.env.KADY_MODEL_PRESETS_FILE = storeFile;
    try {
      expect(() => resolveModel("preset/mp_gone", registry)).toThrow(
        /no longer exists/,
      );
      expect(presetForSelectorRef("preset/mp_gone", env)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.KADY_MODEL_PRESETS_FILE;
      else process.env.KADY_MODEL_PRESETS_FILE = previous;
    }
  });
});

/**
 * The round-2 medium: a cleared field must actually clear.
 *
 * The PATCH route merges over the stored preset so a partial body cannot blank
 * a field the user never touched. The rule that makes clearing possible without
 * losing that property is that ABSENT and `null` mean different things — absent
 * is "leave it", `null` is "clear it". Round 1 had only the first half, and the
 * editor omitted a key whenever its field was empty, so an emptied
 * system-prompt override silently came back on the next save.
 */
describe("PATCH clears a field when the body says null, and preserves it when absent", () => {
  async function createOverridePreset(app: Awaited<ReturnType<typeof buildApp>>) {
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Fast summariser",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        hyperparameters: { temperature: 0.3, maxTokens: 512 },
        systemPromptOverride: "You are terse.",
      },
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { id: string }).id;
  }

  it("clears a previously-set system-prompt override", async () => {
    const app = await buildApp();
    const id = await createOverridePreset(app);

    const patched = await app.inject({
      method: "PATCH",
      url: `/model-presets/${id}`,
      payload: { systemPromptOverride: null },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).not.toHaveProperty("systemPromptOverride");
    // The effect, read back off disk rather than off the response.
    expect(getModelPreset(id, env)?.systemPromptOverride).toBeUndefined();
    // And the untouched fields are still there — clearing one is not clearing all.
    expect(getModelPreset(id, env)?.hyperparameters).toEqual({
      temperature: 0.3,
      maxTokens: 512,
    });
  });

  it("clears the hyperparameters", async () => {
    const app = await buildApp();
    const id = await createOverridePreset(app);

    const patched = await app.inject({
      method: "PATCH",
      url: `/model-presets/${id}`,
      payload: { hyperparameters: null },
    });

    expect(patched.statusCode).toBe(200);
    expect(getModelPreset(id, env)?.hyperparameters).toBeUndefined();
    expect(getModelPreset(id, env)?.systemPromptOverride).toBe("You are terse.");
  });

  it("still preserves a field the body does not mention", async () => {
    const app = await buildApp();
    const id = await createOverridePreset(app);

    const patched = await app.inject({
      method: "PATCH",
      url: `/model-presets/${id}`,
      payload: { name: "Renamed" },
    });

    expect(patched.statusCode).toBe(200);
    expect(getModelPreset(id, env)?.name).toBe("Renamed");
    expect(getModelPreset(id, env)?.systemPromptOverride).toBe("You are terse.");
  });

  it("moves a Modal preset onto a chat provider", async () => {
    // Round 1's failure: the editor stopped sending `modal`, the merge
    // re-attached the stored block, and `validateModal` rejected the save with
    // "modal settings are only valid on a Modal preset." — an error naming
    // nothing the user could act on.
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Weights",
        providerId: "modal",
        modelId: "meta-llama/Llama-3.3-70B-Instruct",
        modal: {
          huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
          gpuCount: 4,
          instanceId: "h100",
        },
      },
    });
    const { id } = created.json() as { id: string };

    const patched = await app.inject({
      method: "PATCH",
      url: `/model-presets/${id}`,
      payload: {
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        modal: null,
      },
    });

    expect(patched.statusCode).toBe(200);
    const stored = getModelPreset(id, env);
    expect(stored?.providerId).toBe("groq");
    expect(stored?.modal).toBeUndefined();
    expect(stored?.ref).toBe("groq/llama-3.3-70b-versatile");
  });

  it("drops the Modal block on a provider change even when the body omits it", async () => {
    // Defence in depth for the same defect: an older client that still omits
    // `modal` must not be told its preset is invalid for a reason it cannot act
    // on. A provider change clears the block.
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Weights",
        providerId: "modal",
        modelId: "org/name",
        modal: { huggingFaceModelId: "org/name", gpuCount: 1 },
      },
    });
    const { id } = created.json() as { id: string };

    const patched = await app.inject({
      method: "PATCH",
      url: `/model-presets/${id}`,
      payload: { providerId: "groq", modelId: "llama-3.3-70b-versatile" },
    });

    expect(patched.statusCode).toBe(200);
    expect(getModelPreset(id, env)?.modal).toBeUndefined();
  });
});

/**
 * ROW 6 GATE B — the ModalJobRequest that reaches the Modal job path.
 *
 * The assertion is on the request OBJECT handed to `modalJobManager.submit`'s
 * signature — the same entry point `POST /modal/jobs` uses — not on the preset
 * schema accepting the two fields. `submitModalJob` is injected only so the
 * assertion can read that object without creating a real Modal sandbox; the
 * production default is `modalJobManager.submit` itself.
 */
describe("row 6 — a Modal preset's HF model and GPU count reach the Modal job request", () => {
  it("hands the Modal job path the preset's huggingFaceModelId and gpuCount", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-only-modal-id");
    vi.stubEnv("MODAL_TOKEN_SECRET", "test-only-modal-secret");
    const submitted: Array<{ projectId: string; request: Record<string, unknown> }> = [];
    const app = await buildApp({
      submitModalJob: (projectId, request) => {
        submitted.push({ projectId, request: request as unknown as Record<string, unknown> });
        return {
          id: "job_1",
          state: "queued",
          request: { ...request, instance: request.instance ?? "cpu", gpuCount: request.gpuCount ?? 1 },
        } as never;
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Llama on H100s",
        providerId: "modal",
        modelId: "meta-llama/Llama-3.3-70B-Instruct",
        modal: {
          huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
          gpuCount: 4,
          instanceId: "h100",
        },
      },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/modal-job`,
    });

    expect(response.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    const request = submitted[0].request;
    // The GPU count is the integer F12's interface specifies, NOT an "H100:4"
    // string — that form is produced server-side at dispatch by gpuString().
    expect(request.gpuCount).toBe(4);
    expect(request.instance).toBe("h100");
    // The Hugging Face model id is what the job actually loads.
    expect(String(request.command)).toContain("meta-llama/Llama-3.3-70B-Instruct");
    expect(response.json()).toMatchObject({
      jobId: "job_1",
      huggingFaceModelId: "meta-llama/Llama-3.3-70B-Instruct",
      request: { gpuCount: 4, instance: "h100" },
    });
  });

  it("makes no Modal call at all when Modal is not configured", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "");
    vi.stubEnv("MODAL_TOKEN_SECRET", "");
    const submit = vi.fn();
    const app = await buildApp({ submitModalJob: submit as never });
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: {
        name: "Weights",
        providerId: "modal",
        modelId: "org/name",
        modal: { huggingFaceModelId: "org/name", gpuCount: 1 },
      },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/modal-job`,
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { detail: string }).detail).toContain("MODAL_TOKEN_ID");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a non-Modal preset without touching the Modal job path", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-only-modal-id");
    vi.stubEnv("MODAL_TOKEN_SECRET", "test-only-modal-secret");
    const submit = vi.fn();
    const app = await buildApp({ submitModalJob: submit as never });
    const created = await app.inject({
      method: "POST",
      url: "/model-presets",
      payload: { name: "g", providerId: "groq", modelId: "llama-3.3-70b-versatile" },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({
      method: "POST",
      url: `/model-presets/${id}/modal-job`,
    });

    expect(response.statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to store a GPU count above the chosen instance's ceiling, and a CPU instance above 1", async () => {
    const app = await buildApp();
    // a10g's maxGpuCount is 4 and cpu-4's kind is "cpu" — both read from the
    // existing catalogue in server/src/modal/catalog.ts, never re-typed here.
    for (const [instanceId, gpuCount] of [
      ["a10g", 5],
      ["cpu-4", 2],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/model-presets",
        payload: {
          name: "too many",
          providerId: "modal",
          modelId: "org/name",
          modal: { huggingFaceModelId: "org/name", gpuCount, instanceId },
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
