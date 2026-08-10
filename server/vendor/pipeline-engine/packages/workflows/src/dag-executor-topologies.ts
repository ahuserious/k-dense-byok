/** Bounded provider-neutral deliberation topologies used by the DAG executor. */
export const FUSION_TOPOLOGY_KINDS = [
  'opinion',
  'parallel',
  'coordinate',
  'ultraplan',
  'plan-debate',
  'auto-validate',
  'draco-fusion',
] as const;

export type FusionTopologyKind = (typeof FUSION_TOPOLOGY_KINDS)[number];

export interface FusionTopologyAgent {
  id: string;
  role: string;
  prompt?: string;
}

export interface FusionTopologyNode {
  id: string;
  kind: FusionTopologyKind;
  task: string;
  agents: FusionTopologyAgent[];
  /** Auto-validation repair ceiling, including the initial draft. */
  maxRounds?: number;
}

export type FusionTopologyPhase =
  | 'opinion'
  | 'parallel'
  | 'coordinate-plan'
  | 'coordinate-work'
  | 'coordinate-final'
  | 'ultraplan-draft'
  | 'ultraplan-final'
  | 'plan-draft'
  | 'plan-debate'
  | 'plan-debate-final'
  | 'auto-validate-draft'
  | 'auto-validate-check'
  | 'auto-validate-repair'
  | 'draco-opinion'
  | 'draco-deliberation'
  | 'draco-final';

export interface FusionTopologyInvocation {
  nodeId: string;
  topology: FusionTopologyKind;
  phase: FusionTopologyPhase;
  agent: FusionTopologyAgent;
  task: string;
  inputs: ReadonlyArray<{ agentId: string; output: string }>;
  round: number;
  /** One signal shared by every invocation in this topology attempt. */
  signal: AbortSignal;
  /** Stable metadata for atomically sharing a phase budget across siblings. */
  batch: { id: string; index: number; size: number };
}

export interface FusionTopologyProvider {
  run(invocation: FusionTopologyInvocation): Promise<string>;
}

export interface FusionTopologyTraceEntry {
  phase: FusionTopologyPhase;
  agentId: string;
  round: number;
  output: string;
}

export interface FusionTopologyResult {
  kind: FusionTopologyKind;
  output: string;
  outputs: Array<{ agentId: string; output: string }>;
  trace: FusionTopologyTraceEntry[];
  validation?: { passed: boolean; rounds: number };
}

const MAX_AGENTS = 32;
const MAX_TASK_CHARS = 32_768;
const MAX_OUTPUT_CHARS = 65_536;
const MAX_ROUNDS = 8;

function validateNode(node: FusionTopologyNode): void {
  if (!FUSION_TOPOLOGY_KINDS.includes(node.kind)) {
    throw new Error(`Unsupported fusion topology: ${String(node.kind)}.`);
  }
  if (!node.id || !node.task.trim() || node.task.length > MAX_TASK_CHARS) {
    throw new Error('Fusion topology requires a bounded id and non-empty task.');
  }
  if (node.agents.length < 1 || node.agents.length > MAX_AGENTS) {
    throw new Error(`Fusion topology requires 1 through ${MAX_AGENTS} agents.`);
  }
  const ids = new Set<string>();
  for (const agent of node.agents) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agent.id) || !agent.role.trim()) {
      throw new Error(`Fusion topology has an invalid agent: ${agent.id}.`);
    }
    if (ids.has(agent.id)) throw new Error(`Duplicate fusion topology agent: ${agent.id}.`);
    ids.add(agent.id);
  }
  const rounds = node.maxRounds ?? 2;
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new Error(`Fusion topology maxRounds must be from 1 through ${MAX_ROUNDS}.`);
  }
}

function boundedOutput(output: string, invocation: FusionTopologyInvocation): string {
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error(
      `Fusion topology ${invocation.phase}/${invocation.agent.id} returned no output.`
    );
  }
  if (output.length > MAX_OUTPUT_CHARS) {
    throw new Error(
      `Fusion topology ${invocation.phase}/${invocation.agent.id} exceeded ${String(MAX_OUTPUT_CHARS)} characters.`
    );
  }
  return output.trim();
}

interface FusionTopologyValidationVerdict {
  passed: boolean;
  findings: string[];
}

function parseValidationVerdict(output: string): FusionTopologyValidationVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { passed: false, findings: ['validator returned malformed JSON'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { passed: false, findings: ['validator verdict must be an object'] };
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== 'findings\0passed' ||
    typeof record.passed !== 'boolean' ||
    !Array.isArray(record.findings) ||
    record.findings.length > 64 ||
    record.findings.some(finding =>
      typeof finding !== 'string' || !finding.trim() || finding.length > 4_096
    )
  ) {
    return { passed: false, findings: ['validator verdict failed its strict schema'] };
  }
  return {
    passed: record.passed,
    findings: record.findings.map(finding => (finding as string).trim()),
  };
}

/** Execute one topology with deterministic agent ordering and bounded rounds. */
export async function executeFusionTopology(
  node: FusionTopologyNode,
  provider: FusionTopologyProvider
): Promise<FusionTopologyResult> {
  validateNode(node);
  const trace: FusionTopologyTraceEntry[] = [];
  const topologyAbort = new AbortController();
  const invoke = async (
    phase: FusionTopologyPhase,
    agent: FusionTopologyAgent,
    inputs: ReadonlyArray<{ agentId: string; output: string }> = [],
    round = 1,
    batch = { id: `${phase}:${String(round)}`, index: 0, size: 1 }
  ): Promise<{ agentId: string; output: string }> => {
    if (topologyAbort.signal.aborted) {
      throw topologyAbort.signal.reason instanceof Error
        ? topologyAbort.signal.reason
        : new Error('Fusion topology invocation aborted.');
    }
    const invocation: FusionTopologyInvocation = {
      nodeId: node.id,
      topology: node.kind,
      phase,
      agent: { ...agent },
      task: node.task,
      inputs: inputs.map(input => ({ ...input })),
      round,
      signal: topologyAbort.signal,
      batch,
    };
    const traceEntry: FusionTopologyTraceEntry = {
      phase,
      agentId: agent.id,
      round,
      output: '',
    };
    // Reserve authored order before provider work completes; parallel provider
    // latency must not make the execution trace nondeterministic.
    trace.push(traceEntry);
    try {
      const output = boundedOutput(await provider.run(invocation), invocation);
      traceEntry.output = output;
      return { agentId: agent.id, output };
    } catch (error) {
      if (!topologyAbort.signal.aborted) topologyAbort.abort(error);
      throw error;
    }
  };
  const parallel = async (
    phase: FusionTopologyPhase,
    agents = node.agents,
    inputs: ReadonlyArray<{ agentId: string; output: string }> = [],
    round = 1
  ): Promise<Array<{ agentId: string; output: string }>> => {
    const batchId = `${phase}:${String(round)}`;
    const settled = await Promise.allSettled(agents.map((agent, index) =>
      invoke(phase, agent, inputs, round, { id: batchId, index, size: agents.length })
    ));
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) throw failed.reason;
    return settled.map(result => (result as PromiseFulfilledResult<{
      agentId: string;
      output: string;
    }>).value);
  };
  const lead = node.agents[0];

  switch (node.kind) {
    case 'opinion': {
      const opinion = await invoke('opinion', lead);
      return { kind: node.kind, output: opinion.output, outputs: [opinion], trace };
    }
    case 'parallel': {
      const outputs = await parallel('parallel');
      return {
        kind: node.kind,
        output: outputs.map(result => result.output).join('\n\n'),
        outputs,
        trace,
      };
    }
    case 'coordinate': {
      const plan = await invoke('coordinate-plan', lead);
      const workers = node.agents.slice(1);
      const work = workers.length > 0
        ? await parallel('coordinate-work', workers, [plan])
        : [plan];
      const final = await invoke('coordinate-final', lead, work);
      return { kind: node.kind, output: final.output, outputs: work, trace };
    }
    case 'ultraplan': {
      const plans = await parallel('ultraplan-draft');
      const final = await invoke('ultraplan-final', lead, plans);
      return { kind: node.kind, output: final.output, outputs: plans, trace };
    }
    case 'plan-debate': {
      const plans = await parallel('plan-draft');
      const debate = await parallel('plan-debate', node.agents, plans, 2);
      const final = await invoke('plan-debate-final', lead, [...plans, ...debate], 3);
      return { kind: node.kind, output: final.output, outputs: debate, trace };
    }
    case 'auto-validate': {
      const validator = node.agents[1] ?? lead;
      const maxRounds = node.maxRounds ?? 2;
      let draft = await invoke('auto-validate-draft', lead);
      for (let round = 1; round <= maxRounds; round += 1) {
        const check = await invoke('auto-validate-check', validator, [draft], round);
        const verdict = parseValidationVerdict(check.output);
        if (verdict.passed) {
          return {
            kind: node.kind,
            output: draft.output,
            outputs: [draft, check],
            trace,
            validation: { passed: true, rounds: round },
          };
        }
        if (round < maxRounds) {
          draft = await invoke('auto-validate-repair', lead, [draft, check], round + 1);
        }
      }
      throw new Error(`Auto-validation failed after ${String(maxRounds)} rounds.`);
    }
    case 'draco-fusion': {
      const opinions = await parallel('draco-opinion');
      const deliberation = await parallel('draco-deliberation', node.agents, opinions, 2);
      const final = await invoke('draco-final', lead, [...opinions, ...deliberation], 3);
      return { kind: node.kind, output: final.output, outputs: deliberation, trace };
    }
  }
}
