/**
 * The provider-group registry — the single reconciliation of Kady's two
 * disagreeing provider lists into the eight groups the Model presets UI groups
 * by.
 *
 * Why a third structure exists, stated here so nobody has to re-derive it:
 *
 *   - `SUBSCRIPTION_PROVIDERS` (provider-auth.ts) answers "who is paying" —
 *     four OAuth *billing identities* (openai-codex, anthropic, github-copilot,
 *     xai). `api/model-providers.ts` deliberately refuses to present an ambient
 *     API key as subscription access, so an API-key provider cannot be added to
 *     that list without breaking what the list means.
 *   - `setupModelRuntime` (models.ts) answers "what is dispatchable" — the
 *     runtime registrations (ollama, openai-compatible, openrouter) plus the
 *     built-in nvidia path. A provider that is not registered has no entry at
 *     all, which is the load-bearing #57/#64 guard; a UI that grouped by that
 *     list could not render "visible but not configured" at all.
 *
 * Neither list can carry the eight owner-named groups, and their ids do not
 * agree, so this file declares the grouping explicitly and records for every
 * group which list it projects from. Nothing here dispatches, and nothing here
 * reads a credential VALUE — configuration state is decided from the presence
 * of an environment variable NAME (or from Kady's local OAuth state), never
 * from a network probe.
 */
import {
  isSubscriptionProvider,
  type SubscriptionProviderId,
} from "../provider-auth.ts";

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

/**
 * How a group proves it is configured.
 *   api-key            — an environment variable NAME holds a non-empty value
 *   oauth-subscription — Kady's local Pi credential store holds an OAuth login
 *   local              — the user named a local server's base URL
 *   compute            — a remote compute account (Modal), not a chat provider
 */
export type ProviderGroupKind =
  | "api-key"
  | "oauth-subscription"
  | "local"
  | "compute";

/** Which of the two pre-existing lists this group projects from, if either. */
export type ProviderGroupProjection =
  | "subscription-providers"
  | "runtime-registry"
  | "none";

/**
 * Which call parameters the group's provider actually accepts. A parameter a
 * provider does not accept is rendered DISABLED with this as the reason rather
 * than shipped as a live control over a value that would be discarded (§6.7).
 */
export interface ProviderGroupParameterSupport {
  temperature: boolean;
  topP: boolean;
  maxTokens: boolean;
  reasoningEffort: boolean;
  seed: boolean;
}

export interface ProviderGroupDefinition {
  id: ProviderGroupId;
  label: string;
  kind: ProviderGroupKind;
  projectsFrom: ProviderGroupProjection;
  /** Set when this group projects from SUBSCRIPTION_PROVIDERS. */
  subscriptionProviderId?: SubscriptionProviderId;
  /**
   * Canonical Kady runtime provider ids a model ref in this group carries.
   * `local` has two; `modal` has none because a Modal preset is a compute job
   * specification, not a chat model.
   */
  runtimeProviderIds: readonly string[];
  /**
   * Environment variable NAMES — never values — whose presence configures this
   * group. Reported to the user verbatim so they know what to set.
   */
  credentialVariableNames: readonly string[];
  /** `all`: every name must be present. `any`: one is enough. */
  credentialMode: "all" | "any";
  parameterSupport: ProviderGroupParameterSupport;
  /** Shown when the group is not configured. Names the user's next action. */
  notConfiguredReason: string;
  /** True when a preset in this group can be selected as a chat model. */
  dispatchableAsChatModel: boolean;
}

const CHAT_SAMPLING_ONLY: ProviderGroupParameterSupport = {
  temperature: true,
  topP: true,
  maxTokens: true,
  reasoningEffort: false,
  seed: true,
};

const NO_PARAMETERS: ProviderGroupParameterSupport = {
  temperature: false,
  topP: false,
  maxTokens: false,
  reasoningEffort: false,
  seed: false,
};

/**
 * The eight groups, in the order the owner named them.
 *
 * `github-copilot` (a SUBSCRIPTION_PROVIDERS member) and `nvidia` (a real
 * surface that is on neither list) are deliberately NOT projected into a preset
 * group. Every existing surface for both is untouched — this registry decides
 * only what the preset UI groups by. Recorded so the omission reads as a
 * decision rather than as a regression.
 */
export const PROVIDER_GROUPS: readonly ProviderGroupDefinition[] = [
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "api-key",
    projectsFrom: "none",
    runtimeProviderIds: ["cerebras"],
    credentialVariableNames: ["CEREBRAS_API_KEY"],
    credentialMode: "any",
    parameterSupport: CHAT_SAMPLING_ONLY,
    notConfiguredReason:
      "Cerebras is not configured. Set CEREBRAS_API_KEY in your environment file and restart Kady.",
    dispatchableAsChatModel: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "oauth-subscription",
    projectsFrom: "subscription-providers",
    subscriptionProviderId: "openai-codex",
    runtimeProviderIds: ["openai-codex"],
    credentialVariableNames: [],
    credentialMode: "all",
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: true,
      seed: true,
    },
    notConfiguredReason:
      "OpenAI is not connected. Connect the ChatGPT subscription under Settings ▸ Model providers.",
    dispatchableAsChatModel: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "api-key",
    projectsFrom: "runtime-registry",
    runtimeProviderIds: ["openrouter"],
    credentialVariableNames: ["OPENROUTER_API_KEY", "OR_API_KEY"],
    credentialMode: "any",
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: true,
      seed: true,
    },
    notConfiguredReason:
      "OpenRouter is not configured. Add the OpenRouter key under Settings ▸ API keys.",
    dispatchableAsChatModel: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "oauth-subscription",
    projectsFrom: "subscription-providers",
    subscriptionProviderId: "anthropic",
    runtimeProviderIds: ["anthropic"],
    credentialVariableNames: [],
    credentialMode: "all",
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: true,
      seed: false,
    },
    notConfiguredReason:
      "Anthropic is not connected. Connect the Claude subscription under Settings ▸ Model providers.",
    dispatchableAsChatModel: true,
  },
  {
    id: "groq",
    label: "Groq",
    kind: "api-key",
    projectsFrom: "none",
    runtimeProviderIds: ["groq"],
    credentialVariableNames: ["GROQ_API_KEY"],
    credentialMode: "any",
    parameterSupport: CHAT_SAMPLING_ONLY,
    notConfiguredReason:
      "Groq is not configured. Set GROQ_API_KEY in your environment file and restart Kady.",
    dispatchableAsChatModel: true,
  },
  {
    id: "xai",
    label: "xAI",
    kind: "oauth-subscription",
    projectsFrom: "subscription-providers",
    subscriptionProviderId: "xai",
    runtimeProviderIds: ["xai"],
    credentialVariableNames: [],
    credentialMode: "all",
    parameterSupport: {
      temperature: true,
      topP: true,
      maxTokens: true,
      reasoningEffort: true,
      seed: true,
    },
    notConfiguredReason:
      "xAI is not connected. Connect the xAI subscription under Settings ▸ Model providers.",
    dispatchableAsChatModel: true,
  },
  {
    id: "local",
    label: "Local",
    kind: "local",
    projectsFrom: "runtime-registry",
    runtimeProviderIds: ["ollama", "openai-compatible"],
    credentialVariableNames: ["OLLAMA_BASE_URL", "OPENAI_COMPATIBLE_BASE_URL"],
    credentialMode: "any",
    parameterSupport: CHAT_SAMPLING_ONLY,
    notConfiguredReason:
      "No local model server is configured. Set OLLAMA_BASE_URL or OPENAI_COMPATIBLE_BASE_URL to the address of your own server and restart Kady.",
    dispatchableAsChatModel: true,
  },
  {
    id: "modal",
    label: "Modal",
    kind: "compute",
    projectsFrom: "none",
    runtimeProviderIds: [],
    credentialVariableNames: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    credentialMode: "all",
    // A Modal preset describes a GPU job that loads a Hugging Face model. It is
    // not an OpenAI-shaped chat endpoint, so none of the sampling controls
    // apply; every one of them renders disabled with this recorded.
    parameterSupport: NO_PARAMETERS,
    notConfiguredReason:
      "Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET under Settings ▸ API keys.",
    dispatchableAsChatModel: false,
  },
] as const;

const GROUP_BY_ID = new Map(PROVIDER_GROUPS.map((group) => [group.id, group] as const));

export function isProviderGroupId(value: string): value is ProviderGroupId {
  return GROUP_BY_ID.has(value as ProviderGroupId);
}

export function providerGroup(id: string): ProviderGroupDefinition | undefined {
  return GROUP_BY_ID.get(id as ProviderGroupId);
}

/**
 * Whether the environment names that configure this group are all (or any)
 * present with a non-empty value.
 *
 * Reads `process.env[name]` and returns a boolean. The value never leaves this
 * function — not to a log, not to a response body, not to an error message.
 */
export function credentialVariablesPresent(
  definition: ProviderGroupDefinition,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const names = definition.credentialVariableNames;
  if (names.length === 0) return false;
  const present = (name: string) => Boolean(env[name]?.trim());
  return definition.credentialMode === "all" ? names.every(present) : names.some(present);
}

export interface ProviderGroupStatus {
  id: ProviderGroupId;
  label: string;
  kind: ProviderGroupKind;
  projectsFrom: ProviderGroupProjection;
  runtimeProviderIds: readonly string[];
  /** Variable NAMES the user must set. Never a value. */
  credentialVariableNames: readonly string[];
  parameterSupport: ProviderGroupParameterSupport;
  dispatchableAsChatModel: boolean;
  configured: boolean;
  notConfiguredReason?: string;
}

export interface ProviderGroupResolutionDependencies {
  /**
   * True when Kady's LOCAL credential store holds an OAuth login for this
   * subscription provider. Must not issue a network request.
   */
  hasSubscriptionLogin(providerId: SubscriptionProviderId): Promise<boolean>;
  env: NodeJS.ProcessEnv;
}

/**
 * Project both existing lists into the eight groups and report each group's
 * configuration state.
 *
 * Every group is always present in the result. An unconfigured group is
 * `configured: false` with a reason naming the variable or the connect action —
 * it is never hidden, and resolving it never contacts anything.
 */
export async function resolveProviderGroups(
  dependencies: ProviderGroupResolutionDependencies,
): Promise<ProviderGroupStatus[]> {
  const statuses: ProviderGroupStatus[] = [];
  for (const definition of PROVIDER_GROUPS) {
    let configured: boolean;
    if (definition.kind === "oauth-subscription") {
      const providerId = definition.subscriptionProviderId;
      configured = providerId
        ? await dependencies.hasSubscriptionLogin(providerId)
        : false;
    } else {
      configured = credentialVariablesPresent(definition, dependencies.env);
    }
    statuses.push({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      projectsFrom: definition.projectsFrom,
      runtimeProviderIds: definition.runtimeProviderIds,
      credentialVariableNames: definition.credentialVariableNames,
      parameterSupport: definition.parameterSupport,
      dispatchableAsChatModel: definition.dispatchableAsChatModel,
      configured,
      ...(configured ? {} : { notConfiguredReason: definition.notConfiguredReason }),
    });
  }
  return statuses;
}

/**
 * The canonical Kady model ref for a preset's provider group + model id.
 *
 * `local` presets carry their runtime provider inside the model id
 * (`ollama/llama3`), because that is already the ref spelling the resolver and
 * every persisted selection use. Everything else is `<runtime provider>/<id>`.
 */
export function providerGroupModelRef(
  groupId: ProviderGroupId,
  modelId: string,
): string {
  const definition = providerGroup(groupId);
  if (!definition) throw new Error(`Unknown provider group ${groupId}`);
  if (groupId === "local") return modelId;
  const runtimeProviderId = definition.runtimeProviderIds[0] ?? groupId;
  return `${runtimeProviderId}/${modelId}`;
}

/** The provider group a canonical model ref belongs to, when it names one. */
export function providerGroupForRef(ref: string): ProviderGroupId | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const prefix = ref.slice(0, slash);
  if (prefix === "ollama" || prefix === "openai-compatible") return "local";
  for (const definition of PROVIDER_GROUPS) {
    if (definition.runtimeProviderIds.includes(prefix)) return definition.id;
  }
  // Keeps the two lists honest: a subscription id with no group is not silently
  // reinterpreted as some other group's model.
  if (isSubscriptionProvider(prefix)) return undefined;
  return undefined;
}
