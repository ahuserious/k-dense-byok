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
  providerGroup,
  type ProviderGroupId,
  type ProviderGroupParameterSupport,
} from "./providers/registry.ts";
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
 *  - `direct`: Kady builds the outbound request itself
 *    (`providers/dispatch.ts`), so both land. Asserted on the request body by
 *    `server/test/model-presets-binding.test.ts`.
 *  - `chat-session`: `POST /run` resolves the ref and calls `session.setModel`,
 *    so provider and model DO bind — but the session is built with no sampling
 *    binder and no system-prompt override, so those two do not. Flips to
 *    "bound" once the preset binder is installed on the chat session (the one
 *    line requested in INTEGRATION.md).
 *  - `workflow-node` / `hosted-fusion-supervised`: both transports do carry
 *    per-node provider-request controls, and both refuse to run without them —
 *    but those controls come from the node's own settings. No preset feeds
 *    them, so a preset's values would not be what arrives.
 */
const SURFACE_BINDINGS: Record<PresetBindingSurface, PresetBinding> = {
  direct: { hyperparameters: "bound", systemPromptOverride: "bound" },
  "chat-session": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason:
      "Chat uses this preset's provider and model, but not its sampling parameters or system-prompt override. Use Test preset to send a call that carries them.",
  },
  "workflow-node": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason:
      "Workflow nodes take their sampling parameters and prompt from the node's own settings, so a preset only sets the node's provider and model.",
  },
  "hosted-fusion-supervised": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
    reason:
      "Hosted Fusion nodes take their sampling parameters from the node's own settings, so a preset only sets the node's provider and model.",
  },
};

export function isPresetBindingSurface(value: string): value is PresetBindingSurface {
  return (PRESET_BINDING_SURFACES as readonly string[]).includes(value);
}

export function presetBindingForSurface(surface: PresetBindingSurface): PresetBinding {
  return { ...SURFACE_BINDINGS[surface] };
}

export function presetBindingBySurface(): Record<PresetBindingSurface, PresetBinding> {
  const out = {} as Record<PresetBindingSurface, PresetBinding>;
  for (const surface of PRESET_BINDING_SURFACES) {
    out[surface] = presetBindingForSurface(surface);
  }
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
    binding: presetBindingForSurface(surface),
    bindingBySurface: presetBindingBySurface(),
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
export function applyPresetToProviderPayload(
  payload: Record<string, unknown>,
  resolved: Pick<
    ResolvedModelPreset,
    "hyperparameters" | "systemPromptOverride" | "parameterSupport"
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
