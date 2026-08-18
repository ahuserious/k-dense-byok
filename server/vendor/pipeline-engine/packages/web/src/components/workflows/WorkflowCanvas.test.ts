import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition, NodeSpecV1 } from '@/lib/api';
import type { DagFlowNode } from './DagNodeComponent';
import { dagNodesToReactFlow } from '@/lib/dag-layout';
import {
  CANVAS_INTERACTION_PROPS,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  FIRST_NODE_POSITION,
  FIT_VIEW_OPTIONS,
  HARNESS_DRAG_MIME,
  NEW_NODE_ROW_SPACING,
  newNodeHarnessSettings,
  nextNodePosition,
  nodeSetSignature,
  reactFlowToDagNodes,
} from './WorkflowCanvas';
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

describe('balanced canvas viewport', () => {
  test('the shared fit leaves padding and never pins the viewport at the zoom ceiling', () => {
    expect(FIT_VIEW_OPTIONS.padding).toBeCloseTo(0.25);
    // The owner's "zoom is off balance": React Flow's own fitView default is
    // maxZoom 2, which parked a small graph at 200% — the canvas "+" control
    // then had nowhere to go. The fit must stop well below the hard ceiling.
    expect(FIT_VIEW_OPTIONS.maxZoom).toBeLessThan(CANVAS_MAX_ZOOM);
    expect(FIT_VIEW_OPTIONS.maxZoom).toBeLessThanOrEqual(1.25);
    expect(FIT_VIEW_OPTIONS.minZoom).toBeGreaterThan(CANVAS_MIN_ZOOM);
    expect(CANVAS_MIN_ZOOM).toBeLessThan(1);
    expect(CANVAS_MAX_ZOOM).toBeGreaterThan(1);
  });

  test('re-fit tracks the node SET, so dragging a node cannot yank the viewport', () => {
    const node = (id: string, x: number, y: number): DagFlowNode => ({
      id,
      type: 'dagNode',
      position: { x, y },
      data: { id, label: 'Prompt', nodeType: 'prompt' },
    });
    const loaded = [node('a', 0, 0), node('b', 0, 100)];
    const dragged = [node('a', 640, 480), node('b', 0, 100)];
    const reordered = [node('b', 0, 100), node('a', 0, 0)];
    const added = [...loaded, node('c', 0, 200)];

    expect(nodeSetSignature(dragged)).toBe(nodeSetSignature(loaded));
    expect(nodeSetSignature(reordered)).toBe(nodeSetSignature(loaded));
    expect(nodeSetSignature(added)).not.toBe(nodeSetSignature(loaded));
    expect(nodeSetSignature([])).toBe('');
  });

  test('the palette drag payload has its own harness key', () => {
    expect(HARNESS_DRAG_MIME).toBe('application/reactflow-harness');
    expect(HARNESS_DRAG_MIME).not.toBe('application/reactflow-type');
  });

  test('a node created with a chosen harness persists it through save and reload', () => {
    const dragged: DagFlowNode = {
      id: 'dragged-node',
      type: 'dagNode',
      position: { x: 0, y: 0 },
      data: {
        id: 'dragged-node',
        label: 'Shell',
        nodeType: 'bash',
        bashScript: 'echo hi',
        settings: { harness: 'claude-code' },
      },
    };
    const saved = reactFlowToDagNodes([dragged], []);
    expect(saved[0]?.settings?.harness).toBe('claude-code');
    const reloaded = dagNodesToReactFlow(saved);
    expect(reloaded.nodes[0]?.data.settings?.harness).toBe('claude-code');
  });
});

describe('canvas gestures and node placement', () => {
  const positionedNode = (id: string, x: number, y: number): DagFlowNode => ({
    id,
    type: 'dagNode',
    position: { x, y },
    data: { id, label: 'Prompt', nodeType: 'prompt' },
  });

  test('double-clicking the pane quick-adds without also doubling the zoom', () => {
    // Double click is the builder's OWN quick-add gesture (handlePaneClick), so
    // React Flow's default double-click zoom fired on the same gesture: the menu
    // opened at 200%, a second double click hit the 250% ceiling, and cancelling
    // with Escape left the viewport parked there.
    expect(CANVAS_INTERACTION_PROPS.zoomOnDoubleClick).toBe(false);
    expect(CANVAS_INTERACTION_PROPS.panOnDrag).toBe(true);
    expect(CANVAS_INTERACTION_PROPS.selectionOnDrag).toBe(false);
  });

  test('a new node stacks below the lowest card in the FIRST card\u2019s column', () => {
    expect(nextNodePosition([])).toEqual({ ...FIRST_NODE_POSITION });
    const column = [positionedNode('a', 200, 120), positionedNode('b', 200, 260)];
    expect(nextNodePosition(column)).toEqual({ x: 200, y: 260 + NEW_NODE_ROW_SPACING });
    // Dragging one card far to the right must not drag the column with it.
    const dragged = [positionedNode('a', 200, 120), positionedNode('b', 980, 640)];
    expect(nextNodePosition(dragged)).toEqual({ x: 200, y: 640 + NEW_NODE_ROW_SPACING });
  });

  test('a new node writes settings.harness only when it is not the default', () => {
    // An explicit `pi` would shadow the document-level `defaultHarness` that
    // `settings.harness ?? document.settings.defaultHarness ?? default` resolves.
    expect(newNodeHarnessSettings('pi')).toBeUndefined();
    expect(newNodeHarnessSettings('claude-code')).toEqual({ harness: 'claude-code' });
  });
});
