import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition, NodeSpecV1 } from '@/lib/api';
import type { DagFlowNode } from './DagNodeComponent';
import { dagNodesToReactFlow } from '@/lib/dag-layout';
import { reactFlowToDagNodes } from './WorkflowCanvas';
import { serializeToYaml } from './YamlCodeView';

const completeNodeSpec: NodeSpecV1 = {
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
          reasoning: 'xhigh',
        },
      ],
      reason: 'Use the fixed fallback if the subscription provider is unavailable.',
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

describe('NodeSpec DAG persistence', () => {
  test('edit -> save -> reload preserves every NodeSpec field byte-equivalently', () => {
    const editedNode: DagFlowNode = {
      id: 'analysis-node',
      type: 'dagNode',
      position: { x: 0, y: 0 },
      data: {
        id: 'analysis-node',
        label: 'Prompt',
        nodeType: 'prompt',
        promptText: 'Analyze the supplied dataset.',
        settings: structuredClone(completeNodeSpec),
      },
    };
    const expectedBytes = JSON.stringify(completeNodeSpec);

    const savedNodes = reactFlowToDagNodes([editedNode], []);
    expect(JSON.stringify(savedNodes[0]?.settings)).toBe(expectedBytes);
    expect(savedNodes[0]?.settings?.budget?.maxTokens).toBe(120_000);

    const reloadedFlow = dagNodesToReactFlow(savedNodes);
    expect(JSON.stringify(reloadedFlow.nodes[0]?.data.settings)).toBe(expectedBytes);

    const savedAgain = reactFlowToDagNodes(reloadedFlow.nodes, reloadedFlow.edges);
    expect(JSON.stringify(savedAgain[0]?.settings)).toBe(expectedBytes);
  });

  test('YAML preview includes the canonical settings object and token budget', () => {
    const definition: WorkflowDefinition = {
      name: 'nodespec-persistence',
      description: 'NodeSpec persistence coverage',
      nodes: [
        {
          id: 'analysis-node',
          prompt: 'Analyze the supplied dataset.',
          settings: completeNodeSpec,
        },
      ],
    };
    const yaml = serializeToYaml(definition);

    expect(yaml).toContain('settings:');
    expect(yaml).toContain('reasoningEffort: max');
    expect(yaml).toContain('auth:');
    expect(yaml).toContain('kind: oauth');
    expect(yaml).toContain('maxTokens: 120000');
    expect(yaml).toContain('maxCostUsd: 24.5');
  });
});
