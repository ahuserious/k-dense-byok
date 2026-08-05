"use client";

import {
  AlertTriangleIcon,
  ChevronRightIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  DagWorkflowApiError,
  listDagWorkflowDefinitions,
  readDagWorkflowDefinition,
  saveDagWorkflowDefinition,
  type DagWorkflowDefinitionSummary,
  type VersionedDagWorkflowDefinition,
} from "@/lib/dag-workflows";
import {
  createDefaultWorkflowGraph,
  isWorkflowIdentifier,
} from "@/lib/dag-workflow-builder";
import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
  findDagWorkflowTemplate,
} from "@/lib/dag-workflow-templates";

function errorMessage(error: unknown): string {
  if (error instanceof DagWorkflowApiError) {
    return error.code ? `${error.code}: ${error.detail}` : error.detail;
  }
  return error instanceof Error ? error.message : "Unable to load DAG workflows.";
}

function WorkflowDefinitionRow({
  definition,
  opening,
  onOpen,
}: {
  definition: DagWorkflowDefinitionSummary;
  opening: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={opening}
      aria-label={`Open ${definition.name} in DAG Builder`}
      className="group grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40 disabled:cursor-wait"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{definition.name}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {definition.description || definition.id}
        </span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>Revision {definition.revision}</span>
          <span>{definition.nodeCount} node{definition.nodeCount === 1 ? "" : "s"}</span>
          <span>{definition.edgeCount} edge{definition.edgeCount === 1 ? "" : "s"}</span>
          <span>Schema {definition.schemaVersion}</span>
        </span>
      </span>
      <span className="self-center text-muted-foreground transition-colors group-hover:text-foreground">
        {opening ? (
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
        ) : (
          <ChevronRightIcon className="size-4" aria-hidden />
        )}
      </span>
    </button>
  );
}

export function DagWorkflowsPanel({
  projectId,
  onOpenDefinition,
}: {
  projectId: string;
  onOpenDefinition: (definition: VersionedDagWorkflowDefinition) => void;
}) {
  const [definitions, setDefinitions] = useState<DagWorkflowDefinitionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newWorkflowTemplateId, setNewWorkflowTemplateId] = useState("blank");
  const [newWorkflowId, setNewWorkflowId] = useState("");
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowDescription, setNewWorkflowDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedTemplate = findDagWorkflowTemplate(newWorkflowTemplateId);

  useEffect(() => {
    let cancelled = false;
    setDefinitions(null);
    setError(null);
    void listDagWorkflowDefinitions(projectId)
      .then((items) => {
        if (!cancelled) setDefinitions(items);
      })
      .catch((caught) => {
        if (!cancelled) {
          setDefinitions([]);
          setError(errorMessage(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const openDefinition = async (definition: DagWorkflowDefinitionSummary) => {
    if (openingId) return;
    setOpeningId(definition.id);
    setError(null);
    try {
      onOpenDefinition(await readDagWorkflowDefinition(projectId, definition.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setOpeningId(null);
    }
  };

  const createDefinition = async () => {
    if (creating) return;
    const workflowId = newWorkflowId.trim();
    const workflowName = newWorkflowName.trim();
    if (!isWorkflowIdentifier(workflowId)) {
      setError("Workflow id must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores (64 characters maximum).");
      return;
    }
    if (!workflowName) {
      setError("Workflow name is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const graph = selectedTemplate
        ? createDagWorkflowTemplateGraph(
            selectedTemplate.id,
            workflowId,
            workflowName,
            newWorkflowDescription,
          )
        : createDefaultWorkflowGraph(
            workflowId,
            workflowName,
            newWorkflowDescription,
          );
      const saved = await saveDagWorkflowDefinition(
        projectId,
        workflowId,
        graph,
      );
      onOpenDefinition(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="dag-workflows-title">
      <header className="shrink-0 border-b px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ListTreeIcon className="size-4 text-primary" />
              <h1 id="dag-workflows-title" className="text-sm font-semibold">
                DAG Workflows
              </h1>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Project-scoped, revisioned graph definitions. Open a graph in the native builder or create a bounded Pi (Kady) workflow.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            onClick={() => {
              setShowCreateForm((visible) => !visible);
              setError(null);
            }}
          >
            <PlusIcon className="size-3.5" /> New DAG workflow
          </button>
        </div>
      </header>

      {showCreateForm ? (
        <form
          className="grid shrink-0 gap-3 border-b bg-muted/10 px-5 py-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createDefinition();
          }}
        >
          <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">
            Template
            <select
              aria-label="Workflow template"
              className="block w-full rounded-md border bg-background px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-foreground"
              value={newWorkflowTemplateId}
              onChange={(event) => {
                const templateId = event.target.value;
                const template = findDagWorkflowTemplate(templateId);
                setNewWorkflowTemplateId(templateId);
                setNewWorkflowId(template?.suggestedWorkflowId ?? "");
                setNewWorkflowName(template?.name ?? "");
                setNewWorkflowDescription(template?.description ?? "");
                setError(null);
              }}
            >
              <option value="blank">Blank bounded workflow</option>
              {DAG_WORKFLOW_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.domain} — {template.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Workflow id
            <input
              aria-label="New workflow id"
              className="block w-full rounded-md border bg-background px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-foreground"
              placeholder="private-research"
              value={newWorkflowId}
              onChange={(event) => setNewWorkflowId(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Name
            <input
              aria-label="New workflow name"
              className="block w-full rounded-md border bg-background px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-foreground"
              placeholder="Private research"
              value={newWorkflowName}
              onChange={(event) => setNewWorkflowName(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">
            Description
            <textarea
              aria-label="New workflow description"
              className="block min-h-16 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-foreground"
              placeholder="Optional workflow purpose"
              value={newWorkflowDescription}
              onChange={(event) => setNewWorkflowDescription(event.target.value)}
            />
          </label>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <p className="text-[10px] text-muted-foreground">
              {selectedTemplate ? (
                <>
                  <span className="font-medium text-foreground">{selectedTemplate.domain}</span>
                  {" · "}{selectedTemplate.description} Uses exact Pi (Kady) defaults, best-of-2 paths, an evidence gate, and auto-rescue.
                </>
              ) : (
                <>Starts as a valid one-node graph with Pi (Kady), bounded limits, evidence checks, and auto-rescue enabled.</>
              )}
            </p>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {creating ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
              Create and open
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <div role="alert" className="mx-5 mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {definitions === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Loading DAG workflows…
          </div>
        ) : definitions.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-sm rounded-lg border border-dashed px-6 py-8 text-center">
              <ListTreeIcon className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No DAG workflows yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Definitions saved through Kady&apos;s project-scoped DAG API will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-background">
            {definitions.map((definition) => (
              <WorkflowDefinitionRow
                key={definition.id}
                definition={definition}
                opening={openingId === definition.id}
                onOpen={() => void openDefinition(definition)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
