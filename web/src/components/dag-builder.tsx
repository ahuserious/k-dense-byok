"use client";

import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  NetworkIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DagBuilderCanvas } from "@/components/dag-builder-canvas";
import { HelperAgentChat } from "@/components/helper-agent-chat";
import {
  DagEdgeInspector,
  DagGraphInspector,
  DagNodeInspector,
} from "@/components/dag-builder-inspector";
import {
  WORKFLOW_NODE_KINDS,
  addDefaultNode,
  addWorkflowEdge,
  cloneWorkflowGraph,
  nodeKindLabel,
  removeWorkflowEdge,
  removeWorkflowNode,
  replaceWorkflowNode,
  updateNodePosition,
  type WorkflowNodeKind,
} from "@/lib/dag-workflow-builder";
import {
  createDagWorkflowRun,
  DagWorkflowApiError,
  MAX_WORKFLOW_RUN_GOAL_LENGTH,
  readDagWorkflowDefinition,
  saveDagWorkflowDefinition,
  type VersionedDagWorkflowDefinition,
  type WorkflowEdgeCondition,
  type WorkflowGraphDocument,
  type WorkflowGraphNode,
  type WorkflowNodePosition,
} from "@/lib/dag-workflows";
import { useModels } from "@/lib/use-models";

function builderErrorMessage(error: unknown, operation: "save" | "run" = "save"): string {
  if (error instanceof DagWorkflowApiError) {
    if (error.status === 409) {
      return operation === "run"
        ? `Run conflict: ${error.detail} Reload the latest saved revision before running.`
        : `Save conflict: ${error.detail} Your unsaved draft is still open.`;
    }
    return error.code ? `${error.code}: ${error.detail}` : error.detail;
  }
  return error instanceof Error ? error.message : "Unable to save the DAG workflow.";
}

function snapshotIdentity(
  projectId: string,
  selectedDefinition: VersionedDagWorkflowDefinition | null,
): string {
  if (!selectedDefinition) return `${projectId}:none`;
  const stored = selectedDefinition.definition;
  return `${projectId}:${stored.id}:${stored.revision}:${stored.graphSha256}`;
}

export function DagBuilder({
  projectId,
  selectedDefinition,
  activeSessionId,
  budgetBlocked,
  onDefinitionChanged,
}: {
  projectId: string;
  selectedDefinition: VersionedDagWorkflowDefinition | null;
  activeSessionId: string | null;
  budgetBlocked: boolean;
  onDefinitionChanged: (definition: VersionedDagWorkflowDefinition) => void;
}) {
  const { models: modelInventory } = useModels();
  const [draft, setDraft] = useState<WorkflowGraphDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeKindToAdd, setNodeKindToAdd] = useState<WorkflowNodeKind>("agent");
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [runGoal, setRunGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const identity = snapshotIdentity(projectId, selectedDefinition);

  useEffect(() => {
    if (!selectedDefinition) {
      setDraft(null);
      setDirty(false);
      setSelectedNodeId(null);
      setError(null);
      setNotice(null);
      setRunGoal("");
      setLaunching(false);
      return;
    }
    const nextGraph = cloneWorkflowGraph(selectedDefinition.definition.graph);
    setDraft(nextGraph);
    setDirty(false);
    setSelectedNodeId(nextGraph.entryNodeId);
    setError(null);
    setNotice(null);
    setRunGoal("");
    setLaunching(false);
  }, [identity, selectedDefinition]);

  const selectedNode = useMemo(() => (
    draft?.nodes.find((node) => node.id === selectedNodeId) ?? null
  ), [draft, selectedNodeId]);

  const updateDraft = useCallback((nextGraph: WorkflowGraphDocument) => {
    setDraft(nextGraph);
    setDirty(true);
    setError(null);
    setNotice(null);
  }, []);

  const save = async () => {
    if (!draft || !selectedDefinition || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveDagWorkflowDefinition(
        projectId,
        selectedDefinition.definition.id,
        draft,
        selectedDefinition.definition.revision,
      );
      const savedGraph = cloneWorkflowGraph(saved.definition.graph);
      setDraft(savedGraph);
      setDirty(false);
      setNotice(`Saved revision ${saved.definition.revision}.`);
      onDefinitionChanged(saved);
    } catch (caught) {
      setError(builderErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const discardAndReload = async () => {
    if (!selectedDefinition || reloading) return;
    setReloading(true);
    setError(null);
    setNotice(null);
    try {
      const latest = await readDagWorkflowDefinition(
        projectId,
        selectedDefinition.definition.id,
      );
      onDefinitionChanged(latest);
      const latestGraph = cloneWorkflowGraph(latest.definition.graph);
      setDraft(latestGraph);
      setDirty(false);
      setSelectedNodeId(latestGraph.entryNodeId);
      setNotice(`Loaded revision ${latest.definition.revision}; the previous draft was discarded.`);
    } catch (caught) {
      setError(builderErrorMessage(caught));
    } finally {
      setReloading(false);
    }
  };

  const launchRun = async () => {
    if (
      !selectedDefinition ||
      dirty ||
      saving ||
      reloading ||
      launching ||
      budgetBlocked
    ) {
      return;
    }
    setLaunching(true);
    setError(null);
    setNotice(null);
    try {
      const goal = runGoal.trim();
      const run = await createDagWorkflowRun(
        projectId,
        selectedDefinition.definition.id,
        {
          requestId: crypto.randomUUID(),
          expectedWorkflowRevision: selectedDefinition.definition.revision,
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(goal ? { input: { goal } } : {}),
        },
      );
      setNotice(
        `Created run ${run.manifest.id} with status ${run.state.status}. Open Console for runner progress.`,
      );
    } catch (caught) {
      setError(builderErrorMessage(caught, "run"));
    } finally {
      setLaunching(false);
    }
  };

  if (!selectedDefinition || !draft) {
    return (
      <section className="flex h-full min-h-0" aria-labelledby="dag-builder-title">
        <div className="flex min-w-0 flex-1 items-center justify-center p-8">
          <div className="w-full max-w-xl rounded-xl border border-dashed bg-muted/10 px-6 py-8 text-center">
            <NetworkIcon className="mx-auto size-7 text-primary" />
            <h1 id="dag-builder-title" className="mt-3 text-sm font-semibold">DAG Builder</h1>
            <p className="mt-2 text-xs text-muted-foreground">
              Select or create a project graph in DAG Workflows to edit it here.
            </p>
          </div>
        </div>
        <aside className="w-[390px] shrink-0 border-l" aria-label="DAG Builder agent">
          <HelperAgentChat
            projectId={projectId}
            profile="dag-builder"
          />
        </aside>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-labelledby="dag-builder-title">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <NetworkIcon className="size-4 text-primary" />
            <h1 id="dag-builder-title" className="truncate text-sm font-semibold">{draft.name}</h1>
            <span
              data-testid="dag-dirty-state"
              className={dirty
                ? "rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                : "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"}
            >
              {dirty ? "Unsaved changes" : "Saved"}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {selectedDefinition.definition.id} · revision {selectedDefinition.definition.revision} · project {projectId}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Run goal"
            type="text"
            value={runGoal}
            maxLength={MAX_WORKFLOW_RUN_GOAL_LENGTH}
            disabled={saving || reloading || launching}
            onChange={(event) => setRunGoal(event.target.value)}
            placeholder="Optional run goal"
            className="w-52 rounded-md border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground"
          />
          <select
            aria-label="Node kind to add"
            className="rounded-md border bg-background px-2 py-1.5 text-xs"
            value={nodeKindToAdd}
            disabled={saving || reloading || launching}
            onChange={(event) => setNodeKindToAdd(event.target.value as WorkflowNodeKind)}
          >
            {WORKFLOW_NODE_KINDS.map((kind) => <option key={kind} value={kind}>{nodeKindLabel(kind)}</option>)}
          </select>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40"
            disabled={saving || reloading || launching}
            onClick={() => {
              try {
                const added = addDefaultNode(draft, nodeKindToAdd);
                updateDraft(added.graph);
                setSelectedNodeId(added.nodeId);
              } catch (caught) {
                setError(builderErrorMessage(caught));
              }
            }}
          >
            <PlusIcon className="size-3" /> Add node
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40"
            disabled={!dirty || saving || reloading || launching}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircleIcon className="size-3 animate-spin" /> : <SaveIcon className="size-3" />}
            Save
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={dirty || saving || reloading || launching || budgetBlocked}
            title={
              budgetBlocked
                ? "Project spend limit reached"
                : dirty
                  ? "Save this draft before starting a run"
                  : activeSessionId
                    ? "Run the saved revision using the active Kady session"
                    : "Run the saved revision using the configured Kady default model"
            }
            onClick={() => void launchRun()}
          >
            {launching ? <LoaderCircleIcon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
            Run
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
            disabled={saving || reloading || launching}
            title="Discard this browser draft and load the latest project revision"
            onClick={() => void discardAndReload()}
          >
            {reloading ? <LoaderCircleIcon className="size-3 animate-spin" /> : <RefreshCwIcon className="size-3" />}
            Discard and reload
          </button>
        </div>
      </header>

      <p className="shrink-0 border-b bg-muted/20 px-4 py-1.5 text-[10px] text-muted-foreground">
        {activeSessionId
          ? `Runs bind Kady-current model requests to active session ${activeSessionId}.`
          : "No active chat session is bound; Kady-current model requests use the configured Kady default."}
      </p>

      {error ? (
        <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? <p role="status" className="shrink-0 border-b bg-emerald-500/5 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p> : null}

      <fieldset
        aria-busy={saving || reloading || launching}
        className={`flex min-h-0 min-w-0 flex-1 border-0 p-0 ${saving || reloading || launching ? "pointer-events-none" : ""}`}
        disabled={saving || reloading || launching}
      >
        <div className="min-w-0 flex-1">
          <DagBuilderCanvas
            graph={draft}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onMoveNode={(nodeId: string, position: WorkflowNodePosition) => {
              updateDraft(updateNodePosition(draft, nodeId, position));
            }}
          />
        </div>
        <aside className="w-[390px] shrink-0 overflow-y-auto border-l bg-background" aria-label="DAG Builder inspector">
          <div className="h-80 border-b">
            <HelperAgentChat
              projectId={projectId}
              profile="dag-builder"
              contextReference={{
                kind: "workflow",
                id: `${selectedDefinition.definition.id}@${selectedDefinition.definition.revision}`,
              }}
            />
          </div>
          <DagGraphInspector
            graph={draft}
            modelInventory={modelInventory}
            onChange={updateDraft}
          />
          {selectedNode ? (
            <DagNodeInspector
              graph={draft}
              node={selectedNode}
              modelInventory={modelInventory}
              onChange={(node: WorkflowGraphNode) => updateDraft(replaceWorkflowNode(draft, node))}
              onRemove={() => {
                const removed = removeWorkflowNode(draft, selectedNode.id);
                if (removed.error) {
                  setError(removed.error);
                  return;
                }
                updateDraft(removed.graph);
                setSelectedNodeId(removed.graph.entryNodeId);
              }}
            />
          ) : null}
          <DagEdgeInspector
            key={selectedNodeId ?? "no-selected-node"}
            graph={draft}
            selectedNodeId={selectedNodeId}
            onAdd={(edge: { from: string; to: string; condition: WorkflowEdgeCondition }) => {
              const added = addWorkflowEdge(draft, edge);
              if (!added.error) updateDraft(added.graph);
              return added.error;
            }}
            onRemove={(edgeId: string) => updateDraft(removeWorkflowEdge(draft, edgeId))}
          />
        </aside>
      </fieldset>
    </section>
  );
}
