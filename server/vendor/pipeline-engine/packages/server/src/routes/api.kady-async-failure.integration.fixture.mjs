import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationLockManager } from '@archon/core';
import { closeDatabase } from '@archon/core/db';
import { parseWorkflow } from '@archon/workflows/loader';
import {
  findPipelineAdmission,
  listWorkflowBudgetReservations,
  persistPipelineAdmission,
  reservePipelineNodeBudgets,
  workflowBudgetSummary,
} from '../../../../../../src/workflows/budget.ts';
import { reconcilePipelineTerminalSnapshot } from '../../../../../../src/api/pipelines.ts';
import {
  createProject,
  createProjectRunSnapshot,
  resolvePaths,
} from '../../../../../../src/projects.ts';
import { WebAdapter } from '../adapters/web.ts';
import { MessagePersistence } from '../adapters/web/persistence.ts';
import { SSETransport } from '../adapters/web/transport.ts';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge.ts';
import { validationErrorHook } from './openapi-defaults.ts';
import { registerApiRoutes } from './api.ts';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const app = new OpenAPIHono({ defaultHook: validationErrorHook });
const transport = new SSETransport(undefined, 1);
const persistence = new MessagePersistence((conversationId, event) =>
  transport.emit(conversationId, event)
);
const bridge = new WorkflowEventBridge(transport);
const adapter = new WebAdapter(transport, persistence, bridge);
await adapter.start();
const lockManager = new ConversationLockManager(2);
registerApiRoutes(app, adapter, lockManager, undefined, {
  beforeKadyWorkerIsolation(run) {
    if (run.metadata.kadyFailureFixture === 'isolation') {
      throw new Error('Injected worker isolation failure');
    }
  },
  beforeKadyRunRebind(run) {
    if (run.metadata.kadyFailureFixture === 'rebind') {
      throw new Error('Injected pre-created row rebind failure');
    }
  },
  beforeKadyProviderAccess(run) {
    if (run.metadata.kadyFailureFixture === 'execute') {
      throw new Error('Injected executeWorkflow setup failure after rebind');
    }
  },
});

async function jsonRequest(path, init) {
  const response = await app.request(path, init);
  const body = await response.json();
  return { response, body };
}

async function runFailure(stage) {
  const projectId = `async-failure-${stage}`;
  createProject({ name: `Async failure ${stage}`, projectId, spendLimitUsd: 5 });
  const sandbox = resolvePaths(projectId).sandbox;
  const { response: registration, body: codebase } = await jsonRequest('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sandbox, name: `kady/${projectId}` }),
  });
  if (registration.status !== 201) throw new Error(`Registration failed: ${registration.status}`);
  const scope = new URLSearchParams({ cwd: sandbox, codebaseId: codebase.id });
  const workflowName = `failure-${stage}`;
  const save = await app.request(`/api/workflows/${workflowName}?${scope}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      definition: {
        name: workflowName,
        description: `Fault at ${stage}`,
        nodes: [{ id: 'admitted', command: 'test-command' }],
      },
    }),
  });
  if (!save.ok) throw new Error(`Workflow save failed: ${save.status}`);
  const list = await jsonRequest(`/api/workflows?${scope}`);
  const workflow = list.body.workflows.find(entry => entry.workflow.name === workflowName);
  const parsed = parseWorkflow(
    readFileSync(join(sandbox, '.archon', 'workflows', `${workflowName}.yaml`), 'utf8'),
    `${workflowName}.yaml`
  );
  if (parsed.error) throw new Error(parsed.error.error);
  const revision = createHash('sha256').update(canonicalJson(parsed.workflow)).digest('hex');
  const requestDigest = createHash('sha256').update(`request:${stage}`).digest('hex');
  const admission = await reservePipelineNodeBudgets({
    projectId,
    admissionId: `async-failure-${stage}`,
    workflowNodeCount: 1,
    hooks: [{
      nodeId: 'admitted',
      maxTokens: 100,
      maxCostUsd: 1,
      declaredBillingMode: 'api',
      billing: { provider: 'openrouter', authType: 'api_key', billingMode: 'payg' },
    }],
    durableIntent: {
      workflowName,
      requestSha256: requestDigest,
      workflowRevisionSha256: revision,
    },
  });
  const admissionRecord = persistPipelineAdmission(
    admission,
    workflowName,
    requestDigest,
    revision
  );
  const snapshotSha = createProjectRunSnapshot(projectId, admissionRecord.engineAdmissionKey);
  const launch = await app.request(`/api/workflows/${workflow.workflowId}/run?${scope}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: `async-failure-${stage}-conversation`,
      message: `Fail at ${stage}`,
      kadyProjectId: projectId,
      kadyAdmissionId: admission.admissionId,
      kadyEngineAdmissionKey: admissionRecord.engineAdmissionKey,
      idempotencyKey: admissionRecord.engineAdmissionKey,
      workflowRevisionSha256: revision,
      kadyRunSnapshotSha: snapshotSha,
      metadata: {
        kadyFailureFixture: stage,
        kadyRunSnapshotSha: snapshotSha,
      },
    }),
  });
  if (!launch.ok) throw new Error(`Launch failed: ${launch.status} ${await launch.text()}`);

  let terminalRun;
  let lastLookupBody;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const lookup = await jsonRequest(
      `/api/workflows/runs?projectId=${encodeURIComponent(projectId)}&admissionId=${encodeURIComponent(admission.admissionId)}`
    );
    lastLookupBody = lookup.body;
    terminalRun = lookup.body.runs?.find(run => run.status === 'failed');
    if (terminalRun) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!terminalRun) {
    throw new Error(`Faulted run did not terminalize: ${stage} ${JSON.stringify(lastLookupBody)}`);
  }
  const detail = await jsonRequest(`/api/workflows/runs/${terminalRun.id}`);
  const reconciliation = await reconcilePipelineTerminalSnapshot(
    projectId,
    terminalRun.id,
    detail.body,
    'full-charge'
  );
  return {
    launchStatus: launch.status,
    terminalStatus: terminalRun.status,
    dispatchState: terminalRun.metadata?.kadyDispatchState,
    failureStage: terminalRun.metadata?.kadyDispatchFailureStage,
    hasWatermark: terminalRun.metadata?.kady_completion_watermark !== undefined,
    watermarkCost: Object.values(
      terminalRun.metadata?.kady_completion_watermark?.usageByNode ?? {}
    ).reduce((sum, usage) => sum + usage.costUsd, 0),
    reconciliationEvidence: reconciliation.evidence,
    admissionStatus: findPipelineAdmission(projectId, admission.admissionId)?.record.status,
    reservationStatuses: listWorkflowBudgetReservations(projectId).map(record => record.status),
    activeReservedUsd: workflowBudgetSummary(projectId).activeReservedUsd,
  };
}

const isolation = await runFailure('isolation');
const rebind = await runFailure('rebind');
const execute = await runFailure('execute');
console.log(`KADY_ASYNC_FAILURE_RESULT=${JSON.stringify({ isolation, rebind, execute })}`);

await adapter.stop();
await closeDatabase();
process.exit(0);
