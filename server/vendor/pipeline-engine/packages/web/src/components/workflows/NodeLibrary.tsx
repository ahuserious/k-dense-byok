import { useState, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { categorizeCommands } from '@/lib/command-categories';
import type { CommandEntry, NodeHarness } from '@/lib/api';
import { DEFAULT_NODE_HARNESS, HarnessSelect } from './DagNodeComponent';
import { HARNESS_DRAG_MIME } from './WorkflowCanvas';

export type QuickNodeType = 'prompt' | 'bash';

/** The two Quick Nodes, each with its own pre-drag harness choice. */
export const QUICK_NODES: readonly {
  type: QuickNodeType;
  /** Payload name the canvas turns into the node label. */
  name: string;
  displayName: string;
}[] = [
  { type: 'prompt', name: 'Prompt', displayName: 'Prompt' },
  { type: 'bash', name: 'Shell', displayName: 'Bash' },
];

interface NodeLibraryProps {
  commands: CommandEntry[];
  isLoading: boolean;
  /**
   * Keyboard/click path for adding a quick node with its selected harness.
   * Dragging is pointer-only, so the same choice needs a non-pointer route.
   */
  onAddQuickNode?: (type: QuickNodeType, name: string, harness: NodeHarness) => void;
}

const NODE_TYPE_COLORS: Record<string, string> = {
  command: 'bg-node-command',
  prompt: 'bg-node-prompt',
  bash: 'bg-node-bash',
};

function onDragStart(
  e: React.DragEvent,
  type: 'command' | 'prompt' | 'bash',
  name: string,
  harness?: NodeHarness
): void {
  e.dataTransfer.setData('application/reactflow-type', type);
  e.dataTransfer.setData('application/reactflow-command', name);
  if (harness) e.dataTransfer.setData(HARNESS_DRAG_MIME, harness);
  e.dataTransfer.effectAllowed = 'move';
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-7 rounded-md bg-surface-elevated animate-pulse" />
      ))}
    </div>
  );
}

function DraggableItem({
  type,
  name,
  displayName,
}: {
  type: 'command' | 'prompt' | 'bash';
  name: string;
  displayName: string;
}): React.ReactElement {
  return (
    <div
      draggable
      onDragStart={(e): void => {
        onDragStart(e, type, name);
      }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary"
    >
      <span className={cn('w-2 h-2 rounded-full shrink-0', NODE_TYPE_COLORS[type])} />
      <span className="font-mono truncate">{displayName}</span>
    </div>
  );
}

/**
 * A Quick Node card: pick the CLI harness FIRST, then drag (or press Add).
 * The selected harness rides along in the drag payload and lands in the new
 * node's `settings.harness`, so the card badge and the saved YAML agree.
 */
function QuickNodeCard({
  type,
  name,
  displayName,
  onAdd,
}: {
  type: QuickNodeType;
  name: string;
  displayName: string;
  onAdd?: (type: QuickNodeType, name: string, harness: NodeHarness) => void;
}): React.ReactElement {
  const [harness, setHarness] = useState<NodeHarness>(DEFAULT_NODE_HARNESS);

  return (
    <div
      data-testid={`quick-node-${type}`}
      draggable
      onDragStart={(e): void => {
        onDragStart(e, type, name, harness);
      }}
      className="flex cursor-grab flex-col gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-text-primary hover:border-accent-bright"
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', NODE_TYPE_COLORS[type])} />
        <span className="truncate font-mono">{displayName}</span>
      </div>
      <div className="flex items-center gap-1">
        <HarnessSelect
          value={harness}
          onChange={setHarness}
          label={`CLI harness for the ${displayName} quick node`}
        />
        {onAdd && (
          <button
            type="button"
            data-testid={`quick-node-add-${type}`}
            onClick={(): void => {
              onAdd(type, name, harness);
            }}
            title={`Add a ${displayName} node running on ${harness}`}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-bright"
          >
            add
          </button>
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={(): void => {
          setOpen(!open);
        }}
        className="flex items-center gap-1 px-1 py-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wide hover:text-text-secondary"
      >
        <span className="text-text-tertiary">{open ? '\u25BE' : '\u25B8'}</span>
        <span>{title}</span>
        <span className="text-text-tertiary ml-auto">({count})</span>
      </button>
      {open && <div className="flex flex-col gap-1 pl-1">{children}</div>}
    </div>
  );
}

export function NodeLibrary({
  commands,
  isLoading,
  onAddQuickNode,
}: NodeLibraryProps): React.ReactElement {
  const [search, setSearch] = useState('');

  const categories = useMemo(() => categorizeCommands(commands), [commands]);

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return categories;
    const term = search.toLowerCase();
    return categories
      .map(cat => ({
        ...cat,
        commands: cat.commands.filter(cmd => cmd.name.toLowerCase().includes(term)),
      }))
      .filter(cat => cat.commands.length > 0);
  }, [categories, search]);

  const showQuickNodes =
    !search.trim() ||
    'prompt'.includes(search.toLowerCase()) ||
    'bash'.includes(search.toLowerCase());

  return (
    <div className="flex flex-col h-full overflow-hidden border-r border-border bg-surface">
      {/* Header */}
      <div className="border-b border-border px-2.5 py-1.5">
        <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
          Node Library
        </h3>
        <input
          type="text"
          value={search}
          onChange={(e): void => {
            setSearch(e.target.value);
          }}
          placeholder="Search..."
          className="h-7 w-full rounded border border-border bg-surface-elevated px-2 font-mono text-[11px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent-bright"
        />
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : (
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="flex flex-col gap-2 p-2">
            {/* Quick Nodes */}
            {showQuickNodes && (
              <CollapsibleSection title="Quick Nodes" count={QUICK_NODES.length} defaultOpen>
                {QUICK_NODES.map(quickNode => (
                  <QuickNodeCard
                    key={quickNode.type}
                    type={quickNode.type}
                    name={quickNode.name}
                    displayName={quickNode.displayName}
                    {...(onAddQuickNode ? { onAdd: onAddQuickNode } : {})}
                  />
                ))}
              </CollapsibleSection>
            )}

            {/* Command categories */}
            {filteredCategories.map(category => (
              <CollapsibleSection
                key={category.name}
                title={category.name}
                count={category.commands.length}
                defaultOpen={category.name === 'Project'}
              >
                {category.commands.map(cmd => (
                  <DraggableItem
                    key={cmd.name}
                    type="command"
                    name={cmd.name}
                    displayName={cmd.name}
                  />
                ))}
              </CollapsibleSection>
            ))}

            {filteredCategories.length === 0 && !showQuickNodes && (
              <p className="text-xs text-text-tertiary px-2 py-4 text-center">No matching nodes</p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
