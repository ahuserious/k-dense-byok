import Fastify from 'fastify';
import { OpenAPIHono } from '@hono/zod-openapi';
import { ConversationLockManager } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as workflowDb from '@archon/core/db/workflows';
import { closeDatabase } from '@archon/core/db';
import { createProject, resolvePaths } from '../../../../../../src/projects.ts';
import { registerPipelineRoutes } from '../../../../../../src/api/pipelines.ts';
import { withActiveProject } from '../../../../../../src/scope.ts';
import { WebAdapter } from '../adapters/web.ts';
import { MessagePersistence } from '../adapters/web/persistence.ts';
import { SSETransport } from '../adapters/web/transport.ts';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge.ts';
import { validationErrorHook } from './openapi-defaults.ts';
import { registerApiRoutes } from './api.ts';

const engine = new OpenAPIHono({ defaultHook: validationErrorHook });
const transport = new SSETransport(undefined, 1);
const persistence = new MessagePersistence((conversationId, event) =>
  transport.emit(conversationId, event)
);
const bridge = new WorkflowEventBridge(transport);
const adapter = new WebAdapter(transport, persistence, bridge);
await adapter.start();
registerApiRoutes(engine, adapter, new ConversationLockManager(2));

async function engineJson(path, init) {
  const response = await engine.request(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`Engine ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const projects = [
  createProject({ name: 'Lifecycle A', projectId: 'lifecycle-a', spendLimitUsd: 10 }),
  createProject({ name: 'Lifecycle B', projectId: 'lifecycle-b', spendLimitUsd: 10 }),
];
const scopes = new Map();
for (const project of projects) {
  const sandbox = resolvePaths(project.id).sandbox;
  const registration = await engineJson('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sandbox, name: `kady/${project.id}` }),
  });
  scopes.set(project.id, { cwd: sandbox, codebaseId: registration.id });
}

const conversationA = await conversationDb.getOrCreateConversation(
  'web',
  'lifecycle-conversation-a'
);
const conversationB = await conversationDb.getOrCreateConversation(
  'web',
  'lifecycle-conversation-b'
);
const scopeA = scopes.get('lifecycle-a');
const scopeB = scopes.get('lifecycle-b');
const runA = await workflowDb.createWorkflowRun({
  workflow_name: 'same-name',
  conversation_id: conversationA.id,
  codebase_id: scopeA.codebaseId,
  user_message: 'A',
  working_path: scopeA.cwd,
});
const runB = await workflowDb.createWorkflowRun({
  workflow_name: 'same-name',
  conversation_id: conversationB.id,
  codebase_id: scopeB.codebaseId,
  user_message: 'B',
  working_path: scopeB.cwd,
});

const kady = Fastify();
kady.addHook('onRequest', (request, _reply, done) => {
  const projectId = request.headers['x-project-id'];
  withActiveProject(typeof projectId === 'string' ? projectId : 'lifecycle-a', () => done());
});
await registerPipelineRoutes(kady, {
  reconciliationWorker: false,
  resolveWorkflowScope: async projectId => scopes.get(projectId),
  listRuns: async codebaseId =>
    engineJson(`/api/dashboard/runs?${new URLSearchParams({ codebaseId })}`),
  getRun: async runId => engineJson(`/api/workflows/runs/${encodeURIComponent(runId)}`),
  resumeRun: async runId =>
    engineJson(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }),
  cancelRun: async runId =>
    engineJson(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
});

const projectHeaders = projectId => ({ 'x-project-id': projectId });
const listA = await kady.inject({
  method: 'GET',
  url: '/pipelines/runs',
  headers: projectHeaders('lifecycle-a'),
});
const getCross = await kady.inject({
  method: 'GET',
  url: `/pipelines/runs/${runB.id}`,
  headers: projectHeaders('lifecycle-a'),
});
const streamCross = await kady.inject({
  method: 'GET',
  url: `/pipelines/runs/${runB.id}/stream`,
  headers: projectHeaders('lifecycle-a'),
});
const resumeCross = await kady.inject({
  method: 'POST',
  url: `/pipelines/runs/${runB.id}/resume`,
  headers: projectHeaders('lifecycle-a'),
  payload: {},
});
const cancelCross = await kady.inject({
  method: 'POST',
  url: `/pipelines/runs/${runB.id}/cancel`,
  headers: projectHeaders('lifecycle-a'),
});
const runBAfter = await workflowDb.getWorkflowRun(runB.id);

console.log(`KADY_LIFECYCLE_RESULT=${JSON.stringify({
  listStatus: listA.statusCode,
  listedIds: listA.json().runs.map(run => run.id),
  ownRunId: runA.id,
  hiddenRunId: runB.id,
  getCrossStatus: getCross.statusCode,
  streamCrossStatus: streamCross.statusCode,
  resumeCrossStatus: resumeCross.statusCode,
  cancelCrossStatus: cancelCross.statusCode,
  hiddenRunStatusAfterActions: runBAfter?.status,
})}`);

await kady.close();
await adapter.stop();
await closeDatabase();
process.exit(0);
