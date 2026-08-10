import { describe, test, expect, mock } from 'bun:test';

// Binary-mode variant — must be in a separate file from source-mode tests
// because mock.module() is process-global in Bun (see CLAUDE.md test isolation rules).
// This file mocks BUNDLED_IS_BINARY=true; the source-build path is verified
// by postgres.test.ts indirectly when bundled-schema is NOT mocked.

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: true,
}));

import { getSchemaSQL } from './bundled-schema';
import { BUNDLED_SCHEMA_SQL } from './bundled-schema.generated';

describe('getSchemaSQL() — binary build', () => {
  test('returns the embedded BUNDLED_SCHEMA_SQL constant (not a disk read)', () => {
    const result = getSchemaSQL();
    expect(result).toBe(BUNDLED_SCHEMA_SQL);
  });

  test('BUNDLED_SCHEMA_SQL is non-empty and contains expected table markers', () => {
    expect(BUNDLED_SCHEMA_SQL.length).toBeGreaterThan(1000);
    expect(BUNDLED_SCHEMA_SQL).toContain('remote_agent_codebases');
    expect(BUNDLED_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS');
  });

  test('creates admission indexes only after the pre-024 column upgrade block', () => {
    const admissionUpgrade = BUNDLED_SCHEMA_SQL.indexOf('-- From migration 024:');
    const finalAdmissionColumn = BUNDLED_SCHEMA_SQL.indexOf(
      'ADD COLUMN IF NOT EXISTS workflow_revision_sha256 TEXT;',
      admissionUpgrade
    );
    const uniqueAdmissionIndex = BUNDLED_SCHEMA_SQL.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS unique_workflow_run_kady_admission'
    );
    const lookupAdmissionIndex = BUNDLED_SCHEMA_SQL.indexOf(
      'CREATE INDEX IF NOT EXISTS idx_workflow_runs_kady_admission_lookup'
    );

    expect(admissionUpgrade).toBeGreaterThan(-1);
    expect(finalAdmissionColumn).toBeGreaterThan(admissionUpgrade);
    expect(uniqueAdmissionIndex).toBeGreaterThan(finalAdmissionColumn);
    expect(lookupAdmissionIndex).toBeGreaterThan(uniqueAdmissionIndex);
  });
});
