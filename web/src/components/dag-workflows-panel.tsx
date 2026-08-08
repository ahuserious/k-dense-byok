"use client";

import {
  AlertTriangleIcon,
  ChevronRightIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PipelinesPanel } from "@/components/pipelines-panel";
import {
  createDagWorkflowRun,
  DagWorkflowApiError,
  listDagWorkflowDefinitions,
  MAX_WORKFLOW_RUN_GOAL_LENGTH,
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
  return error instanceof Error ? error.message : "Unable to load typed workflow definitions.";
}

function runErrorMessage(error: unknown): string {
  if (error instanceof DagWorkflowApiError && error.status === 409) {
    return `Run conflict: ${error.detail} Reopen the latest saved revision before running.`;
  }
  return errorMessage(error);
}

function isAmbiguousRunFailure(error: unknown): boolean {
  if (error instanceof DagWorkflowApiError) return error.status >= 500;
  // Fetch transport failures are TypeError, aborted/time-limited fetches are
  // DOMException/Error variants, and an unknown thrown value cannot prove
  // that server admission did not happen. Only local validation is definite.
  return !(error instanceof RangeError);
}

function summaryFromDefinition(
  value: VersionedDagWorkflowDefinition,
): DagWorkflowDefinitionSummary {
  const { definition } = value;
  return {
    id: definition.id,
    revision: definition.revision,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    graphSha256: definition.graphSha256,
    schemaVersion: definition.graph.schemaVersion,
    name: definition.graph.name,
    description: definition.graph.description ?? null,
    nodeCount: definition.graph.nodes.length,
    edgeCount: definition.graph.edges.length,
  };
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
      aria-label={`Open ${definition.name} details`}
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

function DefinitionDetails({
  projectId,
  selectedDefinition,
  activeSessionId,
  budgetBlocked,
  onClose,
}: {
  projectId: string;
  selectedDefinition: VersionedDagWorkflowDefinition;
  activeSessionId: string | null;
  budgetBlocked: boolean;
  onClose: () => void;
}) {
  const { definition } = selectedDefinition;
  const { graph } = definition;
  const [runGoal, setRunGoal] = useState("");
  const [launching, setLaunching] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const pendingRunRequest = useRef<{ intentKey: string; requestId: string } | null>(null);
  const rawDefinition = JSON.stringify(definition, null, 2);
  const runIntentKey = JSON.stringify([
    definition.id,
    definition.revision,
    activeSessionId,
    runGoal.trim(),
  ]);

  useEffect(() => {
    pendingRunRequest.current = null;
    setRunError(null);
    setRunNotice(null);
  }, [runIntentKey]);

  const launchRun = async () => {
    if (launching || budgetBlocked) return;
    const goal = runGoal.trim();
    const request = pendingRunRequest.current?.intentKey === runIntentKey
      ? pendingRunRequest.current
      : { intentKey: runIntentKey, requestId: crypto.randomUUID() };
    pendingRunRequest.current = request;
    setLaunching(true);
    setRunError(null);
    setRunNotice(null);
    try {
      const run = await createDagWorkflowRun(projectId, definition.id, {
        requestId: request.requestId,
        expectedWorkflowRevision: definition.revision,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(goal ? { input: { goal } } : {}),
      });
      setRunNotice(
        `Created run ${run.manifest.id} with status ${run.state.status}. Open Console for runner progress.`,
      );
      if (
        pendingRunRequest.current?.intentKey === request.intentKey &&
        pendingRunRequest.current.requestId === request.requestId
      ) {
        pendingRunRequest.current = null;
      }
    } catch (caught) {
      const ambiguous = isAmbiguousRunFailure(caught);
      if (
        !ambiguous &&
        pendingRunRequest.current?.intentKey === request.intentKey &&
        pendingRunRequest.current.requestId === request.requestId
      ) {
        pendingRunRequest.current = null;
      }
      setRunError(
        ambiguous
          ? `${runErrorMessage(caught)} Retrying this unchanged run will reuse the same request id.`
          : runErrorMessage(caught),
      );
    } finally {
      setLaunching(false);
    }
  };

  const downloadRawDefinition = () => {
    const objectUrl = URL.createObjectURL(new Blob([rawDefinition], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${definition.id}-revision-${definition.revision}.json`;
    link.click();
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <section className="rounded-lg border bg-background" aria-labelledby="typed-definition-details-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 id="typed-definition-details-title" className="truncate text-sm font-semibold">
            {graph.name}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {definition.id} · revision {definition.revision} · {graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} edge{graph.edges.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Typed workflow run goal"
            type="text"
            value={runGoal}
            maxLength={MAX_WORKFLOW_RUN_GOAL_LENGTH}
            disabled={launching}
            onChange={(event) => setRunGoal(event.target.value)}
            placeholder="Optional run goal"
            className="w-52 rounded-md border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground disabled:opacity-50"
          />
          <button
            type="button"
            disabled={launching || budgetBlocked}
            title={
              budgetBlocked
                ? "Project spend limit reached"
                : activeSessionId
                  ? "Run this saved revision using the active Kady session"
                  : "Run this saved revision using the configured Kady default model"
            }
            onClick={() => void launchRun()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {launching ? <LoaderCircleIcon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
            Run typed workflow
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={launching}
            className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-50"
          >
            Close details
          </button>
        </div>
      </header>
      <p className="border-b bg-muted/20 px-4 py-2 text-[10px] text-muted-foreground">
        {activeSessionId
          ? `Runs bind Kady-current model requests to active session ${activeSessionId}.`
          : "No active chat session is bound; Kady-current model requests use the configured Kady default."}
      </p>
      {runError ? (
        <div role="alert" className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{runError}</span>
        </div>
      ) : null}
      {runNotice ? (
        <p role="status" className="border-b bg-emerald-500/5 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {runNotice}
        </p>
      ) : null}
      {graph.description ? (
        <p className="border-b px-4 py-3 text-xs text-muted-foreground">{graph.description}</p>
      ) : null}
      <section className="p-4" aria-labelledby="raw-typed-definition-title">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 id="raw-typed-definition-title" className="text-xs font-semibold">
              Complete stored definition (read-only)
            </h4>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Includes entry node, edges and conditions, model routing, limits, rescue/evidence policy, artifacts, and specialized node configuration.
            </p>
          </div>
          <button
            type="button"
            onClick={downloadRawDefinition}
            className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/50"
          >
            Download raw definition
          </button>
        </div>
        <pre
          data-testid="raw-typed-definition"
          className="mt-3 max-h-[34rem] overflow-auto rounded-md border bg-muted/20 p-3 text-[10px] leading-relaxed"
        >
          {rawDefinition}
        </pre>
      </section>
    </section>
  );
}

export function DagWorkflowsPanel({
  projectId,
  activeSessionId,
  budgetBlocked,
  onRunPipeline,
  onEditPipeline,
}: {
  projectId: string;
  activeSessionId: string | null;
  budgetBlocked: boolean;
  onRunPipeline: (name: string) => void;
  onEditPipeline: (name: string) => void;
}) {
  const [definitions, setDefinitions] = useState<DagWorkflowDefinitionSummary[] | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<VersionedDagWorkflowDefinition | null>(null);
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
    setSelectedDefinition(null);
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
      setSelectedDefinition(await readDagWorkflowDefinition(projectId, definition.id));
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
      const saved = await saveDagWorkflowDefinition(projectId, workflowId, graph);
      const savedSummary = summaryFromDefinition(saved);
      setDefinitions((current) => [
        savedSummary,
        ...(current ?? []).filter((item) => item.id !== savedSummary.id),
      ]);
      setSelectedDefinition(saved);
      setShowCreateForm(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="scientific-pipelines-title">
      <header className="shrink-0 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <ListTreeIcon className="size-4 text-primary" />
          <h1 id="scientific-pipelines-title" className="text-sm font-semibold">
            Scientific Pipelines
          </h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          One workspace for two separate engines: vendored visual pipelines and project-scoped typed definitions.
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        <section className="overflow-hidden rounded-lg border bg-background" aria-label="Vendored-engine pipelines">
          <PipelinesPanel
            onRunPipeline={onRunPipeline}
            onEditPipeline={onEditPipeline}
          />
        </section>

        <section className="overflow-hidden rounded-lg border bg-background" aria-labelledby="typed-workflows-title">
          <header className="border-b px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="typed-workflows-title" className="text-sm font-semibold">
                  Typed-engine definitions
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Revisioned Kady graphs remain in their separate project-scoped store.
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
                <PlusIcon className="size-3.5" /> New typed workflow
              </button>
            </div>
          </header>

          {showCreateForm ? (
            <form
              className="grid gap-3 border-b bg-muted/10 px-4 py-4 sm:grid-cols-2"
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
            <div role="alert" className="mx-4 mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="p-4">
            {definitions === null ? (
              <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                Loading typed workflows…
              </div>
            ) : definitions.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center">
                <div className="max-w-sm rounded-lg border border-dashed px-6 py-8 text-center">
                  <ListTreeIcon className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">No typed workflows yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Definitions saved through Kady&apos;s project-scoped typed API will appear here.
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

        {selectedDefinition ? (
          <DefinitionDetails
            key={`${selectedDefinition.definition.id}@${selectedDefinition.definition.revision}`}
            projectId={projectId}
            selectedDefinition={selectedDefinition}
            activeSessionId={activeSessionId}
            budgetBlocked={budgetBlocked}
            onClose={() => setSelectedDefinition(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
