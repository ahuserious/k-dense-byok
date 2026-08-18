// danbot-byok — web/src/components/dag-builder-surface.tsx
//
// The Kady-side frame around the vendored visual builder: a slim header strip,
// the full-bleed builder iframe, and a collapsible DAG-BUILDER ASSISTANT rail.
//
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
//   * Nothing is read out of the builder iframe. There is no postMessage bridge
//     to read from: the vendored in-canvas chat (CanvasChatPopout.tsx) is a
//     disabled null render, and the iframe is cross-origin. So the assistant
//     reasons about SAVED revisions, not the unsaved canvas draft — which is
//     also the only shape the server contract accepts. The picker below is
//     therefore the whole context surface.
//
// WHAT THE ASSISTANT CANNOT DO, and why the copy must not imply otherwise:
// the no-bridge fact above cuts BOTH ways. Nothing the assistant produces can
// reach the canvas either. There is no apply path AND no paste target: the
// engine's YAML surface is a <pre> that refuses edits in both YAML and Split
// modes, there is no YAML import anywhere in the vendored app or in Kady's web
// app, and /dag-workflow-imports/* has no caller in web/src. Precisely (r4
// review R6): the READ-ONLINESS holds in both modes, the "Read-only YAML
// preview" header that announces it renders in full YAML mode only —
// YamlCodeView.tsx:183-187 gates that header on `mode === 'full'`, and Split
// mode shows the same non-editable <pre> with nothing on screen saying so. The
// canvas app is not free of editable text either: selecting a node opens an
// inspector with real <textarea> fields (NodeInspector.tsx:955-1010,
// `JsonTextareaField`). None of them takes a workflow document — they are
// per-node config — so the conclusion is unchanged: no YAML import. So the
// draft is text in the rail's own transcript and nothing more, until lane W3's
// typed authoring path lands.
//
// The TWO STORES matter to the copy as much as the missing bridge. This rail's
// picker lists Kady's TYPED workflows (GET /dag-workflows). The canvas saves
// into the vendored engine's own store (PUT /api/workflows/<name> on the
// iframe's origin), and those appear in Scientific Pipelines as `vendored` rows
// that this picker never shows. So "save it in the canvas" is not a route to a
// selectable revision — "Scientific Pipelines → New typed workflow" is the only
// one — and the copy must not offer the first.
//
// The rule for every user-facing string here and in
// `helperEmptyState("dag-builder")`: it must name a route a user can walk end
// to end, and someone must have walked it. Rounds 1 and 3 both shipped copy that
// passed the word ban and still described something the product cannot do, so
// the ban ("apply", "applies", "visual", and naming the canvas as somewhere to
// put something) is a floor, not the test.
//
// WHERE THE BAN IS APPLIED, exactly — r4's report claimed it covered "every
// user-visible string in all four states", and it did not (r4 review R4).
// helper-agent-chat.test.tsx runs it over the 19 strings
// `helperEmptyState("dag-builder")` can return; dag-builder-surface.test.tsx
// runs it over this file's own fixed copy — the three strip lines, the four
// picker placeholder options and the rail's labels — which is where the line
// r3's F2 was actually about lives. Between them every fixed string the rail
// renders is covered. The three remaining strings are supplied at runtime (the
// list error, the helper session error, and the `{name} · rev {revision}`
// option label) and cannot be pinned by a static assertion.
//
// The main Kady chat is unaffected: it keeps its own `/sessions` sessions and
// never shares a transcript with this rail.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelRightCloseIcon, PanelRightOpenIcon, RefreshCwIcon } from "lucide-react";

import { HelperAgentChat } from "@/components/helper-agent-chat";
import { PipelineBuilderPanel } from "@/components/pipeline-builder-panel";
import {
  listDagWorkflowDefinitions,
  type DagWorkflowDefinitionSummary,
} from "@/lib/dag-workflows";
import { useModels } from "@/lib/use-models";
import { cn } from "@/lib/utils";
import type { VendoredPipelineEditTarget } from "@/lib/scientific-pipeline-registry";

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
  /** Scopes the assistant's helper session and its saved-workflow picker. */
  projectId: string;
  /** Pipeline to deep-link open in the vendored visual builder, if any. */
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Slim Raindrop-style chrome: neutral surface, hairline rule, small mono
          label, compact control. No gradients, blur, or glow. */}
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

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <PipelineBuilderPanel editTarget={editTarget} />
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
