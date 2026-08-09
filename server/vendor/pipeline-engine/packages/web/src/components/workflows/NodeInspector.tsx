import { useState, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  NODE_AUTH_KINDS,
  NODE_HARNESSES,
  NODE_REASONING_LEVELS,
  NODE_SKILLS_MODES,
  NODE_SUBAGENT_MODES,
} from './DagNodeComponent';
import type {
  DagNodeData,
  FixedNodeRequestedModel,
  NodeAuthKind,
  NodeModelRequest,
  NodeReasoningLevel,
  NodeRequestedModel,
  NodeSamplingValue,
  NodeSkillsMode,
  NodeSpecV1,
  NodeSubagentMode,
} from './DagNodeComponent';
import type { CommandEntry, DagNode } from '@/lib/api';
import { useProviders } from '@/hooks/useProviders';

// Keep in sync with triggerRuleSchema.options in @archon/workflows/schemas/dag-node.ts
// (api.generated.d.ts is type-only and cannot export runtime values)
type TriggerRule = NonNullable<DagNode['trigger_rule']>;
const TRIGGER_RULES: readonly TriggerRule[] = [
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
];

/** New DAG-mode inspector props (tabbed right panel). */
export interface NodeInspectorProps {
  node: DagNodeData;
  commands: CommandEntry[];
  onUpdate: (updates: Partial<DagNodeData>) => void;
  onDelete: () => void;
  onClose: () => void;
}

const inputClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent';

const selectClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

const labelClass = 'text-[10px] text-text-tertiary uppercase tracking-wide';

const textareaClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y';

export const NODE_SPEC_EDITOR_DROPDOWNS = {
  modelSource: ['inherit', 'kady-current', 'fixed'],
  authKind: NODE_AUTH_KINDS,
  reasoning: NODE_REASONING_LEVELS,
  harness: NODE_HARNESSES,
  skillsMode: NODE_SKILLS_MODES,
  subagentsMode: NODE_SUBAGENT_MODES,
  autonomy: ['strict', 'loose'],
  billingMode: ['inherit', 'api', 'subscription'],
  mimeographsMode: ['auto', 'manual'],
} as const;

export const NODE_SPEC_V1_BINDING_FIELDS = [
  'version',
  'model',
  'model.requested.auth.kind',
  'reasoningEffort',
  'hyperparameters.temperature',
  'hyperparameters.top_p',
  'hyperparameters.sampling',
  'conditions.when',
  'conditions.exists',
  'harness',
  'databases',
  'skills.mode',
  'skills.list',
  'subagents.mode',
  'autonomy',
  'deliberation.personalityStoreRef',
  'deliberation.bestOfNPersonalityCount',
  'deliberation.mimeographs.mode',
  'deliberation.mimeographs.personalityRefs',
  'billingMode',
  'budget.maxTokens',
  'budget.maxCostUsd',
] as const;

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAMPLING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Immutable update primitive used by every NodeSpec editor control. */
export function mergeNodeSpecV1(
  current: NodeSpecV1 | undefined,
  updates: Partial<NodeSpecV1>
): NodeSpecV1 {
  return { version: 1, ...current, ...updates };
}

function isValidReference(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && REFERENCE_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateObjectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[]
): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) {
    errors.push(`${path} contains unsupported fields: ${unexpected.join(', ')}.`);
  }
}

function validateRequestedModel(
  model: unknown,
  path: string,
  errors: string[]
): model is NodeRequestedModel {
  const startingErrorCount = errors.length;
  if (!isRecord(model)) {
    errors.push(`${path} must be a requested-model object.`);
    return false;
  }
  if (model.source !== 'fixed' && model.source !== 'kady-current') {
    errors.push(`${path}.source must be fixed or kady-current.`);
    return false;
  }
  if (!NODE_REASONING_LEVELS.includes(model.reasoning as NodeReasoningLevel)) {
    errors.push(`${path}.reasoning is invalid.`);
  }
  if (!isRecord(model.auth)) {
    errors.push(`${path}.auth must be an object.`);
    return false;
  }

  if (model.source === 'kady-current') {
    validateObjectKeys(model, ['source', 'auth', 'reasoning'], path, errors);
    validateObjectKeys(model.auth, ['kind'], `${path}.auth`, errors);
    if (model.auth.kind !== 'kady-current') {
      errors.push(`${path}.auth.kind must be kady-current.`);
    }
    return errors.length === startingErrorCount;
  }

  validateObjectKeys(model, ['source', 'provider', 'model', 'auth', 'reasoning'], path, errors);
  validateObjectKeys(model.auth, ['kind', 'profile'], `${path}.auth`, errors);
  if (
    typeof model.provider !== 'string' ||
    model.provider.length < 1 ||
    model.provider.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model.provider)
  ) {
    errors.push(`${path}.provider must be a valid 1 to 64 character provider ID.`);
  }
  if (typeof model.model !== 'string' || model.model.length < 1 || model.model.length > 256) {
    errors.push(`${path}.model must be a 1 to 256 character string.`);
  }
  if (!NODE_AUTH_KINDS.includes(model.auth.kind as NodeAuthKind)) {
    errors.push(`${path}.auth.kind is invalid.`);
  }
  if (
    model.auth.profile !== undefined &&
    (typeof model.auth.profile !== 'string' ||
      model.auth.profile.length < 1 ||
      model.auth.profile.length > 128)
  ) {
    errors.push(`${path}.auth.profile must be a non-blank string of at most 128 characters.`);
  }
  return errors.length === startingErrorCount;
}

export function nodeRequestedModelIdentity(model: NodeRequestedModel): string {
  if (model.source === 'kady-current') {
    return [model.source, model.auth.kind, model.reasoning].join('\u0000');
  }
  return [
    model.source,
    model.provider.toLowerCase(),
    model.model,
    model.auth.kind,
    model.auth.profile ?? '',
    model.reasoning,
  ].join('\u0000');
}

function validateReferences(values: string[] | undefined, path: string, errors: string[]): void {
  for (const value of values ?? []) {
    if (!isValidReference(value)) {
      errors.push(`${path} contains invalid reference "${value}".`);
    }
  }
}

/** Schema and current enforcement diagnostics; edits remain saveable for server validation. */
export function nodeSpecV1InlineErrors(settings: NodeSpecV1 | undefined): string[] {
  if (!settings) return [];
  const errors: string[] = [];

  if (settings.model) {
    const modelRequest = settings.model as unknown;
    if (!isRecord(modelRequest)) {
      errors.push('model must be a model-request object.');
      return errors;
    }
    validateObjectKeys(modelRequest, ['requested', 'resolution'], 'model', errors);
    const requested = modelRequest.requested;
    const requestedIsValid = validateRequestedModel(
      requested,
      'model.requested',
      errors
    );
    const resolution = modelRequest.resolution;
    if (!isRecord(resolution)) {
      errors.push('model.resolution must be an object.');
    } else if (resolution.mode === 'exact') {
      validateObjectKeys(resolution, ['mode'], 'model.resolution', errors);
    } else if (resolution.mode === 'explicit-fallback') {
      validateObjectKeys(
        resolution,
        ['mode', 'alternatives', 'reason'],
        'model.resolution',
        errors
      );
      const alternatives = Array.isArray(resolution.alternatives)
        ? resolution.alternatives
        : undefined;
      if (!alternatives) {
        errors.push('model.resolution.alternatives must be an array.');
      } else if (alternatives.length < 1 || alternatives.length > 8) {
        errors.push('model.resolution.alternatives requires between one and eight models.');
      }
      const validAlternatives: NodeRequestedModel[] = [];
      alternatives?.forEach((alternative, index) => {
        if (
          validateRequestedModel(
            alternative,
            `model.resolution.alternatives[${index}]`,
            errors
          )
        ) {
          validAlternatives.push(alternative);
        }
      });
      if (
        typeof resolution.reason !== 'string' ||
        resolution.reason.length < 1 ||
        resolution.reason.length > 256
      ) {
        errors.push('model.resolution.reason must be a 1 to 256 character string.');
      }

      if (
        (requestedIsValid && requested.source === 'kady-current') ||
        validAlternatives.some(alternative => alternative.source === 'kady-current')
      ) {
        errors.push(
          'Kady Current is an exact runtime selection and cannot appear in an explicit fallback list.'
        );
      }

      if (requestedIsValid) {
        const requestedIdentity = nodeRequestedModelIdentity(requested);
        const fallbackIdentities = new Set<string>();
        validAlternatives.forEach(alternative => {
          const identity = nodeRequestedModelIdentity(alternative);
          if (identity === requestedIdentity) {
            errors.push('An explicit fallback must differ from the requested model and auth.');
          }
          if (fallbackIdentities.has(identity)) {
            errors.push('Explicit model fallbacks must be unique.');
          }
          fallbackIdentities.add(identity);
        });
      }
    } else {
      errors.push('model.resolution.mode must be exact or explicit-fallback.');
    }
  }

  const temperature = settings.hyperparameters?.temperature;
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    errors.push('hyperparameters.temperature must be between 0 and 2.');
  }
  const topP = settings.hyperparameters?.top_p;
  if (topP !== undefined && (topP < 0 || topP > 1)) {
    errors.push('hyperparameters.top_p must be between 0 and 1.');
  }
  const sampling = settings.hyperparameters?.sampling;
  if (sampling) {
    for (const [key, value] of Object.entries(sampling)) {
      if (!SAMPLING_KEY_PATTERN.test(key)) {
        errors.push(`hyperparameters.sampling has invalid key "${key}".`);
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        errors.push(`hyperparameters.sampling.${key} must be a string, number, or boolean.`);
      }
    }
  }

  if ((settings.conditions?.when?.length ?? 0) > 32_768) {
    errors.push('conditions.when exceeds 32,768 characters.');
  }
  for (const value of settings.conditions?.exists ?? []) {
    if (!value || value.length > 1_024) {
      errors.push('conditions.exists entries must contain 1 to 1,024 characters.');
    }
  }
  validateReferences(settings.databases, 'databases', errors);
  validateReferences(settings.skills?.list, 'skills.list', errors);
  if (
    settings.deliberation?.personalityStoreRef !== undefined &&
    !isValidReference(settings.deliberation.personalityStoreRef)
  ) {
    errors.push('deliberation.personalityStoreRef is not a valid reference.');
  }
  validateReferences(
    settings.deliberation?.mimeographs?.personalityRefs,
    'deliberation.mimeographs.personalityRefs',
    errors
  );
  const personalityCount = settings.deliberation?.bestOfNPersonalityCount;
  if (personalityCount !== undefined && (personalityCount < 1 || personalityCount > 32)) {
    errors.push('deliberation.bestOfNPersonalityCount must be between 1 and 32.');
  }
  const maxTokens = settings.budget?.maxTokens;
  if (
    maxTokens !== undefined &&
    (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 100_000_000)
  ) {
    errors.push('budget.maxTokens must be an integer between 1 and 100,000,000.');
  }
  const maxCostUsd = settings.budget?.maxCostUsd;
  if (maxCostUsd !== undefined && (maxCostUsd < 0 || maxCostUsd > 1_000_000)) {
    errors.push('budget.maxCostUsd must be between 0 and 1,000,000.');
  }

  if (
    temperature !== undefined &&
    temperature !== 1
  ) {
    errors.push('Server validation currently rejects non-default temperature until S4 binds it.');
  }
  if (topP !== undefined && topP !== 1) {
    errors.push('Server validation currently rejects non-default top_p until S4 binds it.');
  }
  if (sampling && Object.keys(sampling).length > 0) {
    errors.push('Server validation currently rejects sampling overrides until S4 binds them.');
  }
  if (settings.conditions?.when) {
    errors.push('Server validation currently rejects conditions.when until S4 binds it.');
  }
  if ((settings.conditions?.exists?.length ?? 0) > 0) {
    errors.push('Server validation currently rejects conditions.exists until S4 binds it.');
  }
  if (settings.harness !== undefined && settings.harness !== 'pi') {
    errors.push('Server validation currently rejects non-pi harnesses until S4 binds them.');
  }
  if ((settings.databases?.length ?? 0) > 0) {
    errors.push('Server validation currently rejects per-node databases until S4 binds them.');
  }
  if (settings.skills?.mode !== undefined && settings.skills.mode !== 'auto') {
    errors.push('Server validation currently rejects non-auto skills mode until S4 binds it.');
  }
  if ((settings.skills?.list?.length ?? 0) > 0) {
    errors.push('Server validation currently rejects per-node skills lists until S4 binds them.');
  }
  if (settings.subagents?.mode !== undefined && settings.subagents.mode !== 'auto') {
    errors.push('Server validation currently rejects non-auto subagent mode until S4 binds it.');
  }
  if (settings.autonomy !== undefined && settings.autonomy !== 'strict') {
    errors.push('Server validation currently rejects loose autonomy until S4 binds it.');
  }
  if (settings.billingMode !== undefined && settings.billingMode !== 'inherit') {
    errors.push('Server validation currently rejects billing overrides until S4 binds them.');
  }
  const deliberation = settings.deliberation;
  if (deliberation?.personalityStoreRef) {
    errors.push('Server validation currently rejects personalityStoreRef until S5 binds it.');
  }
  if (
    deliberation?.bestOfNPersonalityCount !== undefined &&
    deliberation.bestOfNPersonalityCount !== 2
  ) {
    errors.push('Server validation currently rejects non-default personality counts until S5 binds them.');
  }
  if (deliberation?.mimeographs?.mode !== undefined && deliberation.mimeographs.mode !== 'auto') {
    errors.push('Server validation currently rejects manual mimeographs until S5 binds them.');
  }
  if ((deliberation?.mimeographs?.personalityRefs?.length ?? 0) > 0) {
    errors.push('Server validation currently rejects mimeograph personality refs until S5 binds them.');
  }

  return errors;
}

function parseToolsList(value: string): string[] | undefined {
  if (!value.trim()) return undefined;
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass}>{label}</label>
      {children}
    </div>
  );
}

function ProviderField({
  node,
  onUpdate,
  selectClass: cls,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
  selectClass: string;
}): React.ReactElement {
  const { providers } = useProviders();
  return (
    <Field label="Provider">
      <select
        value={node.provider ?? ''}
        onChange={(e): void => {
          onUpdate({ provider: e.target.value || undefined });
        }}
        className={cls}
      >
        <option value="">Inherit</option>
        {providers.map(p => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </Field>
  );
}

type ToolsMode = 'none' | 'allow' | 'deny';

const TOOLS_MODE_LABELS: Record<ToolsMode, string> = {
  none: 'Default',
  allow: 'Allow',
  deny: 'Deny',
};

function resolveToolsMode(node: DagNodeData): ToolsMode {
  if (node.allowed_tools !== undefined) return 'allow';
  if (node.denied_tools !== undefined) return 'deny';
  return 'none';
}

function DependencyTags({
  values,
  onChange,
}: {
  values: string[];
  onChange: (deps: string[] | undefined) => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState('');

  const handleAdd = (): void => {
    const trimmed = addValue.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setAddValue('');
    setAdding(false);
  };

  const handleRemove = (dep: string): void => {
    const next = values.filter(v => v !== dep);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {values.map(dep => (
        <span
          key={dep}
          className="inline-flex items-center gap-1 rounded-md bg-surface-elevated px-1.5 py-0.5 text-[10px] font-mono text-text-secondary"
        >
          {dep}
          <button
            type="button"
            onClick={(): void => {
              handleRemove(dep);
            }}
            className="text-text-tertiary hover:text-error"
          >
            x
          </button>
        </span>
      ))}
      {adding ? (
        <input
          type="text"
          value={addValue}
          onChange={(e): void => {
            setAddValue(e.target.value);
          }}
          onKeyDown={(e): void => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
            if (e.key === 'Escape') {
              setAdding(false);
              setAddValue('');
            }
          }}
          onBlur={handleAdd}
          autoFocus
          placeholder="node-id"
          className="w-20 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      ) : (
        <button
          type="button"
          onClick={(): void => {
            setAdding(true);
          }}
          className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary hover:border-accent"
        >
          +
        </button>
      )}
    </div>
  );
}

function GeneralTab({
  node,
  commands,
  onUpdate,
}: {
  node: DagNodeData;
  commands: CommandEntry[];
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Node ID */}
      <Field label="Node ID">
        <input
          type="text"
          value={node.id}
          onChange={(e): void => {
            onUpdate({ id: e.target.value });
          }}
          className={cn(inputClass, 'font-mono')}
        />
        <p className="text-[9px] text-warning">
          Changing the node ID may break dependency references.
        </p>
      </Field>

      {/* Type selector */}
      <Field label="Type">
        <select
          value={node.nodeType}
          onChange={(e): void => {
            const newType = e.target.value as DagNodeData['nodeType'];
            const updates: Partial<DagNodeData> = { nodeType: newType };
            if (newType === 'command') {
              updates.promptText = undefined;
              updates.bashScript = undefined;
              updates.bashTimeout = undefined;
              updates.label = '';
            } else if (newType === 'prompt') {
              updates.bashScript = undefined;
              updates.bashTimeout = undefined;
              updates.label = 'Prompt';
            } else if (newType === 'bash') {
              updates.promptText = undefined;
              updates.label = 'Shell';
              updates.allowed_tools = undefined;
              updates.denied_tools = undefined;
              updates.output_format = undefined;
              updates.hooks = undefined;
              updates.mcp = undefined;
              updates.skills = undefined;
            }
            onUpdate(updates);
          }}
          className={selectClass}
        >
          <option value="command">Command</option>
          <option value="prompt">Prompt</option>
          <option value="bash">Bash</option>
        </select>
      </Field>

      {/* Type-adaptive content */}
      {node.nodeType === 'command' && (
        <Field label="Command">
          <select
            value={node.label}
            onChange={(e): void => {
              onUpdate({ label: e.target.value });
            }}
            className={selectClass}
          >
            <option value="">Select command...</option>
            {commands.map(cmd => (
              <option key={cmd.name} value={cmd.name}>
                {cmd.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {node.nodeType === 'prompt' && (
        <Field label="Prompt">
          <textarea
            value={node.promptText ?? ''}
            onChange={(e): void => {
              onUpdate({ promptText: e.target.value });
            }}
            rows={5}
            placeholder="Enter inline prompt..."
            className={cn(textareaClass, 'min-h-[120px]')}
          />
        </Field>
      )}

      {node.nodeType === 'bash' && (
        <>
          <Field label="Shell Script">
            <textarea
              value={node.bashScript ?? ''}
              onChange={(e): void => {
                onUpdate({ bashScript: e.target.value });
              }}
              rows={5}
              placeholder="echo 'hello world'"
              className={cn(textareaClass, 'min-h-[120px]')}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              type="number"
              value={node.bashTimeout ?? ''}
              onChange={(e): void => {
                const v = e.target.value;
                onUpdate({ bashTimeout: v ? Number(v) : undefined });
              }}
              placeholder="120000"
              className={inputClass}
            />
          </Field>
        </>
      )}

      {/* Dependencies */}
      <Field label="Dependencies">
        <DependencyTags
          values={node.depends_on ?? []}
          onChange={(deps): void => {
            onUpdate({ depends_on: deps });
          }}
        />
      </Field>

      {/* When condition */}
      <Field label="When Condition">
        <input
          type="text"
          value={node.when ?? ''}
          onChange={(e): void => {
            onUpdate({ when: e.target.value || undefined });
          }}
          placeholder="$nodeId.output.field == 'value'"
          className={cn(inputClass, 'font-mono')}
        />
      </Field>
    </div>
  );
}

function ExecutionTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  const isBash = node.nodeType === 'bash';

  return (
    <div className="flex flex-col gap-3 p-3">
      {!isBash && (
        <>
          <ProviderField node={node} onUpdate={onUpdate} selectClass={selectClass} />

          <Field label="Model">
            <input
              type="text"
              value={node.model ?? ''}
              onChange={(e): void => {
                onUpdate({ model: e.target.value || undefined });
              }}
              placeholder="Inherit"
              className={inputClass}
            />
          </Field>

          <Field label="Context">
            <select
              value={node.context ?? ''}
              onChange={(e): void => {
                onUpdate({ context: (e.target.value || undefined) as 'fresh' | undefined });
              }}
              className={selectClass}
            >
              <option value="">Inherit</option>
              <option value="fresh">Fresh</option>
            </select>
          </Field>
        </>
      )}

      <Field label="Trigger Rule">
        <select
          value={node.trigger_rule ?? ''}
          onChange={(e): void => {
            onUpdate({
              trigger_rule: (e.target.value || undefined) as TriggerRule | undefined,
            });
          }}
          className={selectClass}
        >
          <option value="">Default (all_success)</option>
          {TRIGGER_RULES.map(rule => (
            <option key={rule} value={rule}>
              {rule}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Idle Timeout (ms)">
        <input
          type="number"
          value={node.idle_timeout ?? ''}
          onChange={(e): void => {
            const v = e.target.value;
            onUpdate({ idle_timeout: v ? Number(v) : undefined });
          }}
          placeholder="300000"
          className={inputClass}
        />
      </Field>

      {/* Retry config */}
      <div className="border-t border-border pt-3 mt-1">
        <p className={cn(labelClass, 'mb-2')}>Retry Configuration</p>

        <div className="flex flex-col gap-2">
          <Field label="Max Attempts (1-5)">
            <input
              type="number"
              min={1}
              max={5}
              value={node.retry?.max_attempts ?? ''}
              onChange={(e): void => {
                const v = e.target.value;
                if (!v) {
                  onUpdate({ retry: undefined });
                } else {
                  onUpdate({
                    retry: {
                      max_attempts: Number(v),
                      delay_ms: node.retry?.delay_ms,
                      on_error: node.retry?.on_error,
                    },
                  });
                }
              }}
              placeholder="2"
              className={inputClass}
            />
          </Field>

          <Field label="Delay (ms, 1000-60000)">
            <input
              type="number"
              min={1000}
              max={60000}
              value={node.retry?.delay_ms ?? ''}
              onChange={(e): void => {
                const v = e.target.value;
                if (node.retry) {
                  onUpdate({
                    retry: {
                      ...node.retry,
                      delay_ms: v ? Number(v) : undefined,
                    },
                  });
                }
              }}
              placeholder="3000"
              disabled={!node.retry}
              className={cn(inputClass, !node.retry && 'opacity-50')}
            />
          </Field>

          <Field label="On Error">
            <select
              value={node.retry?.on_error ?? ''}
              onChange={(e): void => {
                if (node.retry) {
                  onUpdate({
                    retry: {
                      ...node.retry,
                      on_error: (e.target.value || undefined) as 'transient' | 'all' | undefined,
                    },
                  });
                }
              }}
              disabled={!node.retry}
              className={cn(selectClass, !node.retry && 'opacity-50')}
            >
              <option value="">Default (transient)</option>
              <option value="transient">transient</option>
              <option value="all">all</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

const TOOL_PRESETS: readonly {
  label: string;
  allowed: string[];
}[] = [
  { label: 'No tools', allowed: [] },
  { label: 'Read-only', allowed: ['Read', 'Glob', 'Grep'] },
  { label: 'Edit-only', allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] },
];

function ToolsTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  const currentMode = resolveToolsMode(node);

  const handleModeChange = (mode: ToolsMode): void => {
    if (mode === 'none') {
      onUpdate({ allowed_tools: undefined, denied_tools: undefined });
    } else if (mode === 'allow') {
      onUpdate({ allowed_tools: node.allowed_tools ?? [], denied_tools: undefined });
    } else {
      onUpdate({ allowed_tools: undefined, denied_tools: node.denied_tools ?? [] });
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <Field label="Mode">
        <div className="flex gap-1">
          {(['none', 'allow', 'deny'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={(): void => {
                handleModeChange(mode);
              }}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                currentMode === mode
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-surface-elevated text-text-secondary hover:text-text-primary'
              )}
            >
              {TOOLS_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Presets">
        <div className="flex flex-wrap gap-1">
          {TOOL_PRESETS.map(preset => (
            <button
              key={preset.label}
              type="button"
              onClick={(): void => {
                onUpdate({ allowed_tools: preset.allowed, denied_tools: undefined });
              }}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Allowed Tools">
        <input
          type="text"
          value={node.allowed_tools?.join(', ') ?? ''}
          onChange={(e): void => {
            onUpdate({ allowed_tools: parseToolsList(e.target.value) });
          }}
          placeholder="tool1, tool2..."
          className={inputClass}
        />
      </Field>

      <Field label="Denied Tools">
        <input
          type="text"
          value={node.denied_tools?.join(', ') ?? ''}
          onChange={(e): void => {
            onUpdate({ denied_tools: parseToolsList(e.target.value) });
          }}
          placeholder="tool1, tool2..."
          className={inputClass}
        />
      </Field>
    </div>
  );
}

function JsonTextareaField({
  label,
  value,
  placeholder,
  rows,
  onCommit,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  placeholder: string;
  rows: number;
  onCommit: (parsed: Record<string, unknown> | undefined) => void;
}): React.ReactElement {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback(
    (raw: string): void => {
      setText(raw);
      if (!raw.trim()) {
        setError(null);
        onCommit(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Expected a JSON object.');
          return;
        }
        setError(null);
        onCommit(parsed as Record<string, unknown>);
      } catch (e) {
        if (e instanceof SyntaxError) {
          setError(e.message);
        } else {
          throw e;
        }
      }
    },
    [onCommit]
  );

  return (
    <Field label={label}>
      <textarea
        value={text}
        onChange={(e): void => {
          handleChange(e.target.value);
        }}
        rows={rows}
        placeholder={placeholder}
        className={cn(textareaClass, 'min-h-[100px]')}
      />
      {error && <p className="text-[10px] text-error">{error}</p>}
    </Field>
  );
}

function isFixedRequestedModel(value: unknown): value is FixedNodeRequestedModel {
  const errors: string[] = [];
  return validateRequestedModel(value, 'requested model', errors) && value.source === 'fixed';
}

export function parseRequestedModelAlternatives(
  raw: string
): { value?: FixedNodeRequestedModel[]; error?: string } {
  if (!raw.trim()) return { value: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isFixedRequestedModel)) {
      return {
        error:
          'Expected a JSON array of valid fixed requested-model objects; Kady Current is not allowed in explicit fallbacks.',
      };
    }
    if (parsed.length > 8) return { error: 'At most eight fallback alternatives are allowed.' };
    return { value: parsed };
  } catch (error) {
    return { error: error instanceof SyntaxError ? error.message : String(error) };
  }
}

function RequestedModelAlternativesField({
  value,
  onCommit,
}: {
  value: NodeRequestedModel[];
  onCommit: (models: NodeRequestedModel[]) => void;
}): React.ReactElement {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  return (
    <Field label="Fallback alternatives (JSON)">
      <textarea
        value={text}
        rows={7}
        className={cn(textareaClass, 'min-h-[140px]')}
        onChange={(event): void => {
          const raw = event.target.value;
          setText(raw);
          const parsed = parseRequestedModelAlternatives(raw);
          if (parsed.error) {
            setError(parsed.error);
            return;
          }
          setError(null);
          onCommit(parsed.value ?? []);
        }}
      />
      {error && <p className="text-[10px] text-error">{error}</p>}
    </Field>
  );
}

function AdvancedTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-3">
      <JsonTextareaField
        label="Output Format (JSON Schema)"
        value={node.output_format}
        placeholder='{"type": "object", "properties": {...}}'
        rows={5}
        onCommit={(v): void => {
          onUpdate({ output_format: v });
        }}
      />

      <Field label="Skills">
        <input
          type="text"
          value={node.skills?.join(', ') ?? ''}
          onChange={(e): void => {
            onUpdate({ skills: parseToolsList(e.target.value) });
          }}
          placeholder="skill1, skill2..."
          className={inputClass}
        />
      </Field>

      <Field label="MCP Config Path">
        <input
          type="text"
          value={node.mcp ?? ''}
          onChange={(e): void => {
            onUpdate({ mcp: e.target.value || undefined });
          }}
          placeholder=".archon/mcp/github.json"
          className={cn(inputClass, 'font-mono')}
        />
        <p className="text-[9px] text-text-tertiary">
          Path relative to repo root. JSON matching SDK McpServerConfig format.
        </p>
      </Field>

      <JsonTextareaField
        label="Hooks (SDK SyncHookJSONOutput)"
        value={node.hooks as Record<string, unknown> | undefined}
        placeholder='{"PreToolUse": [{"matcher": "Bash", "response": {...}}]}'
        rows={5}
        onCommit={(v): void => {
          onUpdate({ hooks: v });
        }}
      />
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="border-t border-border pt-3 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
      {children}
    </p>
  );
}

function defaultFixedRequestedModel(): FixedNodeRequestedModel {
  return {
    source: 'fixed',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    auth: { kind: 'api-key' },
    reasoning: 'high',
  };
}

export function defaultFallbackFor(requested: NodeRequestedModel): FixedNodeRequestedModel {
  const candidates: FixedNodeRequestedModel[] = [
    {
      source: 'fixed',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      auth: { kind: 'api-key' },
      reasoning: requested.reasoning,
    },
    {
      source: 'fixed',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      auth: { kind: 'api-key' },
      reasoning: requested.reasoning,
    },
  ];
  const requestedIdentity = nodeRequestedModelIdentity(requested);
  return (
    candidates.find(candidate => nodeRequestedModelIdentity(candidate) !== requestedIdentity) ??
    candidates[0]
  );
}

export function createExplicitFallbackModelRequest(
  requested: NodeRequestedModel
): NodeModelRequest {
  const fixedRequested =
    requested.source === 'fixed' ? requested : defaultFixedRequestedModel();
  return {
    requested: fixedRequested,
    resolution: {
      mode: 'explicit-fallback',
      alternatives: [defaultFallbackFor(fixedRequested)],
      reason: 'Use the declared fallback if the primary model is unavailable.',
    },
  };
}

export function NodeSpecTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  const settings = node.settings;
  const model = settings?.model;
  const fixedRequested = model?.requested.source === 'fixed' ? model.requested : undefined;
  const inlineErrors = nodeSpecV1InlineErrors(settings);

  const commit = (updates: Partial<NodeSpecV1>): void => {
    onUpdate({ settings: mergeNodeSpecV1(settings, updates) });
  };

  const commitModel = (nextModel: NodeModelRequest | undefined): void => {
    commit({ model: nextModel });
  };

  const commitRequested = (requested: NodeRequestedModel): void => {
    commitModel({ requested, resolution: model?.resolution ?? { mode: 'exact' } });
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-[10px] leading-relaxed text-text-tertiary">
        Edits write the frozen per-node <code>settings</code> object. Values awaiting runtime
        binding remain editable; current server rejections appear below.
      </p>

      {inlineErrors.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-error/40 bg-error/10 p-2 text-[10px] text-error"
        >
          <p className="mb-1 font-semibold">NodeSpec validation</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {inlineErrors.map(error => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <Field label="NodeSpec version">
        <input value="1" readOnly disabled className={cn(inputClass, 'opacity-70')} />
      </Field>

      <SectionHeading>Model and authentication</SectionHeading>

      <Field label="Model source">
        <select
          data-testid="nodespec-model-source"
          value={model?.requested.source ?? 'inherit'}
          className={selectClass}
          onChange={(event): void => {
            const source = event.target.value;
            if (source === 'inherit') {
              commitModel(undefined);
            } else if (source === 'kady-current') {
              commitModel({
                requested: {
                  source: 'kady-current',
                  auth: { kind: 'kady-current' },
                  reasoning: model?.requested.reasoning ?? 'high',
                },
                resolution: { mode: 'exact' },
              });
            } else {
              commitModel({ requested: defaultFixedRequestedModel(), resolution: { mode: 'exact' } });
            }
          }}
        >
          <option value="inherit">Inherit node/default model</option>
          <option value="kady-current">Kady current</option>
          <option value="fixed">Fixed provider/model</option>
        </select>
      </Field>

      {fixedRequested && (
        <>
          <Field label="Provider">
            <input
              value={fixedRequested.provider}
              className={inputClass}
              placeholder="openrouter"
              onChange={(event): void => {
                commitRequested({ ...fixedRequested, provider: event.target.value });
              }}
            />
          </Field>
          <Field label="Model ID">
            <input
              value={fixedRequested.model}
              className={inputClass}
              placeholder="anthropic/claude-sonnet-4"
              onChange={(event): void => {
                commitRequested({ ...fixedRequested, model: event.target.value });
              }}
            />
          </Field>
          <Field label="Authentication">
            <select
              data-testid="nodespec-auth-kind"
              value={fixedRequested.auth.kind}
              className={selectClass}
              onChange={(event): void => {
                commitRequested({
                  ...fixedRequested,
                  auth: {
                    ...fixedRequested.auth,
                    kind: event.target.value as NodeAuthKind,
                  },
                });
              }}
            >
              <option value="api-key">API key</option>
              <option value="oauth">Subscription / OAuth</option>
              <option value="local">Local</option>
              <option value="custom">Custom</option>
            </select>
          </Field>
          <Field label="Auth profile">
            <input
              value={fixedRequested.auth.profile ?? ''}
              className={inputClass}
              placeholder="Optional profile"
              onChange={(event): void => {
                commitRequested({
                  ...fixedRequested,
                  auth: {
                    ...fixedRequested.auth,
                    profile: event.target.value || undefined,
                  },
                });
              }}
            />
          </Field>
        </>
      )}

      {model && (
        <>
          <Field label="Requested-model reasoning">
            <select
              value={model.requested.reasoning}
              className={selectClass}
              onChange={(event): void => {
                commitRequested({
                  ...model.requested,
                  reasoning: event.target.value as NodeReasoningLevel,
                });
              }}
            >
              {NODE_REASONING_LEVELS.map(level => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Resolution">
            <select
              value={model.resolution.mode}
              className={selectClass}
              onChange={(event): void => {
                if (event.target.value === 'exact') {
                  commitModel({ requested: model.requested, resolution: { mode: 'exact' } });
                } else {
                  commitModel(createExplicitFallbackModelRequest(model.requested));
                }
              }}
            >
              <option value="exact">Exact</option>
              <option
                value="explicit-fallback"
                disabled={model.requested.source === 'kady-current'}
              >
                Explicit fallback (fixed models only)
              </option>
            </select>
          </Field>
          {model.resolution.mode === 'explicit-fallback' && (
            <>
              <RequestedModelAlternativesField
                value={model.resolution.alternatives}
                onCommit={(alternatives): void => {
                  commitModel({
                    requested: model.requested,
                    resolution: {
                      mode: 'explicit-fallback',
                      alternatives,
                      reason:
                        model.resolution.mode === 'explicit-fallback'
                          ? model.resolution.reason
                          : '',
                    },
                  });
                }}
              />
              <Field label="Fallback reason">
                <textarea
                  value={model.resolution.reason}
                  rows={3}
                  className={textareaClass}
                  onChange={(event): void => {
                    commitModel({
                      requested: model.requested,
                      resolution: {
                        mode: 'explicit-fallback',
                        alternatives:
                          model.resolution.mode === 'explicit-fallback'
                            ? model.resolution.alternatives
                            : [],
                        reason: event.target.value,
                      },
                    });
                  }}
                />
              </Field>
            </>
          )}
        </>
      )}

      <Field label="Per-node reasoning effort">
        <select
          value={settings?.reasoningEffort ?? ''}
          className={selectClass}
          onChange={(event): void => {
            commit({
              reasoningEffort: (event.target.value || undefined) as
                | NodeReasoningLevel
                | undefined,
            });
          }}
        >
          <option value="">Inherit</option>
          {NODE_REASONING_LEVELS.map(level => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </Field>

      <SectionHeading>Hyperparameters and conditions</SectionHeading>

      <Field label="Temperature (0-2)">
        <input
          type="number"
          min={0}
          max={2}
          step="0.01"
          value={settings?.hyperparameters?.temperature ?? ''}
          className={inputClass}
          onChange={(event): void => {
            commit({
              hyperparameters: {
                ...settings?.hyperparameters,
                temperature: event.target.value ? Number(event.target.value) : undefined,
              },
            });
          }}
        />
      </Field>
      <Field label="Top p (0-1)">
        <input
          type="number"
          min={0}
          max={1}
          step="0.01"
          value={settings?.hyperparameters?.top_p ?? ''}
          className={inputClass}
          onChange={(event): void => {
            commit({
              hyperparameters: {
                ...settings?.hyperparameters,
                top_p: event.target.value ? Number(event.target.value) : undefined,
              },
            });
          }}
        />
      </Field>
      <JsonTextareaField
        label="Sampling overrides (JSON)"
        value={settings?.hyperparameters?.sampling}
        placeholder='{"seed": 42, "frequency_penalty": 0.2}'
        rows={4}
        onCommit={(sampling): void => {
          commit({
            hyperparameters: {
              ...settings?.hyperparameters,
              sampling: sampling as Record<string, NodeSamplingValue> | undefined,
            },
          });
        }}
      />
      <Field label="When condition">
        <textarea
          value={settings?.conditions?.when ?? ''}
          rows={3}
          className={textareaClass}
          placeholder="Harness condition expression"
          onChange={(event): void => {
            commit({
              conditions: {
                ...settings?.conditions,
                when: event.target.value || undefined,
              },
            });
          }}
        />
      </Field>
      <Field label="Required paths / inputs">
        <input
          value={settings?.conditions?.exists?.join(', ') ?? ''}
          className={inputClass}
          placeholder="artifact/report.md, named-input"
          onChange={(event): void => {
            commit({
              conditions: {
                ...settings?.conditions,
                exists: parseToolsList(event.target.value),
              },
            });
          }}
        />
      </Field>

      <SectionHeading>Harness topology and resources</SectionHeading>

      <Field label="CLI / harness">
        <select
          data-testid="nodespec-harness"
          value={settings?.harness ?? 'pi'}
          className={selectClass}
          onChange={(event): void => {
            commit({ harness: event.target.value as NodeSpecV1['harness'] });
          }}
        >
          {NODE_HARNESSES.map(harness => (
            <option key={harness} value={harness}>
              {harness}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Databases">
        <input
          value={settings?.databases?.join(', ') ?? ''}
          className={inputClass}
          placeholder="database/ref, corpus:v1"
          onChange={(event): void => {
            commit({ databases: parseToolsList(event.target.value) });
          }}
        />
      </Field>
      <Field label="Billing mode">
        <select
          value={settings?.billingMode ?? 'inherit'}
          className={selectClass}
          onChange={(event): void => {
            commit({ billingMode: event.target.value as NodeSpecV1['billingMode'] });
          }}
        >
          <option value="inherit">Inherit</option>
          <option value="api">API</option>
          <option value="subscription">Subscription</option>
        </select>
      </Field>

      <SectionHeading>Skills, subagents, and autonomy</SectionHeading>

      <Field label="Skills mode">
        <select
          value={settings?.skills?.mode ?? 'auto'}
          className={selectClass}
          onChange={(event): void => {
            commit({
              skills: {
                ...settings?.skills,
                mode: event.target.value as NodeSkillsMode,
              },
            });
          }}
        >
          {NODE_SKILLS_MODES.map(mode => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Skills list">
        <input
          value={settings?.skills?.list?.join(', ') ?? ''}
          className={inputClass}
          placeholder="literature-review, data-analysis"
          onChange={(event): void => {
            commit({
              skills: { ...settings?.skills, list: parseToolsList(event.target.value) },
            });
          }}
        />
      </Field>
      <Field label="Subagents mode">
        <select
          value={settings?.subagents?.mode ?? 'auto'}
          className={selectClass}
          onChange={(event): void => {
            commit({
              subagents: {
                mode: event.target.value as NodeSubagentMode,
              },
            });
          }}
        >
          {NODE_SUBAGENT_MODES.map(mode => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Autonomy">
        <select
          value={settings?.autonomy ?? 'strict'}
          className={selectClass}
          onChange={(event): void => {
            commit({ autonomy: event.target.value as NodeSpecV1['autonomy'] });
          }}
        >
          <option value="strict">Strict</option>
          <option value="loose">Loose</option>
        </select>
      </Field>

      <SectionHeading>Deliberation</SectionHeading>

      <Field label="Personality store ref">
        <input
          value={settings?.deliberation?.personalityStoreRef ?? ''}
          className={inputClass}
          placeholder="personalities/scientific-v1"
          onChange={(event): void => {
            commit({
              deliberation: {
                ...settings?.deliberation,
                personalityStoreRef: event.target.value || undefined,
              },
            });
          }}
        />
      </Field>
      <Field label="Best-of-N personality count (1-32)">
        <input
          type="number"
          min={1}
          max={32}
          value={settings?.deliberation?.bestOfNPersonalityCount ?? ''}
          className={inputClass}
          onChange={(event): void => {
            commit({
              deliberation: {
                ...settings?.deliberation,
                bestOfNPersonalityCount: event.target.value
                  ? Number(event.target.value)
                  : undefined,
              },
            });
          }}
        />
      </Field>
      <Field label="Mimeographs mode">
        <select
          value={settings?.deliberation?.mimeographs?.mode ?? 'auto'}
          className={selectClass}
          onChange={(event): void => {
            commit({
              deliberation: {
                ...settings?.deliberation,
                mimeographs: {
                  ...settings?.deliberation?.mimeographs,
                  mode: event.target.value as 'auto' | 'manual',
                },
              },
            });
          }}
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
      </Field>
      <Field label="Mimeograph personality refs">
        <input
          value={settings?.deliberation?.mimeographs?.personalityRefs?.join(', ') ?? ''}
          className={inputClass}
          placeholder="personality/optimist, personality/skeptic"
          onChange={(event): void => {
            commit({
              deliberation: {
                ...settings?.deliberation,
                mimeographs: {
                  ...settings?.deliberation?.mimeographs,
                  personalityRefs: parseToolsList(event.target.value),
                },
              },
            });
          }}
        />
      </Field>

      <SectionHeading>Budget</SectionHeading>

      <Field label="Max tokens">
        <input
          type="number"
          min={1}
          max={100_000_000}
          value={settings?.budget?.maxTokens ?? ''}
          className={inputClass}
          onChange={(event): void => {
            commit({
              budget: {
                ...settings?.budget,
                maxTokens: event.target.value ? Number(event.target.value) : undefined,
              },
            });
          }}
        />
      </Field>
      <Field label="Max cost (USD)">
        <input
          type="number"
          min={0}
          max={1_000_000}
          step="0.01"
          value={settings?.budget?.maxCostUsd ?? ''}
          className={inputClass}
          onChange={(event): void => {
            commit({
              budget: {
                ...settings?.budget,
                maxCostUsd: event.target.value ? Number(event.target.value) : undefined,
              },
            });
          }}
        />
      </Field>
    </div>
  );
}

function DagInspector({
  node,
  commands,
  onUpdate,
  onDelete,
  onClose,
}: NodeInspectorProps): React.ReactElement {
  const isBash = node.nodeType === 'bash';

  return (
    <div key={node.id} className="flex flex-col h-full border-l border-border bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="flex-1 truncate text-xs font-semibold text-text-primary">
          {node.label || node.id}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          className="h-6 shrink-0 px-2 text-[10px]"
          aria-label="Delete node"
        >
          Delete
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 px-1 text-sm leading-none text-text-tertiary hover:text-text-primary"
          title="Close inspector"
        >
          x
        </button>
      </div>

      {/* Tabbed content */}
      <Tabs defaultValue="general" className="flex-1 flex flex-col gap-0">
        <TabsList variant="line" className="w-full justify-start overflow-x-auto px-2 pt-1">
          <TabsTrigger value="general" className="text-xs">
            General
          </TabsTrigger>
          <TabsTrigger value="execution" className="text-xs">
            Execution
          </TabsTrigger>
          {!isBash && (
            <TabsTrigger value="tools" className="text-xs">
              Tools
            </TabsTrigger>
          )}
          {!isBash && (
            <TabsTrigger value="advanced" className="text-xs">
              Advanced
            </TabsTrigger>
          )}
          <TabsTrigger value="nodespec" className="text-xs">
            NodeSpec
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1">
          <TabsContent value="general">
            <GeneralTab node={node} commands={commands} onUpdate={onUpdate} />
          </TabsContent>

          <TabsContent value="execution">
            <ExecutionTab node={node} onUpdate={onUpdate} />
          </TabsContent>

          {!isBash && (
            <TabsContent value="tools">
              <ToolsTab node={node} onUpdate={onUpdate} />
            </TabsContent>
          )}

          {!isBash && (
            <TabsContent value="advanced">
              <AdvancedTab key={node.id} node={node} onUpdate={onUpdate} />
            </TabsContent>
          )}

          <TabsContent value="nodespec">
            <NodeSpecTab key={node.id} node={node} onUpdate={onUpdate} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}

export function NodeInspector(props: NodeInspectorProps): React.ReactElement {
  return (
    <DagInspector
      node={props.node}
      commands={props.commands}
      onUpdate={props.onUpdate}
      onDelete={props.onDelete}
      onClose={props.onClose}
    />
  );
}
