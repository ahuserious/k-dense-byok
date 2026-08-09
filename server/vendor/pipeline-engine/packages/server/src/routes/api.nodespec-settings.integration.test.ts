import { describe, expect, mock, test } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import { registerBuiltinProviders } from '@archon/providers';
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

registerBuiltinProviders();

const settings = {
  version: 1 as const,
  model: {
    requested: {
      source: 'fixed' as const,
      provider: 'claude',
      model: 'claude-sonnet-4',
      auth: { kind: 'oauth' as const },
      reasoning: 'high' as const,
    },
    resolution: { mode: 'exact' as const },
  },
  reasoningEffort: 'max' as const,
  budget: { maxCostUsd: 24.5 },
};

function settingsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function createApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
  return app;
}

function fixedModel(model: string) {
  return {
    source: 'fixed' as const,
    provider: 'claude',
    model,
    auth: { kind: 'oauth' as const },
    reasoning: 'high' as const,
  };
}

async function validateSettings(settingsValue: unknown): Promise<string> {
  const response = await createApp().request('/api/workflows/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      definition: {
        name: 'nodespec-negative',
        description: 'Exercise authoritative vendored validation.',
        nodes: [{ id: 'research', prompt: 'Analyze.', settings: settingsValue }],
      },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { valid: boolean; errors?: string[] };
  expect(body.valid).toBe(false);
  return body.errors?.join('\n') ?? '';
}

describe('NodeSpec v1 vendored persistence contract', () => {
  test('validate -> PUT -> GET -> parseWorkflow -> adapter args preserves every bound settings byte', async () => {
    registeredCwd = join(tmpdir(), `nodespec-persistence-${crypto.randomUUID()}`);
    await mkdir(registeredCwd, { recursive: true });

    try {
      const app = createApp();
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
      expect(adapterArgs.maxBudgetUsd).toBe(24.5);
      expect(adapterArgs.auth).toEqual({ kind: 'oauth' });
    } finally {
      await rm(registeredCwd, { recursive: true, force: true });
    }
  });

  test('validate rejects Kady Current anywhere in explicit fallbacks', async () => {
    const errors = await validateSettings({
      version: 1,
      model: {
        requested: fixedModel('claude-sonnet-4'),
        resolution: {
          mode: 'explicit-fallback',
          alternatives: [
            {
              source: 'kady-current',
              auth: { kind: 'kady-current' },
              reasoning: 'high',
            },
          ],
          reason: 'Try the current Kady selection.',
        },
      },
    });
    expect(errors).toContain('ambiguous-kady-current-fallback');
  });

  test('validate rejects a fallback identical to the requested model identity', async () => {
    const requested = fixedModel('claude-sonnet-4');
    const errors = await validateSettings({
      version: 1,
      model: {
        requested,
        resolution: {
          mode: 'explicit-fallback',
          alternatives: [requested],
          reason: 'Retry the same model.',
        },
      },
    });
    expect(errors).toContain('fallback-repeats-request');
  });

  test('validate rejects duplicate explicit fallback identities', async () => {
    const duplicate = fixedModel('claude-haiku-4');
    const errors = await validateSettings({
      version: 1,
      model: {
        requested: fixedModel('claude-sonnet-4'),
        resolution: {
          mode: 'explicit-fallback',
          alternatives: [duplicate, duplicate],
          reason: 'Try the backup list in order.',
        },
      },
    });
    expect(errors).toContain('duplicate-model-fallback');
  });

  test('save rejects populated fields pending their named enforcement unit', async () => {
    registeredCwd = join(tmpdir(), `nodespec-rejected-save-${crypto.randomUUID()}`);
    await mkdir(registeredCwd, { recursive: true });
    try {
      const response = await createApp().request(
        `/api/workflows/nodespec-rejected?cwd=${encodeURIComponent(registeredCwd)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            definition: {
              name: 'nodespec-rejected',
              description: 'Must fail before persistence.',
              nodes: [
                {
                  id: 'research',
                  prompt: 'Analyze.',
                  settings: { version: 1, hyperparameters: { temperature: 1 } },
                },
              ],
            },
          }),
        }
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Pending unit S4');
    } finally {
      await rm(registeredCwd, { recursive: true, force: true });
    }
  });
});
