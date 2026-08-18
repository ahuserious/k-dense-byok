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
// reach the canvas either — there is no apply path, so its output is text the
// user copies in by hand. Until lane W3's bridge lands, every user-facing
// string in this rail and in `helperEmptyState("dag-builder")` is limited to
// explain / draft YAML you paste in / propose fixes. Do not write "apply", and
// do not write "visual DAG": the assistant cannot draw one.
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
        setWorkflows(saved);
        setWorkflowsError(null);
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
  // Only true once a list has actually come back: before that the rail must not
  // tell the user there is nothing to select.
  const hasSelectableContext = !workflowsLoaded || workflows.length > 0;

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
            // Deliberately not "…saved workflow revisions": Playwright matches
            // an accessible name by substring, so a label containing the
            // picker's own "SAVED WORKFLOW REVISION" text would make every
            // getByLabel for the picker ambiguous.
            aria-label="Refresh the workflow list"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            <RefreshCwIcon className="size-3" />
            Refresh
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
              : workflows.length === 0
                ? "No saved workflows yet"
                : "Select a saved workflow…"}
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
            BACK either. There is no bridge from this rail into the canvas. */}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          The assistant explains and drafts YAML you copy in. It cannot edit the canvas.
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
          providerBlocked={providerBlocked}
        />
      </div>
    </aside>
  );
}
