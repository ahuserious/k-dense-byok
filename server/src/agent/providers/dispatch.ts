/**
 * The one surface on which a model preset's call parameters demonstrably reach
 * a provider: a single OpenAI-shaped chat completion built from a resolved
 * preset and sent to the provider's own base URL.
 *
 * Egress hygiene (#44 / #57 / #64). Three rules, all enforced here rather than
 * at the route:
 *   1. There is NO base-URL constant in this file. The address comes from the
 *      Pi model the ref resolved to (`Model.baseUrl`), so an unregistered or
 *      unknown provider has no address at all and cannot be contacted.
 *   2. `dispatchPresetCompletion` throws BEFORE calling fetch when the
 *      credential variable is absent. Unconfigured means no outbound request —
 *      not an empty result, not a 401 round trip.
 *   3. The credential is read from `process.env[name]` and placed in the
 *      Authorization header. It is never logged, never echoed into an error
 *      message, and never returned. Errors name the variable, not its value.
 *
 * A corollary the first round got wrong: this file builds ONE wire shape (an
 * OpenAI `chat/completions` body with an `Authorization: Bearer` credential),
 * so it may only ever be reached by a group and a model that actually speak
 * it. That decision is not made here — it is `directDispatchSupport` in
 * `registry.ts`, the same function the ▶ Test control's enabled state and the
 * `direct` row of the binding-honesty block derive from.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  credentialVariablesPresent,
  directDispatchSupport,
  providerGroup,
  type ProviderGroupDefinition,
  type ProviderGroupId,
} from "./registry.ts";
import type { ResolvedModelPreset } from "../model-presets.ts";

export class PresetDispatchError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_NOT_CONFIGURED"
      | "PROVIDER_NOT_DISPATCHABLE"
      | "PROVIDER_REQUEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PresetDispatchError";
  }
}

/** The exact outbound request. Everything a Gate B assertion needs to see. */
export interface OutboundChatCompletionRequest {
  url: string;
  method: "POST";
  /** Header NAMES only; the credential value is attached at send time. */
  authHeaderName: string;
  body: {
    model: string;
    messages: Array<{ role: "system" | "user"; content: string }>;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    reasoning_effort?: string;
    seed?: number;
    stream: false;
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Build the outbound request for a resolved preset.
 *
 * Row 5 semantics, chosen deliberately and asserted on in the tests: the
 * system-prompt override REPLACES the system prompt. When it is set the request
 * carries exactly one `role: "system"` message and its content is the override
 * verbatim. When it is absent the request carries no system message at all
 * rather than a Kady-invented default, so "no override" and "override" differ
 * only by that one message.
 *
 * A hyperparameter the provider does not accept is omitted entirely rather than
 * sent and ignored — `parameterSupport` in the registry is the single source of
 * that decision, and the editor disables the same fields from the same data.
 */
export function buildPresetChatCompletionRequest(input: {
  model: Model<Api>;
  preset: Pick<ResolvedModelPreset, "hyperparameters" | "systemPromptOverride">;
  group: ProviderGroupDefinition;
  prompt: string;
}): OutboundChatCompletionRequest {
  const { model, preset, group, prompt } = input;
  const messages: OutboundChatCompletionRequest["body"]["messages"] = [];
  if (preset.systemPromptOverride) {
    messages.push({ role: "system", content: preset.systemPromptOverride });
  }
  messages.push({ role: "user", content: prompt });

  const hyperparameters = preset.hyperparameters ?? {};
  const body: OutboundChatCompletionRequest["body"] = {
    model: model.id,
    messages,
    stream: false,
  };
  if (group.parameterSupport.temperature && hyperparameters.temperature !== undefined) {
    body.temperature = hyperparameters.temperature;
  }
  if (group.parameterSupport.topP && hyperparameters.topP !== undefined) {
    body.top_p = hyperparameters.topP;
  }
  if (group.parameterSupport.maxTokens && hyperparameters.maxTokens !== undefined) {
    body.max_tokens = hyperparameters.maxTokens;
  }
  if (
    group.parameterSupport.reasoningEffort &&
    hyperparameters.reasoningEffort !== undefined
  ) {
    body.reasoning_effort = hyperparameters.reasoningEffort;
  }
  if (group.parameterSupport.seed && hyperparameters.seed !== undefined) {
    body.seed = hyperparameters.seed;
  }

  return {
    url: chatCompletionsUrl(model.baseUrl),
    method: "POST",
    authHeaderName: "Authorization",
    body,
  };
}

export interface PresetDispatchDependencies {
  fetch: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
}

export interface PresetDispatchResult {
  /** The request that was sent, minus the credential. Safe to return and log. */
  request: OutboundChatCompletionRequest;
  status: number;
  /** First choice's message content, when the provider returned one. */
  text: string | null;
}

/**
 * Send one completion for a resolved preset.
 *
 * Fails closed: an unconfigured provider throws before `fetch` is reached, so
 * the injected fetch in the tests can assert it was never called.
 */
export async function dispatchPresetCompletion(
  input: {
    model: Model<Api>;
    preset: Pick<ResolvedModelPreset, "hyperparameters" | "systemPromptOverride">;
    groupId: ProviderGroupId;
    prompt: string;
  },
  dependencies: PresetDispatchDependencies,
): Promise<PresetDispatchResult> {
  const group = providerGroup(input.groupId);
  if (!group) {
    throw new PresetDispatchError(
      "PROVIDER_NOT_DISPATCHABLE",
      `Unknown provider group ${input.groupId}.`,
    );
  }
  // The one predicate, applied with the resolved model in hand so the wire
  // shape is checked too. Round 1 asked only `dispatchableAsChatModel`, which
  // is true for the three OAuth groups — so an Anthropic preset built an
  // OpenAI-shaped body for https://api.anthropic.com/chat/completions with no
  // credential at all. This refuses before a request exists. The UI disables
  // the control from the same function.
  const support = directDispatchSupport(group, input.model);
  if (!support.supported) {
    throw new PresetDispatchError(
      "PROVIDER_NOT_DISPATCHABLE",
      support.reason ?? `${group.label} presets cannot be sent as a completion.`,
    );
  }
  // The guard that makes "unconfigured reaches nothing" true rather than
  // aspirational. Nothing below this line runs for an unconfigured provider.
  // `directDispatchSupport` has already established `kind === "api-key"`, so
  // this is unconditional rather than conditional on the kind — the round-1
  // `group.kind === "api-key" &&` prefix was the clause that let credential-less
  // groups through.
  if (!credentialVariablesPresent(group, dependencies.env)) {
    throw new PresetDispatchError(
      "PROVIDER_NOT_CONFIGURED",
      group.notConfiguredReason,
    );
  }

  const request = buildPresetChatCompletionRequest({
    model: input.model,
    preset: input.preset,
    group,
    prompt: input.prompt,
  });

  // `credentialVariablesPresent` returned true for an `api-key` group, so a
  // non-empty name exists here. It is asserted rather than assumed: a request
  // must never leave without the credential it was supposed to carry, and the
  // round-1 code silently sent one when the name lookup came back empty —
  // which for the Local group put the value of OLLAMA_BASE_URL, a base URL and
  // not a credential, into an `Authorization: Bearer` header.
  const credentialName = group.credentialVariableNames.find((name) =>
    dependencies.env[name]?.trim(),
  );
  if (!credentialName) {
    throw new PresetDispatchError(
      "PROVIDER_NOT_CONFIGURED",
      group.notConfiguredReason,
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [request.authHeaderName]: `Bearer ${dependencies.env[credentialName]}`,
  };

  const response = await dependencies.fetch(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(request.body),
  });
  if (!response.ok) {
    // Never echoes the response body: #71 found sandbox paths leaking through
    // upstream error bodies, and an upstream 401 body can quote a credential.
    throw new PresetDispatchError(
      "PROVIDER_REQUEST_FAILED",
      `${group.label} rejected the request with HTTP ${response.status}. Check the model id and the ${
        group.credentialVariableNames[0] ?? "provider"
      } credential.`,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload?.choices?.[0]?.message?.content;
  return {
    request,
    status: response.status,
    text: typeof content === "string" ? content : null,
  };
}
