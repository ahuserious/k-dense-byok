import { OpenAPIHono } from '@hono/zod-openapi';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { validationErrorHook } from './openapi-defaults.ts';
import { WebAdapter } from '../adapters/web.ts';
import { MessagePersistence } from '../adapters/web/persistence.ts';
import { SSETransport } from '../adapters/web/transport.ts';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge.ts';
import { ConversationLockManager } from '@archon/core';

const [{ createProject, ensureProjectExists, resolvePaths }, { registerApiRoutes }, { parseWorkflow }] = await Promise.all([
  import('../../../../../../src/projects.ts'),
  import('./api.ts'),
  import('@archon/workflows/loader'),
]);
const project = createProject({
  name: 'Fresh executable project',
  projectId: 'fresh-executable',
  spendLimitUsd: 10,
});
const sandbox = resolvePaths(project.id).sandbox;
const initialCommitAuthor = execFileSync(
  'git',
  ['-C', sandbox, 'log', '-1', '--format=%an <%ae>'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
).trim();
const initialCommitCount = Number(execFileSync(
  'git',
  ['-C', sandbox, 'rev-list', '--count', 'HEAD'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
).trim());
const initialTrackedFiles = execFileSync(
  'git',
  ['-C', sandbox, 'ls-tree', '--name-only', 'HEAD'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
).split(/\r?\n/);
const app = new OpenAPIHono({ defaultHook: validationErrorHook });
const transport = new SSETransport(undefined, 1);
const persistence = new MessagePersistence((conversationId, event) =>
  transport.emit(conversationId, event)
);
const workflowBridge = new WorkflowEventBridge(transport);
const webAdapter = new WebAdapter(transport, persistence, workflowBridge);
await webAdapter.start();
const lockManager = new ConversationLockManager(1);
registerApiRoutes(app, webAdapter, lockManager);

const registration = await app.request('/api/codebases', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: sandbox,
    name: `kady/${project.id}`,
  }),
});
const codebase = await registration.json();
if (registration.status !== 201 || !codebase.id || codebase.default_cwd !== sandbox) {
  throw new Error(`Workspace registration failed: ${registration.status}`);
}

const scope = new URLSearchParams({ cwd: sandbox, codebaseId: codebase.id });
const save = await app.request(`/api/workflows/fresh-workflow?${scope.toString()}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    definition: {
      name: 'fresh-workflow',
      description: 'Fresh Kady workflow',
      nodes: [{ id: 'verify', bash: 'printf durable' }],
    },
  }),
});
if (save.status !== 200) {
  throw new Error(`Scoped workflow save failed: ${save.status} ${await save.text()}`);
}
const list = await app.request(`/api/workflows?${scope.toString()}`);
const listBody = await list.json();
const listed = listBody.workflows?.find(entry => entry.workflow.name === 'fresh-workflow');
if (!listed) {
  throw new Error(`Scoped workflow list failed: ${list.status} ${JSON.stringify(listBody)}`);
}

let releaseCapacity;
const capacityGate = new Promise(resolve => {
  releaseCapacity = resolve;
});
await lockManager.acquireLock('capacity-blocker', async () => capacityGate);

const admissionId = 'fresh-durable-admission';
const admissionKey = `kadypipe_${createHash('sha256')
  .update(`${project.id}\0${admissionId}`)
  .digest('hex')
  .slice(0, 32)}`;
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
const parsedWorkflow = parseWorkflow(
  readFileSync(join(sandbox, '.archon', 'workflows', 'fresh-workflow.yaml'), 'utf8'),
  'fresh-workflow.yaml'
);
if (parsedWorkflow.error) throw new Error(parsedWorkflow.error.error);
const workflowRevisionSha256 = createHash('sha256')
  .update(canonicalJson(parsedWorkflow.workflow))
  .digest('hex');
const launch = await app.request(
  `/api/workflows/${listed.workflowId}/run?${scope.toString()}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: 'fresh-conversation',
      message: 'Run it',
      kadyProjectId: project.id,
      kadyAdmissionId: admissionId,
      kadyEngineAdmissionKey: admissionKey,
      idempotencyKey: admissionKey,
      workflowRevisionSha256,
      metadata: { kadyRunId: 'fresh-kady-run' },
    }),
  }
);
if (launch.status !== 200) {
  throw new Error(`Workflow launch failed: ${launch.status} ${await launch.text()}`);
}
// Treat the accepted response as lost: prove the durable admission is visible
// while the real lock still delays execution.
const pendingLookup = await app.request(
  `/api/workflows/runs?projectId=${encodeURIComponent(project.id)}&admissionId=${encodeURIComponent(admissionId)}`
);
const pendingBody = await pendingLookup.json();
releaseCapacity();

let terminalRun;
let lastLookupBody;
for (let attempt = 0; attempt < 300; attempt += 1) {
  const lookup = await app.request(
    `/api/workflows/runs?projectId=${encodeURIComponent(project.id)}&admissionId=${encodeURIComponent(admissionId)}`
  );
  const body = await lookup.json();
  lastLookupBody = body;
  terminalRun = body.runs?.find(run => ['completed', 'failed', 'cancelled'].includes(run.status));
  if (terminalRun) break;
  await new Promise(resolve => setTimeout(resolve, 50));
}
if (!terminalRun) {
  throw new Error(
    `Durable workflow run did not reach a terminal status: ${JSON.stringify({ lastLookupBody, lockStats: lockManager.getStats() })}`
  );
}

async function exerciseEnsuredProject(projectId, workflowName, preExistingNonGit) {
  const projectPaths = resolvePaths(projectId);
  if (preExistingNonGit) {
    mkdirSync(projectPaths.sandbox, { recursive: true });
    writeFileSync(join(projectPaths.sandbox, 'legacy-input.txt'), 'legacy data\n');
  }
  const ensured = ensureProjectExists(projectId);
  const commitCountAfterUpgrade = Number(execFileSync(
    'git',
    ['-C', ensured.sandbox, 'rev-list', '--count', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim());
  ensureProjectExists(projectId);
  const commitCountAfterRepeat = Number(execFileSync(
    'git',
    ['-C', ensured.sandbox, 'rev-list', '--count', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim());

  const registerResponse = await app.request('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: ensured.sandbox, name: `kady/${projectId}` }),
  });
  const registeredCodebase = await registerResponse.json();
  if (registerResponse.status !== 201 || !registeredCodebase.id) {
    throw new Error(`Ensured workspace registration failed: ${registerResponse.status}`);
  }
  const ensuredScope = new URLSearchParams({
    cwd: ensured.sandbox,
    codebaseId: registeredCodebase.id,
  });
  const saveResponse = await app.request(`/api/workflows/${workflowName}?${ensuredScope}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      definition: {
        name: workflowName,
        description: `Executable workflow for ${projectId}`,
        nodes: [{ id: 'verify', bash: `printf ${projectId}` }],
      },
    }),
  });
  if (saveResponse.status !== 200) {
    throw new Error(`Ensured workflow save failed: ${saveResponse.status}`);
  }
  const listResponse = await app.request(`/api/workflows?${ensuredScope}`);
  const ensuredListBody = await listResponse.json();
  const ensuredWorkflow = ensuredListBody.workflows?.find(
    entry => entry.workflow.name === workflowName
  );
  if (!ensuredWorkflow) throw new Error(`Ensured workflow list failed: ${listResponse.status}`);

  const ensuredAdmissionId = `${projectId}-admission`;
  const ensuredAdmissionKey = `kadypipe_${createHash('sha256')
    .update(`${projectId}\0${ensuredAdmissionId}`)
    .digest('hex')
    .slice(0, 32)}`;
  const ensuredParsed = parseWorkflow(
    readFileSync(join(ensured.sandbox, '.archon', 'workflows', `${workflowName}.yaml`), 'utf8'),
    `${workflowName}.yaml`
  );
  if (ensuredParsed.error) throw new Error(ensuredParsed.error.error);
  const ensuredRevision = createHash('sha256')
    .update(canonicalJson(ensuredParsed.workflow))
    .digest('hex');
  const launchResponse = await app.request(
    `/api/workflows/${ensuredWorkflow.workflowId}/run?${ensuredScope}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: `${projectId}-conversation`,
        message: 'Run it',
        kadyProjectId: projectId,
        kadyAdmissionId: ensuredAdmissionId,
        kadyEngineAdmissionKey: ensuredAdmissionKey,
        idempotencyKey: ensuredAdmissionKey,
        workflowRevisionSha256: ensuredRevision,
        metadata: { kadyRunId: `${projectId}-run` },
      }),
    }
  );
  if (launchResponse.status !== 200) {
    throw new Error(`Ensured workflow launch failed: ${launchResponse.status}`);
  }
  let ensuredTerminalRun;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const lookup = await app.request(
      `/api/workflows/runs?projectId=${encodeURIComponent(projectId)}&admissionId=${encodeURIComponent(ensuredAdmissionId)}`
    );
    const body = await lookup.json();
    ensuredTerminalRun = body.runs?.find(run =>
      ['completed', 'failed', 'cancelled'].includes(run.status)
    );
    if (ensuredTerminalRun) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ensuredTerminalRun) throw new Error(`Ensured workflow did not finish: ${projectId}`);
  return {
    hasGitDirectory: existsSync(join(ensured.sandbox, '.git')),
    commitCountAfterUpgrade,
    commitCountAfterRepeat,
    legacyFileTracked: preExistingNonGit
      ? execFileSync('git', ['-C', ensured.sandbox, 'ls-files', '--error-unmatch', 'legacy-input.txt'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() === 'legacy-input.txt'
      : undefined,
    registrationStatus: registerResponse.status,
    listStatus: listResponse.status,
    launchStatus: launchResponse.status,
    terminalStatus: ensuredTerminalRun.status,
  };
}

const defaultProject = await exerciseEnsuredProject('default', 'default-workflow', false);
const upgradedProject = await exerciseEnsuredProject(
  'legacy-upgrade',
  'legacy-workflow',
  true
);
console.log(`KADY_WORKSPACE_RESULT=${JSON.stringify({
  hasGitDirectory: existsSync(join(sandbox, '.git')),
  initialCommitAuthor,
  initialCommitCount,
  seededContentsCommitted:
    initialTrackedFiles.includes('AGENTS.md') && initialTrackedFiles.includes('pyproject.toml'),
  finalCommitCount: Number(execFileSync(
    'git',
    ['-C', sandbox, 'rev-list', '--count', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()),
  registrationStatus: registration.status,
  saveStatus: save.status,
  listStatus: list.status,
  workflowId: listed.workflowId,
  launchStatus: launch.status,
  pendingAuthoritative: pendingBody.admissionQuery?.authoritative,
  pendingStatus: pendingBody.runs?.[0]?.status,
  terminalStatus: terminalRun.status,
  terminalWorkingPath: terminalRun.workingPath ?? terminalRun.working_path,
  defaultProject,
  upgradedProject,
})}`);

await webAdapter.stop();
const { closeDatabase } = await import('@archon/core/db');
await closeDatabase();
process.exit(0);
