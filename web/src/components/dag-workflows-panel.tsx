"use client";

import {
  AlertTriangleIcon,
  ChevronRightIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { validateScientificWorkflowTemplatePreconditions } from "@/data/dag-workflow-templates";

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
import { PIPELINE_ENGINE_URL } from "@/lib/embed-config";
import {
  buildScientificPipelineRegistry,
  listVendoredWorkflowRegistrySources,
  normalizeWorkflowName,
  typedWorkflowRegistrySource,
  vendoredPipelineEngineHealth,
  workflowRouteForEngine,
  type ScientificPipelineRegistryEntry,
  type TypedWorkflowRegistrySource,
  type VendoredPipelineEditTarget,
  type VendoredWorkflowRegistrySource,
} from "@/lib/scientific-pipeline-registry";

const VENDORED_BUILDER_URL = `${PIPELINE_ENGINE_URL}/legacy/workflows/builder`;

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

interface StoredRunRequest {
  workflowId: string;
  revision: number;
  sessionId: string | null;
  goal: string;
  variables?: Record<string, string>;
  files?: Record<string, string[]>;
  requestId: string;
  savedAt: number;
}

type StoredRunRequests = Record<string, StoredRunRequest>;

const RUN_REQUEST_STORAGE_PREFIX = "kady:typed-workflow-run-requests:v1:";

function isStoredRunRequest(value: unknown): value is StoredRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.workflowId === "string" &&
    typeof request.revision === "number" &&
    (request.sessionId === null || typeof request.sessionId === "string") &&
    typeof request.goal === "string" &&
    (request.variables === undefined ||
      (request.variables !== null &&
        typeof request.variables === "object" &&
        !Array.isArray(request.variables) &&
        Object.values(request.variables).every((value) => typeof value === "string"))) &&
    (request.files === undefined ||
      (request.files !== null &&
        typeof request.files === "object" &&
        !Array.isArray(request.files) &&
        Object.values(request.files).every((value) =>
          Array.isArray(value) && value.every((path) => typeof path === "string")
        ))) &&
    typeof request.requestId === "string" &&
    typeof request.savedAt === "number"
  );
}

function runRequestStorageKey(projectId: string): string {
  return `${RUN_REQUEST_STORAGE_PREFIX}${encodeURIComponent(projectId)}`;
}

function readStoredRunRequests(projectId: string): StoredRunRequests {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(runRequestStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, StoredRunRequest] =>
        isStoredRunRequest(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredRunRequests(projectId: string, requests: StoredRunRequests): void {
  if (typeof window === "undefined") return;
  try {
    const storageKey = runRequestStorageKey(projectId);
    if (Object.keys(requests).length === 0) {
      window.sessionStorage.removeItem(storageKey);
    } else {
      window.sessionStorage.setItem(storageKey, JSON.stringify(requests));
    }
  } catch {
    // A denied/full sessionStorage must not block workflow admission. The
    // component ref still protects retries for the current mount.
  }
}

function storeRunRequest(
  projectId: string,
  intentKey: string,
  request: StoredRunRequest,
): void {
  writeStoredRunRequests(projectId, {
    ...readStoredRunRequests(projectId),
    [intentKey]: request,
  });
}

function removeStoredRunRequest(
  projectId: string,
  intentKey: string,
  expectedRequestId?: string,
): void {
  const requests = readStoredRunRequests(projectId);
  if (!(intentKey in requests)) return;
  if (expectedRequestId && requests[intentKey]?.requestId !== expectedRequestId) return;
  delete requests[intentKey];
  writeStoredRunRequests(projectId, requests);
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

interface VendoredRunReceipt {
  receiptId: string | null;
  runId: string | null;
  status: string;
}

function vendoredRunReceipt(value: unknown): VendoredRunReceipt {
  const outer = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const response = outer.response && typeof outer.response === "object" && !Array.isArray(outer.response)
    ? outer.response as Record<string, unknown>
    : outer;
  if (response.accepted !== true) {
    const detail = [response.error, response.detail, response.message]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    throw new Error(detail ?? "Vendored pipeline response did not confirm acceptance.");
  }
  if (typeof response.status !== "string" || response.status.length === 0) {
    throw new Error("Vendored pipeline response confirmed acceptance without a valid status.");
  }
  const runId = [response.runId, response.run_id]
    .find((candidate): candidate is string => typeof candidate === "string") ?? null;
  const receiptId = typeof outer.receiptId === "string" ? outer.receiptId : runId;
  return { receiptId, runId, status: response.status };
}

function WorkflowRegistryRow({
  entry,
  opening,
  budgetBlocked,
  receipt,
  onOpenTyped,
  onEditVendored,
  onRunVendored,
}: {
  entry: ScientificPipelineRegistryEntry;
  opening: boolean;
  budgetBlocked: boolean;
  receipt?: VendoredRunReceipt & { error?: string };
  onOpenTyped: () => void;
  onEditVendored: () => void;
  onRunVendored: () => void;
}) {
  const typed = entry.typed;
  const vendored = entry.vendored;
  const vendoredRouteBlocked = entry.vendoredRouting?.routable === false;
  return (
    <li
      data-workflow-registry-id={entry.id}
      className="border-b px-4 py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{entry.name}</span>
            {typed ? (
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                Typed
              </span>
            ) : null}
            {vendored ? (
              <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                Vendored
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {entry.description || typed?.workflowId || vendored?.workflowName}
          </p>
          {entry.routingAmbiguities?.map((ambiguity) => (
            <p
              key={ambiguity.engine}
              role="alert"
              className="mt-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {ambiguity.message}
            </p>
          ))}
          {typed ? (
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>Revision {typed.summary.revision}</span>
              <span>{typed.summary.nodeCount} node{typed.summary.nodeCount === 1 ? "" : "s"}</span>
              <span>{typed.summary.edgeCount} edge{typed.summary.edgeCount === 1 ? "" : "s"}</span>
              <span>Schema {typed.summary.schemaVersion}</span>
            </p>
          ) : null}
          {receipt ? (
            <p role="status" className={`mt-2 text-xs ${receipt.error ? "text-destructive" : "text-muted-foreground"}`}>
              {receipt.error
                ? `Run failed: ${receipt.error}`
                : receipt.runId
                  ? `Run ${receipt.runId} · ${receipt.status}`
                  : receipt.receiptId
                    ? `Dispatch ${receipt.receiptId} · ${receipt.status}`
                    : receipt.status}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {typed ? (
            <button
              type="button"
              onClick={onOpenTyped}
              disabled={opening}
              aria-label={`Open ${entry.name} details`}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50 disabled:cursor-wait"
            >
              {opening ? <LoaderCircleIcon className="size-3 animate-spin" /> : <ChevronRightIcon className="size-3" />}
              Details &amp; run
            </button>
          ) : null}
          {vendored ? (
            <>
              <button
                type="button"
                onClick={onEditVendored}
                disabled={vendoredRouteBlocked}
                aria-label={`Edit ${entry.name} with vendored engine`}
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onRunVendored}
                disabled={vendoredRouteBlocked}
                aria-label={`Run ${entry.name} with vendored engine`}
                title={vendoredRouteBlocked
                  ? entry.vendoredRouting?.blockedReason
                  : budgetBlocked
                    ? "Project spend limit reached"
                    : undefined}
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run
              </button>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function DefinitionDetails({
  projectId,
  selectedDefinition,
  activeSessionId,
  budgetBlocked,
  uploadedFiles,
  onClose,
}: {
  projectId: string;
  selectedDefinition: VersionedDagWorkflowDefinition;
  activeSessionId: string | null;
  budgetBlocked: boolean;
  uploadedFiles: readonly string[];
  onClose: () => void;
}) {
  const { definition } = selectedDefinition;
  const { graph } = definition;
  const [runGoal, setRunGoal] = useState("");
  const [runVariables, setRunVariables] = useState<Record<string, string>>({});
  const [runFiles, setRunFiles] = useState<Record<string, string[]>>({});
  const [launching, setLaunching] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const pendingRunRequest = useRef<{ intentKey: string; requestId: string } | null>(null);
  const previousRunIntentKey = useRef<string | null>(null);
  const restoredRunIntent = useRef(false);
  const rawDefinition = JSON.stringify(definition, null, 2);
  const runIntentKey = JSON.stringify([
    definition.id,
    definition.revision,
    activeSessionId,
    runGoal.trim(),
    runVariables,
    runFiles,
  ]);
  const preconditionIssues = useMemo(
    () => graph.preconditions
      ? validateScientificWorkflowTemplatePreconditions(graph.preconditions, {
          goal: runGoal,
          variables: runVariables,
          files: runFiles,
          capabilities: ["prompt-analysis", "read-uploaded-files"],
        })
      : [],
    [graph.preconditions, runGoal, runVariables, runFiles],
  );

  useEffect(() => {
    if (!restoredRunIntent.current) {
      restoredRunIntent.current = true;
      // Typed run summaries do not expose requestId, so an absent list result
      // cannot prove that an ambiguously acknowledged admission was rejected.
      // Restore the most recently saved exact intent and retain it until an
      // observed intent edit or a confirmed API outcome reconciles it.
      const restorable = Object.entries(readStoredRunRequests(projectId))
        .filter(
          ([, request]) =>
            request.workflowId === definition.id &&
            request.revision === definition.revision &&
            request.sessionId === activeSessionId,
        )
        .sort((left, right) => right[1].savedAt - left[1].savedAt)[0];
      if (restorable) {
        const [storedIntentKey, request] = restorable;
        previousRunIntentKey.current = storedIntentKey;
        pendingRunRequest.current = {
          intentKey: storedIntentKey,
          requestId: request.requestId,
        };
        setRunGoal(request.goal);
        setRunVariables(request.variables ?? {});
        setRunFiles(request.files ?? {});
        return;
      }
    }

    const previousIntentKey = previousRunIntentKey.current;
    if (previousIntentKey && previousIntentKey !== runIntentKey) {
      removeStoredRunRequest(projectId, previousIntentKey);
    }
    previousRunIntentKey.current = runIntentKey;
    const storedRequest = readStoredRunRequests(projectId)[runIntentKey];
    pendingRunRequest.current = storedRequest
      ? { intentKey: runIntentKey, requestId: storedRequest.requestId }
      : null;
    setRunError(null);
    setRunNotice(null);
  }, [activeSessionId, definition.id, definition.revision, projectId, runIntentKey]);

  const launchRun = async () => {
    if (launching || budgetBlocked || preconditionIssues.length > 0) return;
    const goal = runGoal.trim();
    const storedRequest = readStoredRunRequests(projectId)[runIntentKey];
    const request = pendingRunRequest.current?.intentKey === runIntentKey
      ? pendingRunRequest.current
      : storedRequest
        ? { intentKey: runIntentKey, requestId: storedRequest.requestId }
        : { intentKey: runIntentKey, requestId: crypto.randomUUID() };
    pendingRunRequest.current = request;
    storeRunRequest(projectId, runIntentKey, {
      workflowId: definition.id,
      revision: definition.revision,
      sessionId: activeSessionId,
      goal,
      variables: runVariables,
      files: runFiles,
      requestId: request.requestId,
      savedAt: Date.now(),
    });
    setLaunching(true);
    setRunError(null);
    setRunNotice(null);
    try {
      const run = await createDagWorkflowRun(projectId, definition.id, {
        requestId: request.requestId,
        expectedWorkflowRevision: definition.revision,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(goal || Object.keys(runVariables).length > 0 || Object.keys(runFiles).length > 0
          ? {
              input: {
                ...(goal ? { goal } : {}),
                ...(Object.keys(runVariables).length > 0
                  ? { variables: runVariables }
                  : {}),
                ...(Object.keys(runFiles).length > 0 ? { files: runFiles } : {}),
              },
            }
          : {}),
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
      removeStoredRunRequest(projectId, request.intentKey, request.requestId);
    } catch (caught) {
      const ambiguous = isAmbiguousRunFailure(caught);
      if (
        !ambiguous &&
        pendingRunRequest.current?.intentKey === request.intentKey &&
        pendingRunRequest.current.requestId === request.requestId
      ) {
        pendingRunRequest.current = null;
        removeStoredRunRequest(projectId, request.intentKey, request.requestId);
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
          {graph.preconditions ? (
            <div className="flex max-w-xl flex-wrap items-end gap-2">
              {graph.preconditions.requiredInputs.map((input) => (
                <label key={input.key} className="flex min-w-40 flex-col gap-1 text-[10px] text-muted-foreground">
                  {input.label}
                  <input
                    aria-label={input.label}
                    type="text"
                    value={runVariables[input.key] ?? ""}
                    disabled={launching}
                    onChange={(event) => setRunVariables((current) => ({
                      ...current,
                      [input.key]: event.target.value,
                    }))}
                    placeholder={input.label}
                    className="rounded-md border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground disabled:opacity-50"
                  />
                </label>
              ))}
              {graph.preconditions.requiredFiles.length > 0 ? (
                <div className="min-w-48 text-[10px] text-muted-foreground">
                  <p className="font-medium text-foreground">Required uploads</p>
                  <ul className="mt-1 space-y-2">
                    {graph.preconditions.requiredFiles.map((file) => (
                      <li key={file.key}>
                        <p>{file.label} ({file.minimumCount} minimum)</p>
                        <div className="mt-1 flex max-h-24 flex-col gap-1 overflow-auto">
                          {uploadedFiles.map((uploadedFile) => (
                            <label key={uploadedFile} className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                aria-label={`${file.label}: ${uploadedFile}`}
                                checked={(runFiles[file.key] ?? []).includes(uploadedFile)}
                                disabled={launching}
                                onChange={(event) => setRunFiles((current) => {
                                  const next = Object.fromEntries(
                                    Object.entries(current).map(([key, paths]) => [
                                      key,
                                      paths.filter((path) => path !== uploadedFile),
                                    ]),
                                  );
                                  if (event.target.checked) {
                                    next[file.key] = [...(next[file.key] ?? []), uploadedFile];
                                  }
                                  return next;
                                })}
                              />
                              <span className="truncate">{uploadedFile}</span>
                            </label>
                          ))}
                          {uploadedFiles.length === 0 ? <span>No uploaded files available.</span> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preconditionIssues.length > 0 ? (
                <ul role="alert" className="w-full text-[10px] text-destructive">
                  {preconditionIssues.map((issue) => (
                    <li key={`${issue.kind}:${issue.key}`}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <input
            aria-label="Typed workflow run goal"
            type="text"
            value={runGoal}
            maxLength={MAX_WORKFLOW_RUN_GOAL_LENGTH}
            disabled={launching}
            onChange={(event) => setRunGoal(event.target.value)}
            placeholder={graph.preconditions ? "Required run goal" : "Optional run goal"}
            className="w-52 rounded-md border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground disabled:opacity-50"
          />
          <button
            type="button"
            disabled={launching || budgetBlocked || preconditionIssues.length > 0}
            title={
              budgetBlocked
                ? "Project spend limit reached"
                : preconditionIssues.length > 0
                  ? "Complete the required workflow inputs before launch"
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
  uploadedFiles = [],
  onRunPipeline,
  onEditPipeline,
}: {
  projectId: string;
  activeSessionId: string | null;
  budgetBlocked: boolean;
  uploadedFiles?: readonly string[];
  onRunPipeline: (name: string) => Promise<unknown>;
  onEditPipeline: (target: VendoredPipelineEditTarget) => void;
}) {
  const [typedSources, setTypedSources] = useState<TypedWorkflowRegistrySource[] | null>(null);
  const [vendoredSources, setVendoredSources] = useState<VendoredWorkflowRegistrySource[] | null>(null);
  const [vendoredHealthy, setVendoredHealthy] = useState<boolean | null>(null);
  const [vendoredHealthError, setVendoredHealthError] = useState<string | null>(null);
  const [vendoredListError, setVendoredListError] = useState<string | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<VersionedDagWorkflowDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newWorkflowTemplateId, setNewWorkflowTemplateId] = useState("blank");
  const [newWorkflowId, setNewWorkflowId] = useState("");
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowDescription, setNewWorkflowDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [vendoredRunReceipts, setVendoredRunReceipts] = useState<Record<string, VendoredRunReceipt & { error?: string }>>({});
  const launchingVendoredRuns = useRef(new Set<string>());
  const loadGeneration = useRef(0);
  const structureComparisonFailures = useRef(new Set<string>());
  const selectedTemplate = findDagWorkflowTemplate(newWorkflowTemplateId);
  const registryEntries = useMemo(
    () => typedSources === null && vendoredSources === null
      ? null
      : buildScientificPipelineRegistry(typedSources ?? [], vendoredSources ?? []),
    [typedSources, vendoredSources],
  );

  const refreshRegistry = useCallback(() => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    structureComparisonFailures.current.clear();
    setTypedSources(null);
    setVendoredSources(null);
    setVendoredHealthy(null);
    setVendoredHealthError(null);
    setVendoredListError(null);
    setSelectedDefinition(null);
    setError(null);

    void listDagWorkflowDefinitions(projectId)
      .then((summaries) => {
        if (loadGeneration.current !== generation) return;
        setTypedSources(summaries.map((summary) => typedWorkflowRegistrySource(summary)));
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setTypedSources([]);
        setError(errorMessage(caught));
      });

    void vendoredPipelineEngineHealth(projectId)
      .then((healthy) => {
        if (loadGeneration.current !== generation) return;
        setVendoredHealthy(healthy);
        setVendoredHealthError(
          healthy ? null : "The advisory health probe did not report a healthy engine.",
        );
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setVendoredHealthy(false);
        setVendoredHealthError(errorMessage(caught));
      });

    void listVendoredWorkflowRegistrySources(projectId)
      .then((sources) => {
        if (loadGeneration.current !== generation) return;
        setVendoredListError(null);
        setVendoredSources(sources);
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setVendoredListError(errorMessage(caught));
        setVendoredSources([]);
      });
  }, [projectId]);

  useEffect(() => {
    void refreshRegistry();
    return () => {
      loadGeneration.current += 1;
    };
  }, [refreshRegistry]);

  useEffect(() => {
    if (typedSources === null || vendoredSources === null) return;
    const vendoredNames = new Set(
      vendoredSources.map((source) => normalizeWorkflowName(source.workflowName)),
    );
    const candidates = typedSources.filter((source) =>
      !source.graph &&
      !structureComparisonFailures.current.has(source.sourceId) &&
      vendoredNames.has(normalizeWorkflowName(source.summary.name))
    );
    if (candidates.length === 0) return;

    const generation = loadGeneration.current;
    let cancelled = false;
    void Promise.all(candidates.map(async (source) => {
      try {
        const definition = await readDagWorkflowDefinition(projectId, source.workflowId);
        return { source, graph: definition.definition.graph } as const;
      } catch {
        return { source, graph: null } as const;
      }
    })).then((results) => {
      if (cancelled || loadGeneration.current !== generation) return;
      const graphs = new Map(
        results.flatMap(({ source, graph }) => graph ? [[source.sourceId, graph] as const] : []),
      );
      const failures = results
        .filter(({ graph }) => graph === null)
        .map(({ source }) => source);
      for (const source of failures) {
        structureComparisonFailures.current.add(source.sourceId);
      }
      if (graphs.size > 0) {
        setTypedSources((current) => current?.map((source) => {
          const graph = graphs.get(source.sourceId);
          return graph ? { ...source, graph } : source;
        }) ?? null);
      }
      if (failures.length > 0) {
        setError(
          `Could not verify structure for ${failures.map((source) => source.summary.name).join(", ")}; its engine entries remain separate.`,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, typedSources, vendoredSources]);

  const openDefinition = async (entry: ScientificPipelineRegistryEntry) => {
    if (openingId) return;
    const route = workflowRouteForEngine(entry, "typed");
    setOpeningId(route.sourceId);
    setError(null);
    try {
      const selected = await readDagWorkflowDefinition(projectId, route.workflowId);
      setSelectedDefinition(selected);
      setTypedSources((current) => current?.map((source) =>
        source.sourceId === route.sourceId
          ? { ...source, graph: selected.definition.graph }
          : source
      ) ?? null);
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
      // This form only ever creates: a definition that already exists must fail
      // as a 409 rather than silently overwrite or no-op.
      const saved = await saveDagWorkflowDefinition(projectId, workflowId, graph, {
        kind: "create",
      });
      const savedSummary = summaryFromDefinition(saved);
      setTypedSources((current) => [
        typedWorkflowRegistrySource(savedSummary, saved.definition.graph),
        ...(current ?? []).filter((item) => item.workflowId !== savedSummary.id),
      ]);
      setSelectedDefinition(saved);
      setShowCreateForm(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  const runVendoredPipeline = async (name: string) => {
    if (budgetBlocked) {
      setVendoredRunReceipts((current) => ({
        ...current,
        [name]: {
          receiptId: null,
          runId: null,
          status: "blocked",
          error: "Project spend limit reached.",
        },
      }));
      return;
    }
    if (launchingVendoredRuns.current.has(name)) return;
    launchingVendoredRuns.current.add(name);
    setVendoredRunReceipts((current) => ({
      ...current,
      [name]: { receiptId: null, runId: null, status: "submitting" },
    }));
    try {
      const receipt = vendoredRunReceipt(await onRunPipeline(name));
      setVendoredRunReceipts((current) => ({ ...current, [name]: receipt }));
    } catch (caught) {
      setVendoredRunReceipts((current) => ({
        ...current,
        [name]: {
          receiptId: null,
          runId: null,
          status: "failed",
          error: caught instanceof Error ? caught.message : "Unable to start vendored pipeline.",
        },
      }));
    } finally {
      launchingVendoredRuns.current.delete(name);
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
          One deduplicated registry with transparent routes to each workflow&apos;s backing engine.
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        <section className="overflow-hidden rounded-lg border bg-background" aria-labelledby="workflow-registry-title">
          <header className="border-b px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="workflow-registry-title" className="text-sm font-semibold">
                    Workflow registry
                  </h2>
                  <span
                    className={
                      "rounded px-1.5 py-0.5 text-[11px] " +
                      (vendoredHealthy === null
                        ? "bg-muted text-muted-foreground"
                        : vendoredHealthy
                          ? "bg-emerald-500/15 text-emerald-600"
                          : "bg-amber-500/15 text-amber-700 dark:text-amber-300")
                    }
                  >
                    {vendoredHealthy === null
                      ? "checking vendored engine…"
                      : vendoredHealthy
                        ? "vendored engine online"
                        : "vendored health degraded"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Matching names and graph topologies share one row; engine namespaces remain intact.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={VENDORED_BUILDER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/50"
                >
                  Open builder ↗
                </a>
                <button
                  type="button"
                  onClick={() => void refreshRegistry()}
                  className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/50"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                  onClick={() => {
                    setShowCreateForm((visible) => !visible);
                    setError(null);
                  }}
                >
                  <PlusIcon className="size-3.5" /> New typed workflow
                </button>
              </div>
            </div>
          </header>

          {vendoredHealthError ? (
            <p className="border-b px-4 py-2 text-xs text-muted-foreground">
              Vendored health is degraded: {vendoredHealthError} Workflows returned by the list request remain available.
            </p>
          ) : null}
          {vendoredListError ? (
            <p role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
              Could not load vendored workflows: {vendoredListError}
            </p>
          ) : null}
          {budgetBlocked ? (
            <p role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
              Vendored pipeline runs are disabled because the project spend limit is reached.
            </p>
          ) : null}

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
            {registryEntries === null ? (
              <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                Loading workflow registry…
              </div>
            ) : registryEntries.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center">
                <div className="max-w-sm rounded-lg border border-dashed px-6 py-8 text-center">
                  <ListTreeIcon className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">No workflows yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create a typed workflow here or use the vendored visual builder.
                  </p>
                </div>
              </div>
            ) : (
              <ul
                className="overflow-hidden rounded-lg border bg-background"
                aria-label="Scientific pipeline workflows"
              >
                {registryEntries.map((entry) => {
                  const typedRoute = entry.typed;
                  const vendoredRoute = entry.vendored;
                  return (
                    <WorkflowRegistryRow
                      key={entry.id}
                      entry={entry}
                      opening={openingId === typedRoute?.sourceId}
                      budgetBlocked={budgetBlocked}
                      receipt={vendoredRoute ? vendoredRunReceipts[vendoredRoute.workflowId] : undefined}
                      onOpenTyped={() => {
                        if (typedRoute) void openDefinition(entry);
                      }}
                      onEditVendored={() => {
                        if (vendoredRoute) {
                          const route = workflowRouteForEngine(entry, "vendored");
                          onEditPipeline({
                            workflowId: route.workflowId,
                            codebaseId: route.codebaseId,
                          });
                        }
                      }}
                      onRunVendored={() => {
                        if (vendoredRoute) {
                          void runVendoredPipeline(
                            workflowRouteForEngine(entry, "vendored").workflowId,
                          );
                        }
                      }}
                    />
                  );
                })}
              </ul>
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
            uploadedFiles={uploadedFiles}
            onClose={() => setSelectedDefinition(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
