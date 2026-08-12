import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from './postgres';

const postgresUpgradeUrl = process.env.PIPELINE_ENGINE_POSTGRES_UPGRADE_TEST_URL;
const schemasToDrop: string[] = [];

afterAll(async () => {
  if (!postgresUpgradeUrl || schemasToDrop.length === 0) return;
  const cleanupPool = new Pool({ connectionString: postgresUpgradeUrl });
  try {
    for (const schema of schemasToDrop) {
      await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  } finally {
    await cleanupPool.end();
  }
});

describe.skipIf(!postgresUpgradeUrl)('combined Postgres schema upgrade', () => {
  test('boots from a real pre-024 schema and installs admission columns and indexes', async () => {
    const schema = `kady_upgrade_${randomUUID().replaceAll('-', '')}`;
    schemasToDrop.push(schema);
    const seedPool = new Pool({ connectionString: postgresUpgradeUrl });
    const seedClient = await seedPool.connect();
    try {
      await seedClient.query(`CREATE SCHEMA ${schema}`);
      await seedClient.query(`SET search_path TO ${schema}`);
      const migrationsDir = resolve(import.meta.dir, '../../../../../migrations');
      const pre024Migrations = readdirSync(migrationsDir)
        .filter(filename => /^0(?:0[1-9]|1\d|2[0-3])_.*\.sql$/.test(filename))
        .sort();
      expect(pre024Migrations).toHaveLength(23);
      for (const filename of pre024Migrations) {
        await seedClient.query(readFileSync(resolve(migrationsDir, filename), 'utf8'));
      }
    } finally {
      seedClient.release();
      await seedPool.end();
    }

    const scopedUrl = new URL(postgresUpgradeUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    const engineDatabase = new PostgresAdapter(scopedUrl.toString());
    try {
      // Every query awaits the adapter's transactional combined-schema startup.
      await expect(engineDatabase.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
      const columns = await engineDatabase.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'remote_agent_workflow_runs'`,
        [schema]
      );
      expect(columns.rows.map(row => row.column_name)).toEqual(
        expect.arrayContaining([
          'kady_project_id',
          'kady_admission_id',
          'kady_engine_admission_key',
          'workflow_revision_sha256',
        ])
      );
      const indexes = await engineDatabase.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = 'remote_agent_workflow_runs'`,
        [schema]
      );
      expect(indexes.rows.map(row => row.indexname)).toEqual(
        expect.arrayContaining([
          'unique_workflow_run_kady_admission',
          'idx_workflow_runs_kady_admission_lookup',
        ])
      );
    } finally {
      await engineDatabase.close();
    }
  }, 30_000);
});
