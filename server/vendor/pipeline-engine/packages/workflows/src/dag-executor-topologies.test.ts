import { describe, expect, it, mock } from 'bun:test';
import {
  executeFusionTopology,
  type FusionTopologyInvocation,
  type FusionTopologyKind,
  type FusionTopologyNode,
} from './dag-executor-topologies';

const agents = [
  { id: 'alpha', role: 'Lead scientist' },
  { id: 'beta', role: 'Adversarial reviewer' },
  { id: 'gamma', role: 'Evidence auditor' },
];

function topology(kind: FusionTopologyKind): FusionTopologyNode {
  return { id: `node-${kind}`, kind, task: 'Evaluate the evidence.', agents };
}

describe('fusion topology executor semantics', () => {
  it.each([
    ['opinion', ['opinion']],
    ['parallel', ['parallel', 'parallel', 'parallel']],
    ['coordinate', ['coordinate-plan', 'coordinate-work', 'coordinate-work', 'coordinate-final']],
    ['ultraplan', ['ultraplan-draft', 'ultraplan-draft', 'ultraplan-draft', 'ultraplan-final']],
    [
      'plan-debate',
      [
        'plan-draft', 'plan-draft', 'plan-draft',
        'plan-debate', 'plan-debate', 'plan-debate',
        'plan-debate-final',
      ],
    ],
    [
      'draco-fusion',
      [
        'draco-opinion', 'draco-opinion', 'draco-opinion',
        'draco-deliberation', 'draco-deliberation', 'draco-deliberation',
        'draco-final',
      ],
    ],
  ] as const)('executes %s with its bounded phase topology', async (kind, expectedPhases) => {
    const provider = {
      run: mock(async (invocation: FusionTopologyInvocation) =>
        `${invocation.phase}:${invocation.agent.id}`
      ),
    };
    const result = await executeFusionTopology(topology(kind), provider);
    expect(result.kind).toBe(kind);
    expect(result.trace.map(entry => entry.phase)).toEqual(expectedPhases);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('runs parallel analysts concurrently while preserving authored result order', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const provider = {
      run: mock(async (invocation: FusionTopologyInvocation) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active -= 1;
        return invocation.agent.id;
      }),
    };
    const promise = executeFusionTopology(topology('parallel'), provider);
    await Promise.resolve();
    expect(peak).toBe(3);
    releases.splice(0).reverse().forEach(release => release());
    const result = await promise;
    expect(result.outputs.map(output => output.agentId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.trace.map(entry => entry.agentId)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('repairs an invalid draft and returns only after a validator passes it', async () => {
    let checks = 0;
    const provider = {
      run: mock(async (invocation: FusionTopologyInvocation) => {
        if (invocation.phase === 'auto-validate-check') {
          checks += 1;
          return checks === 1
            ? JSON.stringify({ passed: false, findings: ['missing evidence'] })
            : JSON.stringify({ passed: true, findings: [] });
        }
        return invocation.phase === 'auto-validate-repair' ? 'repaired draft' : 'initial draft';
      }),
    };
    const result = await executeFusionTopology(
      { ...topology('auto-validate'), maxRounds: 2 },
      provider
    );
    expect(result.output).toBe('repaired draft');
    expect(result.validation).toEqual({ passed: true, rounds: 2 });
    expect(result.trace.map(entry => entry.phase)).toEqual([
      'auto-validate-draft',
      'auto-validate-check',
      'auto-validate-repair',
      'auto-validate-check',
    ]);
  });

  it('fails closed on duplicate staffing and exhausted auto-validation', async () => {
    await expect(executeFusionTopology(
      { ...topology('parallel'), agents: [agents[0], agents[0]] },
      { run: async () => 'unused' }
    )).rejects.toThrow('Duplicate fusion topology agent');

    await expect(executeFusionTopology(
      { ...topology('auto-validate'), maxRounds: 1 },
      {
        run: async invocation => invocation.phase === 'auto-validate-check'
          ? JSON.stringify({ passed: false, findings: ['still invalid'] })
          : 'draft',
      }
    )).rejects.toThrow('Auto-validation failed after 1 rounds');
  });

  it.each([
    'VALID: false — missing evidence',
    'not invalid; no problems found',
    '{"passed":"true","findings":[]}',
    '{"passed":true}',
    '',
  ])('never accepts an ambiguous validator verdict: %s', async verdict => {
    await expect(executeFusionTopology(
      { ...topology('auto-validate'), maxRounds: 1 },
      {
        run: async invocation => invocation.phase === 'auto-validate-check' ? verdict : 'draft',
      }
    )).rejects.toThrow();
  });

  it('accepts only a strict JSON verdict whose boolean passed field is true', async () => {
    const result = await executeFusionTopology(
      { ...topology('auto-validate'), maxRounds: 1 },
      {
        run: async invocation => invocation.phase === 'auto-validate-check'
          ? JSON.stringify({ passed: true, findings: [] })
          : 'verified draft',
      }
    );
    expect(result.validation).toEqual({ passed: true, rounds: 1 });
    expect(result.output).toBe('verified draft');
  });
});
