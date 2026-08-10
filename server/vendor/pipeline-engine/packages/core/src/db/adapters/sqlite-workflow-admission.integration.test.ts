import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { closeDatabase, getDatabase, resetDatabase } from '../connection';
import {
  claimKadyWorkflowDispatch,
  createWorkflowRun,
  markKadyWorkflowDispatched,
} from '../workflows';

const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let testHome: string | undefined;

async function seedRunParents(conversationId: string): Promise<void> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd)
     VALUES ($1, $2, $3)`,
    ['codebase-1', 'kady/test-project', '/tmp/kady-test-project']
  );
  await db.query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id, codebase_id, cwd)
     VALUES ($1, $2, $3, $4, $5)`,
    [conversationId, 'web', conversationId, 'codebase-1', '/tmp/kady-test-project']
  );
}

function useIsolatedSqliteHome(prefix: string): string {
  testHome = mkdtempSync(join(tmpdir(), prefix));
  process.env.ARCHON_HOME = testHome;
  delete process.env.DATABASE_URL;
  resetDatabase();
  return testHome;
}

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = undefined;
});

describe('SQLite workflow admission schema integration', () => {
  test('fresh schema executes createWorkflowRun without Kady admission metadata', async () => {
    const home = useIsolatedSqliteHome('pipeline-sqlite-admission-fresh-');
    await seedRunParents('conversation-fresh');

    const run = await createWorkflowRun({
      workflow_name: 'fresh-workflow',
      conversation_id: 'conversation-fresh',
      codebase_id: 'codebase-1',
      user_message: 'Run the fresh workflow',
    });

    expect(run.workflow_name).toBe('fresh-workflow');
    const admitted = await createWorkflowRun({
      workflow_name: 'fresh-admitted-workflow',
      conversation_id: 'conversation-fresh',
      codebase_id: 'codebase-1',
      user_message: 'Run the admitted fresh workflow',
      metadata: {
        kadyProjectId: 'project-fresh',
        kadyAdmissionId: 'kadypipe_33333333333333333333333333333333',
        kadyEngineAdmissionKey: 'kadypipe_44444444444444444444444444444444',
        workflowRevisionSha256: 'b'.repeat(64),
      },
    });
    expect(admitted.workflow_name).toBe('fresh-admitted-workflow');
    const raw = new Database(join(home, 'archon.db'), { readonly: true });
    try {
      const columns = raw
        .prepare("PRAGMA table_info('remote_agent_workflow_runs')")
        .all() as { name: string }[];
      expect(columns.map(column => column.name)).toEqual(
        expect.arrayContaining([
          'kady_project_id',
          'kady_admission_id',
          'kady_engine_admission_key',
          'workflow_revision_sha256',
        ])
      );
      const indexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[];
      expect(indexes.map(index => index.name)).toEqual(
        expect.arrayContaining([
          'unique_workflow_run_kady_admission',
          'idx_workflow_runs_kady_admission_lookup',
        ])
      );
    } finally {
      raw.close();
    }
  });

  test('migrateColumns upgrades an existing database before an admitted createWorkflowRun', async () => {
    const home = useIsolatedSqliteHome('pipeline-sqlite-admission-upgrade-');
    mkdirSync(home, { recursive: true });
    const dbPath = join(home, 'archon.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE remote_agent_workflow_runs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT,
        codebase_id TEXT,
        workflow_name TEXT NOT NULL,
        user_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step_index INTEGER,
        metadata TEXT DEFAULT '{}',
        parent_conversation_id TEXT,
        user_id TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now')),
        working_path TEXT
      );
    `);
    legacy.close();

    await seedRunParents('conversation-upgraded');
    const metadata = {
      kadyProjectId: 'project-upgraded',
      kadyAdmissionId: 'kadypipe_11111111111111111111111111111111',
      kadyEngineAdmissionKey: 'kadypipe_22222222222222222222222222222222',
      workflowRevisionSha256: 'a'.repeat(64),
    };
    const run = await createWorkflowRun({
      workflow_name: 'upgraded-workflow',
      conversation_id: 'conversation-upgraded',
      codebase_id: 'codebase-1',
      user_message: 'Run the upgraded workflow',
      metadata,
    });

    expect(run.metadata).toEqual(metadata);
    const unadmitted = await createWorkflowRun({
      workflow_name: 'upgraded-unadmitted-workflow',
      conversation_id: 'conversation-upgraded',
      codebase_id: 'codebase-1',
      user_message: 'Run without admission metadata after upgrade',
    });
    expect(unadmitted.workflow_name).toBe('upgraded-unadmitted-workflow');
    const persisted = await getDatabase().query<{
      kady_project_id: string;
      kady_admission_id: string;
      kady_engine_admission_key: string;
      workflow_revision_sha256: string;
    }>(
      `SELECT kady_project_id, kady_admission_id, kady_engine_admission_key,
              workflow_revision_sha256
       FROM remote_agent_workflow_runs WHERE id = $1`,
      [run.id]
    );
    expect(persisted.rows[0]).toEqual({
      kady_project_id: metadata.kadyProjectId,
      kady_admission_id: metadata.kadyAdmissionId,
      kady_engine_admission_key: metadata.kadyEngineAdmissionKey,
      workflow_revision_sha256: metadata.workflowRevisionSha256,
    });

    await closeDatabase();
    resetDatabase();
    expect(() => getDatabase()).not.toThrow();
  });

  test('reclaims a pending dispatch after a process restart without double-claiming in-process', async () => {
    useIsolatedSqliteHome('pipeline-sqlite-dispatch-claim-');
    await seedRunParents('conversation-dispatch-claim');
    const scope = {
      workflowName: 'claim-workflow',
      codebaseId: 'codebase-1',
      workingPath: '/tmp/kady-test-project',
      projectId: 'project-claim',
      engineAdmissionKey: 'kadypipe_55555555555555555555555555555555',
      workflowRevisionSha256: 'c'.repeat(64),
    };
    const run = await createWorkflowRun({
      workflow_name: scope.workflowName,
      conversation_id: 'conversation-dispatch-claim',
      codebase_id: scope.codebaseId,
      user_message: 'Run the claimed workflow',
      working_path: scope.workingPath,
      metadata: {
        kadyProjectId: scope.projectId,
        kadyAdmissionId: 'admission-claim',
        kadyEngineAdmissionKey: scope.engineAdmissionKey,
        workflowRevisionSha256: scope.workflowRevisionSha256,
        kadyDispatchState: 'pre_dispatch',
      },
    });

    const firstClaim = await claimKadyWorkflowDispatch(
      run.id,
      scope,
      'process-a',
      'claim-a'
    );
    expect(firstClaim).toMatchObject({
      claimed: true,
      run: { metadata: { kadyDispatchState: 'dispatching' } },
    });
    expect(
      await claimKadyWorkflowDispatch(run.id, scope, 'process-a', 'claim-a-retry')
    ).toMatchObject({ claimed: false });

    await markKadyWorkflowDispatched(run.id, 'process-a', 'claim-a');
    expect(
      await claimKadyWorkflowDispatch(run.id, scope, 'process-a', 'claim-a-after-dispatch')
    ).toMatchObject({ claimed: false });

    const restartedClaim = await claimKadyWorkflowDispatch(
      run.id,
      scope,
      'process-b',
      'claim-b'
    );
    expect(restartedClaim).toMatchObject({
      claimed: true,
      run: {
        metadata: {
          kadyDispatchState: 'dispatching',
          kadyDispatchProcessId: 'process-b',
          kadyDispatchClaimId: 'claim-b',
        },
      },
    });
  });
});
