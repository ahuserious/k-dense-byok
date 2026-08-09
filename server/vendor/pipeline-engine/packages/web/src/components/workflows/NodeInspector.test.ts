import { createElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, mock, test } from 'bun:test';
import type { DagNodeData, NodeSpecV1 } from './DagNodeComponent';

const Passthrough = ({ children }: { children?: ReactNode }): ReactElement =>
  createElement('div', null, children);

mock.module('@xyflow/react', () => ({
  Handle: (): null => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));
mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]): string => values.filter(Boolean).join(' '),
}));
mock.module('@/components/ui/tabs', () => ({
  Tabs: Passthrough,
  TabsList: Passthrough,
  TabsTrigger: Passthrough,
  TabsContent: Passthrough,
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children?: ReactNode }): ReactElement =>
    createElement('button', null, children),
}));
mock.module('@/components/ui/scroll-area', () => ({ ScrollArea: Passthrough }));
mock.module('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [] }) }));

const {
  NODE_SPEC_EDITOR_DROPDOWNS,
  NODE_SPEC_V1_BINDING_FIELDS,
  NodeSpecTab,
  createExplicitFallbackModelRequest,
  defaultFallbackFor,
  mergeNodeSpecV1,
  nodeSpecV1InlineErrors,
  nodeRequestedModelIdentity,
  parseRequestedModelAlternatives,
} = await import('./NodeInspector');

const fullNodeSpec: NodeSpecV1 = {
  version: 1,
  model: {
    requested: {
      source: 'fixed',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      auth: { kind: 'oauth', profile: 'research-subscription' },
      reasoning: 'xhigh',
    },
    resolution: {
      mode: 'explicit-fallback',
      alternatives: [
        {
          source: 'fixed',
          provider: 'openrouter',
          model: 'openai/gpt-5',
          auth: { kind: 'api-key' },
          reasoning: 'high',
        },
      ],
      reason: 'Preserve execution when the fixed provider is unavailable.',
    },
  },
  reasoningEffort: 'max',
  hyperparameters: {
    temperature: 0.4,
    top_p: 0.8,
    sampling: { seed: 17, response_format: 'json', deterministic: true },
  },
  conditions: { when: 'inputs.ready == true', exists: ['inputs/dataset.parquet'] },
  harness: 'codex',
  databases: ['database/literature'],
  skills: { mode: 'manual', list: ['literature-review', 'citation-management'] },
  subagents: { mode: 'auto-manual' },
  autonomy: 'loose',
  deliberation: {
    personalityStoreRef: 'personalities/science-v1',
    bestOfNPersonalityCount: 4,
    mimeographs: {
      mode: 'manual',
      personalityRefs: ['personality/skeptic', 'personality/synthesist'],
    },
  },
  billingMode: 'subscription',
  budget: { maxTokens: 120_000, maxCostUsd: 24.5 },
};

describe('NodeSpec v1 editor contract', () => {
  test('builder dropdowns expose every frozen enum choice', () => {
    expect(NODE_SPEC_EDITOR_DROPDOWNS).toEqual({
      modelSource: ['inherit', 'kady-current', 'fixed'],
      authKind: ['api-key', 'oauth', 'local', 'custom'],
      reasoning: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      harness: ['pi', 'claude-code', 'codex', 'opencode', 'copilot'],
      skillsMode: ['auto', 'auto-manual', 'manual'],
      subagentsMode: ['auto', 'auto-manual'],
      autonomy: ['strict', 'loose'],
      billingMode: ['inherit', 'api', 'subscription'],
      mimeographsMode: ['auto', 'manual'],
    });
  });

  test('auth.kind is rendered as an editable subscription-vs-API control', () => {
    const node: DagNodeData = {
      id: 'auth-node',
      label: 'Prompt',
      nodeType: 'prompt',
      promptText: 'Authenticate this node.',
      settings: fullNodeSpec,
    };
    const html = renderToStaticMarkup(
      createElement(NodeSpecTab, { node, onUpdate: (): void => undefined })
    );
    expect(html).toContain('data-testid="nodespec-auth-kind"');
    expect(html).toContain('API key');
    expect(html).toContain('Subscription / OAuth');
    expect(html).toContain('Local');
    expect(html).toContain('Custom');
  });

  test('round-trips every NodeSpec field through the immutable settings update path', () => {
    const roundTripped = mergeNodeSpecV1(undefined, fullNodeSpec);
    expect(roundTripped).toEqual(fullNodeSpec);
    expect(NODE_SPEC_V1_BINDING_FIELDS).toEqual([
      'version',
      'model',
      'model.requested.auth.kind',
      'reasoningEffort',
      'hyperparameters.temperature',
      'hyperparameters.top_p',
      'hyperparameters.sampling',
      'conditions.when',
      'conditions.exists',
      'harness',
      'databases',
      'skills.mode',
      'skills.list',
      'subagents.mode',
      'autonomy',
      'deliberation.personalityStoreRef',
      'deliberation.bestOfNPersonalityCount',
      'deliberation.mimeographs.mode',
      'deliberation.mimeographs.personalityRefs',
      'billingMode',
      'budget.maxTokens',
      'budget.maxCostUsd',
    ]);
  });

  test('preserves existing fields when a single control commits an update', () => {
    const updated = mergeNodeSpecV1(fullNodeSpec, { billingMode: 'api' });
    expect(updated.model).toEqual(fullNodeSpec.model);
    expect(updated.deliberation).toEqual(fullNodeSpec.deliberation);
    expect(updated.budget).toEqual(fullNodeSpec.budget);
    expect(updated.billingMode).toBe('api');
  });

  test('surfaces clear inline errors for values still rejected by S4 and S5', () => {
    const errors = nodeSpecV1InlineErrors(fullNodeSpec);
    expect(errors.some(error => error.includes('temperature until S4'))).toBe(true);
    expect(errors.some(error => error.includes('non-pi harnesses until S4'))).toBe(true);
    expect(errors.some(error => error.includes('personalityStoreRef until S5'))).toBe(true);
    expect(errors.some(error => error.includes('manual mimeographs until S5'))).toBe(true);
  });

  test('validates explicit fallback JSON before committing it', () => {
    const valid = parseRequestedModelAlternatives(
      JSON.stringify(fullNodeSpec.model?.resolution.mode === 'explicit-fallback'
        ? fullNodeSpec.model.resolution.alternatives
        : [])
    );
    expect(valid.error).toBeUndefined();
    expect(valid.value).toHaveLength(1);
    expect(parseRequestedModelAlternatives('[{"source":"fixed"}]').error).toContain(
      'valid fixed requested-model objects'
    );
    expect(
      parseRequestedModelAlternatives(
        '[{"source":"kady-current","auth":{"kind":"kady-current"},"reasoning":"high"}]'
      ).error
    ).toContain('Kady Current is not allowed');
  });

  test('fallback creation always produces distinct fixed model identities', () => {
    const fromKadyCurrent = createExplicitFallbackModelRequest({
      source: 'kady-current',
      auth: { kind: 'kady-current' },
      reasoning: 'high',
    });
    expect(fromKadyCurrent.requested.source).toBe('fixed');
    expect(fromKadyCurrent.resolution.mode).toBe('explicit-fallback');
    if (fromKadyCurrent.resolution.mode !== 'explicit-fallback') {
      throw new Error('expected explicit fallback');
    }
    expect(fromKadyCurrent.resolution.alternatives.every(model => model.source === 'fixed')).toBe(
      true
    );
    expect(
      nodeRequestedModelIdentity(fromKadyCurrent.resolution.alternatives[0])
    ).not.toBe(nodeRequestedModelIdentity(fromKadyCurrent.requested));
    expect(nodeSpecV1InlineErrors({ model: fromKadyCurrent })).toEqual([]);

    const primary = fullNodeSpec.model?.requested;
    if (!primary) throw new Error('expected primary model');
    expect(defaultFallbackFor(primary).source).toBe('fixed');
    expect(nodeRequestedModelIdentity(defaultFallbackFor(primary))).not.toBe(
      nodeRequestedModelIdentity(primary)
    );
  });

  test('mirrors canonical ambiguity and duplicate-identity validation', () => {
    const fixedPrimary = {
      source: 'fixed' as const,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      auth: { kind: 'api-key' as const },
      reasoning: 'high' as const,
    };
    const fixedAlternative = {
      source: 'fixed' as const,
      provider: 'openrouter',
      model: 'openai/gpt-5',
      auth: { kind: 'api-key' as const },
      reasoning: 'high' as const,
    };
    const kadyCurrent = {
      source: 'kady-current' as const,
      auth: { kind: 'kady-current' as const },
      reasoning: 'high' as const,
    };

    const primaryAmbiguity = nodeSpecV1InlineErrors({
      model: {
        requested: kadyCurrent,
        resolution: {
          mode: 'explicit-fallback',
          alternatives: [fixedAlternative],
          reason: 'fallback',
        },
      },
    });
    expect(primaryAmbiguity).toContain(
      'Kady Current is an exact runtime selection and cannot appear in an explicit fallback list.'
    );

    const alternativeAmbiguity = nodeSpecV1InlineErrors({
      model: {
        requested: fixedPrimary,
        resolution: {
          mode: 'explicit-fallback',
          alternatives: [kadyCurrent],
          reason: 'fallback',
        },
      },
    });
    expect(alternativeAmbiguity).toContain(
      'Kady Current is an exact runtime selection and cannot appear in an explicit fallback list.'
    );

    const repeatedAndDuplicate = nodeSpecV1InlineErrors({
      model: {
        requested: fixedPrimary,
        resolution: {
          mode: 'explicit-fallback',
          alternatives: [fixedPrimary, fixedAlternative, fixedAlternative],
          reason: 'fallback',
        },
      },
    });
    expect(repeatedAndDuplicate).toContain(
      'An explicit fallback must differ from the requested model and auth.'
    );
    expect(repeatedAndDuplicate).toContain('Explicit model fallbacks must be unique.');
  });
});
