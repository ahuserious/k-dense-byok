/**
 * Model presets — the persisted store.
 *
 * A preset is a named bundle of `provider group + model + call parameters` that
 * can be selected anywhere a model is chosen. Consumers persist the preset's
 * **id** and resolve it at dispatch time; they never copy its contents (see
 * docs/model-presets.md and the F1 interface).
 *
 * Deliberately global rather than per project. A preset is a policy statement
 * about which model to use — the watcher model, the rescue model, the model a
 * given chat runs on — and those follow the user, not the project directory.
 * Making them per project would mean the same policy had to be re-authored in
 * every project, which is the "model defaults are constants" failure this is
 * meant to remove.
 *
 * This module deliberately imports nothing from `models.ts`: `models.ts` reads
 * presets to resolve a `preset/<id>` ref, so the dependency has to run one way.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isProviderGroupId,
  providerGroup,
  providerGroupModelRef,
  type ProviderGroupId,
} from "./providers/registry.ts";

/** Synthetic selector prefix, mirroring the existing `fusion/<id>` entries. */
export const MODEL_PRESET_REF_PREFIX = "preset/";

export const MAX_MODEL_PRESETS = 256;
export const MAX_PRESET_NAME_LENGTH = 80;
export const MAX_SYSTEM_PROMPT_OVERRIDE_LENGTH = 32_000;

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelPresetHyperparameters {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  seed?: number;
}

export interface ModelPresetModalSettings {
  /** Hugging Face hub id, shape-validated only (`org/name`). No network call. */
  huggingFaceModelId: string;
  gpuCount: number;
  /** Modal instance id from the existing catalogue, when the user pinned one. */
  instanceId?: string;
}

export interface ModelPreset {
  id: string;
  name: string;
  providerId: ProviderGroupId;
  modelId: string;
  /** Derived, read-only: the canonical ref Kady dispatches with. */
  ref: string;
  hyperparameters?: ModelPresetHyperparameters;
  systemPromptOverride?: string;
  modal?: ModelPresetModalSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPresetInput {
  name: string;
  providerId: string;
  modelId: string;
  hyperparameters?: ModelPresetHyperparameters;
  systemPromptOverride?: string;
  modal?: ModelPresetModalSettings;
}

export class ModelPresetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ModelPresetError";
  }
}

/**
 * `org/name`, the Hugging Face hub shape. Validated by shape only — no HF API
 * is contacted and none is depended on, because Hugging Face plumbing is lane
 * F12's and does not exist in this tree yet.
 */
const HUGGING_FACE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

const LOCAL_MODEL_REF_PREFIXES = ["ollama/", "openai-compatible/"] as const;

interface PresetFileV1 {
  schemaVersion: 1;
  presets: ModelPreset[];
}

/**
 * Where presets live. Outside every project sandbox and outside the Pi agent
 * directory, matching the personality store's arrangement. Overridable so tests
 * never touch a real user's file.
 */
export function modelPresetsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KADY_MODEL_PRESETS_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".kady", "model-presets.json");
}

function readFile(env: NodeJS.ProcessEnv): PresetFileV1 {
  const file = modelPresetsFilePath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, presets: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // #62's lesson applied one layer down: a malformed store degrades to empty
    // rather than throwing into whatever is reading it.
    console.warn(
      "[model-presets] The preset store is not valid JSON; continuing with no presets. " +
        "Fix or remove the file to restore them.",
    );
    return { schemaVersion: 1, presets: [] };
  }
  const presets = (parsed as PresetFileV1 | null)?.presets;
  if (!Array.isArray(presets)) return { schemaVersion: 1, presets: [] };
  return {
    schemaVersion: 1,
    presets: presets.filter((preset): preset is ModelPreset =>
      Boolean(
        preset &&
          typeof preset === "object" &&
          typeof (preset as ModelPreset).id === "string" &&
          typeof (preset as ModelPreset).modelId === "string" &&
          isProviderGroupId(String((preset as ModelPreset).providerId)),
      ),
    ),
  };
}

function writeFile(contents: PresetFileV1, env: NodeJS.ProcessEnv): void {
  const file = modelPresetsFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function mintPresetId(): string {
  return `mp_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelPresetError(400, `${field} must be a finite number.`);
  }
  return value;
}

function validateHyperparameters(
  raw: unknown,
  providerId: ProviderGroupId,
): ModelPresetHyperparameters | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelPresetError(400, "hyperparameters must be an object.");
  }
  const group = providerGroup(providerId);
  if (!group) throw new ModelPresetError(400, `Unknown provider ${providerId}.`);
  const input = raw as Record<string, unknown>;
  const out: ModelPresetHyperparameters = {};

  const reject = (field: string, supported: boolean) => {
    if (!supported) {
      throw new ModelPresetError(
        400,
        `${group.label} does not accept ${field}. Leave it unset for this provider.`,
      );
    }
  };

  if (input.temperature !== undefined) {
    reject("a temperature", group.parameterSupport.temperature);
    const temperature = requireFiniteNumber(input.temperature, "temperature");
    if (temperature < 0 || temperature > 2) {
      throw new ModelPresetError(400, "temperature must be between 0 and 2.");
    }
    out.temperature = temperature;
  }
  if (input.topP !== undefined) {
    reject("a top_p", group.parameterSupport.topP);
    const topP = requireFiniteNumber(input.topP, "topP");
    if (topP < 0 || topP > 1) {
      throw new ModelPresetError(400, "topP must be between 0 and 1.");
    }
    out.topP = topP;
  }
  if (input.maxTokens !== undefined) {
    reject("a max_tokens", group.parameterSupport.maxTokens);
    const maxTokens = requireFiniteNumber(input.maxTokens, "maxTokens");
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new ModelPresetError(400, "maxTokens must be a positive integer.");
    }
    out.maxTokens = maxTokens;
  }
  if (input.reasoningEffort !== undefined) {
    reject("a reasoning level", group.parameterSupport.reasoningEffort);
    if (!REASONING_EFFORTS.includes(input.reasoningEffort as ReasoningEffort)) {
      throw new ModelPresetError(
        400,
        `reasoningEffort must be one of: ${REASONING_EFFORTS.join(", ")}.`,
      );
    }
    out.reasoningEffort = input.reasoningEffort as ReasoningEffort;
  }
  if (input.seed !== undefined) {
    reject("a seed", group.parameterSupport.seed);
    const seed = requireFiniteNumber(input.seed, "seed");
    if (!Number.isInteger(seed)) {
      throw new ModelPresetError(400, "seed must be an integer.");
    }
    out.seed = seed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateModal(
  raw: unknown,
  providerId: ProviderGroupId,
  maxGpuCountForInstance: (instanceId: string) => number | null,
): ModelPresetModalSettings | undefined {
  if (providerId !== "modal") {
    if (raw !== undefined && raw !== null) {
      throw new ModelPresetError(
        400,
        "modal settings are only valid on a Modal preset.",
      );
    }
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelPresetError(
      400,
      "A Modal preset needs a Hugging Face model id and a GPU count.",
    );
  }
  const input = raw as Record<string, unknown>;
  const huggingFaceModelId = String(input.huggingFaceModelId ?? "").trim();
  if (!HUGGING_FACE_MODEL_ID_RE.test(huggingFaceModelId)) {
    throw new ModelPresetError(
      400,
      'The Hugging Face model id must look like "org/name", for example "meta-llama/Llama-3.3-70B-Instruct".',
    );
  }
  const gpuCount = input.gpuCount;
  if (typeof gpuCount !== "number" || !Number.isInteger(gpuCount) || gpuCount < 1) {
    throw new ModelPresetError(400, "The GPU count must be a whole number of 1 or more.");
  }
  const instanceId = input.instanceId ? String(input.instanceId).trim() : undefined;
  if (instanceId) {
    const maxGpuCount = maxGpuCountForInstance(instanceId);
    if (maxGpuCount === null) {
      throw new ModelPresetError(400, `Unknown Modal instance "${instanceId}".`);
    }
    if (gpuCount > maxGpuCount) {
      throw new ModelPresetError(
        400,
        `The ${instanceId} instance accepts at most ${maxGpuCount} GPUs.`,
      );
    }
  }
  return {
    huggingFaceModelId,
    gpuCount,
    ...(instanceId ? { instanceId } : {}),
  };
}

export interface ModelPresetValidationDependencies {
  /** Max GPUs for a Modal instance id, or null when the id is unknown. */
  maxGpuCountForInstance(instanceId: string): number | null;
  env: NodeJS.ProcessEnv;
}

export function validateModelPresetInput(
  raw: unknown,
  dependencies: ModelPresetValidationDependencies,
): ModelPresetInput & { providerId: ProviderGroupId } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelPresetError(400, "A preset body is required.");
  }
  const input = raw as Record<string, unknown>;
  const name = String(input.name ?? "").trim();
  if (!name || name.length > MAX_PRESET_NAME_LENGTH) {
    throw new ModelPresetError(
      400,
      `The preset name must be 1 to ${MAX_PRESET_NAME_LENGTH} characters.`,
    );
  }
  const providerId = String(input.providerId ?? "").trim();
  if (!isProviderGroupId(providerId)) {
    throw new ModelPresetError(400, `Unknown provider "${providerId}".`);
  }
  const modelId = String(input.modelId ?? "").trim();
  if (!modelId) {
    throw new ModelPresetError(400, "A model id is required.");
  }
  if (
    providerId === "local" &&
    !LOCAL_MODEL_REF_PREFIXES.some((prefix) => modelId.startsWith(prefix))
  ) {
    throw new ModelPresetError(
      400,
      'A local model id must name its server, for example "ollama/llama3" or "openai-compatible/qwen/qwen3-8b".',
    );
  }
  const systemPromptOverrideRaw = input.systemPromptOverride;
  let systemPromptOverride: string | undefined;
  if (systemPromptOverrideRaw !== undefined && systemPromptOverrideRaw !== null) {
    const text = String(systemPromptOverrideRaw);
    if (text.length > MAX_SYSTEM_PROMPT_OVERRIDE_LENGTH) {
      throw new ModelPresetError(
        400,
        `The system-prompt override must be at most ${MAX_SYSTEM_PROMPT_OVERRIDE_LENGTH} characters.`,
      );
    }
    if (text.trim()) systemPromptOverride = text;
  }
  return {
    name,
    providerId,
    modelId,
    hyperparameters: validateHyperparameters(input.hyperparameters, providerId),
    systemPromptOverride,
    modal: validateModal(input.modal, providerId, dependencies.maxGpuCountForInstance),
  };
}

/** Every stored preset, oldest first. */
export function listModelPresets(env: NodeJS.ProcessEnv = process.env): ModelPreset[] {
  return readFile(env).presets;
}

export function getModelPreset(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelPreset | undefined {
  return readFile(env).presets.find((preset) => preset.id === id);
}

/** Resolve a `preset/<id>` selector ref to its stored preset. */
export function presetForSelectorRef(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelPreset | undefined {
  if (!ref.startsWith(MODEL_PRESET_REF_PREFIX)) return undefined;
  return getModelPreset(ref.slice(MODEL_PRESET_REF_PREFIX.length), env);
}

export function createModelPreset(
  input: ModelPresetInput & { providerId: ProviderGroupId },
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
): ModelPreset {
  const file = readFile(env);
  if (file.presets.length >= MAX_MODEL_PRESETS) {
    throw new ModelPresetError(
      400,
      `You already have ${MAX_MODEL_PRESETS} presets. Delete one before adding another.`,
    );
  }
  const timestamp = now();
  const preset: ModelPreset = {
    id: mintPresetId(),
    name: input.name,
    providerId: input.providerId,
    modelId: input.modelId,
    ref: providerGroupModelRef(input.providerId, input.modelId),
    ...(input.hyperparameters ? { hyperparameters: input.hyperparameters } : {}),
    ...(input.systemPromptOverride
      ? { systemPromptOverride: input.systemPromptOverride }
      : {}),
    ...(input.modal ? { modal: input.modal } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeFile({ schemaVersion: 1, presets: [...file.presets, preset] }, env);
  return preset;
}

export function updateModelPreset(
  id: string,
  input: ModelPresetInput & { providerId: ProviderGroupId },
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
): ModelPreset {
  const file = readFile(env);
  const index = file.presets.findIndex((preset) => preset.id === id);
  if (index < 0) {
    throw new ModelPresetError(404, `No preset with id ${id}.`);
  }
  const existing = file.presets[index];
  const updated: ModelPreset = {
    id: existing.id,
    name: input.name,
    providerId: input.providerId,
    modelId: input.modelId,
    ref: providerGroupModelRef(input.providerId, input.modelId),
    ...(input.hyperparameters ? { hyperparameters: input.hyperparameters } : {}),
    ...(input.systemPromptOverride
      ? { systemPromptOverride: input.systemPromptOverride }
      : {}),
    ...(input.modal ? { modal: input.modal } : {}),
    createdAt: existing.createdAt,
    updatedAt: now(),
  };
  const presets = [...file.presets];
  presets[index] = updated;
  writeFile({ schemaVersion: 1, presets }, env);
  return updated;
}

export function deleteModelPreset(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = readFile(env);
  const presets = file.presets.filter((preset) => preset.id !== id);
  if (presets.length === file.presets.length) {
    throw new ModelPresetError(404, `No preset with id ${id}.`);
  }
  writeFile({ schemaVersion: 1, presets }, env);
}
