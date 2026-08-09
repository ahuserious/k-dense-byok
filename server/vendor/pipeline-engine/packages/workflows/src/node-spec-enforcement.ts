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
    settings.hyperparameters?.temperature !== undefined,
    'vendored-temperature-unbound',
    'hyperparameters/temperature',
    'hyperparameters.temperature',
    'S4'
  );
  reject(
    settings.hyperparameters?.top_p !== undefined,
    'vendored-top-p-unbound',
    'hyperparameters/top_p',
    'hyperparameters.top_p',
    'S4'
  );
  reject(
    settings.hyperparameters?.sampling !== undefined,
    'vendored-sampling-unbound',
    'hyperparameters/sampling',
    'hyperparameters.sampling',
    'S4'
  );
  reject(settings.conditions?.when !== undefined, 'vendored-condition-when-unbound', 'conditions/when', 'conditions.when', 'S4');
  reject(settings.conditions?.exists !== undefined, 'vendored-condition-exists-unbound', 'conditions/exists', 'conditions.exists', 'S4');
  reject(settings.harness !== undefined, 'vendored-harness-unbound', 'harness', 'harness', 'S4');
  reject(settings.databases !== undefined, 'vendored-databases-unbound', 'databases', 'databases', 'S4');
  reject(settings.skills?.mode !== undefined, 'vendored-skills-mode-unbound', 'skills/mode', 'skills.mode', 'S4');
  reject(settings.skills?.list !== undefined, 'vendored-skills-list-unbound', 'skills/list', 'skills.list', 'S4');
  reject(settings.subagents?.mode !== undefined, 'vendored-subagents-mode-unbound', 'subagents/mode', 'subagents.mode', 'S4');
  reject(settings.autonomy !== undefined, 'vendored-autonomy-unbound', 'autonomy', 'autonomy', 'S4');
  reject(settings.deliberation?.personalityStoreRef !== undefined, 'vendored-personality-store-unbound', 'deliberation/personalityStoreRef', 'deliberation.personalityStoreRef', 'S5');
  reject(settings.deliberation?.bestOfNPersonalityCount !== undefined, 'vendored-personality-count-unbound', 'deliberation/bestOfNPersonalityCount', 'deliberation.bestOfNPersonalityCount', 'S5');
  reject(settings.deliberation?.mimeographs?.mode !== undefined, 'vendored-mimeograph-mode-unbound', 'deliberation/mimeographs/mode', 'deliberation.mimeographs.mode', 'S5');
  reject(settings.deliberation?.mimeographs?.personalityRefs !== undefined, 'vendored-mimeograph-personalities-unbound', 'deliberation/mimeographs/personalityRefs', 'deliberation.mimeographs.personalityRefs', 'S5');
  reject(settings.billingMode !== undefined, 'vendored-billing-mode-unbound', 'billingMode', 'billingMode', 'S4');
  reject(settings.budget?.maxTokens !== undefined, 'vendored-token-budget-unbound', 'budget/maxTokens', 'budget.maxTokens', 'S4');
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
    if (binding.reasoning !== undefined) {
      if (!binding.provider || routePresetEffort(binding.provider, binding.reasoning) === null) {
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

/** Select one existing credential channel without exposing credential values. */
export function applyVendoredNodeAuthSelection(
  env: Record<string, string> | undefined,
  provider: string,
  auth: VendoredNodeSpecRuntimeBinding['auth']
): Record<string, string> | undefined {
  if (!auth) return env;
  const selectedEnv = { ...(env ?? {}) };
  if (provider === 'claude') {
    if (auth.kind === 'api-key') {
      selectedEnv.CLAUDE_USE_GLOBAL_AUTH = 'false';
      selectedEnv.CLAUDE_CODE_OAUTH_TOKEN = '';
      selectedEnv.ANTHROPIC_OAUTH_TOKEN = '';
    } else {
      const hasExplicitOAuth = Boolean(
        selectedEnv.CLAUDE_CODE_OAUTH_TOKEN ||
          selectedEnv.ANTHROPIC_OAUTH_TOKEN ||
          process.env.CLAUDE_CODE_OAUTH_TOKEN ||
          process.env.ANTHROPIC_OAUTH_TOKEN
      );
      selectedEnv.CLAUDE_USE_GLOBAL_AUTH = hasExplicitOAuth ? 'false' : 'true';
      selectedEnv.CLAUDE_API_KEY = '';
      selectedEnv.ANTHROPIC_API_KEY = '';
    }
  } else if (provider === 'codex') {
    if (auth.kind === 'api-key') {
      selectedEnv.CODEX_HOME = '';
    } else {
      selectedEnv.OPENAI_API_KEY = '';
    }
  }
  return selectedEnv;
}
