import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ProjectPaths } from "../projects.ts";
import type {
  WorkflowModelResolutionReceipt,
  WorkflowResolvedModel,
  WorkflowRunManifestV1,
} from "../workflows/run-state.ts";
import type { ModelRequest, RequestedModel } from "../workflows/schema.ts";
import {
  ModelAuthenticationError,
  assertModelAuthentication,
  defaultModel,
  resolveModel,
} from "./models.ts";
import {
  getModelRegistry,
  getModelRuntime,
  getSession,
  sessionProfileForId,
} from "./session-registry.ts";
import { isSubscriptionProvider } from "./provider-auth.ts";

type FixedRequestedModel = Extract<RequestedModel, { source: "fixed" }>;

export type WorkflowModelResolutionErrorCode =
  | "WORKFLOW_MODEL_INVALID_CONTEXT"
  | "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM"
  | "WORKFLOW_MODEL_UNSUPPORTED_REQUEST"
  | "WORKFLOW_MODEL_SESSION_NOT_FOUND"
  | "WORKFLOW_MODEL_SESSION_NOT_MAIN"
  | "WORKFLOW_MODEL_RESOLVER_MISMATCH"
  | "WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE";

export class WorkflowModelResolutionError extends Error {
  constructor(
    readonly code: WorkflowModelResolutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowModelResolutionError";
  }
}

export interface WorkflowModelResolutionContext {
  manifest: Pick<WorkflowRunManifestV1, "projectId" | "sessionId">;
  paths: ProjectPaths;
}

export interface ResolvedWorkflowModel {
  model: Model<Api>;
  receipt: WorkflowModelResolutionReceipt;
}

export interface WorkflowModelResolutionDependencies {
  resolveFixedModel(requested: FixedRequestedModel): Model<Api>;
  resolveConfiguredDefaultModel(): Model<Api>;
  authenticateModel(model: Model<Api>): Promise<void>;
  loadMainKadySessionModel(
    projectId: string,
    paths: ProjectPaths,
    sessionId: string,
  ): Promise<Model<Api>>;
}

function resolutionError(
  code: WorkflowModelResolutionErrorCode,
  message: string,
  cause?: unknown,
): WorkflowModelResolutionError {
  return new WorkflowModelResolutionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function expectedAuthKind(
  provider: string,
): FixedRequestedModel["auth"]["kind"] | null {
  if (provider === "openrouter") return "api-key";
  if (provider === "ollama") return "local";
  if (provider === "openai-compatible") return "custom";
  if (isSubscriptionProvider(provider)) return "oauth";
  return null;
}

function validateFixedAuthClaim(requested: FixedRequestedModel): void {
  if (requested.provider !== requested.provider.toLowerCase()) {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM",
      `Workflow provider ${requested.provider} is not a canonical lowercase Kady provider id.`,
    );
  }
  if (requested.auth.profile !== undefined) {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM",
      `Kady cannot select auth profile ${requested.auth.profile} for ${requested.provider}; remove the profile claim.`,
    );
  }
  const required = expectedAuthKind(requested.provider);
  if (!required) {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM",
      `Provider ${requested.provider} is not an exact Kady workflow provider.`,
    );
  }
  if (requested.auth.kind !== required) {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM",
      `Provider ${requested.provider} requires ${required} auth in Kady workflows, not ${requested.auth.kind}.`,
    );
  }
  if (requested.provider === "openrouter" && requested.model === "openrouter/fusion") {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
      "The openrouter/fusion router is a compound Fusion runtime and cannot be resolved as a simple Pi model call.",
    );
  }
}

function resolveFixedModelWithKady(requested: FixedRequestedModel): Model<Api> {
  const registry = getModelRegistry();
  if (requested.provider === "openrouter") {
    return resolveModel(`openrouter/${requested.model}`, registry);
  }
  if (requested.provider === "ollama") {
    return resolveModel(`ollama/${requested.model}`, registry);
  }
  if (requested.provider === "openai-compatible") {
    return resolveModel(`openai-compatible/${requested.model}`, registry);
  }
  if (isSubscriptionProvider(requested.provider)) {
    return resolveModel(`${requested.provider}/${requested.model}`, registry);
  }
  // validateFixedAuthClaim rejects this before resolution. Keep this guard so
  // direct dependency reuse cannot silently reinterpret an unknown provider as
  // an OpenRouter vendor prefix.
  throw resolutionError(
    "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
    `Provider ${requested.provider} has no strict Kady model resolver.`,
  );
}

async function loadMainKadySessionModel(
  projectId: string,
  paths: ProjectPaths,
  sessionId: string,
): Promise<Model<Api>> {
  const session = await getSession(projectId, paths, sessionId);
  if (!session) {
    throw resolutionError(
      "WORKFLOW_MODEL_SESSION_NOT_FOUND",
      `The workflow manifest references missing Kady session ${sessionId}.`,
    );
  }
  if (sessionProfileForId(paths, sessionId) !== "main") {
    throw resolutionError(
      "WORKFLOW_MODEL_SESSION_NOT_MAIN",
      `Session ${sessionId} is a helper session, not the manifest's main Kady chat.`,
    );
  }
  if (!session.model) {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
      `Main Kady session ${sessionId} has no selected model.`,
    );
  }
  return session.model as Model<Api>;
}

function defaultDependencies(): WorkflowModelResolutionDependencies {
  return {
    resolveFixedModel: resolveFixedModelWithKady,
    resolveConfiguredDefaultModel: () => defaultModel(getModelRegistry()),
    // This checks Kady's local credential store/provider runtime. It does not
    // issue an inference or model-discovery request.
    authenticateModel: (model) => assertModelAuthentication(model, getModelRuntime()),
    loadMainKadySessionModel,
  };
}

function dependenciesWithOverrides(
  overrides: Partial<WorkflowModelResolutionDependencies> | undefined,
): WorkflowModelResolutionDependencies {
  return { ...defaultDependencies(), ...overrides };
}

function assertModelIdentity(
  requested: FixedRequestedModel,
  model: Model<Api>,
): void {
  if (model.provider !== requested.provider || model.id !== requested.model) {
    throw resolutionError(
      "WORKFLOW_MODEL_RESOLVER_MISMATCH",
      `Exact workflow model ${requested.provider}/${requested.model} resolved as ${model.provider}/${model.id}.`,
    );
  }
}

function modelSupportsRequestedReasoning(
  model: Model<Api>,
  reasoning: RequestedModel["reasoning"],
): boolean {
  return getSupportedThinkingLevels(model).includes(reasoning);
}

function unsupportedReasoningFailure(
  candidate: Pick<FixedRequestedModel, "provider" | "model" | "reasoning">,
  model: Model<Api>,
): string {
  const supported = getSupportedThinkingLevels(model);
  return `${candidate.provider}/${candidate.model}: requested reasoning ${candidate.reasoning} ` +
    `is unsupported (supported: ${supported.join(", ")})`;
}

function resolvedRuntime(
  authKind: FixedRequestedModel["auth"]["kind"],
): WorkflowResolvedModel["runtime"] {
  if (authKind === "local") return "local";
  if (authKind === "custom") return "custom";
  return "pi";
}

function fixedReceipt(
  request: ModelRequest,
  selected: FixedRequestedModel,
  selectedIndex: number,
): WorkflowModelResolutionReceipt {
  return {
    request: structuredClone(request),
    resolved: {
      provider: selected.provider,
      model: selected.model,
      auth: { kind: selected.auth.kind },
      reasoning: selected.reasoning,
      runtime: resolvedRuntime(selected.auth.kind),
    },
    fallbackUsed: selectedIndex > 0,
    ...(selectedIndex > 0 && request.resolution.mode === "explicit-fallback"
      ? { resolutionReason: request.resolution.reason }
      : {}),
  };
}

function kadyCurrentSelection(
  model: Model<Api>,
  reasoning: RequestedModel["reasoning"],
): WorkflowResolvedModel {
  if (model.provider === "openrouter" && model.id === "openrouter/fusion") {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
      "Kady Current points at compound OpenRouter Fusion without a durable Fusion configuration.",
    );
  }
  const authKind = expectedAuthKind(model.provider);
  if (!authKind) {
    throw resolutionError(
      "WORKFLOW_MODEL_UNSUPPORTED_AUTH_CLAIM",
      `Kady Current selected provider ${model.provider}, whose auth ownership cannot be represented exactly.`,
    );
  }
  return {
    provider: model.provider,
    model: model.id,
    auth: { kind: authKind },
    reasoning,
    runtime: resolvedRuntime(authKind),
  };
}

function candidateLabel(candidate: FixedRequestedModel): string {
  return `${candidate.provider}/${candidate.model}`;
}

/**
 * Resolve one typed workflow model request without issuing a model call.
 * Authentication or reasoning-capability failures may advance only through
 * the request's ordered, explicit fallback list; invalid ownership claims fail
 * the whole request.
 */
export async function resolveWorkflowModel(
  request: ModelRequest,
  context: WorkflowModelResolutionContext,
  dependencyOverrides?: Partial<WorkflowModelResolutionDependencies>,
): Promise<ResolvedWorkflowModel> {
  if (context.manifest.projectId !== context.paths.id) {
    throw resolutionError(
      "WORKFLOW_MODEL_INVALID_CONTEXT",
      `Workflow manifest project ${context.manifest.projectId} does not match paths for ${context.paths.id}.`,
    );
  }

  const dependencies = dependenciesWithOverrides(dependencyOverrides);
  if (request.requested.source === "kady-current") {
    if (request.resolution.mode !== "exact") {
      throw resolutionError(
        "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
        "Kady Current is an exact manifest-bound selection and cannot use a fallback list.",
      );
    }
    const model = context.manifest.sessionId
      ? await dependencies.loadMainKadySessionModel(
          context.manifest.projectId,
          context.paths,
          context.manifest.sessionId,
        )
      : dependencies.resolveConfiguredDefaultModel();
    if (!modelSupportsRequestedReasoning(model, request.requested.reasoning)) {
      throw resolutionError(
        "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
        `Kady Current resolved to ${model.provider}/${model.id}, but requested reasoning ` +
          `${request.requested.reasoning} is unsupported (supported: ` +
          `${getSupportedThinkingLevels(model).join(", ")}).`,
      );
    }
    const resolved = kadyCurrentSelection(model, request.requested.reasoning);
    try {
      await dependencies.authenticateModel(model);
    } catch (error) {
      throw resolutionError(
        "WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE",
        `Kady Current resolved to ${model.provider}/${model.id}, but its declared auth is unavailable.`,
        error,
      );
    }
    return {
      model,
      receipt: {
        request: structuredClone(request),
        resolved,
        fallbackUsed: false,
      },
    };
  }

  const candidates: FixedRequestedModel[] = [request.requested];
  if (request.resolution.mode === "explicit-fallback") {
    for (const alternative of request.resolution.alternatives) {
      if (alternative.source === "kady-current") {
        throw resolutionError(
          "WORKFLOW_MODEL_UNSUPPORTED_REQUEST",
          "Kady Current cannot appear in an explicit workflow fallback list.",
        );
      }
      candidates.push(alternative);
    }
  }
  // Ownership/profile claims are schema-level intent. Reject them before any
  // candidate is attempted so a fallback cannot conceal an invalid claim.
  for (const candidate of candidates) validateFixedAuthClaim(candidate);

  const failures: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    let model: Model<Api>;
    try {
      model = dependencies.resolveFixedModel(candidate);
    } catch (error) {
      if (error instanceof WorkflowModelResolutionError) throw error;
      failures.push(`${candidateLabel(candidate)}: model unavailable`);
      continue;
    }
    assertModelIdentity(candidate, model);
    if (!modelSupportsRequestedReasoning(model, candidate.reasoning)) {
      const failure = unsupportedReasoningFailure(candidate, model);
      if (request.resolution.mode === "exact") {
        throw resolutionError("WORKFLOW_MODEL_UNSUPPORTED_REQUEST", failure);
      }
      failures.push(failure);
      continue;
    }
    try {
      await dependencies.authenticateModel(model);
    } catch (error) {
      const suffix = error instanceof ModelAuthenticationError
        ? error.message
        : "declared auth unavailable";
      failures.push(`${candidateLabel(candidate)}: ${suffix}`);
      continue;
    }
    return { model, receipt: fixedReceipt(request, candidate, index) };
  }

  throw resolutionError(
    "WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE",
    `No declared workflow model candidate could be authenticated (${failures.join("; ")}).`,
  );
}
