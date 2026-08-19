import { catalogueEntryFor } from "../agent/models.ts";
import type {
  DurabilityEffort,
  DurabilityModelSelection,
  DurabilitySettingsV1,
} from "./durability-settings.ts";

/**
 * Model defaults are policy, not constants.
 *
 * Nothing here invents a model. A selection that does not resolve to exactly
 * one model fails closed with a message naming the user's next action; it is
 * never quietly replaced by a fallback, because a silent fallback spends the
 * user's money on a model they did not choose.
 */
export type DurabilityModelStatus = "resolved" | "unset" | "unresolvable";

export interface DurabilityModelResolution {
  status: DurabilityModelStatus;
  ref?: string;
  effort?: DurabilityEffort;
  contextWindow?: number;
  pricing?: "priced" | "unpriced";
  reason?: string;
  nextAction?: string;
}

export interface DurabilityResolutionReport {
  watcher: DurabilityModelResolution;
  rescue: DurabilityModelResolution;
}

/**
 * Team A's F1 preset system resolves a preset id to a provider + model at
 * dispatch time. Durability stores the id only. Until F1 lands, an installed
 * resolver is absent and a preset selection fails closed.
 */
export interface DurabilityPresetResolver {
  resolve(presetId: string): { ref: string; effort?: DurabilityEffort } | undefined;
}

const PRESETS_UNAVAILABLE_REASON =
  "Model presets are not available in this build yet.";
const PRESETS_UNAVAILABLE_NEXT_ACTION =
  "Choose a model directly, or wait for Settings ▸ Model providers ▸ Model presets.";

function openRouterId(ref: string): string | undefined {
  return ref.startsWith("openrouter/") ? ref.slice("openrouter/".length) : undefined;
}

function resolveDirect(
  ref: string,
  effort: DurabilityEffort | undefined,
): DurabilityModelResolution {
  const orId = openRouterId(ref);
  if (!orId) {
    // A non-OpenRouter provider ref is carried through untouched; its
    // catalogue lives with that provider, not in the OpenRouter catalogue.
    return { status: "resolved", ref, ...(effort ? { effort } : {}) };
  }
  const entry = catalogueEntryFor(orId);
  return {
    status: "resolved",
    ref,
    ...(effort ? { effort } : {}),
    ...(entry ? { contextWindow: entry.contextWindow } : {}),
    // A model missing from the catalogue prices at $0, which silently disables
    // the project spend cap. Report it rather than let it pass as priced.
    pricing: entry && (entry.costInput > 0 || entry.costOutput > 0) ? "priced" : "unpriced",
  };
}

export function resolveDurabilityModel(
  selection: DurabilityModelSelection,
  options: {
    defaultEffort?: DurabilityEffort;
    presetResolver?: DurabilityPresetResolver;
    minContextWindow?: number;
    slotLabel: string;
  },
): DurabilityModelResolution {
  if (selection.kind === "unset") {
    return {
      status: "unset",
      reason: selection.reason,
      nextAction: `Choose a ${options.slotLabel} in Pipeline options ▸ Durability.`,
    };
  }

  let resolution: DurabilityModelResolution;
  if (selection.kind === "preset") {
    const resolved = options.presetResolver?.resolve(selection.presetId);
    if (!resolved) {
      return {
        status: "unresolvable",
        reason: options.presetResolver
          ? `The selected ${options.slotLabel} preset no longer exists.`
          : PRESETS_UNAVAILABLE_REASON,
        nextAction: options.presetResolver
          ? `Choose another ${options.slotLabel} in Pipeline options ▸ Durability.`
          : PRESETS_UNAVAILABLE_NEXT_ACTION,
      };
    }
    resolution = resolveDirect(
      resolved.ref,
      selection.effort ?? resolved.effort ?? options.defaultEffort,
    );
  } else {
    resolution = resolveDirect(selection.ref, selection.effort ?? options.defaultEffort);
  }

  // Row 24 asks for a large 1M-context model. A model whose context window is
  // known to be too small is rejected here rather than discovered mid-rescue.
  if (
    options.minContextWindow !== undefined &&
    resolution.contextWindow !== undefined &&
    resolution.contextWindow < options.minContextWindow
  ) {
    return {
      status: "unresolvable",
      ref: resolution.ref,
      ...(resolution.effort ? { effort: resolution.effort } : {}),
      contextWindow: resolution.contextWindow,
      reason:
        `The selected ${options.slotLabel} has a ${resolution.contextWindow.toLocaleString("en-US")} ` +
        `token context window, below the ${options.minContextWindow.toLocaleString("en-US")} tokens ` +
        "a rescue needs to carry a failing run's context.",
      nextAction: `Choose a larger ${options.slotLabel} in Pipeline options ▸ Durability.`,
    };
  }
  return resolution;
}

export function resolveDurabilityModels(
  settings: DurabilitySettingsV1,
  presetResolver?: DurabilityPresetResolver,
): DurabilityResolutionReport {
  return {
    watcher: resolveDurabilityModel(settings.watcherModel, {
      defaultEffort: "high",
      slotLabel: "watcher model",
      ...(presetResolver ? { presetResolver } : {}),
    }),
    rescue: resolveDurabilityModel(settings.rescueModel, {
      defaultEffort: settings.rescueEffort,
      minContextWindow: settings.minRescueContextWindow,
      slotLabel: "rescue model",
      ...(presetResolver ? { presetResolver } : {}),
    }),
  };
}

export class DurabilityModelUnavailableError extends Error {
  constructor(
    readonly slot: "watcher" | "rescue",
    readonly resolution: DurabilityModelResolution,
  ) {
    super(
      [resolution.reason, resolution.nextAction].filter(Boolean).join(" ") ||
        `The durability ${slot} model is not available.`,
    );
    this.name = "DurabilityModelUnavailableError";
  }
}

/** The resolved ref, or a legible fail-closed error. Never a substitute model. */
export function requireDurabilityModel(
  slot: "watcher" | "rescue",
  resolution: DurabilityModelResolution,
): { ref: string; effort?: DurabilityEffort } {
  if (resolution.status !== "resolved" || !resolution.ref) {
    throw new DurabilityModelUnavailableError(slot, resolution);
  }
  return {
    ref: resolution.ref,
    ...(resolution.effort ? { effort: resolution.effort } : {}),
  };
}
