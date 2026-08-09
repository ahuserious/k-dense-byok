import { describe, expect, mock, test } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

let registeredCwd = '';

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  loadRepoConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.pipeline-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.pipeline-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => {}),
  ConversationNotFoundError: class extends Error {},
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
}));
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));
mock.module('@archon/core/db/conversations', () => ({}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: registeredCwd }]),
}));
mock.module('@archon/core/operations/workflow-operations', () => ({
  resetWorkflowNodeSessions: mock(async () => 0),
}));

import { registerApiRoutes } from './api';
import { parseWorkflow } from '@archon/workflows/loader';
import { buildNodeAdapterConfig } from '../../../workflows/src/dag-executor';

const settings = {
  version: 1 as const,
  model: {
    requested: {
      source: 'fixed' as const,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      auth: { kind: 'oauth' as const, profile: 'research-subscription' },
      reasoning: 'xhigh' as const,
    },
    resolution: {
      mode: 'explicit-fallback' as const,
      alternatives: [
        {
          source: 'fixed' as const,
          provider: 'openrouter',
          model: 'openai/gpt-5',
          auth: { kind: 'api-key' as const },
          reasoning: 'high' as const,
        },
      ],
      reason: 'Use a fixed backup when the primary provider is unavailable.',
    },
  },
  reasoningEffort: 'max' as const,
  hyperparameters: {
    temperature: 0.4,
    top_p: 0.8,
    sampling: { seed: 17, response_format: 'json', deterministic: true },
  },
  conditions: { when: 'inputs.ready == true', exists: ['inputs/dataset.parquet'] },
  harness: 'codex' as const,
  databases: ['database/literature'],
  skills: { mode: 'manual' as const, list: ['literature-review', 'citation-management'] },
  subagents: { mode: 'auto-manual' as const },
  autonomy: 'loose' as const,
  deliberation: {
    personalityStoreRef: 'personalities/science-v1',
    bestOfNPersonalityCount: 4,
    mimeographs: {
      mode: 'manual' as const,
      personalityRefs: ['personality/skeptic', 'personality/synthesist'],
    },
  },
  billingMode: 'subscription' as const,
  budget: { maxTokens: 120_000, maxCostUsd: 24.5 },
};

function settingsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('NodeSpec v1 vendored persistence contract', () => {
  test('validate -> PUT -> GET -> parseWorkflow -> adapter args preserves every settings byte', async () => {
    registeredCwd = join(tmpdir(), `nodespec-persistence-${crypto.randomUUID()}`);
    await mkdir(registeredCwd, { recursive: true });

    try {
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      const openApiResponse = await app.request('/api/openapi.json');
      const openApi = (await openApiResponse.json()) as {
        components: {
          schemas: Record<string, { properties?: Record<string, { $ref?: string }> }>;
        };
      };
      expect(openApi.components.schemas['NodeSpecV1']).toBeDefined();
      expect(openApi.components.schemas['DagNode']?.properties?.['settings']?.$ref).toBe(
        '#/components/schemas/NodeSpecV1'
      );
      const definition = {
        name: 'nodespec-round-trip',
        description: 'Prove canonical NodeSpec persistence.',
        nodes: [{ id: 'research', prompt: 'Analyze the dataset.', settings }],
      };

      const validateResponse = await app.request('/api/workflows/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      expect(validateResponse.status).toBe(200);
      expect(await validateResponse.json()).toEqual({ valid: true });

      const query = `cwd=${encodeURIComponent(registeredCwd)}`;
      const putResponse = await app.request(`/api/workflows/nodespec-round-trip?${query}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      expect(putResponse.status).toBe(200);
      const putBody = (await putResponse.json()) as {
        workflow: { nodes: Array<{ settings?: unknown }> };
      };
      expect(settingsBytes(putBody.workflow.nodes[0]?.settings)).toEqual(settingsBytes(settings));

      const getResponse = await app.request(`/api/workflows/nodespec-round-trip?${query}`);
      expect(getResponse.status).toBe(200);
      const getBody = (await getResponse.json()) as {
        workflow: { nodes: Array<{ settings?: unknown }> };
      };
      expect(settingsBytes(getBody.workflow.nodes[0]?.settings)).toEqual(settingsBytes(settings));

      const reparsed = parseWorkflow(Bun.YAML.stringify(getBody.workflow), 'round-trip.yaml');
      expect(reparsed.error).toBeNull();
      if (!reparsed.workflow) throw new Error('expected parsed workflow');
      const parsedNode = reparsed.workflow.nodes[0];
      expect(settingsBytes(parsedNode?.settings)).toEqual(settingsBytes(settings));

      if (!parsedNode) throw new Error('expected parsed node');
      const adapterArgs = buildNodeAdapterConfig(parsedNode, {});
      expect(settingsBytes(adapterArgs.settings)).toEqual(settingsBytes(settings));
    } finally {
      await rm(registeredCwd, { recursive: true, force: true });
    }
  });
});
