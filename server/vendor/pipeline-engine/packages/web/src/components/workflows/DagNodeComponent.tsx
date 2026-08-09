import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type {
  DagNode,
  NodeHarness,
  NodeModelRequest,
  NodeReasoningLevel,
  NodeSamplingValue,
  NodeSkillsMode,
  NodeSpecV1,
  NodeSubagentMode,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Liquid } from '@/components/canvasui/Liquid';

export type {
  FixedNodeRequestedModel,
  KadyCurrentNodeRequestedModel,
  NodeAuthKind,
  NodeHarness,
  NodeModelRequest,
  NodeReasoningLevel,
  NodeRequestedModel,
  NodeSamplingValue,
  NodeSkillsMode,
  NodeSpecV1,
  NodeSubagentMode,
} from '@/lib/api';

export const NODE_REASONING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const NODE_AUTH_KINDS = ['api-key', 'oauth', 'local', 'custom'] as const;
export const NODE_HARNESSES = ['pi', 'claude-code', 'codex', 'opencode', 'copilot'] as const;
export const NODE_SKILLS_MODES = ['auto', 'auto-manual', 'manual'] as const;
export const NODE_SUBAGENT_MODES = ['auto', 'auto-manual'] as const;

export interface ResolvedNodeSpecV1 {
  version: 1;
  model?: NodeModelRequest;
  reasoningEffort: NodeReasoningLevel;
  hyperparameters: {
    temperature: number;
    top_p: number;
    sampling: Record<string, NodeSamplingValue>;
  };
  conditions: { when?: string; exists: string[] };
  harness: NodeHarness;
  databases: string[];
  skills: { mode: NodeSkillsMode; list: string[] };
  subagents: { mode: NodeSubagentMode };
  autonomy: 'strict' | 'loose';
  deliberation: {
    personalityStoreRef?: string;
    bestOfNPersonalityCount: number;
    mimeographs: { mode: 'auto' | 'manual'; personalityRefs: string[] };
  };
  billingMode: 'inherit' | 'api' | 'subscription';
  budget: { maxTokens?: number; maxCostUsd?: number };
}

export interface DagNodeData extends DagNode {
  /** For command nodes: the command name. For prompt nodes: display label ("Prompt"). For bash: display label ("Shell"). */
  label: string;
  nodeType: 'command' | 'prompt' | 'bash' | 'loop' | 'approval';
  promptText?: string;
  bashScript?: string;
  bashTimeout?: number;
  /** Frozen typed-node settings edited by the Scientific DAG Studio inspector. */
  settings?: NodeSpecV1;
  /** Required by React Flow's Node<T> constraint — do not rely on this for typed access. */
  [key: string]: unknown;
}

export type DagFlowNode = Node<DagNodeData>;

export const TYPE_CONFIG = {
  command: {
    badge: 'CMD',
    stripeColor: 'bg-node-command',
    badgeBg: 'bg-node-command/20',
    badgeText: 'text-node-command',
  },
  prompt: {
    badge: 'PROMPT',
    stripeColor: 'bg-node-prompt',
    badgeBg: 'bg-node-prompt/20',
    badgeText: 'text-node-prompt',
  },
  bash: {
    badge: 'BASH',
    stripeColor: 'bg-node-bash',
    badgeBg: 'bg-node-bash/20',
    badgeText: 'text-node-bash',
  },
  loop: {
    badge: 'LOOP',
    stripeColor: 'bg-node-loop',
    badgeBg: 'bg-node-loop/20',
    badgeText: 'text-node-loop',
  },
  approval: {
    badge: 'APPROVAL',
    stripeColor: 'bg-node-approval',
    badgeBg: 'bg-node-approval/20',
    badgeText: 'text-node-approval',
  },
} as const;

export function getContentPreview(data: DagNodeData): string {
  switch (data.nodeType) {
    case 'command':
      return data.label;
    case 'prompt':
    case 'loop':
      return data.promptText?.split('\n')[0] ?? '';
    case 'bash':
      return data.bashScript?.split('\n')[0] ?? '';
    case 'approval':
      return '';
  }
}

export function getFullPrompt(data: DagNodeData): string {
  switch (data.nodeType) {
    case 'prompt':
    case 'loop':
      return data.promptText ?? '';
    case 'bash':
      return data.bashScript ?? '';
    case 'command':
      return data.label;
    case 'approval':
      return data.approval?.message ?? '';
  }
}

export function resolveNodeSpecProjection(settings?: NodeSpecV1): ResolvedNodeSpecV1 {
  const deliberation = settings?.deliberation;
  const mimeographs = deliberation?.mimeographs;
  return {
    version: 1,
    ...(settings?.model ? { model: settings.model } : {}),
    reasoningEffort:
      settings?.reasoningEffort ?? settings?.model?.requested.reasoning ?? 'high',
    hyperparameters: {
      temperature: settings?.hyperparameters?.temperature ?? 1,
      top_p: settings?.hyperparameters?.top_p ?? 1,
      sampling: settings?.hyperparameters?.sampling ?? {},
    },
    conditions: {
      ...(settings?.conditions?.when ? { when: settings.conditions.when } : {}),
      exists: settings?.conditions?.exists ?? [],
    },
    harness: settings?.harness ?? 'pi',
    databases: settings?.databases ?? [],
    skills: {
      mode: settings?.skills?.mode ?? 'auto',
      list: settings?.skills?.list ?? [],
    },
    subagents: { mode: settings?.subagents?.mode ?? 'auto' },
    autonomy: settings?.autonomy ?? 'strict',
    deliberation: {
      ...(deliberation?.personalityStoreRef
        ? { personalityStoreRef: deliberation.personalityStoreRef }
        : {}),
      bestOfNPersonalityCount: deliberation?.bestOfNPersonalityCount ?? 2,
      mimeographs: {
        mode: mimeographs?.mode ?? 'auto',
        personalityRefs: mimeographs?.personalityRefs ?? [],
      },
    },
    billingMode: settings?.billingMode ?? 'inherit',
    budget: {
      ...(settings?.budget?.maxTokens !== undefined
        ? { maxTokens: settings.budget.maxTokens }
        : {}),
      ...(settings?.budget?.maxCostUsd !== undefined
        ? { maxCostUsd: settings.budget.maxCostUsd }
        : {}),
    },
  };
}

export function formatNodeModel(model: NodeModelRequest | undefined, legacyModel?: string): string {
  if (!model) return legacyModel || 'Inherited';
  if (model.requested.source === 'kady-current') return 'Kady current';
  return `${model.requested.provider}/${model.requested.model}`;
}

export function shouldShowNodeDetails(isHovered: boolean, isPinned: boolean): boolean {
  return isHovered || isPinned;
}

export function nodeExpandControlLabel(isPinned: boolean): string {
  return isPinned ? 'collapse -' : 'expand +';
}

function MetadataPill({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-surface-inset text-text-secondary">
      {children}
    </span>
  );
}

export function NodeTypeBadge({ nodeType }: { nodeType: DagNodeData['nodeType'] }): React.ReactElement {
  const config = TYPE_CONFIG[nodeType];
  return (
    <span
      data-testid="node-type-badge"
      className={cn(
        'text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0',
        config.badgeBg,
        config.badgeText
      )}
    >
      {config.badge}
    </span>
  );
}

export function NodeDetailsSurface({ data }: { data: DagNodeData }): React.ReactElement {
  const settings = resolveNodeSpecProjection(data.settings);
  const prompt = getFullPrompt(data);
  return (
    <Liquid
      className="nodrag nowheel w-[360px] max-h-[420px] overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-2xl"
      simResolution={64}
      dyeResolution={256}
      intensity={1.25}
      distortion={0.2}
      blend={3}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-[10px] text-text-secondary">
        <div className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1">
          <span className="uppercase tracking-wide text-text-tertiary">Model</span>
          <span className="break-all text-text-primary">
            {formatNodeModel(settings.model, data.model)}
          </span>
          <span className="uppercase tracking-wide text-text-tertiary">Reasoning</span>
          <span className="text-text-primary">{settings.reasoningEffort}</span>
          <span className="uppercase tracking-wide text-text-tertiary">Hyperparams</span>
          <span className="break-all font-mono text-text-primary">
            {JSON.stringify(settings.hyperparameters)}
          </span>
        </div>

        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 uppercase tracking-wide text-text-tertiary">Full prompt</p>
          <pre className="whitespace-pre-wrap break-words rounded bg-surface-inset p-2 font-mono text-text-primary">
            {prompt || '(none)'}
          </pre>
        </div>

        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 uppercase tracking-wide text-text-tertiary">Resolved NodeSpec v1</p>
          <pre className="whitespace-pre-wrap break-words rounded bg-surface-inset p-2 font-mono text-text-primary">
            {JSON.stringify(settings, null, 2)}
          </pre>
        </div>
      </div>
    </Liquid>
  );
}

export function DagNodeRender({ data, selected }: NodeProps<DagFlowNode>): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const config = TYPE_CONFIG[data.nodeType];
  const preview = getContentPreview(data);
  const settings = resolveNodeSpecProjection(data.settings);
  const hasPills =
    data.model ||
    data.output_format ||
    data.when ||
    (data.trigger_rule && data.trigger_rule !== 'all_success') ||
    (data.skills && data.skills.length > 0) ||
    data.mcp;
  const showDetails = shouldShowNodeDetails(isHovered, isPinned);

  return (
    <div
      className="relative w-[180px]"
      onMouseEnter={(): void => {
        setIsHovered(true);
      }}
      onMouseLeave={(): void => {
        setIsHovered(false);
      }}
    >
      <div
        className={cn(
          'w-[180px] bg-surface border border-border rounded-lg overflow-hidden cursor-pointer transition-all flex',
          selected && 'border-primary ring-1 ring-primary'
        )}
      >
        <Handle type="target" position={Position.Top} className="!bg-accent !w-2 !h-2" />

        {/* Left color stripe */}
        <div className={cn('w-[3px] shrink-0', config.stripeColor)} />

        {/* Content area */}
        <div className="flex-1 min-w-0 px-2.5 py-2">
          {/* Header: type + harness topology + label */}
          <div className="flex items-center gap-1 mb-1">
            <NodeTypeBadge nodeType={data.nodeType} />
            <span
              data-testid="node-harness-badge"
              className="shrink-0 rounded bg-surface-inset px-1 py-0.5 text-[8px] font-semibold uppercase text-text-secondary"
              title={`Harness topology: ${settings.harness}`}
            >
              {settings.harness}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
              {data.label}
            </span>
            <button
              type="button"
              className="nodrag shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              aria-expanded={showDetails}
              aria-label={isPinned ? 'Collapse node details' : 'Expand full node details'}
              title={isPinned ? 'Collapse node details' : 'Expand full prompt and NodeSpec'}
              onPointerDown={(event): void => {
                event.stopPropagation();
              }}
              onClick={(event): void => {
                event.stopPropagation();
                setIsPinned(current => !current);
              }}
            >
              {nodeExpandControlLabel(isPinned)}
            </button>
          </div>

          {/* Content preview */}
          {preview && (
            <div className="mb-1 truncate font-mono text-[10px] text-text-tertiary">{preview}</div>
          )}

          {/* Metadata pills */}
          {hasPills && (
            <div className="flex flex-wrap gap-1">
              {data.model && <MetadataPill>{data.model}</MetadataPill>}
              {data.output_format && <MetadataPill>{'{}'} JSON</MetadataPill>}
              {data.when && <MetadataPill>when</MetadataPill>}
              {data.trigger_rule && data.trigger_rule !== 'all_success' && (
                <MetadataPill>{data.trigger_rule}</MetadataPill>
              )}
              {data.skills && data.skills.length > 0 && <MetadataPill>skills</MetadataPill>}
              {data.mcp && <MetadataPill>mcp</MetadataPill>}
            </div>
          )}
        </div>

        <Handle type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2" />
      </div>

      {showDetails && (
        <div className="absolute left-0 top-full z-50 mt-1" data-testid="node-details-surface">
          <NodeDetailsSurface data={data} />
        </div>
      )}
    </div>
  );
}

// memo() for React Flow performance; exported as a named function component
export const dagNodeComponent = memo(DagNodeRender);
