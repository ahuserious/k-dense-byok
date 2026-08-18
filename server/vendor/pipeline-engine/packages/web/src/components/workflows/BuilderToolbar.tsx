import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listWorkflows } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';
import { useProviders } from '@/hooks/useProviders';

export type ViewMode = 'hidden' | 'split' | 'full';

export interface BuilderToolbarProps {
  workflowName: string;
  workflowDescription: string;
  provider: string | undefined;
  model: string | undefined;
  hasUnsavedChanges: boolean;
  validationErrors: string[];
  viewMode: ViewMode;
  onNameChange: (name: string) => void;
  onDescriptionChange: (desc: string) => void;
  onProviderChange: (p: string | undefined) => void;
  onModelChange: (m: string | undefined) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onValidate: () => void;
  onSave: () => void;
  saveDisabledReason?: string;
  onRun: () => void;
  onLoadWorkflow: (name: string) => void;
}

const VIEW_MODE_LABELS: readonly { value: ViewMode; label: string }[] = [
  { value: 'hidden', label: 'Visual' },
  { value: 'split', label: 'Split' },
  { value: 'full', label: 'YAML' },
];

export function BuilderToolbar({
  workflowName,
  workflowDescription,
  provider,
  model,
  hasUnsavedChanges,
  validationErrors,
  viewMode,
  onNameChange,
  onDescriptionChange,
  onProviderChange,
  onModelChange,
  onViewModeChange,
  onValidate,
  onSave,
  saveDisabledReason,
  onRun,
  onLoadWorkflow,
}: BuilderToolbarProps): React.ReactElement {
  const navigate = useNavigate();
  const { codebases, selectedProjectId } = useProject();
  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  const { providers } = useProviders();
  const [showDescription, setShowDescription] = useState(false);

  const { data: workflowsResult, isError: workflowsError } = useQuery({
    queryKey: ['workflows', cwd],
    queryFn: () => listWorkflows(cwd),
  });
  const workflows = workflowsResult?.workflows;

  return (
    <>
      <div className="flex h-10 items-center gap-2 border-b border-border px-2.5">
        {/* Left group: Load + Breadcrumb + Mode badge */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Load existing pipeline */}
          <select
            value=""
            onChange={(e): void => {
              if (e.target.value) onLoadWorkflow(e.target.value);
            }}
            className="h-7 w-[92px] shrink-0 rounded border border-border bg-surface px-1.5 font-mono text-[11px] text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent-bright"
            title={
              workflowsError
                ? 'Failed to load pipelines — check server connection'
                : 'Load pipeline'
            }
          >
            <option value="">{workflowsError ? 'Load failed' : 'Load pipeline…'}</option>
            {(workflows ?? []).map(entry => (
              <option key={entry.workflowId} value={entry.workflowId}>
                {entry.workflow.name}
              </option>
            ))}
          </select>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={(): void => {
                navigate('/legacy/workflows');
              }}
              className="shrink-0 font-mono text-[11px] text-text-tertiary hover:text-text-primary"
            >
              Pipelines
            </button>
            <span className="shrink-0 font-mono text-[11px] text-text-tertiary">/</span>
            <input
              type="text"
              value={workflowName}
              onChange={(e): void => {
                onNameChange(e.target.value);
              }}
              placeholder="workflow-name"
              className="h-7 min-w-[80px] max-w-[160px] rounded border border-transparent bg-transparent px-1.5 font-mono text-[11px] font-medium text-text-primary placeholder:text-text-tertiary hover:border-border focus:border-border focus:outline-none focus:ring-1 focus:ring-accent-bright"
            />
            {hasUnsavedChanges && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-warning shrink-0"
                title="Unsaved changes"
              />
            )}
          </div>

          {/* Description (click to expand) */}
          {showDescription ? (
            <input
              type="text"
              value={workflowDescription}
              onChange={(e): void => {
                onDescriptionChange(e.target.value);
              }}
              onBlur={(): void => {
                setShowDescription(false);
              }}
              autoFocus
              placeholder="Description..."
              className="h-7 w-48 rounded border border-border bg-surface px-2 font-mono text-[11px] text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent-bright"
            />
          ) : (
            <button
              type="button"
              onClick={(): void => {
                setShowDescription(true);
              }}
              className="max-w-[120px] shrink-0 truncate font-mono text-[10px] text-text-tertiary hover:text-text-primary"
              title={workflowDescription || 'Add description'}
            >
              {workflowDescription || 'add description'}
            </button>
          )}

          {/* Mode badge */}
          <span className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            DAG
          </span>
        </div>

        {/* Center group: HIDDEN for the Kady embed. The executing assistant is pinned to
            Pi (pi-kady) via config and per-step model is set on the node inspector, so the
            toolbar's provider + model controls are both hidden (wrapped in {false}). They're
            kept (dead) so provider/onProviderChange/providers/model/onModelChange props stay
            referenced — provider-select-hidden-kady. */}
        <div className="flex items-center gap-1.5 mx-auto">
          {false && (
            <>
              <select
                value={provider ?? ''}
                onChange={(e): void => {
                  onProviderChange(e.target.value || undefined);
                }}
                className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">Provider</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={model ?? ''}
                onChange={(e): void => {
                  onModelChange(e.target.value || undefined);
                }}
                placeholder="Model"
                className="w-20 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </>
          )}
        </div>

        {/* Right group: View toggle + Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* View toggle */}
          <div className="flex h-7 overflow-hidden rounded border border-border">
            {VIEW_MODE_LABELS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={(): void => {
                  onViewModeChange(value);
                }}
                aria-pressed={viewMode === value}
                className={cn(
                  'px-2 font-mono text-[10px] font-medium transition-colors',
                  viewMode === value
                    ? 'bg-surface-hover text-text-primary'
                    : 'bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Validation errors badge */}
          {validationErrors.length > 0 && (
            <span className="rounded border border-error/50 px-1.5 py-px font-mono text-[10px] font-medium text-error">
              {validationErrors.length}
            </span>
          )}

          <Button variant="outline" size="xs" onClick={onValidate}>
            Validate
          </Button>

          <Button
            variant="secondary"
            size="xs"
            onClick={onSave}
            disabled={!workflowName.trim() || Boolean(saveDisabledReason)}
            title={saveDisabledReason}
          >
            Save
          </Button>

          <Button
            size="xs"
            onClick={onRun}
            disabled={!workflowName.trim() || hasUnsavedChanges}
            title={hasUnsavedChanges ? 'Save the workflow before running' : undefined}
          >
            Run
          </Button>
        </div>
      </div>

      {workflowsError && (
        <div className="border-b border-border bg-surface-inset px-3 py-1 font-mono text-[11px] text-error">
          Failed to load workflow list. The load dropdown may be empty.
        </div>
      )}
    </>
  );
}
