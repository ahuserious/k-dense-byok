import { OpenAPIHono } from '@hono/zod-openapi';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { validationErrorHook } from './openapi-defaults.ts';

const [{ createProject, resolvePaths }, { registerApiRoutes }] = await Promise.all([
  import('../../../../../../src/projects.ts'),
  import('./api.ts'),
]);
const project = createProject({
  name: 'Fresh non-git project',
  projectId: 'fresh-non-git',
  spendLimitUsd: 10,
});
const sandbox = resolvePaths(project.id).sandbox;
const workflowDir = join(sandbox, '.archon', 'workflows');
mkdirSync(workflowDir, { recursive: true });
writeFileSync(
  join(workflowDir, 'fresh.yaml'),
  `name: fresh-workflow\ndescription: Fresh Kady workflow\nnodes:\n  - id: collect\n    prompt: Collect evidence.\n`,
  'utf8'
);

const app = new OpenAPIHono({ defaultHook: validationErrorHook });
const webAdapter = {
  setConversationDbId: () => undefined,
  emitSSE: async () => undefined,
  emitLockEvent: async () => undefined,
};
const lockManager = {
  acquireLock: async () => ({ status: 'started' }),
  getStats: () => ({ active: 0, queued: 0 }),
};
registerApiRoutes(app, webAdapter, lockManager);

const registration = await app.request('/api/codebases', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: sandbox,
    registrationMode: 'workspace',
    name: `kady/${project.id}`,
  }),
});
const codebase = await registration.json();
if (registration.status !== 201 || !codebase.id || codebase.default_cwd !== sandbox) {
  throw new Error(`Workspace registration failed: ${registration.status}`);
}

const scope = new URLSearchParams({ cwd: sandbox, codebaseId: codebase.id });
const list = await app.request(`/api/workflows?${scope.toString()}`);
const listBody = await list.json();
const listed = listBody.workflows?.find(entry => entry.workflow.name === 'fresh-workflow');
if (!listed) throw new Error(`Scoped workflow list failed: ${list.status}`);

const launch = await app.request(
  `/api/workflows/${listed.workflowId}/run?${scope.toString()}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: 'fresh-conversation', message: 'Run it' }),
  }
);
const launchBody = await launch.json();
console.log(`KADY_WORKSPACE_RESULT=${JSON.stringify({
  hasGitDirectory: existsSync(join(sandbox, '.git')),
  registrationStatus: registration.status,
  listStatus: list.status,
  workflowId: listed.workflowId,
  launchStatus: launch.status,
  launchBody,
})}`);

const { closeDatabase } = await import('@archon/core/db');
await closeDatabase();
