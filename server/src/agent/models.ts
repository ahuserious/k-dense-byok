/**
 * Model resolution for the Pi agent.
 *
 * Two providers are supported, matching the product requirement:
 *   - OpenRouter (built-in Pi provider, key via OPENROUTER_API_KEY)
 *   - Ollama (local, OpenAI-compatible at OLLAMA_BASE_URL)
 *
 * The frontend picker sends model refs like "openrouter/anthropic/claude-opus-4.8"
 * or "ollama/llama3". OpenRouter has thousands of models that aren't all in Pi's
 * built-in table, so when `find()` misses we synthesize a Model from the
 * frontend catalogue (web/src/data/models.json) — Pi computes usage.cost from
 * `model.cost`, so we populate it from the catalogue's per-1M pricing.
 */
import fs from "node:fs";
import path from "node:path";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PROVIDER,
  OLLAMA_BASE_URL,
  REPO_ROOT,
} from "../config.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CATALOGUE_PATH = path.join(REPO_ROOT, "web", "src", "data", "models.json");

interface CatalogueEntry {
  contextWindow: number;
  maxTokens: number;
  costInput: number; // USD per 1M prompt tokens
  costOutput: number; // USD per 1M completion tokens
  input: ("text" | "image")[];
  label: string;
  isFusion: boolean; // true for OpenRouter's Fusion meta-model (variable, never-$0 pricing)
}

// OpenRouter's Fusion meta-model runs a panel of models plus a judge: it bills several
// completions per request and reports variable pricing, so a Fusion turn must never
// resolve to {cost: $0} — that would silently disable the project spend caps. When the
// catalogue carries no positive price for it, FUSION_COST_FLOOR is the conservative
// per-1M floor we charge instead so budgets still accrue. (Forwarding a picker's custom
// expert panel into the Fusion request is a separate, tracked follow-up — see resolveModel.)
const FUSION_MODEL_ID = "openrouter/fusion";
const FUSION_COST_FLOOR = { input: 5, output: 15 };

let catalogue: Map<string, CatalogueEntry> | null = null;

/** Normalize a frontend/user model ref to a bare OpenRouter id ("vendor/model"). */
function stripOpenRouter(ref: string): string {
  return ref.startsWith("openrouter/") ? ref.slice("openrouter/".length) : ref;
}

function loadCatalogue(): Map<string, CatalogueEntry> {
  if (catalogue) return catalogue;
  const map = new Map<string, CatalogueEntry>();
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOGUE_PATH, "utf-8")) as unknown[];
    for (const item of raw) {
      const m = item as Record<string, unknown>;
      const id = String(m.id ?? "");
      if (!id) continue;
      const pricing = (m.pricing ?? {}) as Record<string, unknown>;
      const modality = String(m.modality ?? "text->text");
      const input: ("text" | "image")[] = modality.includes("image")
        ? ["text", "image"]
        : ["text"];
      map.set(stripOpenRouter(id), {
        contextWindow: Number(m.context_length ?? 0) || 128_000,
        maxTokens: Number(m.max_completion_tokens ?? 0) || 8192,
        costInput: Number(pricing.prompt ?? 0),
        costOutput: Number(pricing.completion ?? 0),
        input,
        label: String(m.label ?? id),
        isFusion: Boolean(m.isFusion),
      });
    }
  } catch (err) {
    // Synthesized models fall back to $0 pricing, which silently disables the
    // project spend caps — make the misconfiguration visible.
    console.warn(
      `[models] Failed to load model catalogue at ${CATALOGUE_PATH}: ` +
        `${(err as Error).message}. Unknown models will be priced at $0, ` +
        `so spend limits will not accrue.`,
    );
  }
  catalogue = map;
  return map;
}

// Choose a per-1M cost. A positive catalogue price is always trusted. Otherwise, a Fusion
// model falls back to the conservative floor (never $0); a normal unknown model keeps the
// historical $0 fallback (changing that is out of scope for the Fusion work).
function pickCost(catalogueValue: number | undefined, isFusion: boolean, floor: number): number {
  if (typeof catalogueValue === "number" && catalogueValue > 0) return catalogueValue;
  return isFusion ? floor : catalogueValue ?? 0;
}

// OpenRouter reasoning-effort suffixes are a routing form (e.g.
// "anthropic/claude-opus-4.8-xhigh"), NOT separate catalogue rows — so an exact
// lookup misses and the model would resolve to $0 cost, silently disabling the
// project spend cap. These are stripped to price as the base model.
const EFFORT_SUFFIXES = ["-xhigh", "-high", "-medium", "-low", "-minimal", "-none"];

/**
 * Catalogue lookup tolerant of a reasoning-effort suffix: exact match first
 * (so "-fast", a distinct catalogue model with its own pricing, is never
 * stripped), then fall back to the base model with the effort suffix removed.
 */
export function catalogueEntryFor(orId: string): CatalogueEntry | undefined {
  const cat = loadCatalogue();
  const exact = cat.get(orId);
  if (exact) return exact;
  for (const sfx of EFFORT_SUFFIXES) {
    if (orId.endsWith(sfx)) {
      const base = cat.get(orId.slice(0, -sfx.length));
      if (base) return base;
    }
  }
  return undefined;
}

function buildOpenRouterModel(orId: string): Model<Api> {
  // Look the entry up under the SAME normalization the catalogue is keyed by
  // (stripOpenRouter inside catalogueEntryFor), so an OpenRouter-vendor meta-model
  // like `openrouter/fusion` — keyed as `fusion` — is found instead of missing and
  // pricing at $0; the lookup is also tolerant of reasoning-effort suffixes.
  const cat = catalogueEntryFor(stripOpenRouter(orId));
  const isFusion = cat?.isFusion ?? false;
  return {
    id: orId,
    name: cat?.label ?? orId,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: true,
    input: cat?.input ?? ["text"],
    cost: {
      input: pickCost(cat?.costInput, isFusion, FUSION_COST_FLOOR.input),
      output: pickCost(cat?.costOutput, isFusion, FUSION_COST_FLOOR.output),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: cat?.contextWindow ?? 128_000,
    maxTokens: cat?.maxTokens ?? 8192,
  };
}

/** Panel (analysis) model ids out of a Fusion request body (real schema). */
function fusionPanelModels(fusionConfig: Record<string, unknown>): string[] {
  const plugins = fusionConfig.plugins as Array<Record<string, unknown>> | undefined;
  const panel = plugins?.[0]?.analysis_models;
  return Array.isArray(panel) ? (panel as string[]) : [];
}

/**
 * Build the Pi Model for an OpenRouter Fusion run. The id is "openrouter/fusion"
 * (the wire model the extension rewrites the body to), but its cost MUST be the
 * SUM of the analysis panel models' catalogue prices — otherwise Pi ledgers the
 * turn at $0 (cost flows from model.cost, not the rewritten HTTP body) and the
 * project spend cap is silently bypassed.
 *
 * Throws if the catalogue priced none of the panel models, so the caller can
 * abort the run rather than proceed with a $0-priced (cap-bypassing) Fusion model.
 */
export function buildFusionModel(fusionConfig: Record<string, unknown>): Model<Api> {
  let costInput = 0;
  let costOutput = 0;
  let priced = 0;
  for (const modelId of fusionPanelModels(fusionConfig)) {
    const entry = catalogueEntryFor(stripOpenRouter(modelId));
    if (!entry) continue;
    costInput += entry.costInput;
    costOutput += entry.costOutput;
    priced++;
  }
  if (priced === 0 || (costInput === 0 && costOutput === 0)) {
    throw new Error(
      "Fusion panel has no priceable models in the catalogue; refusing to run a " +
        "$0-priced Fusion model (spend cap would be bypassed).",
    );
  }
  return {
    id: "openrouter/fusion",
    name: "OpenRouter Fusion",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: costInput, output: costOutput, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  };
}

function buildOllamaModel(name: string): Model<Api> {
  return {
    id: name,
    name,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8192,
  };
}

/** Wire provider credentials into AuthStorage from the environment. */
export function setupAuth(authStorage: AuthStorage): void {
  const orKey = process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY;
  if (orKey) authStorage.setRuntimeApiKey("openrouter", orKey);
  // Local Ollama ignores the key, but Pi requires *some* auth to resolve.
  authStorage.setRuntimeApiKey("ollama", "ollama");
}

/**
 * Resolve a model ref to a Pi Model. Prefers Pi's built-in entry (so cost +
 * capabilities stay accurate), falling back to a synthesized model.
 */
export function resolveModel(
  ref: string | undefined,
  registry: ModelRegistry,
  fusionConfig?: Record<string, unknown>,
): Model<Api> {
  const usingDefault = !ref || !ref.trim();
  const r = usingDefault ? DEFAULT_MODEL_ID.trim() : ref.trim();
  // A "fusion/<id>" ref is the synthetic selector entry for OpenRouter Fusion.
  // With its panel config threaded in by the caller (the /run handler) we price
  // by the analysis-panel sum (most accurate). Without it — a stale ref, or any
  // path that can't thread the config — we degrade to OpenRouter's native Fusion
  // auto-panel priced at the isFusion cost floor: never $0 (budget-safety
  // invariant G1) and never a hard crash. (buildFusionModel still throws when a
  // *supplied* config has no priceable panel models — that's a genuine misconfig
  // the caller should abort on, not a missing-config fallback.)
  if (r.startsWith("fusion/")) {
    return fusionConfig ? buildFusionModel(fusionConfig) : buildOpenRouterModel(FUSION_MODEL_ID);
  }
  if (r.startsWith("ollama/")) {
    return buildOllamaModel(r.slice("ollama/".length));
  }
  // .env.example documents a bare DEFAULT_MODEL_ID (e.g. "llama3") routed by
  // DEFAULT_MODEL_PROVIDER; honor that instead of misrouting to OpenRouter.
  if (usingDefault && DEFAULT_MODEL_PROVIDER.toLowerCase() === "ollama") {
    return buildOllamaModel(r);
  }
  // The canonical Fusion slugs ("openrouter/fusion" / "openrouter/openrouter/fusion"
  // / bare "fusion") all run OpenRouter's Fusion meta-model, so resolve them to its
  // real slug — a valid API id routed through the isFusion cost path (never $0).
  // ("fusion/<id>" picker refs are handled above, with config-aware pricing.)
  const stripped = stripOpenRouter(r);
  if (stripped === "fusion" || stripped === "openrouter/fusion") {
    return buildOpenRouterModel(FUSION_MODEL_ID);
  }
  const orId = stripped;
  return registry.find("openrouter", orId) ?? buildOpenRouterModel(orId);
}

export function defaultModel(registry: ModelRegistry): Model<Api> {
  return resolveModel(DEFAULT_MODEL_ID, registry);
}
