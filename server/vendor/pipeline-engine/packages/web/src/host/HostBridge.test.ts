import { describe, test, expect } from 'bun:test';
import type { Edge } from '@xyflow/react';

import {
  BUILDER_BRIDGE_MAX_PAYLOAD_BYTES,
  BUILDER_BRIDGE_VERSION,
  decodeEnvelope,
  diffToDeltas,
  hostSourceValue,
  parseHostSourceValue,
  readHostMode,
  sanitizeIdentifier,
  viewToFlow,
  baselineFor,
  type HostGraphViewModel,
} from './HostBridge';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';

function view(overrides: Partial<HostGraphViewModel> = {}): HostGraphViewModel {
  return {
    version: 1,
    documentId: 'demo',
    name: 'Demo',
    entryNodeId: 'research',
    graphSha256: 'abc',
    mode: 'typed',
    nodes: [
      {
        id: 'research',
        label: 'Research',
        kind: 'research-until-goal',
        glyph: 'prompt',
        summary: 'Inventory the material',
        harness: 'codex',
        terminal: false,
        position: { x: 10, y: 20 },
        specDigest: 'digest-research',
        editableFields: ['name', 'position', 'harness'],
      },
      {
        id: 'report',
        label: 'Report',
        kind: 'agent',
        glyph: 'prompt',
        terminal: true,
        position: { x: 300, y: 20 },
        specDigest: 'digest-report',
        editableFields: ['name', 'position', 'harness'],
      },
    ],
    edges: [{ id: 'research-to-report', from: 'research', to: 'report', condition: 'always' }],
    ...overrides,
  };
}

function flowNode(
  id: string,
  label: string,
  position: { x: number; y: number },
  harness?: string
): DagFlowNode {
  return {
    id,
    type: 'dagNode',
    position,
    data: {
      id,
      label,
      nodeType: 'prompt',
      ...(harness ? { settings: { harness: harness as never } } : {}),
    },
  };
}

describe('readHostMode', () => {
  test('requires both the host flag and a parsable origin', () => {
    expect(readHostMode('?host=kady&hostOrigin=http%3A%2F%2F127.0.0.1%3A13300')).toEqual({
      hostMode: true,
      hostOrigin: 'http://127.0.0.1:13300',
    });
    expect(readHostMode('')).toEqual({ hostMode: false, hostOrigin: null });
    expect(readHostMode('?host=kady')).toEqual({ hostMode: false, hostOrigin: null });
    expect(readHostMode('?host=other&hostOrigin=http://x')).toEqual({
      hostMode: false,
      hostOrigin: null,
    });
    expect(readHostMode('?host=kady&hostOrigin=not-a-url')).toEqual({
      hostMode: false,
      hostOrigin: null,
    });
  });

  test('normalises a declared origin down to its origin', () => {
    expect(readHostMode('?host=kady&hostOrigin=http%3A%2F%2Fx%3A80%2Fdeep%2Fpath').hostOrigin).toBe(
      'http://x'
    );
  });
});

describe('decodeEnvelope', () => {
  test('accepts a current-version envelope and rejects everything else', () => {
    const ok = JSON.stringify({ v: BUILDER_BRIDGE_VERSION, id: 'host-1', type: 'builder.init', payload: {} });
    expect(decodeEnvelope(ok)).toMatchObject({ type: 'builder.init' });

    expect(decodeEnvelope(JSON.stringify({ v: 2, id: 'a', type: 'builder.init', payload: {} }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ v: 1, id: '', type: 'builder.init', payload: {} }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ v: 1, id: 'a', type: 'builder.init' }))).toBeNull();
    expect(decodeEnvelope({ v: 1, id: 'a', type: 'builder.init', payload: {} })).toBeNull();
    expect(decodeEnvelope('{ not json')).toBeNull();
    expect(decodeEnvelope('"'.padEnd(BUILDER_BRIDGE_MAX_PAYLOAD_BYTES + 2, 'x'))).toBeNull();
  });
});

describe('viewToFlow', () => {
  test('keeps authored positions and derives depends_on from the edges', () => {
    const { nodes, edges } = viewToFlow(view());

    expect(nodes.map(node => node.position)).toEqual([
      { x: 10, y: 20 },
      { x: 300, y: 20 },
    ]);
    expect(nodes[0].data.label).toBe('Research');
    expect(nodes[0].data.settings).toEqual({ harness: 'codex' });
    expect(nodes[1].data.depends_on).toEqual(['research']);
    expect(edges).toEqual([
      { id: 'research-to-report', source: 'research', target: 'report', type: 'smoothstep' },
    ]);
  });

  test('auto-lays-out when any node has no authored position', () => {
    const partial = view();
    delete partial.nodes[1].position;

    const { nodes } = viewToFlow(partial);

    // Dagre must have moved BOTH nodes, not stacked the unpositioned one at 0,0
    // beside an authored coordinate.
    expect(nodes[0].position).not.toEqual({ x: 10, y: 20 });
    expect(nodes[1].position).not.toEqual({ x: 0, y: 0 });
  });

  test('carries no prompt, goal, or credential field onto the canvas', () => {
    const serialized = JSON.stringify(viewToFlow(view()));
    for (const forbidden of ['"prompt":', '"goal":', '"auth":', '"skills":', '"databases":']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('sanitizeIdentifier', () => {
  test('produces an id the typed schema accepts', () => {
    const pattern = /^[a-z][a-z0-9_-]*$/;
    for (const candidate of [
      'xy-edge__node-a-node-b',
      'A->B',
      '123-numeric-start',
      'Node With Spaces',
    ]) {
      const sanitized = sanitizeIdentifier(candidate);
      expect(pattern.test(sanitized)).toBe(true);
      expect(sanitized.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('diffToDeltas', () => {
  test('reports nothing for an auto-laid-out graph the author has not touched', () => {
    // Every node here lacks an authored position, so dagre placed them. Those
    // coordinates are not edits and must not be reported as moves.
    const unpositioned = view();
    delete unpositioned.nodes[0].position;
    delete unpositioned.nodes[1].position;
    const baseline = baselineFor(unpositioned);

    expect(diffToDeltas(baseline, baseline.nodes, baseline.edges)).toEqual([]);
  });

  test('reports a drag of an auto-laid-out node against its projected position', () => {
    const unpositioned = view();
    delete unpositioned.nodes[0].position;
    delete unpositioned.nodes[1].position;
    const baseline = baselineFor(unpositioned);
    const dragged = baseline.nodes.map(node =>
      node.id === 'research' ? { ...node, position: { x: 999, y: 888 } } : node
    );

    expect(diffToDeltas(baseline, dragged, baseline.edges)).toEqual([
      {
        op: 'moveNode',
        nodeId: 'research',
        position: { x: 999, y: 888 },
        specDigest: 'digest-research',
      },
    ]);
  });

  test('reports nothing when the canvas still matches the pushed view', () => {
    const projected = viewToFlow(view());

    expect(diffToDeltas(baselineFor(view()), projected.nodes, projected.edges)).toEqual([]);
  });

  test('ignores sub-pixel jitter but reports a real move', () => {
    const projected = viewToFlow(view());
    const jittered = projected.nodes.map(node =>
      node.id === 'research' ? { ...node, position: { x: 10.2, y: 20.1 } } : node
    );
    expect(diffToDeltas(baselineFor(view()), jittered, projected.edges)).toEqual([]);

    const moved = projected.nodes.map(node =>
      node.id === 'research' ? { ...node, position: { x: 140, y: -60 } } : node
    );
    expect(diffToDeltas(baselineFor(view()), moved, projected.edges)).toEqual([
      {
        op: 'moveNode',
        nodeId: 'research',
        position: { x: 140, y: -60 },
        specDigest: 'digest-research',
      },
    ]);
  });

  test('reports adds, removes, renames, and harness changes with the digest they were computed against', () => {
    const projected = viewToFlow(view());
    const nodes = [
      { ...projected.nodes[0], data: { ...projected.nodes[0].data, label: 'Research, renamed' } },
      flowNode('node-new', 'Fresh node', { x: 600, y: 20 }, 'claude-code'),
    ];
    const edges: Edge[] = [
      { id: 'xy-edge__research-node-new', source: 'research', target: 'node-new' },
    ];

    const ops = diffToDeltas(baselineFor(view()), nodes, edges);

    expect(ops).toEqual([
      {
        op: 'renameNode',
        nodeId: 'research',
        name: 'Research, renamed',
        specDigest: 'digest-research',
      },
      {
        op: 'addNode',
        nodeId: 'node-new',
        name: 'Fresh node',
        position: { x: 600, y: 20 },
        harness: 'claude-code',
      },
      { op: 'removeNode', nodeId: 'report' },
      { op: 'addEdge', edgeId: 'xy-edge__research-node-new', from: 'research', to: 'node-new' },
      { op: 'removeEdge', edgeId: 'research-to-report' },
    ]);
  });
});

describe('diffToDeltas harness', () => {
  test('reports a cleared harness as an explicit null rather than an omission', () => {
    const projected = viewToFlow(view());
    const cleared = projected.nodes.map(node =>
      node.id === 'research' ? { ...node, data: { ...node.data, settings: undefined } } : node
    );

    expect(diffToDeltas(baselineFor(view()), cleared, projected.edges)).toEqual([
      { op: 'setHarness', nodeId: 'research', harness: null, specDigest: 'digest-research' },
    ]);
  });

  test('reports a harness the author picked on an existing node', () => {
    const projected = viewToFlow(view());
    const switched = projected.nodes.map(node =>
      node.id === 'report'
        ? { ...node, data: { ...node.data, settings: { harness: 'opencode' as never } } }
        : node
    );

    expect(diffToDeltas(baselineFor(view()), switched, projected.edges)).toEqual([
      { op: 'setHarness', nodeId: 'report', harness: 'opencode', specDigest: 'digest-report' },
    ]);
  });
});

describe('host source values', () => {
  test('round-trip a group and entry, including ids that contain a colon', () => {
    expect(parseHostSourceValue(hostSourceValue('kady-workflows', 'a:b'))).toEqual({
      groupId: 'kady-workflows',
      entryId: 'a:b',
    });
    expect(parseHostSourceValue('no-separator')).toBeNull();
    expect(parseHostSourceValue(':leading')).toBeNull();
    expect(parseHostSourceValue('trailing:')).toBeNull();
  });
});
