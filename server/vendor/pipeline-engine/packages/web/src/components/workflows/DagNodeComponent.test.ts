import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server';
import { describe, test, expect, mock } from 'bun:test';
import type { DagNodeData } from './DagNodeComponent';

mock.module('@xyflow/react', () => ({
  Handle: (): null => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));
mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]): string => values.filter(Boolean).join(' '),
}));

const {
  NodeDetailsSurface,
  NodeTypeBadge,
  TYPE_CONFIG,
  getContentPreview,
  getFullPrompt,
  nodeExpandControlLabel,
  resolveNodeSpecProjection,
  shouldShowNodeDetails,
} = await import('./DagNodeComponent');

async function renderHookCompatibleMarkup(element: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe('node content projection', () => {
  test('loop node with multi-line prompt keeps a one-line preview and full expanded prompt', () => {
    const data: DagNodeData = {
      id: 'n1',
      label: 'Loop',
      nodeType: 'loop',
      promptText: 'first line\nsecond line\nthird line',
    };
    expect(getContentPreview(data)).toBe('first line');
    expect(getFullPrompt(data)).toBe('first line\nsecond line\nthird line');
  });

  test('approval node returns its message only in the full projection', () => {
    const data: DagNodeData = {
      id: 'n2',
      label: 'Approval',
      nodeType: 'approval',
      approval: { message: 'Please approve' },
    };
    expect(getContentPreview(data)).toBe('');
    expect(getFullPrompt(data)).toBe('Please approve');
  });

  test('hover and explicit expand both reveal details while the control toggles its label', () => {
    expect(shouldShowNodeDetails(false, false)).toBe(false);
    expect(shouldShowNodeDetails(true, false)).toBe(true);
    expect(shouldShowNodeDetails(false, true)).toBe(true);
    expect(nodeExpandControlLabel(false)).toBe('expand +');
    expect(nodeExpandControlLabel(true)).toBe('collapse -');
  });

  test('Liquid detail surface renders full prompt and the complete resolved NodeSpec', async () => {
    const data: DagNodeData = {
      id: 'node-details',
      label: 'Prompt',
      nodeType: 'prompt',
      promptText: 'full prompt line one\nfull prompt line two',
      settings: {
        harness: 'codex',
        reasoningEffort: 'xhigh',
        hyperparameters: { temperature: 0.4, top_p: 0.8, sampling: { seed: 7 } },
        databases: ['lab/results'],
      },
    };
    const html = await renderHookCompatibleMarkup(createElement(NodeDetailsSurface, { data }));
    expect(html).toContain('full prompt line one');
    expect(html).toContain('full prompt line two');
    expect(html).toContain('Resolved NodeSpec v1');
    expect(html).toContain('&quot;harness&quot;: &quot;codex&quot;');
    expect(html).toContain('&quot;databases&quot;');
  });

  test('resolved projection supplies every frozen NodeSpec default without mutating input', () => {
    const input: DagNodeData['settings'] = { skills: { list: ['literature-review'] } };
    const projected = resolveNodeSpecProjection(input);
    expect(projected).toEqual({
      version: 1,
      reasoningEffort: 'high',
      hyperparameters: { temperature: 1, top_p: 1, sampling: {} },
      conditions: { exists: [] },
      harness: 'pi',
      databases: [],
      skills: { mode: 'auto', list: ['literature-review'] },
      subagents: { mode: 'auto' },
      autonomy: 'strict',
      deliberation: {
        bestOfNPersonalityCount: 2,
        mimeographs: { mode: 'auto', personalityRefs: [] },
      },
      billingMode: 'inherit',
      budget: {},
    });
    expect(input).toEqual({ skills: { list: ['literature-review'] } });
  });
});

describe('Scientific DAG Studio visual contracts', () => {
  const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

  test('canvas uses the neutral grey background token', () => {
    expect(css).toContain('--background: oklch(0.13 0 0);');
  });

  test('node palette retains a distinct token for every node type', () => {
    expect(css).toContain('--node-command:');
    expect(css).toContain('--node-prompt:');
    expect(css).toContain('--node-bash:');
    expect(css).toContain('--node-loop:');
    expect(css).toContain('--node-approval:');
    expect(Object.values(TYPE_CONFIG).map(config => config.stripeColor)).toEqual([
      'bg-node-command',
      'bg-node-prompt',
      'bg-node-bash',
      'bg-node-loop',
      'bg-node-approval',
    ]);
  });

  test('type badge renders the configured badge and palette class', () => {
    const html = renderToStaticMarkup(createElement(NodeTypeBadge, { nodeType: 'prompt' }));
    expect(html).toContain('data-testid="node-type-badge"');
    expect(html).toContain('PROMPT');
    expect(html).toContain('text-node-prompt');
  });
});
