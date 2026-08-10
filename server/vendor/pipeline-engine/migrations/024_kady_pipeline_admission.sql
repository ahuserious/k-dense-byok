ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS kady_project_id TEXT;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS kady_admission_id TEXT;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS kady_engine_admission_key TEXT;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS workflow_revision_sha256 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS unique_workflow_run_kady_admission
  ON remote_agent_workflow_runs(kady_project_id, kady_engine_admission_key)
  WHERE kady_project_id IS NOT NULL AND kady_engine_admission_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_kady_admission_lookup
  ON remote_agent_workflow_runs(kady_project_id, kady_admission_id);
