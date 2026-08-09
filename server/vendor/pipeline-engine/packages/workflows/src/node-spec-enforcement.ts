/**
 * Vendored NodeSpec v1 semantic enforcement.
 *
 * The structural schema preserves the frozen host contract. This module is the
 * authoritative semantic gate for the smaller capability surface implemented
 * by the vendored Pipeline Engine:
 *
 * | NodeSpec field | Vendored status |
 * | --- | --- |
 * | `version` | BOUND (schema discriminator) |
 * | fixed `model.requested` + `auth.kind` | BOUND for Claude/Codex API-key or OAuth selection |
 * | `model.resolution` | BOUND for exact or one same-provider/auth fallback model |
 * | `reasoningEffort` / requested reasoning | BOUND when the selected provider supports the value |
 * | `budget.maxCostUsd` | BOUND through Claude's existing `maxBudgetUsd` cost control |
 * | `budget.maxTokens`, per-node controls, billing | FAIL-CLOSED(S4) |
 * | `deliberation` | FAIL-CLOSED(S5) |
 *
 * Any populated field outside the BOUND rows is rejected. Keeping that policy
 * here (rather than only in the web editor) makes validate, save, and run agree.
 */
import { isRegisteredProvider } from '@archon/providers';
import type { DagNode, NodeRequestedModel, NodeSpecV1 } from './schemas/dag-node';
import { routePresetEffort } from './model-validation';

export type VendoredNodeSpecPendingUnit = 'S4' | 'S5';

export interface VendoredNodeSpecIssue {
  code: string;
  path: string;
  message: string;
  unit: VendoredNodeSpecPendingUnit;
}

export interface VendoredNodeSpecRuntimeBinding {
  provider?: string;
  model?: string;
  auth?: Extract<NodeRequestedModel, { source: 'fixed' }>['auth'];
  reasoning?: NodeRequestedModel['reasoning'];
  maxBudgetUsd?: number;
  fallbackModel?: string;
}

/** Mutable for exactly one DAG node execution; shared by its loops and retries. */
export interface VendoredNodeCostBudgetState {
  ceilingUsd?: number;
  spentUsd: number;
}

const SUPPORTED_AUTH_KINDS = new Set(['api-key', 'oauth']);

function issue(
  issues: VendoredNodeSpecIssue[],
  code: string,
  path: string,
  message: string,
  unit: VendoredNodeSpecPendingUnit
): void {
  issues.push({
    code,
    path,
    message: `${message} Pending unit ${unit}; the vendored runtime fails closed until it is bound.`,
    unit,
  });
}

function modelIdentity(model: NodeRequestedModel): string {
  if (model.source === 'kady-current') {
    return [model.source, model.auth.kind, model.reasoning].join('\u0000');
  }
  return [
    model.source,
    model.provider.toLowerCase(),
    model.model,
    model.auth.kind,
    model.auth.profile ?? '',
    model.reasoning,
  ].join('\u0000');
}

function isAiNode(node: DagNode): boolean {
  return 'command' in node || 'prompt' in node || 'loop' in node;
}

function validateRequestedModelBinding(
  requested: NodeRequestedModel,
  path: string,
  issues: VendoredNodeSpecIssue[]
): void {
  if (requested.source === 'kady-current') {
    issue(
      issues,
      'vendored-kady-current-unbound',
      path,
      'Kady Current requires the host runtime context and cannot be resolved by the vendored engine.',
      'S4'
    );
    return;
  }

  if (!isRegisteredProvider(requested.provider)) {
    issue(
      issues,
      'vendored-model-provider-unregistered',
      `${path}/provider`,
      `Provider '${requested.provider}' is not registered in the vendored engine.`,
      'S4'
    );
  } else if (requested.provider !== 'claude' && requested.provider !== 'codex') {
    issue(
      issues,
      'vendored-model-auth-unbound',
      `${path}/auth/kind`,
      `The vendored engine cannot deterministically select ${requested.auth.kind} credentials for provider '${requested.provider}'.`,
      'S4'
    );
  }

  if (!SUPPORTED_AUTH_KINDS.has(requested.auth.kind)) {
    issue(
      issues,
      'vendored-auth-kind-unbound',
      `${path}/auth/kind`,
      `Auth kind '${requested.auth.kind}' has no vendored credential-selection binding.`,
      'S4'
    );
  }
  if (requested.auth.profile !== undefined) {
    issue(
      issues,
      'vendored-auth-profile-unbound',
      `${path}/auth/profile`,
      'Named credential profiles have no vendored selection binding.',
      'S4'
    );
  }
}

function validateFallbacks(
  settings: NodeSpecV1,
  nodePath: string,
  issues: VendoredNodeSpecIssue[]
): void {
  const request = settings.model;
  if (!request || request.resolution.mode !== 'explicit-fallback') return;

  const resolutionPath = `${nodePath}/settings/model/resolution`;
  const alternatives = request.resolution.alternatives;
  if (
    request.requested.source === 'kady-current' ||
    alternatives.some(alternative => alternative.source === 'kady-current')
  ) {
    issue(
      issues,
      'ambiguous-kady-current-fallback',
      resolutionPath,
      'Kady Current is an exact runtime selection and cannot appear in an explicit fallback list.',
      'S4'
    );
  }

  const requestedIdentity = modelIdentity(request.requested);
  const fallbackIdentities = new Set<string>();
  alternatives.forEach((alternative, index) => {
    const alternativePath = `${resolutionPath}/alternatives/${String(index)}`;
    const identity = modelIdentity(alternative);
    if (identity === requestedIdentity) {
      issue(
        issues,
        'fallback-repeats-request',
        alternativePath,
        'An explicit fallback must differ from the requested model and auth.',
        'S4'
      );
    }
    if (fallbackIdentities.has(identity)) {
      issue(
        issues,
        'duplicate-model-fallback',
        alternativePath,
        'Explicit model fallbacks must be unique.',
        'S4'
      );
    }
    fallbackIdentities.add(identity);
    validateRequestedModelBinding(alternative, alternativePath, issues);
  });

  if (alternatives.length !== 1) {
    issue(
      issues,
      'vendored-fallback-topology-unbound',
      `${resolutionPath}/alternatives`,
      'The vendored engine has one fallbackModel slot and cannot represent multiple alternatives.',
      'S4'
    );
    return;
  }

  const primary = request.requested;
  const fallback = alternatives[0];
  if (primary.source !== 'fixed' || fallback?.source !== 'fixed') return;
  if (fallback.provider !== primary.provider) {
    issue(
      issues,
      'vendored-fallback-provider-unbound',
      `${resolutionPath}/alternatives/0/provider`,
      'The existing fallbackModel slot cannot switch providers.',
      'S4'
    );
  }
  if (
    fallback.auth.kind !== primary.auth.kind ||
    fallback.auth.profile !== primary.auth.profile
  ) {
    issue(
      issues,
      'vendored-fallback-auth-unbound',
      `${resolutionPath}/alternatives/0/auth`,
      'The existing fallbackModel slot cannot switch credential selection.',
      'S4'
    );
  }
  if (
    settings.reasoningEffort === undefined &&
    fallback.reasoning !== primary.reasoning
  ) {
    issue(
      issues,
      'vendored-fallback-reasoning-unbound',
      `${resolutionPath}/alternatives/0/reasoning`,
      'The existing fallbackModel slot cannot apply a different reasoning level.',
      'S4'
    );
  }
}

function rejectUnboundFields(
  settings: NodeSpecV1,
  nodePath: string,
  issues: VendoredNodeSpecIssue[]
): void {
  // The frozen contract defines explicit canonical defaults as equivalent to
  // omission. Normalize them before deciding whether a pending field is
  // populated so save/run validation cannot reject a semantically empty value.
  const normalized = {
    temperature:
      settings.hyperparameters?.temperature === 1
        ? undefined
        : settings.hyperparameters?.temperature,
    topP:
      settings.hyperparameters?.top_p === 1 ? undefined : settings.hyperparameters?.top_p,
    sampling:
      settings.hyperparameters?.sampling !== undefined &&
      Object.keys(settings.hyperparameters.sampling).length === 0
        ? undefined
        : settings.hyperparameters?.sampling,
    conditionWhen: settings.conditions?.when,
    conditionExists:
      settings.conditions?.exists?.length === 0 ? undefined : settings.conditions?.exists,
    harness: settings.harness === 'pi' ? undefined : settings.harness,
    databases: settings.databases?.length === 0 ? undefined : settings.databases,
    skillsMode: settings.skills?.mode === 'auto' ? undefined : settings.skills?.mode,
    skillsList: settings.skills?.list?.length === 0 ? undefined : settings.skills?.list,
    subagentsMode:
      settings.subagents?.mode === 'auto' ? undefined : settings.subagents?.mode,
    autonomy: settings.autonomy === 'strict' ? undefined : settings.autonomy,
    personalityStoreRef: settings.deliberation?.personalityStoreRef,
    bestOfNPersonalityCount:
      settings.deliberation?.bestOfNPersonalityCount === 2
        ? undefined
        : settings.deliberation?.bestOfNPersonalityCount,
    mimeographMode:
      settings.deliberation?.mimeographs?.mode === 'auto'
        ? undefined
        : settings.deliberation?.mimeographs?.mode,
    mimeographPersonalityRefs:
      settings.deliberation?.mimeographs?.personalityRefs?.length === 0
        ? undefined
        : settings.deliberation?.mimeographs?.personalityRefs,
    billingMode: settings.billingMode === 'inherit' ? undefined : settings.billingMode,
    maxTokens: settings.budget?.maxTokens,
  };
  const reject = (
    populated: boolean,
    code: string,
    pathSuffix: string,
    field: string,
    unit: VendoredNodeSpecPendingUnit
  ): void => {
    if (populated) {
      issue(
        issues,
        code,
        `${nodePath}/settings/${pathSuffix}`,
        `NodeSpec ${field} is structurally valid but is not execution-bound in the vendored engine.`,
        unit
      );
    }
  };

  reject(
    normalized.temperature !== undefined,
    'vendored-temperature-unbound',
    'hyperparameters/temperature',
    'hyperparameters.temperature',
    'S4'
  );
  reject(
    normalized.topP !== undefined,
    'vendored-top-p-unbound',
    'hyperparameters/top_p',
    'hyperparameters.top_p',
    'S4'
  );
  reject(
    normalized.sampling !== undefined,
    'vendored-sampling-unbound',
    'hyperparameters/sampling',
    'hyperparameters.sampling',
    'S4'
  );
  reject(normalized.conditionWhen !== undefined, 'vendored-condition-when-unbound', 'conditions/when', 'conditions.when', 'S4');
  reject(normalized.conditionExists !== undefined, 'vendored-condition-exists-unbound', 'conditions/exists', 'conditions.exists', 'S4');
  reject(normalized.harness !== undefined, 'vendored-harness-unbound', 'harness', 'harness', 'S4');
  reject(normalized.databases !== undefined, 'vendored-databases-unbound', 'databases', 'databases', 'S4');
  reject(normalized.skillsMode !== undefined, 'vendored-skills-mode-unbound', 'skills/mode', 'skills.mode', 'S4');
  reject(normalized.skillsList !== undefined, 'vendored-skills-list-unbound', 'skills/list', 'skills.list', 'S4');
  reject(normalized.subagentsMode !== undefined, 'vendored-subagents-mode-unbound', 'subagents/mode', 'subagents.mode', 'S4');
  reject(normalized.autonomy !== undefined, 'vendored-autonomy-unbound', 'autonomy', 'autonomy', 'S4');
  reject(normalized.personalityStoreRef !== undefined, 'vendored-personality-store-unbound', 'deliberation/personalityStoreRef', 'deliberation.personalityStoreRef', 'S5');
  reject(normalized.bestOfNPersonalityCount !== undefined, 'vendored-personality-count-unbound', 'deliberation/bestOfNPersonalityCount', 'deliberation.bestOfNPersonalityCount', 'S5');
  reject(normalized.mimeographMode !== undefined, 'vendored-mimeograph-mode-unbound', 'deliberation/mimeographs/mode', 'deliberation.mimeographs.mode', 'S5');
  reject(normalized.mimeographPersonalityRefs !== undefined, 'vendored-mimeograph-personalities-unbound', 'deliberation/mimeographs/personalityRefs', 'deliberation.mimeographs.personalityRefs', 'S5');
  reject(normalized.billingMode !== undefined, 'vendored-billing-mode-unbound', 'billingMode', 'billingMode', 'S4');
  reject(normalized.maxTokens !== undefined, 'vendored-token-budget-unbound', 'budget/maxTokens', 'budget.maxTokens', 'S4');
}

export function validateVendoredNodeSpecSemantics(
  workflow: { nodes: readonly DagNode[]; provider?: string }
): VendoredNodeSpecIssue[] {
  const issues: VendoredNodeSpecIssue[] = [];
  workflow.nodes.forEach((node, index) => {
    const settings = node.settings;
    if (!settings) return;
    const nodePath = `nodes/${String(index)}`;

    rejectUnboundFields(settings, nodePath, issues);

    if (!isAiNode(node)) {
      if (settings.model !== undefined) {
        issue(issues, 'vendored-slotless-model', `${nodePath}/settings/model`, 'This node has no vendored model slot.', 'S4');
      }
      if (settings.reasoningEffort !== undefined) {
        issue(issues, 'vendored-slotless-reasoning', `${nodePath}/settings/reasoningEffort`, 'This node has no vendored reasoning slot.', 'S4');
      }
      if (settings.budget?.maxCostUsd !== undefined) {
        issue(issues, 'vendored-slotless-cost-budget', `${nodePath}/settings/budget/maxCostUsd`, 'This node has no provider cost-control slot.', 'S4');
      }
      return;
    }

    if (settings.model) {
      validateRequestedModelBinding(
        settings.model.requested,
        `${nodePath}/settings/model/requested`,
        issues
      );
      validateFallbacks(settings, nodePath, issues);
    }

    const binding = resolveVendoredNodeSpecRuntimeBinding(node, workflow.provider);
    if (binding.reasoning !== undefined && binding.provider !== undefined) {
      if (routePresetEffort(binding.provider, binding.reasoning) === null) {
        issue(
          issues,
          'vendored-reasoning-effort-unbound',
          `${nodePath}/settings/${settings.reasoningEffort !== undefined ? 'reasoningEffort' : 'model/requested/reasoning'}`,
          `Reasoning '${binding.reasoning}' cannot be routed to provider '${binding.provider ?? 'implicit'}'.`,
          'S4'
        );
      }
    }
    if (
      settings.budget?.maxCostUsd !== undefined &&
      binding.provider !== undefined &&
      binding.provider !== 'claude'
    ) {
      issue(
        issues,
        'vendored-cost-budget-unbound',
        `${nodePath}/settings/budget/maxCostUsd`,
        `Provider '${binding.provider ?? 'implicit'}' has no existing maxBudgetUsd cost-control capability.`,
        'S4'
      );
    }
  });
  return issues;
}

export function formatVendoredNodeSpecIssue(issueValue: VendoredNodeSpecIssue): string {
  return `[${issueValue.code}] '${issueValue.path}': ${issueValue.message}`;
}

export function assertVendoredNodeSpecSemantics(
  workflow: { nodes: readonly DagNode[]; provider?: string }
): void {
  const issues = validateVendoredNodeSpecSemantics(workflow);
  if (issues.length > 0) {
    throw new Error(`Vendored NodeSpec validation failed: ${issues.map(formatVendoredNodeSpecIssue).join('; ')}`);
  }
}

/**
 * Extract only values the semantic gate permits the vendored runtime to use.
 * Callers must validate first; this function intentionally contains no silent
 * fallback for a rejected NodeSpec shape.
 */
export function resolveVendoredNodeSpecRuntimeBinding(
  node: DagNode,
  workflowProvider: string | undefined
): VendoredNodeSpecRuntimeBinding {
  const settings = node.settings;
  const requested = settings?.model?.requested;
  const fixedRequested = requested?.source === 'fixed' ? requested : undefined;
  const provider = fixedRequested?.provider ?? node.provider ?? workflowProvider;
  const fallback =
    settings?.model?.resolution.mode === 'explicit-fallback'
      ? settings.model.resolution.alternatives[0]
      : undefined;
  const settingsCost = settings?.budget?.maxCostUsd;
  const legacyCost = node.maxBudgetUsd;
  const maxBudgetUsd =
    settingsCost === undefined
      ? legacyCost
      : legacyCost === undefined
        ? settingsCost
        : Math.min(settingsCost, legacyCost);

  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(fixedRequested !== undefined
      ? {
          model: fixedRequested.model,
          auth: fixedRequested.auth,
          reasoning: settings?.reasoningEffort ?? fixedRequested.reasoning,
        }
      : settings?.reasoningEffort !== undefined
        ? { reasoning: settings.reasoningEffort }
        : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(fallback?.source === 'fixed' ? { fallbackModel: fallback.model } : {}),
  };
}

export function createVendoredNodeCostBudgetState(
  ceilingUsd: number | undefined
): VendoredNodeCostBudgetState {
  return { ...(ceilingUsd !== undefined ? { ceilingUsd } : {}), spentUsd: 0 };
}

export function optionsWithRemainingVendoredNodeBudget<T extends { maxBudgetUsd?: number }>(
  options: T | undefined,
  budget: VendoredNodeCostBudgetState,
  nodeId: string
): T | undefined {
  if (budget.ceilingUsd === undefined) return options;
  const remainingUsd = budget.ceilingUsd - budget.spentUsd;
  if (remainingUsd <= 0) {
    throw new Error(
      `Node '${nodeId}' exhausted its cumulative cost ceiling of $${budget.ceilingUsd.toFixed(2)} before the next provider call.`
    );
  }
  return { ...(options ?? ({} as T)), maxBudgetUsd: remainingUsd };
}

export function recordVendoredNodeSpend(
  budget: VendoredNodeCostBudgetState,
  costUsd: number,
  nodeId: string
): void {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`Node '${nodeId}' reported an invalid provider cost.`);
  }
  budget.spentUsd += costUsd;
  if (budget.ceilingUsd !== undefined && budget.spentUsd > budget.ceilingUsd) {
    throw new Error(
      `Node '${nodeId}' exceeded its cumulative cost ceiling of $${budget.ceilingUsd.toFixed(2)} (spent $${budget.spentUsd.toFixed(2)}).`
    );
  }
}

/** Select one per-run credential channel; operator/global fallback is forbidden. */
export function applyVendoredNodeAuthSelection(
  env: Record<string, string> | undefined,
  provider: string,
  auth: VendoredNodeSpecRuntimeBinding['auth'],
  nodeId: string
): Record<string, string> | undefined {
  if (!auth) return env;
  const selectedEnv = { ...(env ?? {}) };
  if (provider === 'claude') {
    if (auth.kind === 'api-key') {
      if (!selectedEnv.CLAUDE_API_KEY && !selectedEnv.ANTHROPIC_API_KEY) {
        throw new Error(
          `Node '${nodeId}' requested Claude API-key auth, but no per-run Claude API key was resolved; operator/global credentials are disabled for explicit NodeSpec auth.`
        );
      }
      selectedEnv.CLAUDE_USE_GLOBAL_AUTH = 'false';
      selectedEnv.CLAUDE_CODE_OAUTH_TOKEN = '';
      selectedEnv.ANTHROPIC_OAUTH_TOKEN = '';
    } else if (auth.kind === 'oauth') {
      if (!selectedEnv.CLAUDE_CODE_OAUTH_TOKEN && !selectedEnv.ANTHROPIC_OAUTH_TOKEN) {
        throw new Error(
          `Node '${nodeId}' requested Claude OAuth auth, but no per-run OAuth credential was resolved; operator/global credentials are disabled for explicit NodeSpec auth.`
        );
      }
      selectedEnv.CLAUDE_USE_GLOBAL_AUTH = 'false';
      selectedEnv.CLAUDE_API_KEY = '';
      selectedEnv.ANTHROPIC_API_KEY = '';
    } else {
      throw new Error(`Node '${nodeId}' requested unsupported Claude auth kind '${auth.kind}'.`);
    }
  } else if (provider === 'codex') {
    if (auth.kind === 'api-key') {
      if (!selectedEnv.OPENAI_API_KEY) {
        throw new Error(
          `Node '${nodeId}' requested Codex API-key auth, but no per-run OpenAI API key was resolved; operator/global credentials are disabled for explicit NodeSpec auth.`
        );
      }
      selectedEnv.CODEX_HOME = '';
    } else if (auth.kind === 'oauth') {
      if (!selectedEnv.CODEX_HOME) {
        throw new Error(
          `Node '${nodeId}' requested Codex OAuth auth, but no per-run CODEX_HOME credential was resolved; operator/global credentials are disabled for explicit NodeSpec auth.`
        );
      }
      selectedEnv.OPENAI_API_KEY = '';
    } else {
      throw new Error(`Node '${nodeId}' requested unsupported Codex auth kind '${auth.kind}'.`);
    }
  }
  return selectedEnv;
}
