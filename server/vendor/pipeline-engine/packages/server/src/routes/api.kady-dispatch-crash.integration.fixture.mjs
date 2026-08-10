import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationLockManager } from '@archon/core';
import { closeDatabase } from '@archon/core/db';
import { parseWorkflow } from '@archon/workflows/loader';
import { WebAdapter } from '../adapters/web.ts';
import { MessagePersistence } from '../adapters/web/persistence.ts';
import { SSETransport } from '../adapters/web/transport.ts';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge.ts';
import { validationErrorHook } from './openapi-defaults.ts';
import { registerApiRoutes } from './api.ts';
import { ensureProjectExists } from '../../../../../../src/projects.ts';

const mode = process.env.KADY_CRASH_FIXTURE_MODE;
const projectId = 'dispatch-crash-project';
const admissionId = 'dispatch-crash-admission';
const conversationId = 'dispatch-crash-conversation';
const workflowName = 'dispatch-crash-workflow';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createRealApp(faultInjection) {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const transport = new SSETransport(undefined, 1);
  const persistence = new MessagePersistence((id, event) => transport.emit(id, event));
  const bridge = new WorkflowEventBridge(transport);
  const adapter = new WebAdapter(transport, persistence, bridge);
  const lockManager = new ConversationLockManager(1);
  registerApiRoutes(app, adapter, lockManager, undefined, faultInjection);
  return { app, adapter, lockManager };
}

if (mode === 'seed') {
  const paths = ensureProjectExists(projectId);
  let crashState;
  const crashStatePath = join(process.env.ARCHON_HOME, 'crash-state.json');
  const { app, adapter } = createRealApp({
    afterKadyAdmissionPersisted(run) {
      writeFileSync(
        crashStatePath,
        JSON.stringify({
          ...crashState,
          runId: run.id,
          pendingStatus: run.status,
          dispatchState: run.metadata.kadyDispatchState,
        })
      );
      process.exit(86);
    },
  });
  await adapter.start();
  const registration = await app.request('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: paths.sandbox, name: `kady/${projectId}` }),
  });
  const codebase = await registration.json();
  if (registration.status !== 201 || !codebase.id) {
    throw new Error(`Crash fixture registration failed: ${registration.status}`);
  }
  const scope = new URLSearchParams({ cwd: paths.sandbox, codebaseId: codebase.id });
  const save = await app.request(`/api/workflows/${workflowName}?${scope}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      definition: {
        name: workflowName,
        description: 'Crash replay workflow',
        nodes: [{ id: 'verify', bash: 'printf replayed' }],
      },
    }),
  });
  if (save.status !== 200) throw new Error(`Crash fixture save failed: ${save.status}`);
  const list = await app.request(`/api/workflows?${scope}`);
  const listBody = await list.json();
  const listed = listBody.workflows?.find(entry => entry.workflow.name === workflowName);
  if (!listed) throw new Error(`Crash fixture list failed: ${list.status}`);
  const parsed = parseWorkflow(
    readFileSync(join(paths.sandbox, '.archon', 'workflows', `${workflowName}.yaml`), 'utf8'),
    `${workflowName}.yaml`
  );
  if (parsed.error) throw new Error(parsed.error.error);
  const revision = createHash('sha256').update(canonicalJson(parsed.workflow)).digest('hex');
  const admissionKey = `kadypipe_${createHash('sha256')
    .update(`${projectId}\0${admissionId}`)
    .digest('hex')
    .slice(0, 32)}`;
  crashState = {
    projectId,
    admissionId,
    admissionKey,
    conversationId,
    workflowId: listed.workflowId,
    revision,
    codebaseId: codebase.id,
    sandbox: paths.sandbox,
  };
  await app.request(`/api/workflows/${listed.workflowId}/run?${scope}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      message: 'Run after crash',
      kadyProjectId: projectId,
      kadyAdmissionId: admissionId,
      kadyEngineAdmissionKey: admissionKey,
      idempotencyKey: admissionKey,
      workflowRevisionSha256: revision,
      metadata: {},
    }),
  });
  throw new Error('Crash boundary did not terminate the seed process');
}

if (mode === 'replay') {
  const state = JSON.parse(process.env.KADY_CRASH_STATE ?? '{}');
  ensureProjectExists(state.projectId);
  const { app, adapter, lockManager } = createRealApp();
  await adapter.start();
  const scope = new URLSearchParams({ cwd: state.sandbox, codebaseId: state.codebaseId });
  const replay = await app.request(`/api/workflows/${state.workflowId}/run?${scope}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: state.conversationId,
      message: 'Run after crash',
      kadyProjectId: state.projectId,
      kadyAdmissionId: state.admissionId,
      kadyEngineAdmissionKey: state.admissionKey,
      idempotencyKey: state.admissionKey,
      workflowRevisionSha256: state.revision,
      metadata: {},
    }),
  });
  if (replay.status !== 200) {
    throw new Error(`Crash replay failed: ${replay.status} ${await replay.text()}`);
  }
  let terminalRun;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const lookup = await app.request(
      `/api/workflows/runs?projectId=${encodeURIComponent(state.projectId)}&admissionId=${encodeURIComponent(state.admissionId)}`
    );
    const body = await lookup.json();
    terminalRun = body.runs?.find(run => ['completed', 'failed', 'cancelled'].includes(run.status));
    if (terminalRun) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!terminalRun) {
    throw new Error(`Crash replay did not finish: ${JSON.stringify(lockManager.getStats())}`);
  }
  console.log(`KADY_CRASH_REPLAY=${JSON.stringify({
    replayStatus: replay.status,
    runId: terminalRun.id,
    terminalStatus: terminalRun.status,
    dispatchState: terminalRun.metadata?.kadyDispatchState,
  })}`);
  await adapter.stop();
  await closeDatabase();
  process.exit(0);
}

throw new Error(`Unknown KADY_CRASH_FIXTURE_MODE: ${String(mode)}`);
