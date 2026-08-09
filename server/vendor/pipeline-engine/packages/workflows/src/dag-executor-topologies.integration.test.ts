import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeDagWorkflow } from '@archon/workflows/dag-executor';
import { parseWorkflow } from '@archon/workflows/loader';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from './deps';
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

function runRecord(id: string): WorkflowRun {
  return {
    id,
    workflow_name: id,
    conversation_id: `conversation-${id}`,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'integration test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
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
  ])('executes persisted %s through the public production API', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-topology-public-'));
    temporaryRoots.push(root);
    const artifacts = join(root, 'artifacts');
    const logs = join(root, 'logs');
    await mkdir(artifacts, { recursive: true });
    await mkdir(logs, { recursive: true });
    const phases: string[] = [];
    const sendQuery = mock(function* (prompt: string) {
      const phase = prompt.match(/^Phase: (.+)$/m)?.[1] ?? 'unknown';
      phases.push(phase);
      const content = phase === 'auto-validate-check'
        ? JSON.stringify({ passed: true, findings: [] })
        : `${phase}: completed`;
      yield { type: 'assistant' as const, content };
      yield { type: 'result' as const, sessionId: `session-${phase}` };
    });
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
    const persisted = parseWorkflow(`
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
`, `public-${kind}.yaml`);
    expect(persisted.error).toBeNull();
    if (!persisted.workflow) throw new Error(String(persisted.error?.error));

    await executeDagWorkflow(
      deps,
      platform,
      `conversation-${kind}`,
      root,
      persisted.workflow,
      runRecord(`run-${kind}`),
      'claude',
      undefined,
      artifacts,
      logs,
      'main',
      'docs/',
      config
    );

    expect(phases.length).toBeGreaterThan(0);
    expect(phases.some(phase => phase === 'opinion' || phase.includes(kind.split('-')[0])))
      .toBe(true);
    expect(workflowStore.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });
});
