// danbot-byok — web/src/components/dag-builder-surface.tsx
//
// The Kady host for the vendored DAG builder.
//
// The vendored React Flow canvas stays the editor, but it is demoted to a
// PROJECTION of a typed `WorkflowGraphDocument` this component owns. The
// canvas is handed a `GraphViewModel` and answers with deltas; load, validate,
// and save all travel the typed `/dag-workflows` route. Engine-native pipelines
// keep their existing path untouched — `PipelineBuilderPanel` below is
// unchanged and still renders the same iframe.
//
// This is also where "none of the workflows have loaded" is fixed: the source
// list is produced HERE, from the project's typed workflows and the workflow
// library, and pushed to the iframe over the bridge. The vendored select's own
// enumeration of engine YAML on disk is left in place and simply merged with
// what the host feeds it.

"use client";

import { AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BuilderHostProvider } from "@/components/builder/builder-host-context";
import {
  casConflictActions,
  copyWorkflowId,
  copyWorkflowName,
} from "@/components/builder/cas-conflict";
import {
  blockedSaveStatus,
  issueLine,
  issueLocation,
} from "@/components/builder/issue-text";
import { SourcePicker } from "@/components/builder/source-picker";
import { PipelineBuilderPanel } from "@/components/pipeline-builder-panel";
import {
  builderOrigin,
  createBuilderHostBridge,
  withHostModeParam,
  type BuilderBridgeEnvelope,
  type BuilderBridgeStatus,
  type BuilderIssue,
  type BuilderRequestSourcePayload,
  type BuilderSourceGroup,
  type BuilderHostBridge,
} from "@/lib/builder-bridge";
import {
  listDagWorkflowDefinitions,
  readDagWorkflowDefinition,
  saveDagWorkflowDefinition,
  validateDagWorkflowDocument,
  type WorkflowGraphDocument,
} from "@/lib/dag-workflows";
import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
  findDagWorkflowTemplate,
  type DagWorkflowTemplateId,
} from "@/lib/dag-workflow-templates";
import { PIPELINE_ENGINE_URL } from "@/lib/embed-config";
import { useProjectScopeId } from "@/lib/projects";
import { applyDelta, rejectStaleDeltas, type CanvasDeltaOp } from "@/lib/typed-canvas-adapter";
import { typedToView, type GraphViewModel } from "@/lib/typed-graph-view";
import {
  listVendoredWorkflowRegistrySources,
  type VendoredPipelineEditTarget,
} from "@/lib/scientific-pipeline-registry";
import { cn } from "@/lib/utils";

/** What the host currently holds. `revision === null` means "never saved". */
interface LoadedWorkflow {
  /** `<groupId>:<entryId>` of the picker row this came from. */
  sourceKey: string;
  document: WorkflowGraphDocument;
  revision: number | null;
  graphSha256: string | null;
}

interface ConflictState {
  detail: string;
  /** Present only when the server published the revision it compared against. */
  currentRevision: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deltas arrive over an origin boundary; nothing about their shape is trusted. */
function parseDeltaOps(payload: unknown): CanvasDeltaOp[] {
  if (!isRecord(payload) || !Array.isArray(payload.ops)) return [];
  return payload.ops.filter(
    (operation): operation is CanvasDeltaOp =>
      isRecord(operation) && typeof operation.op === "string",
  );
}

function parseSourceRequest(payload: unknown): BuilderRequestSourcePayload | null {
  if (!isRecord(payload)) return null;
  const { groupId, entryId } = payload;
  if (typeof groupId !== "string" || typeof entryId !== "string") return null;
  if (groupId !== "kady-workflows" && groupId !== "workflows-library") return null;
  return { groupId, entryId };
}

export function DagBuilderSurface({
  editTarget,
}: {
  /** Pipeline to deep-link open in the vendored visual builder, if any. */
  editTarget?: VendoredPipelineEditTarget;
}) {
  const projectId = useProjectScopeId();

  const [kadyWorkflows, setKadyWorkflows] = useState<BuilderSourceGroup["entries"]>([]);
  const [enginePipelines, setEnginePipelines] = useState<BuilderSourceGroup["entries"]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedWorkflow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<BuilderIssue[]>([]);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [status, setStatus] = useState<string>("");
  const [bridgeStatus, setBridgeStatus] = useState<BuilderBridgeStatus>("connecting");
  const [saving, setSaving] = useState(false);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<BuilderHostBridge | null>(null);
  /** Latest message handler, so the bridge's listener never closes over stale state. */
  const onEnvelopeRef = useRef<(envelope: BuilderBridgeEnvelope) => void>(() => {});
  const loadedRef = useRef<LoadedWorkflow | null>(null);
  const viewRef = useRef<GraphViewModel | null>(null);

  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  const libraryEntries = useMemo(
    () =>
      DAG_WORKFLOW_TEMPLATES.map((template) => ({
        id: template.id,
        label: template.name,
        description: template.description,
        badge: template.domain,
      })),
    [],
  );

  /**
   * What the IFRAME's own select is fed. Engine pipelines are deliberately
   * absent: the vendored select already enumerates them from the engine itself,
   * and feeding them a second time would list every pipeline twice.
   */
  const groups = useMemo<BuilderSourceGroup[]>(
    () => [
      { id: "kady-workflows", label: "Kady workflows", entries: kadyWorkflows },
      { id: "workflows-library", label: "Workflows library", entries: libraryEntries },
    ],
    [kadyWorkflows, libraryEntries],
  );

  /** What the KADY picker renders — the same two groups plus engine pipelines. */
  const pickerGroups = useMemo<BuilderSourceGroup[]>(
    () =>
      enginePipelines.length === 0
        ? groups
        : [...groups, { id: "engine-pipelines", label: "Engine pipelines", entries: enginePipelines }],
    [groups, enginePipelines],
  );

  // --- source list -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    listDagWorkflowDefinitions(projectId)
      .then((summaries) => {
        if (cancelled) return;
        setSourceError(null);
        setKadyWorkflows(
          summaries.map((summary) => ({
            id: summary.id,
            label: summary.name,
            ...(summary.description ? { description: summary.description } : {}),
            badge: `${summary.nodeCount} node${summary.nodeCount === 1 ? "" : "s"}`,
          })),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Reported in the surface, never thrown into the render or the console:
        // an unreachable list must not take the legacy builder down with it.
        setSourceError(error instanceof Error ? error.message : "Could not read the workflow list.");
        setKadyWorkflows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Engine-native pipelines. A down or absent sidecar is NOT an error the author
  // needs to see here — the group simply does not appear, and the typed half of
  // the picker keeps working.
  useEffect(() => {
    let cancelled = false;
    listVendoredWorkflowRegistrySources(projectId)
      .then((sources) => {
        if (cancelled) return;
        setEnginePipelines(
          sources.map((source) => ({
            id: source.workflowId,
            label: source.displayName,
            ...(source.description ? { description: source.description } : {}),
            ...(source.origin ? { badge: source.origin } : {}),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setEnginePipelines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // --- bridge ------------------------------------------------------------

  const frameOrigin = useMemo(() => builderOrigin(PIPELINE_ENGINE_URL), []);

  const pushView = useCallback((view: GraphViewModel) => {
    viewRef.current = view;
    bridgeRef.current?.post("builder.loadGraph", { view });
  }, []);

  const publishDocument = useCallback(
    (next: LoadedWorkflow) => {
      setLoaded(next);
      loadedRef.current = next;
      pushView(typedToView(next.document, { graphSha256: next.graphSha256 }));
    },
    [pushView],
  );

  useEffect(() => {
    if (frameOrigin === null) return;
    const bridge = createBuilderHostBridge({
      targetOrigin: frameOrigin,
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      onMessage: (envelope) => onEnvelopeRef.current(envelope),
      onStatusChange: setBridgeStatus,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [frameOrigin]);

  // Keep the iframe's copy of the source list current whenever it changes.
  useEffect(() => {
    if (bridgeStatus !== "connected") return;
    bridgeRef.current?.post("builder.setSourceList", { groups });
  }, [groups, bridgeStatus]);

  // --- loading a source --------------------------------------------------

  const loadSource = useCallback(
    async (groupId: BuilderSourceGroup["id"], entryId: string) => {
      const sourceKey = `${groupId}:${entryId}`;
      setBusyKey(sourceKey);
      setConflict(null);
      setIssues([]);
      try {
        if (groupId === "kady-workflows") {
          const { definition } = await readDagWorkflowDefinition(projectId, entryId);
          publishDocument({
            sourceKey,
            document: definition.graph,
            revision: definition.revision,
            graphSha256: definition.graphSha256,
          });
          setDirty(false);
          setStatus(`Loaded ${definition.graph.name} (revision ${definition.revision}).`);
          setPickerOpen(false);
          return;
        }
        if (groupId === "workflows-library") {
          const template = findDagWorkflowTemplate(entryId);
          if (!template) {
            setStatus(`No such library template: ${entryId}`);
            return;
          }
          const document = createDagWorkflowTemplateGraph(
            template.id as DagWorkflowTemplateId,
            template.suggestedWorkflowId,
            template.name,
            template.description,
          );
          // A library template is a DRAFT: it has no revision, so its first
          // save is a create and cannot overwrite an existing workflow.
          publishDocument({ sourceKey, document, revision: null, graphSha256: null });
          setDirty(true);
          setStatus(`Started a new workflow from “${template.name}”. Save it to keep it.`);
          setPickerOpen(false);
          return;
        }
        // The engine document model belongs to the iframe, so the host asks it
        // to load rather than converting. Turning an engine pipeline into a
        // typed document is round 2's import work, and the canvas detaches from
        // the typed document first so no delta can be diffed across the two.
        const posted = bridgeRef.current?.post("builder.loadEnginePipeline", {
          workflowId: entryId,
        });
        setStatus(
          posted
            ? `Opening the engine pipeline “${entryId}” in the builder.`
            : "The canvas is not linked, so the engine pipeline could not be opened.",
        );
      } catch (error: unknown) {
        setStatus(
          error instanceof Error
            ? `Could not load that workflow: ${error.message}`
            : "Could not load that workflow.",
        );
      } finally {
        setBusyKey(null);
      }
    },
    [projectId, publishDocument],
  );

  // --- saving ------------------------------------------------------------

  const saveDocument = useCallback(
    async (
      current: LoadedWorkflow,
      intent: { kind: "create" } | { kind: "update"; expectedRevision: number },
      workflowId: string,
    ) => {
      setSaving(true);
      try {
        const validation = await validateDagWorkflowDocument(projectId, current.document);
        if (!validation.ok) {
          // Save is gated on a clean validation: only valid documents persist.
          setIssues(validation.issues);
          setStatus(blockedSaveStatus(validation.issues));
          bridgeRef.current?.post("builder.setIssues", { issues: validation.issues });
          return;
        }
        setIssues([]);
        bridgeRef.current?.post("builder.setIssues", { issues: [] });
        const saved = await saveDagWorkflowDefinition(
          projectId,
          workflowId,
          validation.document,
          intent,
        );
        publishDocument({
          sourceKey: `kady-workflows:${saved.definition.id}`,
          document: saved.definition.graph,
          revision: saved.definition.revision,
          graphSha256: saved.definition.graphSha256,
        });
        setDirty(false);
        setConflict(null);
        setStatus(`Saved ${saved.definition.id} at revision ${saved.definition.revision}.`);
        const summaries = await listDagWorkflowDefinitions(projectId).catch(() => null);
        if (summaries) {
          setKadyWorkflows(
            summaries.map((summary) => ({
              id: summary.id,
              label: summary.name,
              ...(summary.description ? { description: summary.description } : {}),
              badge: `${summary.nodeCount} node${summary.nodeCount === 1 ? "" : "s"}`,
            })),
          );
        }
      } catch (error: unknown) {
        const conflictActions = casConflictActions(error);
        if (conflictActions) {
          setConflict({
            detail: conflictActions.detail,
            currentRevision: conflictActions.overwriteRevision,
          });
          setStatus("This workflow changed since you loaded it.");
          return;
        }
        setStatus(error instanceof Error ? `Save failed: ${error.message}` : "Save failed.");
      } finally {
        setSaving(false);
      }
    },
    [projectId, publishDocument],
  );

  const save = useCallback(() => {
    const current = loadedRef.current;
    if (!current) {
      setStatus("Load a workflow before saving.");
      return;
    }
    void saveDocument(
      current,
      current.revision === null
        ? { kind: "create" }
        : { kind: "update", expectedRevision: current.revision },
      current.document.id,
    );
  }, [saveDocument]);

  const reloadFromServer = useCallback(() => {
    const current = loadedRef.current;
    if (!current) return;
    setConflict(null);
    void loadSource("kady-workflows", current.document.id);
  }, [loadSource]);

  const saveAsCopy = useCallback(() => {
    const current = loadedRef.current;
    if (!current) return;
    const copyId = copyWorkflowId(current.document.id);
    // The NAME travels with the id. Every picker row renders `name`, so a copy
    // that kept the original's name is a second row nobody can tell from the
    // first.
    const copyName = copyWorkflowName(current.document.name);
    void saveDocument(
      { ...current, document: { ...current.document, id: copyId, name: copyName } },
      { kind: "create" },
      copyId,
    );
  }, [saveDocument]);

  const forceOverwrite = useCallback(() => {
    const current = loadedRef.current;
    // Offered only when the server published the revision it compared against,
    // so the retry is STILL a conditional write. There is no blind overwrite.
    if (!current || conflict?.currentRevision === null || conflict === null) return;
    void saveDocument(
      current,
      { kind: "update", expectedRevision: conflict.currentRevision },
      current.document.id,
    );
  }, [conflict, saveDocument]);

  // --- inbound messages --------------------------------------------------

  const applyDocumentReplacement = useCallback(
    async (payload: unknown) => {
      const current = loadedRef.current;
      if (!current || !isRecord(payload) || !isRecord(payload.document)) return;
      // A whole-document replacement arrives as ONE document, so it is
      // validated server-side and applied as ONE undoable change rather than
      // being reconstructed from canvas ops.
      //
      // NOTHING SENDS THIS YET. The vendored builder has no editable YAML or
      // Split surface — `YamlCodeView.tsx` serializes into a `<pre>` — so no
      // hand-edited document reaches the canvas in this tree. The handler is
      // the receiving half of a protocol message whose producer lands with the
      // import work; it is kept, and documented as unreachable, rather than
      // being described as a working path.
      const candidate = payload.document as unknown as WorkflowGraphDocument;
      const validation = await validateDagWorkflowDocument(projectId, candidate).catch(() => null);
      if (validation === null) {
        setStatus("Could not validate the edited document.");
        return;
      }
      if (!validation.ok) {
        setIssues(validation.issues);
        setStatus(blockedSaveStatus(validation.issues));
        bridgeRef.current?.post("builder.setIssues", { issues: validation.issues });
        return;
      }
      setIssues([]);
      publishDocument({ ...current, document: validation.document });
      setDirty(true);
      setStatus("Applied the edited document.");
    },
    [projectId, publishDocument],
  );

  useEffect(() => {
    onEnvelopeRef.current = (envelope) => {
      switch (envelope.type) {
        case "builder.ready": {
          bridgeRef.current?.post("builder.init", {
            mode: "typed",
            protocolVersion: 1,
            hostLabel: "Kady",
          });
          bridgeRef.current?.post("builder.setSourceList", { groups });
          const current = loadedRef.current;
          if (current) {
            pushView(typedToView(current.document, { graphSha256: current.graphSha256 }));
          }
          return;
        }
        case "builder.requestSource": {
          const request = parseSourceRequest(envelope.payload);
          if (request) void loadSource(request.groupId, request.entryId);
          return;
        }
        case "builder.delta": {
          const current = loadedRef.current;
          const view = viewRef.current;
          if (!current || !view) return;
          const ops = parseDeltaOps(envelope.payload);
          if (ops.length === 0) return;
          const { fresh, stale } = rejectStaleDeltas(view, ops);
          const result = applyDelta(current.document, fresh);
          if (stale.length > 0 || result.rejected.length > 0) {
            // The canvas acted on a projection the host has moved past — or
            // asked for something the typed document cannot express. Re-push
            // the authoritative view instead of guessing what was meant.
            pushView(typedToView(current.document, { graphSha256: current.graphSha256 }));
          }
          if (result.applied.length === 0) return;
          const next = { ...current, document: result.document };
          setLoaded(next);
          loadedRef.current = next;
          // Push the result back. Not cosmetic: a node's `specDigest` covers
          // its position, so without this the NEXT drag of the same node would
          // carry a digest the host has already moved past and be dropped as
          // stale. The canvas does not reset — the vendored side re-applies a
          // view only when the document id or graph hash changes.
          pushView(typedToView(result.document, { graphSha256: current.graphSha256 }));
          setDirty(true);
          if (result.entryNodeReassigned) {
            setStatus(`Entry node moved to ${result.document.entryNodeId} after the removal.`);
          }
          return;
        }
        case "builder.requestSave": {
          save();
          return;
        }
        case "builder.documentReplaced": {
          // Unreachable in this tree: no producer exists. See
          // `applyDocumentReplacement` above.
          void applyDocumentReplacement(envelope.payload);
          return;
        }
        case "builder.canvasDetached": {
          // The canvas is showing something the host did not push. Holding on
          // to the typed document would leave a Save button that writes a
          // workflow nobody is looking at.
          if (loadedRef.current === null) return;
          loadedRef.current = null;
          viewRef.current = null;
          setLoaded(null);
          setDirty(false);
          setIssues([]);
          setConflict(null);
          setStatus("The canvas left the typed workflow. Pick one again to keep editing it.");
          return;
        }
        default:
          // builder.selection and builder.requestRun are accepted by the
          // protocol and deliberately inert this round; typed run lands with
          // the import work.
          return;
      }
    };
  }, [applyDocumentReplacement, groups, loadSource, pushView, save]);

  // --- iframe attachment -------------------------------------------------

  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    frameRef.current = frame;
  }, []);
  const onFrameLoad = useCallback(() => {
    bridgeRef.current?.reset();
  }, []);
  const hostAttachment = useMemo(
    () => ({ decorateSrc: withHostModeParam, attachFrame, onFrameLoad }),
    [attachFrame, onFrameLoad],
  );

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const disconnected = bridgeStatus === "timeout";

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="shrink-0 border-b">
        <div className="flex h-10 items-center gap-2 px-2.5">
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/50"
          >
            Load workflow
            {pickerOpen ? (
              <ChevronUpIcon className="size-3.5" />
            ) : (
              <ChevronDownIcon className="size-3.5" />
            )}
          </button>

          <span className="min-w-0 truncate text-xs font-medium" data-testid="loaded-workflow-name">
            {loaded ? loaded.document.name : "No workflow loaded"}
          </span>
          {dirty && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
          {loaded && (
            <span className="shrink-0 rounded border px-1.5 text-[10px] text-muted-foreground">
              {loaded.revision === null ? "draft" : `rev ${loaded.revision}`}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {issues.length > 0 && (
              <span
                className="rounded border border-destructive/50 px-1.5 text-[10px] text-destructive"
                title={issues.map(issueLine).join("\n")}
              >
                {errorCount > 0
                  ? `${errorCount} issue${errorCount === 1 ? "" : "s"}`
                  : `${issues.length} warning${issues.length === 1 ? "" : "s"}`}
              </span>
            )}
            <span
              className={cn(
                "rounded border px-1.5 text-[10px]",
                bridgeStatus === "connected" ? "text-muted-foreground" : "text-amber-600",
              )}
              data-testid="builder-bridge-status"
            >
              {bridgeStatus === "connected" ? "canvas linked" : "canvas not linked"}
            </span>
            <button
              type="button"
              onClick={save}
              disabled={!loaded || saving}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SaveIcon className="size-3.5" />
              {saving ? "Saving…" : "Save workflow"}
            </button>
          </div>
        </div>

        {pickerOpen && (
          <div className="border-t px-2.5 py-2">
            <SourcePicker
              groups={pickerGroups}
              selectedKey={loaded?.sourceKey ?? null}
              busyKey={busyKey}
              onSelect={(groupId, entryId) => void loadSource(groupId, entryId)}
            />
            {sourceError && (
              <p className="mt-1 text-[11px] text-destructive">
                The workflow list could not be read: {sourceError}
              </p>
            )}
          </div>
        )}

        {disconnected && (
          <p className="flex items-center gap-1.5 border-t bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            The canvas did not answer the host. Loading and saving typed workflows is paused; the
            builder below still works on its own.
          </p>
        )}

        {issues.length > 0 && (
          // The validator's own words, not a tally. Every issue is listed with
          // the node or edge it points at, so an author whose save was refused
          // can go and fix the thing rather than undoing edits until it passes.
          <ul
            data-testid="builder-issue-list"
            className="max-h-24 overflow-y-auto border-t bg-destructive/5 px-2.5 py-1 text-[11px]"
          >
            {issues.map((issue, index) => (
              <li
                key={`${issue.code}:${issue.path}:${String(index)}`}
                className="flex gap-1.5 py-px"
              >
                <span
                  className={cn(
                    "shrink-0 font-medium",
                    issue.severity === "error" ? "text-destructive" : "text-amber-600",
                  )}
                >
                  {issue.severity === "error" ? "Error" : "Warning"}
                </span>
                {issueLocation(issue) !== null && (
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {issueLocation(issue)}
                  </span>
                )}
                <span className="min-w-0">{issue.message}</span>
              </li>
            ))}
          </ul>
        )}

        {conflict && (
          <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-2.5 py-1.5 text-[11px]">
            <span>{conflict.detail}</span>
            <button type="button" onClick={reloadFromServer} className="rounded border px-1.5 py-0.5 hover:bg-muted">
              Reload
            </button>
            <button type="button" onClick={saveAsCopy} className="rounded border px-1.5 py-0.5 hover:bg-muted">
              Save as copy
            </button>
            {conflict.currentRevision !== null && (
              <button
                type="button"
                onClick={forceOverwrite}
                className="rounded border px-1.5 py-0.5 hover:bg-muted"
              >
                Overwrite revision {conflict.currentRevision}
              </button>
            )}
          </div>
        )}

        <p
          aria-live="polite"
          title={status}
          className="truncate px-2.5 py-0.5 text-[11px] text-muted-foreground"
          data-testid="builder-host-status"
        >
          {status}
        </p>
      </div>

      <BuilderHostProvider value={hostAttachment}>
        <PipelineBuilderPanel editTarget={editTarget} />
      </BuilderHostProvider>
    </div>
  );
}
