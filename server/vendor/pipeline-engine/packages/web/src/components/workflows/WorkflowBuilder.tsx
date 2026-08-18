import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useViewport,
} from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import type { NodeHarness, WorkflowDefinition, WorkflowSource } from '@/lib/api';

import { useProject } from '@/contexts/ProjectContext';
import {
  getWorkflow,
  listCommands,
  validateWorkflow,
  saveWorkflow,
  createConversation,
  runWorkflow,
} from '@/lib/api';
import type { CommandEntry } from '@/lib/api';
import { dagNodesToReactFlow } from '@/lib/dag-layout';
import { resolveWorkflowBuilderBinding } from '@/lib/workflow-builder-binding';
import { useBuilderKeyboard } from '@/hooks/useBuilderKeyboard';
import { useBuilderUndo } from '@/hooks/useBuilderUndo';
import { useBuilderValidation } from '@/hooks/useBuilderValidation';
import { useHostBridge, viewToFlow } from '@/host/HostBridge';
import type { ValidationIssue } from '@/hooks/useBuilderValidation';
import { BuilderToolbar } from './BuilderToolbar';
import type { ViewMode } from './BuilderToolbar';
import { NodeLibrary } from './NodeLibrary';
import type { QuickNodeType } from './NodeLibrary';
import {
  FIT_VIEW_OPTIONS,
  WorkflowCanvas,
  nextNodePosition,
  reactFlowToDagNodes,
} from './WorkflowCanvas';
import { NodeInspector } from './NodeInspector';
import { ValidationPanel } from './ValidationPanel';
import { StatusBar } from './StatusBar';
import { YamlCodeView } from './YamlCodeView';
import { CanvasChatPopout } from './CanvasChatPopout';
import type { DagNodeData, DagFlowNode } from './DagNodeComponent';

const NODE_LIBRARY_WIDTH_KEY = 'pipeline-engine:nodeLibraryWidth';
const NODE_LIBRARY_MIN_WIDTH = 160;
const NODE_LIBRARY_MAX_WIDTH = 400;
const NODE_LIBRARY_DEFAULT_WIDTH = 208; // w-52

function NodeLibraryPanel({
  commands,
  isLoading,
  onAddQuickNode,
}: {
  commands: CommandEntry[];
  isLoading: boolean;
  onAddQuickNode: (type: QuickNodeType, name: string, harness: NodeHarness) => void;
}): React.ReactElement {
  const [width, setWidth] = useState(() => {
    try {
      const stored = parseInt(localStorage.getItem(NODE_LIBRARY_WIDTH_KEY) ?? '', 10);
      return Number.isFinite(stored)
        ? Math.min(Math.max(stored, NODE_LIBRARY_MIN_WIDTH), NODE_LIBRARY_MAX_WIDTH)
        : NODE_LIBRARY_DEFAULT_WIDTH;
    } catch {
      return NODE_LIBRARY_DEFAULT_WIDTH;
    }
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      e.preventDefault();
    },
    [width]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(
        Math.max(startWidth.current + delta, NODE_LIBRARY_MIN_WIDTH),
        NODE_LIBRARY_MAX_WIDTH
      );
      setWidth(next);
    };
    const onMouseUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      setWidth(prev => {
        try {
          localStorage.setItem(NODE_LIBRARY_WIDTH_KEY, String(prev));
        } catch {
          // Storage unavailable or quota exceeded — width persists in memory only
        }
        return prev;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return (): void => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="relative shrink-0 h-full overflow-hidden flex" style={{ width }}>
      <div className="flex-1 overflow-hidden">
        <NodeLibrary
          commands={commands}
          isLoading={isLoading}
          onAddQuickNode={onAddQuickNode}
        />
      </div>
      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize node library panel"
        onMouseDown={onMouseDown}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
        title="Drag to resize"
      />
    </div>
  );
}

function WorkflowBuilderInner(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const editName = searchParams.get('edit');
  const boundCodebaseId = searchParams.get('codebaseId');
  const navigate = useNavigate();

  const { codebases, selectedProjectId } = useProject();
  const projectBinding = resolveWorkflowBuilderBinding(
    boundCodebaseId,
    selectedProjectId,
    codebases
  );
  const activeCodebaseId = projectBinding?.codebaseId;
  const cwd = projectBinding?.cwd;
  const saveDisabledReason =
    !activeCodebaseId || !cwd ? 'Open a workflow from the registry before saving' : undefined;
  const bindingKey = `${editName ?? ''}\u0000${activeCodebaseId ?? ''}\u0000${cwd ?? ''}`;

  // Core state
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [workflowSource, setWorkflowSource] = useState<WorkflowSource | undefined>(undefined);
  const [loadedWorkflowId, setLoadedWorkflowId] = useState<string | undefined>(undefined);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const [yamlViewMode, setYamlViewMode] = useState<ViewMode>('hidden');
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);

  // DAG state
  const [nodes, setNodes, onNodesChange] = useNodesState<DagFlowNode>([]);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- TSC infers never[] without explicit Edge
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const activeBindingKey = useRef(bindingKey);

  // Host mode (the Kady embed). Outside it every hook below is inert and the
  // builder behaves exactly as it does standalone.
  const host = useHostBridge();
  const appliedHostView = useRef<string | null>(null);
  const { detachCanvas } = host;
  /**
   * The canvas is about to show something the host did not push (an engine
   * pipeline). Forgetting the applied stamp matters as much as detaching: the
   * host may push the very same view again afterwards, and a stamp left behind
   * would make that push a no-op against a canvas that no longer shows it.
   */
  const leaveHostView = useCallback((): void => {
    appliedHostView.current = null;
    detachCanvas();
  }, [detachCanvas]);

  useEffect(() => {
    if (!host.hostMode || !host.view) return;
    // The host is authoritative: a pushed view REPLACES the canvas. Applying
    // the same view twice would clobber edits the author made since it landed.
    const stamp = `${host.view.documentId}\u0000${host.view.graphSha256 ?? ''}`;
    if (appliedHostView.current === stamp) return;
    appliedHostView.current = stamp;
    const projected = viewToFlow(host.view);
    setWorkflowName(host.view.name);
    setWorkflowDescription(host.view.description ?? '');
    setNodes(projected.nodes);
    setEdges(projected.edges);
    setSelectedNodeId(null);
    setHasUnsavedChanges(false);
  }, [host.hostMode, host.view, setNodes, setEdges]);

  // Loop state

  // Commands for palette/inspector
  const {
    data: commands,
    isError: commandsError,
    isLoading: commandsLoading,
  } = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => listCommands(cwd),
  });
  const commandList: CommandEntry[] = commands ?? [];

  const { pushSnapshot, undo, redo } = useBuilderUndo();
  const { zoom } = useViewport();
  const { fitView } = useReactFlow();

  const validationIssues = useBuilderValidation(workflowName, workflowDescription, nodes, edges);
  const errorCount = useMemo(
    () => validationIssues.filter(i => i.severity === 'error').length,
    [validationIssues]
  );
  const warningCount = useMemo(
    () => validationIssues.filter(i => i.severity === 'warning').length,
    [validationIssues]
  );

  const markDirty = useCallback((): void => {
    setHasUnsavedChanges(true);
  }, []);

  // Refs mirror the latest nodes/edges so snapshot-taking callbacks don't
  // close over stale values when events fire in the same tick as a render.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);

  // Report the canvas to the host, which diffs it into deltas against the view
  // it last pushed. Diffing there keeps every mutation path covered without a
  // hook in each handler.
  //
  // Depend on the two STABLE members, never on `host` itself: the hook returns a
  // fresh object every render, so `[host, …]` re-runs this effect on every
  // render and restarts the 250 ms delta debounce each time. On a busy page that
  // starves the timer and an edit silently never reaches the host.
  const { hostMode, syncCanvas } = host;
  useEffect(() => {
    if (!hostMode) return;
    syncCanvas(nodes, edges);
  }, [hostMode, syncCanvas, nodes, edges]);

  const pushSnapshotLatest = useCallback((): void => {
    pushSnapshot({ nodes: nodesRef.current, edges: edgesRef.current });
  }, [pushSnapshot]);

  const buildDefinition = useCallback((): WorkflowDefinition => {
    const name = workflowName.trim() || 'untitled';
    const description = workflowDescription;
    const dagNodes = reactFlowToDagNodes(nodes, edges);
    return {
      name,
      description,
      provider,
      model,
      nodes: dagNodes,
    };
  }, [workflowName, workflowDescription, provider, model, nodes, edges]);

  const loadWorkflow = useCallback(
    async (name: string, requestedBindingKey: string): Promise<void> => {
      if (!activeCodebaseId || !cwd) {
        setValidationErrors(['Select a project before loading a workflow.']);
        return;
      }
      try {
        const { workflow, source, workflowId } = await getWorkflow(name, cwd, activeCodebaseId);
        if (activeBindingKey.current !== requestedBindingKey) return;
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description);
        setProvider(workflow.provider);
        setModel(workflow.model);
        setWorkflowSource(source);
        setLoadedWorkflowId(workflowId);
        setValidationErrors([]);

        const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(workflow.nodes);
        setNodes(rfNodes);
        setEdges(rfEdges);

        setHasUnsavedChanges(false);
      } catch (err) {
        if (activeBindingKey.current !== requestedBindingKey) return;
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[workflow-builder] workflow.load_failed', {
          workflowName: name,
          codebaseId: activeCodebaseId,
          cwd,
          error,
        });
        setValidationErrors([`Failed to load workflow: ${error.message}`]);
      }
    },
    [activeCodebaseId, cwd, setNodes, setEdges]
  );

  // A builder URL is bound to one exact codebase. Reset before loading a new
  // binding so a slow response from the prior project cannot repopulate it.
  useEffect(() => {
    activeBindingKey.current = bindingKey;
    setWorkflowName('');
    setWorkflowDescription('');
    setProvider(undefined);
    setModel(undefined);
    setWorkflowSource(undefined);
    setLoadedWorkflowId(undefined);
    setHasUnsavedChanges(false);
    setValidationErrors([]);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    if (editName) void loadWorkflow(editName, bindingKey);
  }, [bindingKey, editName, loadWorkflow, setEdges, setNodes]);

  // A host-picked ENGINE pipeline goes through the builder's own loader, because
  // the engine document model is the iframe's, not the host's.
  useEffect(() => {
    if (!host.hostMode || !host.enginePipelineRequest) return;
    leaveHostView();
    void loadWorkflow(host.enginePipelineRequest.id, bindingKey);
  }, [host.hostMode, host.enginePipelineRequest, leaveHostView, loadWorkflow, bindingKey]);

  const handleToggleValidationPanel = useCallback((): void => {
    setValidationPanelOpen(v => !v);
  }, []);

  const handleNodeUpdate = useCallback(
    (updates: Partial<DagNodeData>): void => {
      setNodes(nds =>
        nds.map(n => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...updates } } : n))
      );
      markDirty();
    },
    [selectedNodeId, setNodes, markDirty]
  );

  const handleNodeDeleteById = useCallback(
    (nodeId: string): void => {
      pushSnapshotLatest();
      setNodes(nds => nds.filter(n => n.id !== nodeId));
      setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId(prev => (prev === nodeId ? null : prev));
      markDirty();
    },
    [setNodes, setEdges, markDirty, pushSnapshotLatest]
  );

  const handleNodeDelete = useCallback((): void => {
    if (!selectedNodeId) return;
    handleNodeDeleteById(selectedNodeId);
  }, [selectedNodeId, handleNodeDeleteById]);

  const addNode = useCallback(
    (nodeType: 'prompt' | 'bash', label: string, harness?: NodeHarness): void => {
      const id = `node-${crypto.randomUUID()}`;
      const newNode: DagFlowNode = {
        id,
        type: 'dagNode',
        position: nextNodePosition(nodesRef.current),
        data: {
          id,
          label,
          nodeType,
          ...(harness ? { settings: { harness } } : {}),
        },
      };
      pushSnapshotLatest();
      setNodes(nds => [...nds, newNode]);
      markDirty();
    },
    [pushSnapshotLatest, setNodes, markDirty]
  );

  /** Node library "add" button — the keyboard route for a harness-tagged node. */
  const handleAddQuickNode = useCallback(
    (type: QuickNodeType, name: string, harness: NodeHarness): void => {
      addNode(type, name, harness);
    },
    [addNode]
  );

  const handleFitView = useCallback((): void => {
    void fitView(FIT_VIEW_OPTIONS);
  }, [fitView]);

  // Toolbar action handlers
  const handleValidate = useCallback(async (): Promise<void> => {
    try {
      const def = buildDefinition();
      const result = await validateWorkflow(def);
      if (result.valid) {
        setValidationErrors([]);
      } else {
        setValidationErrors(result.errors ?? ['Unknown validation error']);
      }
      setValidationPanelOpen(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.validate_failed', { workflowName, error });
      setValidationErrors([`Validation request failed: ${error.message}`]);
    }
  }, [buildDefinition]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!workflowName.trim()) {
      setValidationErrors(['Workflow name is required']);
      return;
    }
    if (!activeCodebaseId || !cwd) {
      setValidationErrors(['Select a project before saving a workflow.']);
      setValidationPanelOpen(true);
      return;
    }
    const requestedBindingKey = activeBindingKey.current;
    try {
      const def = buildDefinition();
      const validation = await validateWorkflow(def);
      if (activeBindingKey.current !== requestedBindingKey) return;
      if (!validation.valid) {
        setValidationErrors(validation.errors ?? ['Workflow is invalid']);
        return;
      }
      setValidationErrors([]);
      const saved = await saveWorkflow(
        loadedWorkflowId ?? workflowName.trim(),
        def,
        cwd,
        workflowSource,
        activeCodebaseId
      );
      if (activeBindingKey.current !== requestedBindingKey) return;
      setLoadedWorkflowId(saved.workflowId);
      setHasUnsavedChanges(false);
    } catch (err) {
      if (activeBindingKey.current !== requestedBindingKey) return;
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.save_failed', { workflowName, cwd, error });
      setValidationErrors([`Save failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [activeCodebaseId, buildDefinition, workflowName, cwd, workflowSource, loadedWorkflowId]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!workflowName.trim() || hasUnsavedChanges) return;
    try {
      const result = await createConversation(activeCodebaseId ?? undefined);
      const conversationId = result.conversationId;
      await runWorkflow(loadedWorkflowId ?? workflowName.trim(), conversationId, '', cwd);
      navigate(`/legacy/chat/${conversationId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.run_failed', { workflowName, error });
      setValidationErrors([`Run failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [workflowName, loadedWorkflowId, hasUnsavedChanges, activeCodebaseId, navigate, cwd]);

  // Undo/redo handlers
  const handleUndo = useCallback((): void => {
    const state = undo();
    if (state) {
      setNodes(state.nodes);
      setEdges(state.edges);
    }
  }, [undo, setNodes, setEdges]);

  const handleRedo = useCallback((): void => {
    const state = redo();
    if (state) {
      setNodes(state.nodes);
      setEdges(state.edges);
    }
  }, [redo, setNodes, setEdges]);

  // Convert validation issues to string array for toolbar display
  const toolbarValidationErrors = useMemo(
    (): string[] => [
      ...validationErrors,
      ...validationIssues.filter(i => i.severity === 'error').map(i => i.message),
    ],
    [validationErrors, validationIssues]
  );

  // Convert validation issues for the panel (merge server-side errors with client-side)
  const allValidationIssues = useMemo((): ValidationIssue[] => {
    const serverIssues: ValidationIssue[] = validationErrors.map(msg => ({
      severity: 'error' as const,
      message: msg,
    }));
    return [...serverIssues, ...validationIssues];
  }, [validationErrors, validationIssues]);

  // Keyboard shortcuts — stabilize actions object to avoid re-registering handler on every render
  const keyboardActions = useMemo(
    () => ({
      onSave: (): void => void handleSave(),
      onUndo: handleUndo,
      onRedo: handleRedo,
      onToggleLibrary: (): void => {
        setShowLibrary(v => !v);
      },
      onToggleYaml: (): void => {
        setYamlViewMode(v => {
          const modes: ViewMode[] = ['hidden', 'split', 'full'];
          const idx = modes.indexOf(v);
          return modes[(idx + 1) % modes.length];
        });
      },
      onToggleValidation: handleToggleValidationPanel,
      onAddPrompt: (): void => {
        addNode('prompt', 'Prompt');
      },
      onAddBash: (): void => {
        addNode('bash', 'Shell');
      },
      onFitView: handleFitView,
      onDeleteSelected: (): void => {
        if (selectedNodeId) {
          handleNodeDelete();
        }
      },
      onDuplicateSelected: (): void => {
        if (!selectedNodeId) return;
        const sourceNode = nodes.find(n => n.id === selectedNodeId);
        if (!sourceNode) return;
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: sourceNode.position.x + 30, y: sourceNode.position.y + 30 },
          data: { ...sourceNode.data, id },
        };
        pushSnapshotLatest();
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
    }),
    [
      addNode,
      handleSave,
      handleUndo,
      handleRedo,
      handleToggleValidationPanel,
      handleNodeDelete,
      handleFitView,
      nodes,
      selectedNodeId,
      pushSnapshotLatest,
      setNodes,
      markDirty,
    ]
  );
  useBuilderKeyboard(keyboardActions, true);

  const selectedNode = selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null;

  return (
    <div className="flex flex-col h-full">
      <BuilderToolbar
        workflowName={workflowName}
        workflowDescription={workflowDescription}
        provider={provider}
        model={model}
        hasUnsavedChanges={hasUnsavedChanges}
        validationErrors={toolbarValidationErrors}
        viewMode={yamlViewMode}
        onNameChange={(n): void => {
          setWorkflowName(n);
          markDirty();
        }}
        onDescriptionChange={(d): void => {
          setWorkflowDescription(d);
          markDirty();
        }}
        onProviderChange={(p): void => {
          setProvider(p);
          markDirty();
        }}
        onModelChange={(m): void => {
          setModel(m);
          markDirty();
        }}
        onViewModeChange={setYamlViewMode}
        onValidate={(): void => {
          void handleValidate();
        }}
        onSave={(): void => {
          // Host-owned save applies only while the canvas is actually showing a
          // host-pushed document. In host mode with nothing pushed — a draft, or
          // an engine pipeline the author opened here — this builder still owns
          // its own document and must save it the way it always has.
          if (host.hostMode && host.view) {
            host.requestSave();
            return;
          }
          void handleSave();
        }}
        saveDisabledReason={host.hostMode && host.view ? undefined : saveDisabledReason}
        hostSourceGroups={host.sourceGroups}
        onLoadHostSource={host.requestSource}
        onRun={(): void => {
          void handleRun();
        }}
        onLoadWorkflow={(name): void => {
          if (host.hostMode) leaveHostView();
          void loadWorkflow(name, bindingKey);
        }}
      />

      {commandsError && (
        <div className="px-4 py-1.5 text-xs text-error bg-surface-inset border-b border-border">
          Failed to load commands. Command palette and dropdowns may be empty.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Node Library */}
        {showLibrary && (
          <NodeLibraryPanel
            commands={commandList}
            isLoading={commandsLoading}
            onAddQuickNode={handleAddQuickNode}
          />
        )}

        {/* Center area */}
        <div className="flex-1 relative overflow-hidden flex">
          {yamlViewMode === 'full' ? (
            <YamlCodeView definition={buildDefinition()} mode="full" />
          ) : (
            <>
              <div className="flex-1 relative overflow-hidden">
                <WorkflowCanvas
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  setNodes={setNodes}
                  setEdges={setEdges}
                  onNodeSelect={setSelectedNodeId}
                  onNodeDelete={handleNodeDeleteById}
                  onDirty={markDirty}
                  onPushSnapshot={pushSnapshotLatest}
                  commands={commandList}
                />
                {/* Floating chat pop-out, anchored to the canvas viewport */}
                <CanvasChatPopout selectedProjectId={selectedProjectId} />
              </div>

              {yamlViewMode === 'split' && (
                <div className="w-80 border-l border-border shrink-0">
                  <YamlCodeView definition={buildDefinition()} mode="split" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right panel: Node Inspector */}
        {selectedNodeId && selectedNode && yamlViewMode !== 'full' && (
          <div className="w-72 shrink-0">
            <NodeInspector
              node={selectedNode.data}
              commands={commandList}
              onUpdate={handleNodeUpdate}
              onDelete={handleNodeDelete}
              onClose={(): void => {
                setSelectedNodeId(null);
              }}
            />
          </div>
        )}
      </div>

      {/* Validation Panel */}
      <ValidationPanel
        issues={allValidationIssues}
        isOpen={validationPanelOpen}
        onToggle={handleToggleValidationPanel}
        onFocusNode={setSelectedNodeId}
      />

      {/* Status Bar */}
      <StatusBar
        nodeCount={nodes.length}
        edgeCount={edges.length}
        errorCount={errorCount}
        warningCount={warningCount}
        hasUnsavedChanges={hasUnsavedChanges}
        zoomLevel={Math.round(zoom * 100)}
        onValidationClick={handleToggleValidationPanel}
      />
    </div>
  );
}

export function WorkflowBuilder(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner />
    </ReactFlowProvider>
  );
}
