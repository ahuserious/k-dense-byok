// danbot-byok — web/src/components/dag-builder-surface.tsx
//
// The Kady host for the vendored DAG builder, and the frame around it: the
// typed authoring controller (lane W3), and the collapsible DAG-BUILDER
// ASSISTANT rail beside it (lane W1). The two were written independently
// against different worlds and are reconciled here; the comments below say
// which facts survived that reconciliation and which did not.
//
// THE TYPED CONTROLLER — what the canvas is now.
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
//
// WHAT THE BRIDGE CARRIES, exactly, because the rail's copy is written against
// it: a saved Kady typed workflow or a library template goes onto the canvas
// (`builder.loadGraph`), canvas edits come back as deltas (`builder.delta`),
// a save is validated server-side and written with an `If-Match` precondition.
// A YAML or hand-edited document does NOT: `builder.documentReplaced` has a
// receiving handler here and NO producer anywhere in the tree, because the
// vendored YAML/Split view is a one-way serializer into a `<pre>`
// (YamlCodeView.tsx:181-201). And loading an ENGINE-native pipeline over a
// typed one DETACHES the canvas (`builder.canvasDetached`, posted from
// `leaveHostView` in WorkflowBuilder.tsx:183-186) rather than importing into
// it — the host drops the typed document instead of diffing two unrelated
// graphs against each other.
//
// THE ASSISTANT RAIL — a SEPARATE session, and still no path to the canvas.
// The rail used to host a general Kady chat (chat-rail.tsx, "Ask Kady
// anything…" + "Add to pipeline"; both files deleted 2026-08-18 once nothing
// referenced them). To be precise about what that was — the round-1 report and
// commit called it "the MAIN Kady session", which overstates it: it was a
// `ChatTab` with its own `useAgent` instance and its own session id, but bound
// to the MAIN profile, so it looked and behaved exactly like the assistant the
// user talks to everywhere else (same composer copy, model picker, tools, cost
// meter) and the Builder still had no chat of its own. It now hosts the
// dedicated `dag-builder` helper profile instead: a SEPARATE Pi session with
// its own session id, its own transcript, and no tools.
//
// WHAT IS SENT TO THE ASSISTANT — and what is not:
//   * The browser POSTs `/helper-sessions/dag-builder` with exactly
//     `{ kind: "workflow", id: "<workflow-id>@<revision>" }` — a typed pointer
//     at one SAVED native workflow revision, nothing more. server/src/api/
//     sessions.ts:194 rejects any other key, so a draft graph, a YAML blob, or
//     a filesystem path cannot be smuggled through this route.
//   * Each question is sent alone (helper-agent-chat.tsx). The SERVER rebuilds
//     the bounded projection of that revision from its own store
//     (server/src/agent/raindrop-context.ts buildDagBuilderContext) and refuses
//     if the stored revision has moved on.
//   * Nothing is read out of the builder iframe INTO the rail. The host bridge
//     above is the host's, not the assistant's: it carries typed documents and
//     deltas between this component and the canvas, and the rail is not on it.
//     So the assistant still reasons about SAVED revisions, not the unsaved
//     canvas draft — which is also the only shape the server contract accepts.
//     The picker in the rail is therefore the whole context surface.
//
// WHAT THE ASSISTANT CANNOT DO, and why the copy must not imply otherwise:
// nothing the assistant produces can reach the canvas. W3's bridge did not
// change this and could not: it carries a `WorkflowGraphDocument` the HOST
// loaded from the typed store or built from a library template, never chat
// output, and the one message type that could carry a hand-authored document
// (`builder.documentReplaced`) has no producer. There is no apply path AND no
// paste target: the engine's YAML surface is a <pre> that refuses edits in both
// YAML and Split modes, there is no YAML import anywhere in the vendored app or
// in Kady's web app, and /dag-workflow-imports/* — a server-side PREVIEW route
// that translates legacy Pipeline YAML and writes nothing — has no caller in
// web/src. Precisely (r4 review R6): the READ-ONLINESS holds in both modes, the
// "Read-only YAML preview" header that announces it renders in full YAML mode
// only — YamlCodeView.tsx:186-190 gates that header on `mode === 'full'`, and
// Split mode shows the same non-editable <pre> with nothing on screen saying
// so. The canvas app is not free of editable text either: selecting a node
// opens an inspector with real <textarea> fields (NodeInspector.tsx:955-1010,
// `JsonTextareaField`). None of them takes a workflow document — they are
// per-node config — so the conclusion is unchanged: no YAML import. So the
// assistant's draft is text in the rail's own transcript and nothing more.
//
// THE TWO STORES still matter to the copy, but they no longer decide it. This
// rail's picker lists Kady's TYPED workflows (GET /dag-workflows). The engine's
// own store (PUT /api/workflows/<name> on the iframe's origin) is still a
// separate place whose rows this picker never shows. What changed with W3 is
// that the canvas is no longer only a client of that other store: a library
// template loaded through the picker above and saved with "Save workflow"
// writes to the TYPED store, so it produces exactly the revision this rail can
// then list. "Scientific Pipelines → New typed workflow" is therefore no longer
// the only route to a listable revision, and the empty-state copy in
// `helperEmptyState("dag-builder")` names both.
//
// The rule for every user-facing string here and in
// `helperEmptyState("dag-builder")`: it must name a route a user can walk end
// to end, and someone must have walked it. Rounds 1 and 3 both shipped copy that
// passed the word ban and still described something the product cannot do, and
// round 6 found the mirror image — copy DENYING a route the product had gained
// — so the ban ("apply", "applies", "visual", and naming the canvas as
// somewhere to put something) is a floor, not the test.
//
// WHERE THE BAN IS APPLIED, exactly — r4's report claimed it covered "every
// user-visible string in all four states", and it did not (r4 review R4).
// helper-agent-chat.test.tsx runs it over the 19 strings
// `helperEmptyState("dag-builder")` can return; dag-builder-surface.test.tsx
// runs it over this file's own fixed copy — the strip lines, the picker
// placeholder options, the rail's labels, and now the typed toolbar's controls
// and its fixed banner text — which is where the line r3's F2 was actually
// about lives. Between them every fixed string this surface renders is covered.
// The strings supplied at runtime (the list error, the helper session error,
// the `{name} · rev {revision}` option label, the host status line, and the
// validator's own issue messages) cannot be pinned by a static assertion.
//
// The main Kady chat is unaffected: it keeps its own `/sessions` sessions and
// never shares a transcript with this rail.

"use client";

import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react";
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
import { FusionBoostOptions } from "@/components/pipeline/fusion-boost-options";
import { SavedWorkflowPalette } from "@/components/pipeline/saved-workflow-palette";
import { HelperAgentChat } from "@/components/helper-agent-chat";
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
  type DagWorkflowDefinitionSummary,
  type WorkflowGraphDocument,
} from "@/lib/dag-workflows";
import { exactKadyCurrentModel } from "@/lib/dag-workflow-builder";
import {
  DAG_WORKFLOW_TEMPLATES,
  createDagWorkflowTemplateGraph,
  findDagWorkflowTemplate,
  type DagWorkflowTemplateId,
} from "@/lib/dag-workflow-templates";
import { PIPELINE_ENGINE_URL } from "@/lib/embed-config";
import {
  FUSION_BOOST_DEFAULT,
  applyFusionBoost,
  readFusionBoost,
  type FusionBoostConfig,
} from "@/lib/fusion-boost";
import { StitchError, stitchWorkflows } from "@/lib/stitch-workflows";
import { applyDelta, rejectStaleDeltas, type CanvasDeltaOp } from "@/lib/typed-canvas-adapter";
import { typedToView, type GraphViewModel } from "@/lib/typed-graph-view";
import { useModels } from "@/lib/use-models";
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

// Open on a first visit, and remember the user's choice after that.
const ASSISTANT_OPEN_STORAGE_KEY = "kady.dagBuilderAssistant.open";

/**
 * The rail's visibility is a preference, not state worth taking the Builder
 * down for: `localStorage` throws `SecurityError` outright in blocked-storage
 * contexts (third-party-cookie blocking, some private modes), and this read
 * runs in the render phase, where a throw would unmount the whole surface.
 * Both accessors therefore degrade to "open", the first-visit default.
 */
function readAssistantOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ASSISTANT_OPEN_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function persistAssistantOpen(open: boolean): void {
  try {
    window.localStorage.setItem(ASSISTANT_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // The choice simply does not survive a reload. Nothing else depends on it.
  }
}

/** The `<workflow-id>@<revision>` pointer the dag-builder helper profile takes. */
function workflowRevisionId(workflow: DagWorkflowDefinitionSummary): string {
  return `${workflow.id}@${workflow.revision}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Exactly the five fields of a listed row that this rail RENDERS or SENDS:
 * `name` and `revision` are the option's visible text, `id` and `revision` are
 * the `<workflow-id>@<revision>` pointer POSTed to /helper-sessions, and
 * `nodeCount`/`edgeCount` are the strip line under the picker. The other five
 * stored fields are never read here, so they stay trusted — same posture as the
 * rest of this client.
 *
 * WHY A ROW IS DROPPED RATHER THAN RENDERED (r4 review R3a): a row missing
 * `name`/`revision` renders an option whose entire visible text is "· rev", and
 * selecting it binds the pointer "undefined@undefined", which the server
 * rejects on every question. An unselectable-in-practice option that looks
 * selectable is worse than an absent one.
 *
 * WHY DROPPING ONE ALSO RAISES THE LIST ERROR: silence would put the rail back
 * in the failure r3's F8 was about. A project holding one malformed row and
 * nothing else would render "No saved workflow to work on yet" and send the
 * user off to create a workflow it cannot see; a project holding nine good rows
 * and one bad one would present a picker that silently claims to be the whole
 * list. Neither is knowable from a filtered array, so the drop is reported and
 * the surviving rows stay selectable — the same precedence the rail already
 * uses for a failed RELOAD that holds a usable list.
 */
function isUsableWorkflowSummary(value: unknown): value is DagWorkflowDefinitionSummary {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<DagWorkflowDefinitionSummary>;
  return (
    typeof row.id === "string"
    && row.id.length > 0
    && typeof row.name === "string"
    && row.name.length > 0
    && isNonNegativeInteger(row.revision)
    && isNonNegativeInteger(row.nodeCount)
    && isNonNegativeInteger(row.edgeCount)
  );
}

export function DagBuilderSurface({
  projectId,
  editTarget,
}: {
  /**
   * Scopes the typed source list, the save route, the assistant's helper
   * session and its saved-workflow picker.
   *
   * A PROP, not `useProjectScopeId()`: page.tsx renders this inside its own
   * `ProjectScopeProvider value={projectId}` (page.tsx:274) and passes the same
   * id down explicitly (page.tsx:1302-1307), so the two agree — but the prop is
   * what the caller type-checks against, and the rail needs the id for its
   * `key` anyway.
   */
  projectId: string;
  /** Pipeline to deep-link open in the vendored builder canvas, if any. */
  editTarget?: VendoredPipelineEditTarget;
}) {
  // Read once during render rather than corrected in an effect: page.tsx only
  // mounts the workspace after its own client-side hydration gate, so this
  // subtree is never in the server HTML and cannot mismatch.
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  const toggleAssistant = useCallback(() => {
    // Persisted HERE rather than inside the `setAssistantOpen` updater: updater
    // functions must be pure, and React may invoke one twice (StrictMode) or
    // discard its result during a re-render. The write is a side effect and
    // belongs in the event handler that caused it.
    const next = !assistantOpen;
    persistAssistantOpen(next);
    setAssistantOpen(next);
  }, [assistantOpen]);

  const [kadyWorkflows, setKadyWorkflows] = useState<BuilderSourceGroup["entries"]>([]);
  const [enginePipelines, setEnginePipelines] = useState<BuilderSourceGroup["entries"]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  // Rows 19/22/25 live behind their own disclosure rather than in the always-on
  // strip: the toolbar already carries eight controls, and §6.4 bans chrome
  // that does not carry information. Closed by default, labelled, in tab order.
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeBusyId, setComposeBusyId] = useState<string | null>(null);
  /** The full summaries, kept beside the picker's projection of them. */
  const [savedSummaries, setSavedSummaries] = useState<DagWorkflowDefinitionSummary[]>([]);
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
        setSavedSummaries(summaries);
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
        setSavedSummaries([]);
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

  // --- composing: rows 19, 22 and 25 -------------------------------------

  /**
   * Row 19 + row 22: append a saved workflow to the loaded document as a new
   * PHASE.
   *
   * The phase boundary is real topology, not a label: `stitchWorkflows` routes
   * the loaded document's terminal nodes into the appended workflow's entry
   * node, so the ordinary DAG scheduler runs phase 1 to completion before phase
   * 2 starts. Every appended node carries `meta.compositeOf` naming the source
   * workflow AND the exact `graphSha256` it was taken from.
   *
   * The loaded document keeps its own node ids (`idPrefix: ""`): re-prefixing
   * them on every append would churn the author's ids for nothing.
   */
  const addPhaseFromSaved = useCallback(
    async (workflowId: string) => {
      const current = loadedRef.current;
      if (!current) {
        setStatus("Load a workflow before adding a phase to it.");
        return;
      }
      setComposeBusyId(workflowId);
      try {
        const { definition } = await readDagWorkflowDefinition(projectId, workflowId);
        const { document, phases } = stitchWorkflows(
          [
            {
              document: current.document,
              sourceId: current.document.id,
              ...(current.graphSha256 ? { graphSha256: current.graphSha256 } : {}),
              label: current.document.name,
              idPrefix: "",
            },
            {
              document: definition.graph,
              sourceId: definition.id,
              graphSha256: definition.graphSha256,
              label: definition.graph.name,
              idPrefix: `${definition.id}-`,
            },
          ],
          { id: current.document.id, name: current.document.name },
        );
        publishDocument({ ...current, document });
        setDirty(true);
        setStatus(
          `Added ${definition.graph.name} (revision ${String(definition.revision)}) as a phase after ${String(phases[0]?.handoverNodeIds.length ?? 0)} handover node(s). Save to keep it.`,
        );
      } catch (error: unknown) {
        setStatus(
          error instanceof StitchError
            ? `Could not add that phase: ${error.message}`
            : error instanceof Error
              ? `Could not read that workflow: ${error.message}`
              : "Could not add that phase.",
        );
      } finally {
        setComposeBusyId(null);
      }
    },
    [projectId, publishDocument],
  );

  /**
   * Row 25. The checkbox state is DERIVED from the loaded document rather than
   * held beside it, so a saved-and-reloaded workflow shows the boost it
   * actually carries. A control that remembered its own value while the
   * document dropped it is the pattern this wave exists to stop (#54, #55).
   */
  const fusionBoost: FusionBoostConfig = loaded
    ? readFusionBoost(loaded.document)
    : FUSION_BOOST_DEFAULT;

  const changeFusionBoost = useCallback(
    (next: FusionBoostConfig) => {
      const current = loadedRef.current;
      if (!current) return;
      const { document, appliedStages } = applyFusionBoost(current.document, next, {
        // Supplied by the host rather than invented inside the policy — see
        // fusion-boost.ts. Every document this builder creates already carries a
        // `defaultModel`, so this is the belt to that braces.
        fallbackModel: exactKadyCurrentModel(),
      });
      publishDocument({ ...current, document });
      setDirty(true);
      setStatus(
        appliedStages.length > 0
          ? `Fusion boost on at: ${appliedStages.join(", ")}. Save to keep it.`
          : "Fusion boost off. Save to keep it.",
      );
    },
    [publishDocument],
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
          setSavedSummaries(summaries);
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
      {/* Slim Raindrop-style chrome: neutral surface, hairline rule, small mono
          label, compact control. No gradients, blur, or glow. Kept as its own
          strip above the typed toolbar rather than folded into it: this row
          names the SURFACE and toggles the rail, the row below is the loaded
          document's controls, and merging the two put eight controls of three
          different kinds on one line. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 font-mono">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
          DAG BUILDER
        </span>
        <button
          type="button"
          onClick={toggleAssistant}
          aria-pressed={assistantOpen}
          aria-label={assistantOpen ? "Hide builder assistant" : "Show builder assistant"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
            assistantOpen
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          {assistantOpen ? (
            <PanelRightCloseIcon className="size-3.5" />
          ) : (
            <PanelRightOpenIcon className="size-3.5" />
          )}
          Assistant
        </button>
      </div>

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

          <button
            type="button"
            data-testid="compose-toggle"
            onClick={() => setComposeOpen((open) => !open)}
            aria-expanded={composeOpen}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            Compose
            {composeOpen ? (
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

        {composeOpen && (
          <div
            data-testid="compose-panel"
            className="flex flex-col gap-2.5 border-t px-2.5 py-2"
          >
            <SavedWorkflowPalette
              workflows={savedSummaries}
              busyWorkflowId={composeBusyId}
              canAddPhase={loaded !== null}
              cannotAddPhaseReason={
                loaded === null
                  ? "Load a workflow first — a phase is added to the workflow you are editing."
                  : undefined
              }
              listError={sourceError}
              onAddPhase={(workflowId) => void addPhaseFromSaved(workflowId)}
            />
            <FusionBoostOptions
              config={fusionBoost}
              onChange={changeFusionBoost}
              disabled={loaded === null}
              disabledReason={
                loaded === null ? "Load a workflow first." : undefined
              }
            />
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

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <BuilderHostProvider value={hostAttachment}>
            <PipelineBuilderPanel editTarget={editTarget} />
          </BuilderHostProvider>
        </div>

        {/* Keyed by project so switching projects resets the picker and the
            helper session by remount rather than by clearing state from an
            effect. Kept mounted while collapsed so an in-flight helper turn and
            the rail's transcript survive hiding the panel; `hidden`
            (display:none) already takes it and its controls out of the tree for
            assistive tech, so an extra aria-hidden would only blank the
            landmark's own name. */}
        <BuilderAssistantRail key={projectId} projectId={projectId} open={assistantOpen} />
      </div>
    </div>
  );
}

function BuilderAssistantRail({
  projectId,
  open,
}: {
  projectId: string;
  open: boolean;
}) {
  const [workflows, setWorkflows] = useState<DagWorkflowDefinitionSummary[]>([]);
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const contextSelectId = `dag-builder-assistant-context-${projectId}`;

  // Revalidated, NOT fetched once for the life of the page. The canvas saves
  // revisions inside a cross-origin iframe this rail cannot observe, and
  // PersistentWorkspaceSurfaces keeps the Builder mounted after a first visit,
  // so a one-shot list goes stale in two user-visible ways: a project that has
  // since gained its first workflow keeps reading "No saved workflows yet", and
  // a selection whose workflow was saved over keeps pointing at a superseded
  // revision, which the server rejects with CONFLICT on every question.
  // The two triggers this rail actually controls are re-opening it and the
  // explicit Refresh control below; between them the option list is a snapshot,
  // and the SERVER — not this list — is the authority on whether a pointer is
  // still valid.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listDagWorkflowDefinitions(projectId)
      .then((saved) => {
        if (cancelled) return;
        // A 200 is not a list. `listDagWorkflowDefinitions` returns
        // `body.workflows` with no validation (web/src/lib/dag-workflows.ts),
        // so `200 {}` used to hand this state `undefined` and the
        // `workflows.find` below then threw IN THE RENDER PHASE — past the
        // rail, past the Builder, out to "Application error: a client-side
        // exception has occurred" for the whole page. The `.catch` on this
        // chain cannot help: there is no rejection (r4 review R3b). The
        // declared type is precisely what is not trustworthy here, so it is
        // widened before it is believed.
        //
        // A malformed envelope means the rail does not KNOW what this project
        // holds — the same thing a failed fetch means — so it falls into the
        // `unlistable` state rather than claiming the project is empty.
        const listed: unknown = saved;
        const rows = Array.isArray(listed) ? (listed as unknown[]) : null;
        const usable = rows ? rows.filter(isUsableWorkflowSummary) : [];
        setWorkflows(usable);
        // Three different things happened and the alert says which, because the
        // user's next move differs: an envelope that is not a list is a client
        // or route problem, a list whose every row is unreadable is a store
        // problem, and a list that lost SOME rows still has usable ones in it.
        if (!rows) {
          setWorkflowsError("Saved workflows could not be listed.");
        } else if (usable.length === rows.length) {
          setWorkflowsError(null);
        } else if (usable.length === 0) {
          setWorkflowsError("Saved workflows could not be read.");
        } else {
          setWorkflowsError("Some saved workflows could not be read and are not listed.");
        }
        setWorkflowsLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWorkflowsError(
          error instanceof Error ? error.message : "Saved workflows could not be listed.",
        );
        setWorkflowsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, refreshToken]);

  // A revision that moved on under the selection is rejected by the server, so
  // a refresh that no longer lists the selected pointer drops the selection
  // back to "none" and the composer blocks again — which is the honest state,
  // not a silent CONFLICT on the next question.
  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflowRevisionId(workflow) === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );
  // Three separate facts, and the copy needs all three kept apart. Folding the
  // first fetch into `hasSelectableContext` (as `!workflowsLoaded || length > 0`
  // did) avoided the worse error of claiming emptiness early, but it bought that
  // by telling the user to "choose a saved revision above" while the picker's
  // only option read "Loading saved workflows…" — four strings naming a control
  // that had nothing in it (r4 review R2). The helper now gets the loading
  // instant as its own state and says it is waiting.
  const contextListLoading = !workflowsLoaded;
  const hasSelectableContext = workflows.length > 0;
  // "The list failed" is not "the project is empty". Left conflated, a failed
  // fetch made the rail assert "No saved workflow to work on yet" and then send
  // the user off to create a workflow they may already own (r3 review F8).
  const contextListFailed = workflowsError !== null;

  // "No provider connected" for a helper that has no model picker of its own:
  // the catalogue marks every entry unavailable exactly when nothing is
  // configured. While the credentials probe is still in flight the OpenRouter
  // entries stay `available`, so the amber hint never flashes on load.
  const { models } = useModels();
  const providerBlocked = useMemo(
    () => models.length > 0 && models.every((model) => model.available === false),
    [models],
  );

  return (
    <aside
      aria-label="DAG builder assistant"
      className={cn(
        "h-full w-[360px] shrink-0 flex-col border-l bg-background",
        open ? "flex" : "hidden",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 font-mono">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
          BUILDER ASSISTANT
        </span>
        <span className="text-[10px] text-muted-foreground">separate session</span>
      </div>
      <div className="shrink-0 border-b px-3 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <label
            className="block font-mono text-[10px] tracking-wide text-muted-foreground"
            htmlFor={contextSelectId}
          >
            SAVED WORKFLOW REVISION
          </label>
          <button
            type="button"
            onClick={() => setRefreshToken((token) => token + 1)}
            // "Reload", not "Refresh", and not "…saved workflow revisions".
            // Playwright matches an accessible name by substring for BOTH
            // getByLabel and getByRole(role, { name }), so: a label containing
            // the picker's own "SAVED WORKFLOW REVISION" text would make every
            // getByLabel for the picker ambiguous, and a label containing
            // "Refresh" would be a second match for the
            // getByRole("button", { name: "Refresh" }) already used by
            // e2e/console-raindrop.spec.ts:195, e2e/scientific-pipelines.spec.ts
            // and e2e/live-backend.spec.ts — a strict-mode violation waiting for
            // the first spec that visits the Builder with this rail visible
            // (r3 review F7). The visible label matches, so the empty-state copy
            // can tell the user to "press Reload" and mean this control.
            aria-label="Reload the workflow list"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            <RefreshCwIcon className="size-3" />
            Reload
          </button>
        </div>
        <select
          id={contextSelectId}
          value={selectedWorkflowId ?? ""}
          onChange={(event) => setSelectedWorkflowId(event.target.value || null)}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <option value="">
            {!workflowsLoaded
              ? "Loading saved workflows…"
              : workflows.length > 0
                ? "Select a saved workflow…"
                : workflowsError
                  ? "Saved workflows could not be listed"
                  : "No saved workflows yet"}
          </option>
          {workflows.map((workflow) => (
            <option key={workflowRevisionId(workflow)} value={workflowRevisionId(workflow)}>
              {workflow.name} · rev {workflow.revision}
            </option>
          ))}
        </select>
        {/* The list error is rendered ABOVE the boundary text, not instead of
            it: the previous ternary dropped the one sentence that explains what
            leaves the browser exactly when the rail was already misbehaving. */}
        {workflowsError ? (
          <p role="alert" className="mt-1 text-[10px] text-destructive">
            {workflowsError}
          </p>
        ) : null}
        {/* Permanent, in every state. The boundary used to be the `else` branch
            of a ternary, so it vanished the moment a revision was picked — i.e.
            exactly when context WAS being sent and the reassurance was worth
            something. The node/edge count is an additional line now, not a
            substitution. */}
        <p className="mt-1 text-[10px] text-muted-foreground">
          Only the selected revision is sent — never the unsaved canvas draft.
        </p>
        {selectedWorkflow ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {selectedWorkflow.nodeCount} nodes · {selectedWorkflow.edgeCount} edges sent as
            bounded, server-rebuilt context.
          </p>
        ) : null}
        {/* The other half of the boundary, and just as permanent: nothing comes
            BACK either. This line used to end "…drafts YAML you copy in", which
            named a paste target that does not exist — the canvas's YAML surface
            is read-only and nothing in the product imports YAML (r3 review F2).
            It now states the limit instead of implying a route. */}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          The assistant explains and drafts YAML here in the chat. It cannot edit the canvas, and the
          canvas has no YAML import.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <HelperAgentChat
          projectId={projectId}
          profile="dag-builder"
          contextReference={
            selectedWorkflow
              ? { kind: "workflow", id: workflowRevisionId(selectedWorkflow) }
              : undefined
          }
          hasSelectableContext={hasSelectableContext}
          contextListFailed={contextListFailed}
          contextListLoading={contextListLoading}
          providerBlocked={providerBlocked}
        />
      </div>
    </aside>
  );
}
