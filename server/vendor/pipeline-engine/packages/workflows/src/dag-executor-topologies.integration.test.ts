import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeDagWorkflow } from '@archon/workflows/dag-executor';
import { parseWorkflow } from '@archon/workflows/loader';
import type {
  IAgentProvider,
  IWorkflowPlatform,
  SendQueryOptions,
  WorkflowConfig,
  WorkflowDeps,
} from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';

clearRegistry();
registerBuiltinProviders();

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function store(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() => Promise.reject(new Error('unused'))),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.reject(new Error('unused'))),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
    getWorkflowNodeSession: mock(() => Promise.resolve(null)),
    upsertWorkflowNodeSession: mock(() => Promise.resolve()),
    deleteWorkflowNodeSessions: mock(() => Promise.resolve({ deleted: 0 })),
  };
}

const capabilities = {
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced' as const,
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
};

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

const platform: IWorkflowPlatform = {
  sendMessage: mock(() => Promise.resolve()),
  getStreamingMode: mock(() => 'batch' as const),
  getPlatformType: mock(() => 'test'),
  sendStructuredEvent: mock(() => Promise.resolve()),
};

function runRecord(id: string, metadata: Record<string, unknown> = {}): WorkflowRun {
  return {
    id,
    workflow_name: id,
    conversation_id: `conversation-${id}`,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'integration test',
    metadata,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
}

async function executePersistedFixture(
  name: string,
  source: string,
  sendQuery: IAgentProvider['sendQuery'],
  runMetadata: Record<string, unknown> = {}
): Promise<IWorkflowStore> {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-topology-public-'));
  temporaryRoots.push(root);
  const artifacts = join(root, 'artifacts');
  const logs = join(root, 'logs');
  await mkdir(artifacts, { recursive: true });
  await mkdir(logs, { recursive: true });
  const workflowStore = store();
  const deps: WorkflowDeps = {
    store: workflowStore,
    getAgentProvider: () => ({
      sendQuery,
      getType: () => 'claude',
      getCapabilities: () => capabilities,
    }),
    loadConfig: async () => config,
  };
  const persisted = parseWorkflow(source, `${name}.yaml`);
  expect(persisted.error).toBeNull();
  if (!persisted.workflow) throw new Error(String(persisted.error?.error));

  await executeDagWorkflow(
    deps,
    platform,
    `conversation-${name}`,
    root,
    persisted.workflow,
    runRecord(`run-${name}`, runMetadata),
    'claude',
    undefined,
    artifacts,
    logs,
    'main',
    'docs/',
    config
  );
  return workflowStore;
}

describe('persisted fusion topology reachability', () => {
  it.each([
    'opinion',
    'parallel',
    'coordinate',
    'ultraplan',
    'plan-debate',
    'auto-validate',
    'draco-fusion',
    'council',
    'fusion',
    'best-of-n',
  ])('executes and watermarks persisted %s through the public production API', async kind => {
    const phases: string[] = [];
    const sendQuery = mock(async function* (prompt: string) {
      const phase = prompt.match(/^Phase: (.+)$/m)?.[1] ?? 'unknown';
      phases.push(phase);
      const content = phase === 'auto-validate-check'
        ? JSON.stringify({ passed: true, findings: [] })
        : `${phase}: completed`;
      yield { type: 'assistant' as const, content };
      yield {
        type: 'result' as const,
        sessionId: `session-${phase}`,
        cost: 0.01,
        tokens: { input: 10, output: 5 },
        ...(phase === 'auto-validate-check'
          ? { structuredOutput: { passed: true, findings: [] } }
          : {}),
      };
    });
    const workflowStore = await executePersistedFixture(`public-${kind}`, `
name: public-${kind}
description: Persisted topology integration fixture
provider: claude
nodes:
  - id: deliberate
    kind: ${kind}
    task: Evaluate the evidence.
    max_rounds: 2
    topology_agents:
      - id: alpha
        role: Lead scientist
      - id: beta
        role: Evidence auditor
`, sendQuery, {
      kadyProjectId: `project-${kind}`,
      kadyEngineAdmissionKey: `admission-${kind}`,
      kadyAdmittedModelNodeIds: ['deliberate'],
    });

    expect(phases.length).toBeGreaterThan(0);
    expect(phases.some(phase => phase === 'opinion' || phase.includes(kind.split('-')[0])))
      .toBe(true);
    expect(workflowStore.completeWorkflowRun).toHaveBeenCalledTimes(1);
    const completionMetadata = workflowStore.completeWorkflowRun.mock.calls[0]?.[1] as {
      kady_completion_watermark?: {
        nodeIds?: string[];
        usageByNode?: Record<string, { costUsd: number; tokensIn: number; tokensOut: number }>;
      };
    };
    const actualUsage = completionMetadata.kady_completion_watermark?.usageByNode?.deliberate;
    expect(actualUsage?.costUsd).toBeGreaterThan(0);
    expect(actualUsage?.tokensIn).toBeGreaterThan(0);
    expect(actualUsage?.tokensOut).toBeGreaterThan(0);
    expect(completionMetadata.kady_completion_watermark).toMatchObject({
      nodeIds: ['deliberate'],
      usageByNode: {
        deliberate: {
          costUsd: expect.any(Number),
          tokensIn: expect.any(Number),
          tokensOut: expect.any(Number),
        },
      },
    });
  });

  it('shares one aggregate cap across every successful plan-debate invocation', async () => {
    const allowances: number[] = [];
    const costs: number[] = [];
    const sendQuery = mock(async function* (
      prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: SendQueryOptions
    ) {
      const allowanceUsd = options?.maxBudgetUsd;
      if (allowanceUsd === undefined) throw new Error('missing remaining topology allowance');
      allowances.push(allowanceUsd);
      const cost = allowanceUsd / 2;
      costs.push(cost);
      const phase = prompt.match(/^Phase: (.+)$/m)?.[1] ?? 'unknown';
      yield { type: 'assistant' as const, content: `${phase}: completed` };
      yield { type: 'result' as const, sessionId: `session-${String(costs.length)}`, cost };
    });
    const workflowStore = await executePersistedFixture('aggregate-budget', `
name: aggregate-budget
description: Aggregate topology budget fixture
provider: claude
nodes:
  - id: deliberate
    kind: plan-debate
    task: Evaluate the evidence.
    maxBudgetUsd: 1
    topology_agents:
      - id: alpha
        role: Lead scientist
      - id: beta
        role: Evidence auditor
      - id: gamma
        role: Adversarial reviewer
`, sendQuery);

    expect(allowances).toHaveLength(7);
    for (const allowance of allowances.slice(0, 3)) expect(allowance).toBeCloseTo(1 / 3);
    for (const allowance of allowances.slice(3, 6)) expect(allowance).toBeCloseTo(1 / 6);
    expect(allowances[6]).toBeCloseTo(1 / 4);
    expect(costs.reduce((total, cost) => total + cost, 0)).toBeCloseTo(0.875);
    expect(costs.reduce((total, cost) => total + cost, 0)).toBeLessThanOrEqual(1);
    const completionCall = (workflowStore.completeWorkflowRun as ReturnType<typeof mock>)
      .mock.calls[0];
    const metadata = completionCall[1] as Record<string, unknown>;
    expect(metadata.total_cost_usd).toBeCloseTo(0.875);
  });

  it('keeps the authored output schema off internal drafts and validates the assembled result', async () => {
    const calls: Array<{ phase: string; options?: SendQueryOptions }> = [];
    const sendQuery = mock(async function* (
      prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: SendQueryOptions
    ) {
      const phase = prompt.match(/^Phase: (.+)$/m)?.[1] ?? 'unknown';
      calls.push({ phase, options });
      if (phase === 'auto-validate-check') {
        const verdict = { passed: true, findings: [] };
        yield { type: 'assistant' as const, content: JSON.stringify(verdict) };
        yield {
          type: 'result' as const,
          sessionId: 'session-check',
          structuredOutput: verdict,
        };
        return;
      }
      yield { type: 'assistant' as const, content: JSON.stringify({ answer: 'supported' }) };
      yield { type: 'result' as const, sessionId: 'session-draft' };
    });
    const workflowStore = await executePersistedFixture('authored-output', `
name: authored-output
description: Final-only output schema fixture
provider: claude
nodes:
  - id: validate
    kind: auto-validate
    task: Evaluate the evidence.
    max_rounds: 1
    output_format:
      type: object
      additionalProperties: false
      required: [answer]
      properties:
        answer:
          type: string
    topology_agents:
      - id: alpha
        role: Lead scientist
      - id: beta
        role: Validator
`, sendQuery);

    const draft = calls.find(call => call.phase === 'auto-validate-draft');
    const check = calls.find(call => call.phase === 'auto-validate-check');
    expect(draft?.options?.outputFormat).toBeUndefined();
    expect(draft?.options?.nodeConfig?.output_format).toBeUndefined();
    expect(check?.options?.outputFormat?.schema).toEqual(expect.objectContaining({
      required: ['passed', 'findings'],
    }));
    expect(workflowStore.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('fails when the assembled topology output violates the authored schema', async () => {
    let internalOptions: SendQueryOptions | undefined;
    const sendQuery = mock(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: SendQueryOptions
    ) {
      internalOptions = options;
      yield { type: 'assistant' as const, content: JSON.stringify({ wrong: true }) };
      yield { type: 'result' as const, sessionId: 'session-invalid' };
    });
    const workflowStore = await executePersistedFixture('invalid-assembled-output', `
name: invalid-assembled-output
description: Invalid assembled output fixture
provider: claude
nodes:
  - id: opinion
    kind: opinion
    task: Evaluate the evidence.
    output_format:
      type: object
      additionalProperties: false
      required: [answer]
      properties:
        answer:
          type: string
    topology_agents:
      - id: alpha
        role: Lead scientist
`, sendQuery);

    expect(internalOptions?.outputFormat).toBeUndefined();
    expect(internalOptions?.nodeConfig?.output_format).toBeUndefined();
    expect(workflowStore.completeWorkflowRun).not.toHaveBeenCalled();
    expect(workflowStore.failWorkflowRun).toHaveBeenCalledTimes(1);
  });
});
