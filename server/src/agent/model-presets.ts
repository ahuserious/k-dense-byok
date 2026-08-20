/**
 * Model preset resolution and the binding-honesty block.
 *
 * The resolution rule is the whole point of the feature:
 *
 *   Selecting a preset anywhere a model is chosen resolves to that preset's
 *   provider + model + parameters.
 *
 * The second half of the feature is the part this repo has failed at before
 * (#54 sampling controls, #55 harness): a value that is accepted and then
 * discarded. So resolution does not just return the values — it returns, per
 * dispatch surface, whether that surface actually carries them. Every consumer
 * enforces the same rule from the same data instead of re-deriving it, and no
 * surface can ship a live-looking control over a dropped value by accident.
 *
 * The surface verdicts below are statements about this tree at the sha F1
 * landed on. They are not aspirational, and each one names the reason a user
 * can act on (§6.7 — and never a filesystem path, #71).
 */
import {
  directDispatchSupport,
  providerGroup,
  type ProviderGroupId,
  type ProviderGroupParameterSupport,
} from "./providers/registry.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModalJobRequest } from "../modal/types.ts";
import {
  ModelPresetError,
  type ModelPreset,
  type ModelPresetHyperparameters,
  type ModelPresetModalSettings,
} from "./model-presets-store.ts";

/**
 * Where a resolved preset is about to be used.
 *
 *   direct                   — the provider call Kady makes for this preset
 *                              (`POST /model-presets/:id/test`, and any future
 *                              caller of `dispatchPresetCompletion`)
 *   chat-session             — the main Kady chat / `POST /run`
 *   workflow-node            — a Pi-delegated typed-workflow node
 *   hosted-fusion-supervised — a hosted OpenRouter Fusion node on the
 *                              supervised transport
 */
export const PRESET_BINDING_SURFACES = [
  "direct",
  "chat-session",
  "workflow-node",
  "hosted-fusion-supervised",
] as const;

export type PresetBindingSurface = (typeof PRESET_BINDING_SURFACES)[number];

export type PresetBindingState = "bound" | "dropped";

export interface PresetBinding {
  hyperparameters: PresetBindingState;
  systemPromptOverride: PresetBindingState;
  /** Required whenever anything is "dropped". User-facing; names no path. */
  reason?: string;
}

/**
 * The per-surface truth, derived from the audit trace in
 * `$W/reports/F1-audit.md` §C.
 *
 *  - `direct`: NOT a constant. It is `directDispatchSupport(group)` — see
 *    `bindingForDirect` below. Round 1 had it as the flat literal
 *    `{hyperparameters: "bound", systemPromptOverride: "bound"}`, served for
 *    every group, which told an Anthropic preset's owner "Carried" about a call
 *    Kady cannot build. The binding block must be derived from the same
 *    predicate the button is, never asserted alongside it.
 *  - `chat-session`: this tip installs `makeModelPresetExtension` next to
 *    Fusion and arms it from `/run`. Dest still lacks those files until this
 *    lane merges. No Modal → OpenRouter fallback.
 *  - `workflow-node`: a node can name a preset durably as provider `preset`
 *    and model `<preset-id>`. That resolves to the preset's provider and model.
 *    Sampling and the system-prompt override still come from NodeSpec settings
 *    because ModelRequest has no control fields.
 *  - `hosted-fusion-supervised`: Hosted Fusion validation accepts only a fixed
 *    OpenRouter ModelRequest. That shape has no durable preset id.
 */
const SURFACE_BINDINGS: Record<
  Exclude<PresetBindingSurface, "direct" | "chat-session">,
  PresetBinding
> = {
  "workflow-node": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason:
      "A workflow node can name a preset as provider \"preset\" and model \"<preset-id>\", which sets the node's provider and model. Sampling and the system-prompt override still come from the node's own settings, because ModelRequest has no preset-control fields.",
  },
  "hosted-fusion-supervised": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason:
      "Hosted Fusion accepts only a fixed OpenRouter ModelRequest, which has no durable preset id, so a preset's hyperparameters and system-prompt override are not what the supervised transport sends.",
  },
};

/**
 * The chat-session extension is installed in this lane tip (session-registry
 * + sessions.ts, same commit as this flip). Dest remains unbound until merge.
 */
export const CHAT_SESSION_PRESET_EXTENSION_INSTALLED = true;

const CHAT_HYPERPARAMETER_GROUPS = new Set<ProviderGroupId>([
  "cerebras",
  "openrouter",
  "groq",
  "local",
]);

function bindingForInstalledChat(groupId: ProviderGroupId): PresetBinding {
  const group = providerGroup(groupId);
  if (!group?.dispatchableAsChatModel) {
    return {
      hyperparameters: "dropped",
      systemPromptOverride: "dropped",
      reason: `${group?.label ?? groupId} presets describe a compute job rather than a chat model.`,
    };
  }
  if (CHAT_HYPERPARAMETER_GROUPS.has(groupId)) {
    return {
      hyperparameters: "bound",
      systemPromptOverride: "bound",
    };
  }
  return {
    hyperparameters: "dropped",
    systemPromptOverride: "bound",
    reason:
      `${group.label} chat uses Pi's subscription transport, whose sampling payload is provider-specific. ` +
      "Kady replaces the system prompt, but leaves this preset's hyperparameters disabled rather than guessing fields the provider may discard.",
  };
}

function bindingForChat(groupId: ProviderGroupId): PresetBinding {
  const group = providerGroup(groupId);
  if (!group?.dispatchableAsChatModel) {
    return {
      hyperparameters: "dropped",
      systemPromptOverride: "dropped",
      reason: `${group?.label ?? groupId} presets describe a compute job rather than a chat model.`,
    };
  }
  if (CHAT_SESSION_PRESET_EXTENSION_INSTALLED) {
    return bindingForInstalledChat(groupId);
  }
  return {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason:
      "Chat applies this preset's provider and model. Its hyperparameters and system-prompt override wait for the session builder to install Kady's model-preset extension.",
  };
}

export function isPresetBindingSurface(value: string): value is PresetBindingSurface {
  return (PRESET_BINDING_SURFACES as readonly string[]).includes(value);
}

/**
 * The `direct` verdict for one group, read straight off the dispatch predicate.
 *
 * There is no independent statement of it anywhere: if `directDispatchSupport`
 * refuses the group, this says "dropped" and repeats that function's reason
 * verbatim, so the Settings table and the disabled ▶ Test control cannot
 * disagree with what dispatch would actually do.
 */
function bindingForDirect(groupId: ProviderGroupId): PresetBinding {
  const group = providerGroup(groupId);
  if (!group) {
    return {
      hyperparameters: "dropped",
      systemPromptOverride: "dropped",
      reason: "Kady no longer offers this provider. Edit the preset to pick another one.",
    };
  }
  const support = directDispatchSupport(group);
  if (support.supported) {
    return { hyperparameters: "bound", systemPromptOverride: "bound" };
  }
  return {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason: support.reason,
  };
}

export function presetBindingForSurface(
  surface: PresetBindingSurface,
  groupId: ProviderGroupId,
): PresetBinding {
  if (surface === "direct") return bindingForDirect(groupId);
  if (surface === "chat-session") return bindingForChat(groupId);
  return { ...SURFACE_BINDINGS[surface] };
}

export function presetBindingBySurface(
  groupId: ProviderGroupId,
): Record<PresetBindingSurface, PresetBinding> {
  const out = {} as Record<PresetBindingSurface, PresetBinding>;
  for (const surface of PRESET_BINDING_SURFACES) {
    out[surface] = presetBindingForSurface(surface, groupId);
  }
  return out;
}

/**
 * The whole table, per group. Shipped with `GET /model-presets` so the Settings
 * section can render every group's honest verdict without a request per group
 * and without any component deciding one for itself.
 */
export function presetBindingsByGroup(
  groupIds: readonly ProviderGroupId[],
): Record<string, Record<PresetBindingSurface, PresetBinding>> {
  const out: Record<string, Record<PresetBindingSurface, PresetBinding>> = {};
  for (const groupId of groupIds) out[groupId] = presetBindingBySurface(groupId);
  return out;
}

export interface ResolvedModelPreset {
  presetId: string;
  name: string;
  ref: string;
  providerId: ProviderGroupId;
  modelId: string;
  hyperparameters?: ModelPresetHyperparameters;
  systemPromptOverride?: string;
  modal?: ModelPresetModalSettings;
  /** Which parameters this provider accepts at all (row 4's disabled state). */
  parameterSupport: ProviderGroupParameterSupport;
  /** The surface this response was resolved for. */
  surface: PresetBindingSurface;
  /** Binding for `surface`. */
  binding: PresetBinding;
  /** Binding for every surface, so a consumer can pick without another call. */
  bindingBySurface: Record<PresetBindingSurface, PresetBinding>;
}

export interface PresetResolutionOptions {
  surface?: PresetBindingSurface;
  /**
   * Configuration state of the preset's provider group. Resolution fails closed
   * when this is false — it does not fall back to a default model.
   */
  providerConfigured: boolean;
  providerNotConfiguredReason?: string;
}

/**
 * Resolve a stored preset for one surface.
 *
 * Fails closed on an unconfigured provider (the caller passes that state in;
 * this function contacts nothing) and never substitutes a different model.
 */
export function resolveModelPreset(
  preset: ModelPreset,
  options: PresetResolutionOptions,
): ResolvedModelPreset {
  const group = providerGroup(preset.providerId);
  if (!group) {
    throw new ModelPresetError(
      409,
      `Preset "${preset.name}" names a provider Kady no longer offers. Edit the preset to pick another provider.`,
    );
  }
  if (!options.providerConfigured) {
    throw new ModelPresetError(
      409,
      options.providerNotConfiguredReason ?? group.notConfiguredReason,
    );
  }
  const surface = options.surface ?? "direct";
  return {
    presetId: preset.id,
    name: preset.name,
    ref: preset.ref,
    providerId: preset.providerId,
    modelId: preset.modelId,
    ...(preset.hyperparameters ? { hyperparameters: preset.hyperparameters } : {}),
    ...(preset.systemPromptOverride
      ? { systemPromptOverride: preset.systemPromptOverride }
      : {}),
    ...(preset.modal ? { modal: preset.modal } : {}),
    parameterSupport: group.parameterSupport,
    surface,
    binding: presetBindingForSurface(surface, preset.providerId),
    bindingBySurface: presetBindingBySurface(preset.providerId),
  };
}

/**
 * Apply a resolved preset to a Pi `before_provider_request` payload.
 *
 * This is the binder the chat session needs in order for `chat-session` to
 * become "bound". It is exported and tested here; installing it costs the one
 * `extensionFactories` line quoted in INTEGRATION.md, which is outside F1's
 * writable set. Shipping it wired-but-unproven, or shipping the controls as if
 * this were already installed, is exactly the failure mode this wave exists to
 * stop — so the binding block above reports `chat-session` as dropped until
 * that line lands.
 *
 * Reserved keys are never overwritten from `hyperparameters`: the payload's
 * `messages`, `model`, `tools` and `stream` belong to Pi.
 */
export function applyPresetHyperparametersToProviderPayload(
  payload: Record<string, unknown>,
  resolved: Pick<
    ResolvedModelPreset,
    "hyperparameters" | "parameterSupport"
  >,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  const hyperparameters = resolved.hyperparameters ?? {};
  const support = resolved.parameterSupport;
  if (support.temperature && hyperparameters.temperature !== undefined) {
    next.temperature = hyperparameters.temperature;
  }
  if (support.topP && hyperparameters.topP !== undefined) {
    next.top_p = hyperparameters.topP;
  }
  if (support.maxTokens && hyperparameters.maxTokens !== undefined) {
    next.max_tokens = hyperparameters.maxTokens;
  }
  if (support.reasoningEffort && hyperparameters.reasoningEffort !== undefined) {
    next.reasoning_effort = hyperparameters.reasoningEffort;
  }
  if (support.seed && hyperparameters.seed !== undefined) {
    next.seed = hyperparameters.seed;
  }
  return next;
}

export function applyPresetToProviderPayload(
  payload: Record<string, unknown>,
  resolved: Pick<
    ResolvedModelPreset,
    "hyperparameters" | "systemPromptOverride" | "parameterSupport"
  >,
): Record<string, unknown> {
  const next = applyPresetHyperparametersToProviderPayload(payload, resolved);
  if (resolved.systemPromptOverride) {
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    const withoutSystem = messages.filter(
      (message) =>
        !(
          message &&
          typeof message === "object" &&
          (message as { role?: unknown }).role === "system"
        ),
    );
    next.messages = [
      { role: "system", content: resolved.systemPromptOverride },
      ...withoutSystem,
    ];
  }
  return next;
}

/**
 * Pi has already serialized the provider-specific request when this runs. The
 * four chat groups marked hyperparameter-bound all use OpenAI-shaped payloads,
 * but Responses and Chat Completions spell output caps and reasoning
 * differently. Bind against the actual model API instead of writing one
 * provider's keys into another provider's request.
 */
export function applyPresetToPiProviderPayload(
  payload: Record<string, unknown>,
  resolved: Pick<
    ResolvedModelPreset,
    "hyperparameters" | "parameterSupport"
  >,
  model: Pick<Model<Api>, "api" | "provider" | "compat">,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  const hyperparameters = resolved.hyperparameters ?? {};
  const support = resolved.parameterSupport;

  if (support.temperature && hyperparameters.temperature !== undefined) {
    next.temperature = hyperparameters.temperature;
  }
  if (support.topP && hyperparameters.topP !== undefined) {
    next.top_p = hyperparameters.topP;
  }
  if (support.seed && hyperparameters.seed !== undefined) {
    next.seed = hyperparameters.seed;
  }
  if (support.maxTokens && hyperparameters.maxTokens !== undefined) {
    if (
      model.api === "openai-responses" ||
      model.api === "openai-codex-responses" ||
      model.api === "azure-openai-responses"
    ) {
      next.max_output_tokens = hyperparameters.maxTokens;
    } else if ("max_completion_tokens" in next) {
      next.max_completion_tokens = hyperparameters.maxTokens;
    } else {
      next.max_tokens = hyperparameters.maxTokens;
    }
  }
  if (support.reasoningEffort && hyperparameters.reasoningEffort !== undefined) {
    if (
      model.provider === "openrouter" ||
      model.api === "openai-responses" ||
      model.api === "openai-codex-responses" ||
      model.api === "azure-openai-responses"
    ) {
      const current =
        next.reasoning && typeof next.reasoning === "object" && !Array.isArray(next.reasoning)
          ? next.reasoning as Record<string, unknown>
          : {};
      next.reasoning = { ...current, effort: hyperparameters.reasoningEffort };
    } else {
      next.reasoning_effort = hyperparameters.reasoningEffort;
    }
  }
  return next;
}

const SESSION_PRESETS = new Map<string, ResolvedModelPreset>();

function sessionPresetKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

/**
 * Stash one run's resolved preset for the session extension. The run owner
 * clears it in every terminal path, so a later run that omits a preset cannot
 * inherit stale controls.
 */
export function setSessionModelPreset(
  projectId: string,
  sessionId: string,
  preset: ResolvedModelPreset | null,
): void {
  const key = sessionPresetKey(projectId, sessionId);
  if (preset) SESSION_PRESETS.set(key, structuredClone(preset));
  else SESSION_PRESETS.delete(key);
}

/**
 * Bind a chat preset at Pi's two supported seams:
 * - `before_agent_start` replaces the effective system prompt provider-
 *   independently;
 * - `before_provider_request` applies hyperparameters only for a group whose
 *   chat binding is explicitly `bound`.
 */
export function makeModelPresetExtension(
  projectId: string,
  getSessionId: () => string,
): ExtensionFactory {
  const activePreset = (): ResolvedModelPreset | undefined =>
    SESSION_PRESETS.get(sessionPresetKey(projectId, getSessionId()));

  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const preset = activePreset();
      if (
        !preset?.systemPromptOverride ||
        preset.binding.systemPromptOverride !== "bound"
      ) {
        return;
      }
      return { systemPrompt: preset.systemPromptOverride };
    });
    pi.on("before_provider_request", (event, context) => {
      const preset = activePreset();
      if (
        !preset ||
        preset.binding.hyperparameters !== "bound" ||
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload)
      ) {
        return event.payload;
      }
      const model = context.model;
      if (!model) {
        throw new ModelPresetError(
          409,
          `Preset "${preset.name}" could not bind its hyperparameters because the session has no selected model.`,
        );
      }
      return applyPresetToPiProviderPayload(
        event.payload as Record<string, unknown>,
        preset,
        model,
      );
    });
  };
}

/**
 * The `ModalJobRequest` a Modal preset produces — row 6's actual binding.
 *
 * Round 1 stopped at persistence, and the commit message overstated it. This is
 * the missing half: the preset's Hugging Face id and GPU count become the two
 * fields F12's FINAL interface says carry them, and the returned object is what
 * `POST /model-presets/:id/modal-job` hands to `modalJobManager.submit`. The
 * Gate B test asserts on THIS object at the call site, not on the schema.
 *
 * Two things are deliberately NOT done here, because F12 owns them:
 *   - `gpuCount` stays an integer. The `"H100:4"` string is produced server-side
 *     at dispatch by `gpuString(spec, count)` in `modal/catalog.ts`; building it
 *     here would be a second spelling of the same fact.
 *   - No credential is read, named or checked. `modalJobManager.submit` already
 *     refuses on `modalConfigured()`, which is the one Modal credential path
 *     (`MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`); adding a second check here
 *     would be the two-paths-to-one-service bug F12's interface calls out.
 *
 * The request installs `huggingface_hub` into Modal's otherwise-slim default
 * image and runs `snapshot_download` for exactly the model stored by the
 * preset. Callers cannot replace the command: accepting an arbitrary command
 * here would let the endpoint claim it launched one model while running code
 * that never references it. Interpolating the id into a Python string literal
 * is safe because the store accepts only `org/name` over
 * `[A-Za-z0-9._-]` — there is no quote, backslash or newline it can contain —
 * and that regex is the guard, not this comment.
 */
export function modalJobRequestForPreset(
  preset: Pick<ModelPreset, "name" | "modal">,
  options: { timeoutSec?: number } = {},
): ModalJobRequest {
  const modal = preset.modal;
  if (!modal) {
    throw new ModelPresetError(
      400,
      `Preset "${preset.name}" is not a Modal preset, so there is no Modal job to run.`,
    );
  }
  return {
    command:
      `python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='${modal.huggingFaceModelId}')"`,
    ...(modal.instanceId ? { instance: modal.instanceId } : {}),
    gpuCount: modal.gpuCount,
    image: { pip: ["huggingface_hub"] },
    label: `preset: ${preset.name}`,
    ...(options.timeoutSec ? { timeoutSec: options.timeoutSec } : {}),
  };
}
