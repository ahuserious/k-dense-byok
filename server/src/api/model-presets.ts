/**
 * Model preset endpoints — list/create/update/delete/resolve, plus the single
 * provider call that proves a preset's parameters actually leave the machine
 * the way the editor said they would.
 *
 * Registered without an `/api` prefix, like every other route module in this
 * server (`apiFetch` in the web app prepends only the backend origin).
 *
 * Nothing here contacts a provider except `POST /model-presets/:id/test`, and
 * that route refuses before building a request when the provider's credential
 * variable is unset.
 */
import type { FastifyInstance } from "fastify";
import { resolveInstance } from "../modal/catalog.ts";
import { modalConfigured } from "../config.ts";
import { getModelRegistry, getModelRuntime } from "../agent/session-registry.ts";
import { resolveModel } from "../agent/models.ts";
import {
  MODEL_PRESET_REF_PREFIX,
  ModelPresetError,
  createModelPreset,
  deleteModelPreset,
  getModelPreset,
  listModelPresets,
  updateModelPreset,
  validateModelPresetInput,
  type ModelPreset,
} from "../agent/model-presets-store.ts";
import {
  isPresetBindingSurface,
  presetBindingBySurface,
  resolveModelPreset,
  type PresetBindingSurface,
} from "../agent/model-presets.ts";
import {
  PROVIDER_GROUPS,
  providerGroup,
  resolveProviderGroups,
  type ProviderGroupStatus,
} from "../agent/providers/registry.ts";
import {
  PresetDispatchError,
  dispatchPresetCompletion,
} from "../agent/providers/dispatch.ts";

export interface RegisterModelPresetRoutesOptions {
  /** Injected in tests so no real credential store or provider is consulted. */
  hasSubscriptionLogin?: (providerId: string) => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  resolveModelForRef?: typeof resolveModel;
}

const MAX_TEST_PROMPT_LENGTH = 2_000;
const DEFAULT_TEST_PROMPT = "Reply with the single word: ready.";

function errorReply(
  reply: { code(statusCode: number): unknown },
  error: unknown,
): { detail: string } {
  if (error instanceof ModelPresetError) {
    reply.code(error.status);
    return { detail: error.message };
  }
  if (error instanceof PresetDispatchError) {
    reply.code(error.code === "PROVIDER_NOT_CONFIGURED" ? 409 : 502);
    return { detail: error.message };
  }
  reply.code(500);
  return {
    detail: error instanceof Error ? error.message : "Model-preset operation failed",
  };
}

/** Max GPUs for a Modal instance id, read from the existing Modal catalogue. */
function maxGpuCountForInstance(instanceId: string): number | null {
  return resolveInstance(instanceId)?.maxGpuCount ?? null;
}

export async function registerModelPresetRoutes(
  app: FastifyInstance,
  options: RegisterModelPresetRoutesOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const resolveModelForRef = options.resolveModelForRef ?? resolveModel;
  const hasSubscriptionLogin =
    options.hasSubscriptionLogin ??
    (async (providerId: string) => {
      // Reads Kady's LOCAL credential store. Issues no network request.
      const auth = await getModelRuntime().checkAuth(providerId);
      return auth?.type === "oauth";
    });

  const groups = (): Promise<ProviderGroupStatus[]> =>
    resolveProviderGroups({ hasSubscriptionLogin, env });

  /**
   * Modal is a compute account rather than a chat provider, so its configured
   * state comes from the same single credential path the Modal panel already
   * uses. Two credential paths to one service is a bug; this reads the one.
   */
  const groupStatuses = async (): Promise<ProviderGroupStatus[]> => {
    const resolved = await groups();
    return resolved.map((group) =>
      group.id === "modal"
        ? {
            ...group,
            configured: modalConfigured(),
            ...(modalConfigured()
              ? { notConfiguredReason: undefined }
              : {
                  notConfiguredReason:
                    providerGroup("modal")?.notConfiguredReason ??
                    "Modal is not configured.",
                }),
          }
        : group,
    );
  };

  const requirePreset = (id: string): ModelPreset => {
    const preset = getModelPreset(id, env);
    if (!preset) {
      throw new ModelPresetError(404, `No preset with id ${id}.`);
    }
    return preset;
  };

  const resolveFor = async (preset: ModelPreset, surface: PresetBindingSurface) => {
    const status = (await groupStatuses()).find(
      (group) => group.id === preset.providerId,
    );
    return resolveModelPreset(preset, {
      surface,
      providerConfigured: Boolean(status?.configured),
      providerNotConfiguredReason: status?.notConfiguredReason,
    });
  };

  app.get("/model-presets", async (_req, reply) => {
    try {
      return {
        presets: listModelPresets(env),
        groups: await groupStatuses(),
        // Shipped with the list so the Settings section can state, per dispatch
        // surface, where a preset's parameters actually land — without a second
        // request and without any surface hardcoding the answer.
        bindings: presetBindingBySurface(),
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  // The binding table on its own, so a consumer that has not yet chosen a
  // preset can still render the honest per-surface state.
  app.get("/model-presets/bindings", async () => ({
    surfaces: presetBindingBySurface(),
    // Echoed so a client never has to hardcode the group list to render it.
    groups: PROVIDER_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      parameterSupport: group.parameterSupport,
    })),
  }));

  app.post<{ Body: unknown }>("/model-presets", async (req, reply) => {
    try {
      const input = validateModelPresetInput(req.body, {
        maxGpuCountForInstance,
        env,
      });
      reply.code(201);
      return createModelPreset(input, env);
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/model-presets/:id",
    async (req, reply) => {
      try {
        const existing = requirePreset(req.params.id);
        const body = (req.body ?? {}) as Record<string, unknown>;
        // PATCH over the stored preset so a partial body cannot silently blank
        // a field the user never touched.
        const merged = {
          name: body.name ?? existing.name,
          providerId: body.providerId ?? existing.providerId,
          modelId: body.modelId ?? existing.modelId,
          hyperparameters:
            body.hyperparameters === undefined
              ? existing.hyperparameters
              : body.hyperparameters,
          systemPromptOverride:
            body.systemPromptOverride === undefined
              ? existing.systemPromptOverride
              : body.systemPromptOverride,
          modal: body.modal === undefined ? existing.modal : body.modal,
        };
        const input = validateModelPresetInput(merged, {
          maxGpuCountForInstance,
          env,
        });
        return updateModelPreset(req.params.id, input, env);
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/model-presets/:id", async (req, reply) => {
    try {
      deleteModelPreset(req.params.id, env);
      return { ok: true };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { surface?: string } | null }>(
    "/model-presets/:id/resolve",
    async (req, reply) => {
      try {
        const requested = req.body?.surface;
        if (requested !== undefined && !isPresetBindingSurface(requested)) {
          throw new ModelPresetError(400, `Unknown surface "${requested}".`);
        }
        const preset = requirePreset(req.params.id);
        return await resolveFor(preset, requested ?? "direct");
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  /**
   * Send one completion with this preset applied. The route that makes row 4
   * and row 5 true rather than schema-shaped: the hyperparameters and the
   * system-prompt override are put on the wire here, and the response echoes
   * the exact outbound request (minus the credential) so the user can see what
   * was sent.
   */
  app.post<{ Params: { id: string }; Body: { prompt?: string } | null }>(
    "/model-presets/:id/test",
    async (req, reply) => {
      try {
        const preset = requirePreset(req.params.id);
        const resolved = await resolveFor(preset, "direct");
        const group = providerGroup(preset.providerId);
        if (!group?.dispatchableAsChatModel) {
          throw new ModelPresetError(
            400,
            `${group?.label ?? preset.providerId} presets describe a compute job rather than a chat model, so there is no completion to send.`,
          );
        }
        const prompt = String(req.body?.prompt ?? DEFAULT_TEST_PROMPT).slice(
          0,
          MAX_TEST_PROMPT_LENGTH,
        );
        const model = resolveModelForRef(preset.ref, getModelRegistry());
        const result = await dispatchPresetCompletion(
          {
            model,
            preset: resolved,
            groupId: preset.providerId,
            prompt,
          },
          { fetch: options.fetch ?? globalThis.fetch, env },
        );
        return {
          presetId: preset.id,
          ref: preset.ref,
          status: result.status,
          text: result.text,
          // No credential is present in this object; `authHeaderName` is a
          // header NAME, deliberately not its value.
          request: result.request,
          binding: resolved.binding,
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );
}

export { MODEL_PRESET_REF_PREFIX };
