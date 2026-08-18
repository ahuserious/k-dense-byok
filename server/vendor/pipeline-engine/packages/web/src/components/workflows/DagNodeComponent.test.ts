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
  DagNodeRender,
  HarnessSelect,
  NODE_HARNESSES,
  NODE_HARNESS_OPTIONS,
  NodeDetailsSurface,
  NodeTypeBadge,
  TYPE_CONFIG,
  getContentPreview,
  getFullPrompt,
  nodeExpandControlLabel,
  nodeHarnessLabel,
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

  test('only the explicit expand control reveals details — hover never does', () => {
    expect(shouldShowNodeDetails(false, false)).toBe(false);
    // The owner's "expanding happens when hovering": hovering alone must not
    // open the details panel, and it must not keep it open once collapsed.
    expect(shouldShowNodeDetails(true, false)).toBe(false);
    expect(shouldShowNodeDetails(false, true)).toBe(true);
    expect(shouldShowNodeDetails(true, true)).toBe(true);
  });

  test('the expand control toggles its visible label', () => {
    expect(nodeExpandControlLabel(false)).toBe('expand +');
    expect(nodeExpandControlLabel(true)).toBe('collapse -');
  });

  test('a collapsed card renders the expand control with aria-expanded=false and no details', () => {
    const data: DagNodeData = {
      id: 'collapsed-node',
      label: 'A readable node title',
      nodeType: 'prompt',
      promptText: 'hidden until expanded',
    };
    const html = renderToStaticMarkup(
      createElement(DagNodeRender, { data, selected: false } as never)
    );
    expect(html).toContain('data-testid="node-expand-control"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand full node details"');
    expect(html).toContain('expand +');
    // Details are pinned-only, so the collapsed default renders no surface.
    expect(html).not.toContain('data-testid="node-details-surface"');
    // Title and type badge are on the card and legible (13px title, 10px badge).
    expect(html).toContain('data-testid="node-title"');
    expect(html).toContain('A readable node title');
    expect(html).toContain('text-[13px]');
    expect(html).toContain('PROMPT');
  });

  test('the details surface carries no fluid-canvas effect wrapper', async () => {
    const data: DagNodeData = {
      id: 'effect-free',
      label: 'Prompt',
      nodeType: 'prompt',
      promptText: 'plain',
    };
    const html = await renderHookCompatibleMarkup(createElement(NodeDetailsSurface, { data }));
    expect(html).toContain('data-testid="node-details-panel"');
    // The blue-smoke effect was a WebGL <canvas> painted behind this content.
    expect(html).not.toContain('<canvas');
    expect(html).not.toContain('layoutsubtree');
  });

  test('detail surface renders full prompt and the complete resolved NodeSpec', async () => {
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

describe('quick-node CLI harness selection', () => {
  test('the offered harnesses are exactly the frozen NodeSpec v1 union', () => {
    expect(NODE_HARNESS_OPTIONS.map((option: { value: string }) => option.value)).toEqual([
      ...NODE_HARNESSES,
    ]);
    expect(nodeHarnessLabel('pi')).toBe('Pi (Kady)');
    expect(nodeHarnessLabel('claude-code')).toBe('Claude Code');
    // Grok CLI is not a member of HarnessSchema, so it must not be offered.
    expect(NODE_HARNESS_OPTIONS.map((option: { value: string }) => option.value)).not.toContain(
      'grok'
    );
  });

  test('the harness picker is a labelled, keyboard-operable select of every harness', () => {
    const html = renderToStaticMarkup(
      createElement(HarnessSelect, {
        value: 'codex',
        onChange: (): void => undefined,
        label: 'CLI harness for the Prompt quick node',
      })
    );
    expect(html).toContain('data-testid="quick-node-harness"');
    expect(html).toContain('aria-label="CLI harness for the Prompt quick node"');
    for (const harness of NODE_HARNESSES) {
      expect(html).toContain(`value="${harness}"`);
    }
  });

  test('a non-Pi choice says at the picker that Save does not accept it yet', () => {
    const pi = renderToStaticMarkup(
      createElement(HarnessSelect, {
        value: 'pi',
        onChange: (): void => undefined,
        label: 'CLI harness for the Prompt quick node',
      })
    );
    expect(pi).not.toContain('data-testid="quick-node-harness-note"');

    const codex = renderToStaticMarkup(
      createElement(HarnessSelect, {
        value: 'codex',
        onChange: (): void => undefined,
        label: 'CLI harness for the Prompt quick node',
      })
    );
    expect(codex).toContain('data-testid="quick-node-harness-note"');
    expect(codex).toContain('Save accepts Pi only');
  });

  test('the card badge shows the harness the node actually carries', () => {
    const data: DagNodeData = {
      id: 'harness-node',
      label: 'Prompt',
      nodeType: 'prompt',
      settings: { harness: 'claude-code' },
    };
    const html = renderToStaticMarkup(
      createElement(DagNodeRender, { data, selected: false } as never)
    );
    expect(html).toContain('data-testid="node-harness-badge"');
    expect(html).toContain('claude-code');
    expect(html).toContain('CLI harness: Claude Code');
  });
});
