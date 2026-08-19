"use client";

/**
 * Model preset client.
 *
 * Deliberately a hook of its own rather than a branch inside `useModels`: the
 * model picker needs presets, but so does the Settings section, and neither
 * should pay for the other's discovery calls. `useModels` composes this hook
 * for the picker rather than duplicating the fetch.
 *
 * Everything a surface needs in order to be honest about a dropped value comes
 * back from the server (`parameterSupport`, `bindingBySurface`) — no component
 * hardcodes which provider accepts which parameter, so a change on the server
 * cannot leave a live-looking control behind in the UI.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/projects";

export const PROVIDER_GROUP_IDS = [
  "cerebras",
  "openai",
  "openrouter",
  "anthropic",
  "groq",
  "xai",
  "local",
  "modal",
] as const;

export type ProviderGroupId = (typeof PROVIDER_GROUP_IDS)[number];

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ProviderParameterSupport {
  temperature: boolean;
  topP: boolean;
  maxTokens: boolean;
  reasoningEffort: boolean;
  seed: boolean;
}

export interface ProviderGroupStatus {
  id: ProviderGroupId;
  label: string;
  kind: "api-key" | "oauth-subscription" | "local" | "compute";
  projectsFrom: "subscription-providers" | "runtime-registry" | "none";
  runtimeProviderIds: string[];
  /** Environment variable NAMES the user must set. Never a value. */
  credentialVariableNames: string[];
  parameterSupport: ProviderParameterSupport;
  dispatchableAsChatModel: boolean;
  configured: boolean;
  notConfiguredReason?: string;
}

export interface ModelPresetHyperparameters {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  seed?: number;
}

export interface ModelPresetModalSettings {
  huggingFaceModelId: string;
  gpuCount: number;
  instanceId?: string;
}

export interface ModelPreset {
  id: string;
  name: string;
  providerId: ProviderGroupId;
  modelId: string;
  ref: string;
  hyperparameters?: ModelPresetHyperparameters;
  systemPromptOverride?: string;
  modal?: ModelPresetModalSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPresetInput {
  name: string;
  providerId: ProviderGroupId;
  modelId: string;
  hyperparameters?: ModelPresetHyperparameters;
  systemPromptOverride?: string;
  modal?: ModelPresetModalSettings;
}

export type PresetBindingSurface =
  | "direct"
  | "chat-session"
  | "workflow-node"
  | "hosted-fusion-supervised";

export interface PresetBinding {
  hyperparameters: "bound" | "dropped";
  systemPromptOverride: "bound" | "dropped";
  reason?: string;
}

export interface PresetTestResult {
  presetId: string;
  ref: string;
  status: number;
  text: string | null;
  request: {
    url: string;
    method: string;
    authHeaderName: string;
    body: Record<string, unknown>;
  };
  binding: PresetBinding;
}

/** The synthetic selector id a preset appears under in the model picker. */
export const MODEL_PRESET_REF_PREFIX = "preset/";

export function presetSelectorId(preset: Pick<ModelPreset, "id">): string {
  return `${MODEL_PRESET_REF_PREFIX}${preset.id}`;
}

export const MODEL_PRESETS_CHANGED_EVENT = "kady:model-presets-changed";

function notifyPresetsChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MODEL_PRESETS_CHANGED_EVENT));
  }
}

async function detailFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body?.detail === "string" && body.detail.trim()
      ? body.detail
      : fallback;
  } catch {
    return fallback;
  }
}

export interface ModelPresetListResponse {
  presets: ModelPreset[];
  groups: ProviderGroupStatus[];
  /** Per-surface binding truth, shipped with the list so nothing hardcodes it. */
  bindings: Record<PresetBindingSurface, PresetBinding>;
}

export const EMPTY_BINDINGS: Record<PresetBindingSurface, PresetBinding> = {
  direct: { hyperparameters: "dropped", systemPromptOverride: "dropped" },
  "chat-session": { hyperparameters: "dropped", systemPromptOverride: "dropped" },
  "workflow-node": { hyperparameters: "dropped", systemPromptOverride: "dropped" },
  "hosted-fusion-supervised": {
    hyperparameters: "dropped",
    systemPromptOverride: "dropped",
  },
};

/**
 * Validate before rendering (#62): a malformed-but-200 response degrades to an
 * error state instead of throwing during render.
 */
function isPresetListResponse(value: unknown): value is ModelPresetListResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.presets) &&
    Array.isArray(record.groups) &&
    Boolean(record.bindings) &&
    typeof record.bindings === "object"
  );
}

export async function fetchModelPresets(): Promise<ModelPresetListResponse> {
  const response = await apiFetch("/model-presets");
  if (!response.ok) {
    throw new Error(await detailFrom(response, "Could not load model presets."));
  }
  const payload: unknown = await response.json();
  if (!isPresetListResponse(payload)) {
    throw new Error(
      "The server returned a model-preset list Kady could not read. Reload the page; if it persists, restart Kady.",
    );
  }
  return payload;
}

export async function createModelPreset(input: ModelPresetInput): Promise<ModelPreset> {
  const response = await apiFetch("/model-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await detailFrom(response, "Could not save the preset."));
  }
  const preset = (await response.json()) as ModelPreset;
  notifyPresetsChanged();
  return preset;
}

export async function updateModelPreset(
  id: string,
  input: ModelPresetInput,
): Promise<ModelPreset> {
  const response = await apiFetch(`/model-presets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await detailFrom(response, "Could not save the preset."));
  }
  const preset = (await response.json()) as ModelPreset;
  notifyPresetsChanged();
  return preset;
}

export async function deleteModelPreset(id: string): Promise<void> {
  const response = await apiFetch(`/model-presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await detailFrom(response, "Could not delete the preset."));
  }
  notifyPresetsChanged();
}

export async function testModelPreset(
  id: string,
  prompt?: string,
): Promise<PresetTestResult> {
  const response = await apiFetch(`/model-presets/${encodeURIComponent(id)}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prompt ? { prompt } : {}),
  });
  if (!response.ok) {
    throw new Error(await detailFrom(response, "The provider call did not complete."));
  }
  return (await response.json()) as PresetTestResult;
}

export interface UseModelPresetsReturn {
  presets: ModelPreset[];
  groups: ProviderGroupStatus[];
  bindings: Record<PresetBindingSurface, PresetBinding>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModelPresets(): UseModelPresetsReturn {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [groups, setGroups] = useState<ProviderGroupStatus[]>([]);
  const [bindings, setBindings] =
    useState<Record<PresetBindingSurface, PresetBinding>>(EMPTY_BINDINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void fetchModelPresets()
      .then((payload) => {
        setPresets(payload.presets);
        setGroups(payload.groups);
        setBindings(payload.bindings);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load model presets.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const reload = () => load();
    window.addEventListener(MODEL_PRESETS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MODEL_PRESETS_CHANGED_EVENT, reload);
  }, [load]);

  return { presets, groups, bindings, loading, error, refresh: load };
}

/** Presets grouped by provider, in the owner's stated group order. */
export function groupPresetsByProvider(
  presets: ModelPreset[],
  groups: ProviderGroupStatus[],
): Array<{ group: ProviderGroupStatus; presets: ModelPreset[] }> {
  return groups.map((group) => ({
    group,
    presets: presets.filter((preset) => preset.providerId === group.id),
  }));
}

/**
 * The parameters this provider will not accept, as `[field, reason]` pairs, so
 * a control can render disabled with the reason beside it rather than silently
 * dropping the value.
 */
export function unsupportedParameterReasons(
  group: Pick<ProviderGroupStatus, "label" | "parameterSupport">,
): Record<keyof ProviderParameterSupport, string | null> {
  const label = group.label;
  const reasonFor = (supported: boolean, what: string) =>
    supported ? null : `${label} does not accept ${what}.`;
  return {
    temperature: reasonFor(group.parameterSupport.temperature, "a temperature"),
    topP: reasonFor(group.parameterSupport.topP, "a top_p"),
    maxTokens: reasonFor(group.parameterSupport.maxTokens, "a max tokens limit"),
    reasoningEffort: reasonFor(
      group.parameterSupport.reasoningEffort,
      "a reasoning level",
    ),
    seed: reasonFor(group.parameterSupport.seed, "a seed"),
  };
}
