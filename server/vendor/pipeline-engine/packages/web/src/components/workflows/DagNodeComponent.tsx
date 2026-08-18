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

/**
 * Human labels for the frozen NodeSpec v1 `harness` union, used by every
 * "pick the CLI before you drag" control in the palette and the quick-add menu.
 *
 * The value side is exactly `HarnessSchema` in the engine
 * (server/src/workflows/schema.ts) — the ONLY harness vocabulary the runtime
 * dispatches on. Grok CLI is deliberately absent: it is not a member of that
 * frozen union, so offering it here would write a workflow document the engine
 * rejects. Adding it needs a NodeSpec v1 contract change, not a UI change.
 */
export const NODE_HARNESS_OPTIONS: readonly { value: NodeHarness; label: string }[] = [
  { value: 'pi', label: 'Pi (Kady)' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'copilot', label: 'Copilot' },
];

export const DEFAULT_NODE_HARNESS: NodeHarness = 'pi';

/**
 * The harnesses the vendored engine will actually accept on save today.
 *
 * `HarnessSchema` freezes the SHAPE of the union, but `node-spec-enforcement`
 * fails closed on every member that is not yet execution-bound
 * ([vendored-harness-unbound]), so a document authored with one of the other
 * four is rejected by PUT /api/workflows. The picker keeps the whole frozen
 * union visible — the vocabulary is the contract — but only offers the bound
 * members as selectable, so the builder cannot produce an unsavable graph in
 * two clicks. Widening this list is a runtime-binding change (lane W3's typed
 * route), never a UI change.
 */
export const ENGINE_BOUND_HARNESSES: readonly NodeHarness[] = ['pi'];

export function isHarnessBound(harness: NodeHarness): boolean {
  return ENGINE_BOUND_HARNESSES.includes(harness);
}

/** Why the non-Pi options are greyed out, said where the choice is made. */
export const HARNESS_UNBOUND_NOTE =
  'Save accepts Pi only until the typed route lands (lane W3).';

export function nodeHarnessLabel(harness: NodeHarness): string {
  return NODE_HARNESS_OPTIONS.find(option => option.value === harness)?.label ?? harness;
}

/**
 * Slim, keyboard-operable harness selector shared by the node library, the
 * legacy palette and the canvas quick-add menu. A native <select> is used on
 * purpose: it is compact enough for a 190px palette column and is operable with
 * the keyboard without re-implementing roving focus.
 */
export function HarnessSelect({
  value,
  onChange,
  label,
  id,
}: {
  value: NodeHarness;
  onChange: (harness: NodeHarness) => void;
  /** Accessible name, e.g. "CLI harness for the Prompt node". */
  label: string;
  id?: string;
}): React.ReactElement {
  return (
    <div className="min-w-0 flex-1">
      <select
        {...(id ? { id } : {})}
        data-testid="quick-node-harness"
        aria-label={label}
        title={label}
        value={value}
        onChange={(event): void => {
          onChange(event.target.value as NodeHarness);
        }}
        onClick={(event): void => {
          event.stopPropagation();
        }}
        className="w-full min-w-0 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent-bright"
      >
        {NODE_HARNESS_OPTIONS.map(option => (
          <option key={option.value} value={option.value} disabled={!isHarnessBound(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <p
        data-testid="quick-node-harness-note"
        className="mt-0.5 font-mono text-[9px] leading-tight text-warning"
      >
        {HARNESS_UNBOUND_NOTE}
      </p>
    </div>
  );
}

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

/**
 * Node details open ONLY through the explicit expand control.
 *
 * Hover used to open them (`isHovered || isPinned`), which had two owner-visible
 * consequences: the card exploded into a full NodeSpec panel just from moving
 * the pointer across the canvas, and the "expand +" control looked dead — you
 * can only click it while the pointer is on the card, so the panel it toggles
 * was already open, and "collapse -" left it open too. `isHovered` is kept in
 * the signature (and still drives the card's hover outline) so the hover state
 * stays a deliberate, testable non-input to this decision.
 */
export function shouldShowNodeDetails(_isHovered: boolean, isPinned: boolean): boolean {
  return isPinned;
}

export function nodeExpandControlLabel(isPinned: boolean): string {
  return isPinned ? 'collapse -' : 'expand +';
}

function MetadataPill({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex items-center rounded border border-border px-1 py-px font-mono text-[10px] font-medium text-text-secondary">
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
        'shrink-0 rounded px-1 py-px font-mono text-[10px] font-semibold',
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
    // Plain surface on purpose. This used to be wrapped in the CanvasUI fluid
    // simulation component (blue dye, pointer-driven splats), which painted the
    // owner's "blue smoke effect" straight over the NodeSpec text.
    <div
      data-testid="node-details-panel"
      className="nodrag nowheel w-[360px] max-h-[420px] overflow-hidden rounded-md border border-border bg-surface-elevated shadow-md"
    >
      <div className="max-h-[420px] overflow-auto p-3 text-[11px] text-text-secondary">
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
    </div>
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

  const toggleDetails = (): void => {
    setIsPinned(current => !current);
  };

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
          // Hairline card, Raindrop-slim: 1px border, small radius, no fills
          // beyond the type stripe. Hover is an affordance only (brighter
          // hairline) — it must never expand the card.
          'w-[180px] min-h-[56px] bg-surface border border-border rounded-md overflow-hidden cursor-pointer transition-colors flex',
          isHovered && !selected && 'border-border-bright',
          selected && 'border-primary ring-1 ring-primary'
        )}
      >
        <Handle type="target" position={Position.Top} className="!bg-accent !w-2 !h-2" />

        {/* Left color stripe */}
        <div className={cn('w-[3px] shrink-0', config.stripeColor)} />

        {/* Content area */}
        <div className="flex-1 min-w-0 px-2 py-1.5">
          {/* Row 1: type + harness badges. The harness name can be long
              ("claude-code"), so it truncates here rather than pushing the
              expand control off the fixed-width card. */}
          <div className="flex items-center gap-1">
            <NodeTypeBadge nodeType={data.nodeType} />
            <span
              data-testid="node-harness-badge"
              className="min-w-0 truncate rounded border border-border px-1 py-px font-mono text-[10px] uppercase text-text-secondary"
              title={`CLI harness: ${nodeHarnessLabel(settings.harness)}`}
            >
              {settings.harness}
            </span>
          </div>

          {/* Row 2: title + the expand control, which is always reachable. */}
          <div className="mt-1 flex items-center gap-1">
            <div
              data-testid="node-title"
              className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-text-primary"
              title={data.label}
            >
              {data.label}
            </div>
            <button
              type="button"
              data-testid="node-expand-control"
              className="nodrag shrink-0 rounded border border-transparent px-1 py-px font-mono text-[10px] font-semibold text-text-secondary hover:border-border hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-bright"
              aria-expanded={isPinned}
              aria-label={isPinned ? 'Collapse node details' : 'Expand full node details'}
              title={isPinned ? 'Collapse node details' : 'Expand full prompt and NodeSpec'}
              onPointerDown={(event): void => {
                event.stopPropagation();
              }}
              onKeyDown={(event): void => {
                // React Flow binds its own node-level key handling (Backspace
                // deletes, arrows nudge). Keep Enter/Space on the control.
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation();
                }
              }}
              onClick={(event): void => {
                event.stopPropagation();
                toggleDetails();
              }}
            >
              {nodeExpandControlLabel(isPinned)}
            </button>
          </div>

          {/* Content preview */}
          {preview && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">{preview}</div>
          )}

          {/* Metadata pills */}
          {hasPills && (
            <div className="mt-1 flex flex-wrap gap-1">
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
