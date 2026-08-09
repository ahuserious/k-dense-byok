import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const logger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  trace: mock(() => {}),
  fatal: mock(() => {}),
  child: mock(() => logger),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => logger),
  captureWorkflowCompleted: mock(() => {}),
  getCommandFolderSearchPaths: () => ['.archon/commands'],
  getWorkflowFolderSearchPaths: () => ['.archon/workflows'],
  getDefaultCommandsPath: () => '/nonexistent/defaults',
  getDefaultWorkflowsPath: () => '/nonexistent/defaults/workflows',
  getHomeWorkflowsPath: () => '/nonexistent/home/workflows',
  getLegacyHomeWorkflowsPath: () => '/nonexistent/home/.archon/workflows',
  getArchonHome: () => '/nonexistent/home',
}));

import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import type { SendQueryOptions } from '@archon/providers/types';
import { executeDagWorkflow } from './dag-executor';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

function createStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(async () => createWorkflowRun()),
    getWorkflowRun: mock(async () => null),
    getActiveWorkflowRunByPath: mock(async () => null),
    findResumableRun: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    resumeWorkflowRun: mock(async () => createWorkflowRun()),
    updateWorkflowRun: mock(async () => {}),
    updateWorkflowActivity: mock(async () => {}),
    getWorkflowRunStatus: mock(async () => 'running' as const),
    completeWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    pauseWorkflowRun: mock(async () => {}),
    cancelWorkflowRun: mock(async () => ({ cancelled: true })),
    createWorkflowEvent: mock(async () => {}),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    getCodebaseEnvVars: mock(async () => ({})),
    getCodebase: mock(async () => null),
    getWorkflowNodeSession: mock(async () => null),
    upsertWorkflowNodeSession: mock(async () => {}),
    deleteWorkflowNodeSessions: mock(async () => ({ deleted: 0 })),
  };
}

function createWorkflowRun(): WorkflowRun {
  return {
    id: 'nodespec-run',
    workflow_name: 'nodespec-execution',
    conversation_id: 'conversation-id',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'Run the node.',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
}

function createPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(async () => {}),
  };
}

const config: WorkflowConfig = {
  assistant: 'codex',
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  assistants: { claude: {}, codex: {} },
  envVars: {
    CLAUDE_API_KEY: 'api-key-must-be-scrubbed',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-must-remain',
  },
};

describe('vendored NodeSpec execution bindings', () => {
  let runDir: string;

  beforeEach(async () => {
    clearRegistry();
    registerBuiltinProviders();
    runDir = join(tmpdir(), `nodespec-execution-${crypto.randomUUID()}`);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await mkdir(join(runDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  test('settings selects provider, model, OAuth channel, reasoning, and USD ceiling over legacy fields', async () => {
    let capturedOptions: SendQueryOptions | undefined;
    const sendQuery = mock(async function* (
      _prompt: string,
      _cwd: string,
      _resumeSessionId?: string,
      options?: SendQueryOptions
    ) {
      capturedOptions = options;
      yield { type: 'assistant' as const, content: 'Bound response.' };
      yield { type: 'result' as const, sessionId: 'bound-session' };
    });
    const getAgentProvider = mock((provider: string) => ({
      sendQuery,
      getType: () => provider,
      getCapabilities: () => ({
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
        nativeTools: true,
      }),
    }));
    const deps: WorkflowDeps = {
      store: createStore(),
      getAgentProvider,
      loadConfig: mock(async () => config),
    };

    await executeDagWorkflow(
      deps,
      createPlatform(),
      'conversation-id',
      runDir,
      {
        name: 'nodespec-execution',
        nodes: [
          {
            id: 'research',
            prompt: 'Analyze.',
            provider: 'codex',
            model: 'legacy-model',
            maxBudgetUsd: 3,
            settings: {
              version: 1,
              model: {
                requested: {
                  source: 'fixed',
                  provider: 'claude',
                  model: 'claude-sonnet-4',
                  auth: { kind: 'oauth' },
                  reasoning: 'high',
                },
                resolution: {
                  mode: 'explicit-fallback',
                  alternatives: [
                    {
                      source: 'fixed',
                      provider: 'claude',
                      model: 'claude-haiku-4',
                      auth: { kind: 'oauth' },
                      reasoning: 'high',
                    },
                  ],
                  reason: 'Use one fallback representable by the existing adapter slot.',
                },
              },
              reasoningEffort: 'max',
              budget: { maxCostUsd: 1.25 },
            },
          },
        ],
      },
      createWorkflowRun(),
      'codex',
      'legacy-workflow-model',
      join(runDir, 'artifacts'),
      join(runDir, 'logs'),
      'main',
      'docs/',
      config
    );

    expect(getAgentProvider.mock.calls[0]?.[0]).toBe('claude');
    expect(capturedOptions?.model).toBe('claude-sonnet-4');
    expect(capturedOptions?.fallbackModel).toBe('claude-haiku-4');
    expect(capturedOptions?.maxBudgetUsd).toBe(1.25);
    expect(capturedOptions?.env?.CLAUDE_API_KEY).toBe('');
    expect(capturedOptions?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-must-remain');
    expect(capturedOptions?.nodeConfig?.auth).toEqual({ kind: 'oauth' });
    expect(capturedOptions?.nodeConfig?.effort).toBe('max');
  });

  test('a zero NodeSpec USD ceiling stops before provider construction or spend', async () => {
    const getAgentProvider = mock(() => {
      throw new Error('provider must not be constructed');
    });
    const deps: WorkflowDeps = {
      store: createStore(),
      getAgentProvider,
      loadConfig: mock(async () => config),
    };

    await executeDagWorkflow(
      deps,
      createPlatform(),
      'conversation-id',
      runDir,
      {
        name: 'zero-budget',
        nodes: [
          {
            id: 'blocked',
            prompt: 'Must not run.',
            settings: { version: 1, budget: { maxCostUsd: 0 } },
          },
        ],
      },
      createWorkflowRun(),
      'claude',
      undefined,
      join(runDir, 'artifacts'),
      join(runDir, 'logs'),
      'main',
      'docs/',
      config
    );

    expect(getAgentProvider).not.toHaveBeenCalled();
    expect(deps.store.failWorkflowRun).toHaveBeenCalled();
  });

  test('programmatic run rejects unbound settings before provider resolution', async () => {
    const getAgentProvider = mock(() => {
      throw new Error('provider must not be resolved');
    });
    const deps: WorkflowDeps = {
      store: createStore(),
      getAgentProvider,
      loadConfig: mock(async () => config),
    };

    await expect(
      executeDagWorkflow(
        deps,
        createPlatform(),
        'conversation-id',
        runDir,
        {
          name: 'invalid-run',
          nodes: [
            {
              id: 'invalid',
              prompt: 'Must not run.',
              settings: { version: 1, hyperparameters: { temperature: 1 } },
            },
          ],
        },
        createWorkflowRun(),
        'claude',
        undefined,
        join(runDir, 'artifacts'),
        join(runDir, 'logs'),
        'main',
        'docs/',
        config
      )
    ).rejects.toThrow(/vendored-temperature-unbound.*Pending unit S4/);
    expect(getAgentProvider).not.toHaveBeenCalled();
  });
});
