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
import { modalJobManager } from "../modal/manager.ts";
import { currentProjectId } from "../scope.ts";
import { ModalJobError, type ModalJob, type ModalJobRequest } from "../modal/types.ts";
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
  modalJobRequestForPreset,
  presetBindingsByGroup,
  resolveModelPreset,
  type PresetBindingSurface,
} from "../agent/model-presets.ts";
import {
  PROVIDER_GROUPS,
  PROVIDER_GROUP_IDS,
  directDispatchSupport,
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
  /**
   * Injected in tests so the Gate B assertion can read the exact
   * `ModalJobRequest` this module hands to the Modal job path without creating
   * a real sandbox. Production uses `modalJobManager.submit`, which is the one
   * existing Modal entry point — no second submission path is added here.
   */
  submitModalJob?: (
    projectId: string,
    request: ModalJobRequest,
    owner: { sessionId: string; submittedBy: "api" },
  ) => ModalJob;
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
  if (error instanceof ModalJobError) {
    reply.code(error.statusCode);
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

/**
 * Kind and GPU ceiling for a Modal instance id, read from the existing Modal
 * catalogue. `server/src/modal/catalog.ts` stays the single source of both.
 */
function modalInstance(instanceId: string): { kind: "cpu" | "gpu"; maxGpuCount: number } | null {
  const spec = resolveInstance(instanceId);
  return spec ? { kind: spec.kind, maxGpuCount: spec.maxGpuCount } : null;
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
        // Shipped with the list so the Settings section can state, per provider
        // group and per dispatch surface, where a preset's parameters actually
        // land — without a request per group and without any surface deciding
        // the answer for itself. It is keyed by group because `direct` is not
        // one fact: Kady can build the call for an API-key OpenAI-completions
        // group and cannot build it for an OAuth or Local one.
        bindingsByGroup: presetBindingsByGroup(PROVIDER_GROUP_IDS),
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  // The binding table on its own, so a consumer that has not yet chosen a
  // preset can still render the honest per-group, per-surface state.
  app.get("/model-presets/bindings", async () => ({
    bindingsByGroup: presetBindingsByGroup(PROVIDER_GROUP_IDS),
    // Echoed so a client never has to hardcode the group list to render it.
    groups: PROVIDER_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      parameterSupport: group.parameterSupport,
      directDispatch: directDispatchSupport(group),
    })),
  }));

  app.post<{ Body: unknown }>("/model-presets", async (req, reply) => {
    try {
      const input = validateModelPresetInput(req.body, {
        modalInstance,
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
        // a field the user never touched — with one rule that has to be stated
        // because getting it wrong made a cleared field un-clearable in round 1:
        //
        //   ABSENT  (key not in the body) means "leave it as it is".
        //   null    means "clear it".
        //
        // The editor therefore sends an explicit `null` for an emptied override,
        // an emptied hyperparameter set, and for `modal` when the user moves a
        // preset off the Modal group. Without the second rule, deleting the
        // whole override text silently restored the old one, and re-targeting a
        // Modal preset at Groq failed with "modal settings are only valid on a
        // Modal preset" — an error naming nothing the user could act on.
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
        // A provider change always clears `modal` unless the body said
        // otherwise: carrying a previous group's Modal settings into a chat
        // provider can only produce a rejection the user cannot act on.
        if (
          body.modal === undefined &&
          merged.providerId !== existing.providerId &&
          merged.providerId !== "modal"
        ) {
          merged.modal = undefined;
        }
        const input = validateModelPresetInput(merged, {
          modalInstance,
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
        if (!group) {
          throw new ModelPresetError(
            400,
            `Preset "${preset.name}" names a provider Kady no longer offers. Edit the preset to pick another provider.`,
          );
        }
        // The same predicate the ▶ Test control and the `direct` binding row
        // use, so a request that reaches here despite a disabled button is
        // refused with the identical wording rather than a second one.
        const support = directDispatchSupport(group);
        if (!support.supported) {
          throw new ModelPresetError(400, support.reason ?? `${group.label} presets cannot be tested.`);
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

  /**
   * Row 6's binding: run this Modal preset's Hugging Face model on Modal, with
   * the GPU count the stepper set.
   *
   * The request object is built by `modalJobRequestForPreset` and handed to the
   * EXISTING Modal job path — `modalJobManager.submit`, the same entry point
   * `POST /modal/jobs` uses. No Modal file is edited, no second submission path
   * is written, and no second credential check is added: `submit` already
   * refuses on `modalConfigured()` (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET), which
   * is the one Modal credential path.
   */
  app.post<{ Params: { id: string }; Body: { command?: string } | null }>(
    "/model-presets/:id/modal-job",
    async (req, reply) => {
      try {
        const preset = requirePreset(req.params.id);
        if (preset.providerId !== "modal") {
          throw new ModelPresetError(
            400,
            `Preset "${preset.name}" is not a Modal preset, so there is no Modal job to run.`,
          );
        }
        if (!modalConfigured()) {
          throw new ModelPresetError(
            409,
            providerGroup("modal")?.notConfiguredReason ?? "Modal is not configured.",
          );
        }
        const request = modalJobRequestForPreset(preset, {
          ...(req.body?.command ? { command: String(req.body.command) } : {}),
        });
        const submit = options.submitModalJob ?? submitToModalJobManager;
        const job = submit(currentProjectId(), request, {
          sessionId: `model-preset-${preset.id}`,
          submittedBy: "api",
        });
        reply.code(202);
        return {
          presetId: preset.id,
          jobId: job.id,
          state: job.state,
          // Echoed so the caller — and the Gate B assertion — can see the two
          // values row 6 is about on the request that was actually submitted.
          request: {
            instance: job.request.instance,
            gpuCount: job.request.gpuCount,
            command: job.request.command,
          },
          huggingFaceModelId: preset.modal?.huggingFaceModelId ?? null,
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );
}

/** The existing Modal entry point, named once so the route reads as reuse. */
function submitToModalJobManager(
  projectId: string,
  request: ModalJobRequest,
  owner: { sessionId: string; submittedBy: "api" },
): ModalJob {
  return modalJobManager.submit(projectId, request, owner);
}

export { MODEL_PRESET_REF_PREFIX };
