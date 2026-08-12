import Fastify from 'fastify';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationLockManager } from '@archon/core';
import { closeDatabase } from '@archon/core/db';
import { WebAdapter } from '../adapters/web.ts';
import { MessagePersistence } from '../adapters/web/persistence.ts';
import { SSETransport } from '../adapters/web/transport.ts';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge.ts';
import { validationErrorHook } from './openapi-defaults.ts';
import { registerApiRoutes } from './api.ts';
import {
  PipelineReconciliationWorker,
  registerPipelineRoutes,
} from '../../../../../../src/api/pipelines.ts';
import {
  createProject,
  ensureProjectExists,
  resolvePaths,
} from '../../../../../../src/projects.ts';
import {
  recoverPipelineAdmission,
  workflowBudgetSummary,
} from '../../../../../../src/workflows/budget.ts';
import { withActiveProject } from '../../../../../../src/scope.ts';

const mode = process.env.KADY_CRASH_FIXTURE_MODE;
const projectId = 'dispatch-crash-project';
const admissionId = 'kadypipe_77777777777777777777777777777777';
const conversationId = 'dispatch-crash-conversation';
const workflowName = 'dispatch-crash-workflow';
const crashStatePath = join(process.env.ARCHON_HOME, 'crash-state.json');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createEngineApp(faultInjection) {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const transport = new SSETransport(undefined, 1);
  const persistence = new MessagePersistence((id, event) => transport.emit(id, event));
  const bridge = new WorkflowEventBridge(transport);
  const adapter = new WebAdapter(transport, persistence, bridge);
  const lockManager = new ConversationLockManager(1);
  registerApiRoutes(app, adapter, lockManager, undefined, faultInjection);
  return { app, adapter, lockManager };
}

async function engineJson(app, path, init) {
  const response = await app.request(path, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Engine ${response.status} ${path}: ${text}`);
  return body;
}

async function prepareEngineWorkspace(app, createWorkflow) {
  const paths = ensureProjectExists(projectId);
  const codebases = await engineJson(app, '/api/codebases');
  let codebase = Array.isArray(codebases)
    ? codebases.find(candidate => candidate.default_cwd === paths.sandbox)
    : undefined;
  if (!codebase) {
    codebase = await engineJson(app, '/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: paths.sandbox, name: `kady/${projectId}` }),
    });
  }
  const scope = new URLSearchParams({ cwd: paths.sandbox, codebaseId: codebase.id });
  if (createWorkflow) {
    await engineJson(app, `/api/workflows/${workflowName}?${scope}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: {
          name: workflowName,
          description: 'Cross-Kady crash replay workflow',
          provider: 'claude',
          nodes: [
            { id: 'gate', bash: 'printf no' },
            {
              id: 'admitted',
              prompt: 'This provider node is deterministically skipped.',
              depends_on: ['gate'],
              when: "$gate.output == 'yes'",
              maxBudgetUsd: 1,
            },
          ],
        },
      }),
    });
  }
  const listed = await engineJson(app, `/api/workflows?${scope}`);
  const workflow = listed.workflows?.find(entry => entry.workflow.name === workflowName);
  if (!workflow) throw new Error('Crash fixture workflow was not listed.');
  return { paths, codebase, scope, workflow };
}

function engineAdmissionQuery(app) {
  return async (queriedProjectId, engineAdmissionKey) => {
    const body = await engineJson(
      app,
      `/api/workflows/runs?projectId=${encodeURIComponent(queriedProjectId)}` +
        `&admissionId=${encodeURIComponent(engineAdmissionKey)}`
    );
    const run = body.runs?.[0];
    if (run) {
      return {
        status: 'found',
        runId: run.id,
        run,
        dispatchState: body.admissionQuery?.dispatchState,
      };
    }
    return body.admissionQuery?.authoritative === true
      ? { status: 'not-found' }
      : { status: 'unknown' };
  };
}

async function createKadyApp(engineApp, workspace, replayCounter) {
  const app = Fastify();
  app.addHook('onRequest', (request, _reply, done) => {
    const header = request.headers['x-project-id'];
    withActiveProject(typeof header === 'string' ? header : projectId, () => done());
  });
  const queryAdmission = engineAdmissionQuery(engineApp);
  await registerPipelineRoutes(app, {
    reconciliationWorker: false,
    resolveWorkflowScope: async () => ({
      cwd: workspace.paths.sandbox,
      codebaseId: workspace.codebase.id,
    }),
    resolveBudgetHooks: async () => [{
      nodeId: 'admitted',
      modelCallCount: 1,
      maxTokens: 100,
      maxCostUsd: 1,
      declaredBillingMode: 'api',
      billing: {
        provider: 'openrouter',
        authType: 'api_key',
        billingMode: 'payg',
      },
    }],
    getWorkflow: async workflowId => engineJson(
      engineApp,
      `/api/workflows/${encodeURIComponent(workflowId)}?${workspace.scope}`
    ),
    runWorkflow: async (workflowId, body) => {
      replayCounter.count += 1;
      const selected = await engineJson(
        engineApp,
        `/api/workflows/${encodeURIComponent(workflowId)}?${workspace.scope}`
      );
      const selectedWorkflow = selected.workflow ?? selected.definition ?? selected;
      const expectedRevision = createHash('sha256')
        .update(canonicalJson(selectedWorkflow))
        .digest('hex');
      if (body.workflowRevisionSha256 !== expectedRevision) {
        throw new Error(
          `Fixture revision mismatch: Kady ${String(body.workflowRevisionSha256)} engine ${expectedRevision}`
        );
      }
      return engineJson(
        engineApp,
        `/api/workflows/${encodeURIComponent(workflowId)}/run?${workspace.scope}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
    },
    queryAdmission,
    getRun: async runId => engineJson(
      engineApp,
      `/api/workflows/runs/${encodeURIComponent(runId)}`
    ),
  });
  return { app, queryAdmission };
}

if (mode === 'seed') {
  createProject({ name: 'Dispatch crash project', projectId, spendLimitUsd: 5 });
  let crashContext;
  const engine = createEngineApp({
    afterKadyAdmissionPersisted(run) {
      writeFileSync(crashStatePath, JSON.stringify({
        ...crashContext,
        runId: run.id,
        pendingStatus: run.status,
        dispatchState: run.metadata.kadyDispatchState,
        kadyAdmissionStatus: recoverPipelineAdmission(projectId, admissionId).record.status,
      }));
      process.exit(86);
    },
  });
  await engine.adapter.start();
  const workspace = await prepareEngineWorkspace(engine.app, true);
  crashContext = {
    projectId,
    admissionId,
    conversationId,
    workflowId: workspace.workflow.workflowId,
  };
  const replayCounter = { count: 0 };
  const kady = await createKadyApp(engine.app, workspace, replayCounter);
  const seedResponse = await kady.app.inject({
    method: 'POST',
    url: `/pipelines/${workspace.workflow.workflowId}/run`,
    headers: { 'x-project-id': projectId },
    payload: { conversationId, message: 'Run after crash', kadyAdmissionId: admissionId },
  });
  throw new Error(
    `Crash boundary did not terminate the seed process: ${seedResponse.statusCode} ${seedResponse.body}`
  );
}

if (mode === 'replay') {
  const seeded = JSON.parse(readFileSync(crashStatePath, 'utf8'));
  const engine = createEngineApp();
  await engine.adapter.start();
  const workspace = await prepareEngineWorkspace(engine.app, false);
  const replayCounter = { count: 0 };
  const kady = await createKadyApp(engine.app, workspace, replayCounter);
  const replay = await kady.app.inject({
    method: 'POST',
    url: `/pipelines/${seeded.workflowId}/run`,
    headers: { 'x-project-id': projectId },
    payload: { conversationId, message: 'Run after crash', kadyAdmissionId: admissionId },
  });
  if (replay.statusCode !== 200) {
    throw new Error(`Kady crash retry failed: ${replay.statusCode} ${replay.body}`);
  }
  const queryAdmission = engineAdmissionQuery(engine.app);
  let terminalRun;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const query = await queryAdmission(projectId, recoverPipelineAdmission(
      projectId,
      admissionId
    ).record.engineAdmissionKey);
    if (query.status === 'found' && ['completed', 'failed', 'cancelled'].includes(query.run.status)) {
      terminalRun = query.run;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!terminalRun) throw new Error('Cross-Kady crash replay did not reach a terminal run.');
  const reconciliationErrors = [];
  const worker = new PipelineReconciliationWorker({
    projects: () => [{ id: projectId }],
    queryAdmission,
    getRun: async runId => engineJson(engine.app, `/api/workflows/runs/${runId}`),
    onError: error => reconciliationErrors.push(error instanceof Error ? error.message : String(error)),
  });
  await worker.runOnce();
  const settled = recoverPipelineAdmission(projectId, admissionId);
  if (settled.record.status !== 'settled') {
    const detail = await engineJson(engine.app, `/api/workflows/runs/${terminalRun.id}`);
    throw new Error(`Kady reconciliation failed: ${JSON.stringify({
      reconciliationErrors,
      runStatus: detail.run?.status,
      watermark: detail.run?.metadata?.kady_completion_watermark,
    })}`);
  }
  console.log(`KADY_CRASH_REPLAY=${JSON.stringify({
    replayStatus: replay.statusCode,
    replayedThroughKady: replayCounter.count === 1,
    runId: terminalRun.id,
    originalRunId: seeded.runId,
    terminalStatus: terminalRun.status,
    dispatchState: terminalRun.metadata?.kadyDispatchState,
    admissionStatus: settled.record.status,
    reservationStatus: settled.admission.handle.record.status,
    activeReservedUsd: workflowBudgetSummary(projectId).activeReservedUsd,
  })}`);
  await kady.app.close();
  await engine.adapter.stop();
  await closeDatabase();
  process.exit(0);
}

throw new Error(`Unknown KADY_CRASH_FIXTURE_MODE: ${String(mode)}`);
