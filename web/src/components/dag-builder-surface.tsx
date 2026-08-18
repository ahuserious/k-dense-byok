// danbot-byok — web/src/components/dag-builder-surface.tsx
//
// The Kady-side frame around the vendored visual builder: a slim header strip,
// the full-bleed builder iframe, and a collapsible DAG-BUILDER ASSISTANT rail.
//
// The rail used to host the MAIN Kady chat (chat-rail.tsx, "Ask Kady anything…"
// + "Add to pipeline"; both files deleted 2026-08-18 once nothing referenced
// them). That was the same session the user talks to everywhere else, so the
// Builder had no chat of its own. It now hosts the dedicated
// `dag-builder` helper profile instead: a SEPARATE Pi session with its own
// session id, its own transcript, and no tools.
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
// The main Kady chat is unaffected: it keeps its own `/sessions` sessions and
// never shares a transcript with this rail.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";

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
  const [assistantOpen, setAssistantOpen] = useState(
    () =>
      typeof window === "undefined" ||
      window.localStorage.getItem(ASSISTANT_OPEN_STORAGE_KEY) !== "0",
  );
  const toggleAssistant = useCallback(() => {
    setAssistantOpen((open) => {
      window.localStorage.setItem(ASSISTANT_OPEN_STORAGE_KEY, open ? "0" : "1");
      return !open;
    });
  }, []);

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
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const contextSelectId = `dag-builder-assistant-context-${projectId}`;

  useEffect(() => {
    let cancelled = false;
    void listDagWorkflowDefinitions(projectId)
      .then((saved) => {
        if (!cancelled) setWorkflows(saved);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWorkflowsError(
          error instanceof Error ? error.message : "Saved workflows could not be listed.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // A revision that moved on under the selection is rejected by the server, so
  // the option list is the authority on which pointer is still selectable.
  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflowRevisionId(workflow) === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );

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
        <label
          className="block font-mono text-[10px] tracking-wide text-muted-foreground"
          htmlFor={contextSelectId}
        >
          SAVED WORKFLOW REVISION
        </label>
        <select
          id={contextSelectId}
          value={selectedWorkflowId ?? ""}
          onChange={(event) => setSelectedWorkflowId(event.target.value || null)}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <option value="">
            {workflows.length === 0 ? "No saved workflows yet" : "Select a saved workflow…"}
          </option>
          {workflows.map((workflow) => (
            <option key={workflowRevisionId(workflow)} value={workflowRevisionId(workflow)}>
              {workflow.name} · rev {workflow.revision}
            </option>
          ))}
        </select>
        {workflowsError ? (
          <p role="alert" className="mt-1 text-[10px] text-destructive">
            {workflowsError}
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {selectedWorkflow
              ? `${selectedWorkflow.nodeCount} nodes · ${selectedWorkflow.edgeCount} edges sent as bounded, server-rebuilt context.`
              : "Only the selected revision is sent — never the unsaved canvas draft."}
          </p>
        )}
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
          providerBlocked={providerBlocked}
        />
      </div>
    </aside>
  );
}
