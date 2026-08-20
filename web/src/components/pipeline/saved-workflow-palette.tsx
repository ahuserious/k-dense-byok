// danbot-byok — web/src/components/pipeline/saved-workflow-palette.tsx
//
// Rows 19 and 22's control surface: the saved K-Dense workflows, as palette
// items you can put into the workflow you are editing.
//
// ROW 19 IS SPLIT IN TWO HERE, AND THE SPLIT IS THE HONEST PART.
//
//   "Add as phase"      — LIVE. Stitches the saved workflow onto the end of the
//                         loaded document as a new phase, stamping every added
//                         node's `meta.compositeOf` with the source workflow id
//                         AND its exact `graphSha256`. Real, saved, executed.
//
//   "Insert as reference" — DISABLED, with the reason on screen. Row 19's Gate B
//                         asks for "a real reference that resolves at run time".
//                         Measured, this tree cannot do that: there is no
//                         workflow-reference node kind in the typed union
//                         (schema.ts has agent, research-until-goal, council,
//                         fusion, best-of-n, evidence-gate, lean4 and nothing
//                         else); every object in schema.ts is
//                         `additionalProperties: false` so no field can carry
//                         one; and a run's graph is a SNAPSHOT —
//                         `store.ts:2427` builds the manifest with
//                         `graph: structuredClone(definition.graph)` and no
//                         expansion pass. So nothing would resolve a reference
//                         even if one could be stored.
//
// Shipping "Insert as reference" as a live control would be exactly the
// accepted-then-discarded pattern this wave exists to stop (#54, #55). It is
// rendered disabled with the reason instead (§6.7), and the enabling server
// change is requested in W/requests/c-f6-4.md.
//
// DRAG IS NOT THE ONLY ROUTE (§6.6). Row 19 says "draggable nodes", and a drag
// is a keyboard trap on its own. Every item here is a real `<button>`: it is in
// the tab order, Enter and Space activate it, and it carries `draggable` as an
// ADDITION for pointer users rather than as the only way in. The keyboard path
// and the pointer path call the same handler, so they cannot diverge.

"use client";

import { useState } from "react";

import type { DagWorkflowDefinitionSummary } from "@/lib/dag-workflows";

/** MIME the canvas would read if a drop lands there; also the a11y fallback. */
export const SAVED_WORKFLOW_DRAG_MIME = "application/kady-saved-workflow";

export const REFERENCE_INSERT_DISABLED_REASON =
  "The typed runtime has no workflow-reference node kind, and a run's graph is a snapshot taken at run creation — so a reference would never resolve. Tracked for Orchestrator B.";

export function SavedWorkflowPalette({
  workflows,
  onAddPhase,
  busyWorkflowId,
  canAddPhase,
  cannotAddPhaseReason,
  listError,
}: {
  workflows: readonly DagWorkflowDefinitionSummary[];
  /** Stitch this saved workflow onto the loaded document as a new phase. */
  onAddPhase: (workflowId: string) => void;
  busyWorkflowId?: string | null;
  canAddPhase: boolean;
  /** Why "Add as phase" is unavailable — shown, never implied. */
  cannotAddPhaseReason?: string;
  listError?: string | null;
}) {
  const [filter, setFilter] = useState("");

  const term = filter.trim().toLowerCase();
  const visible = term
    ? workflows.filter(
        (workflow) =>
          workflow.name.toLowerCase().includes(term) || workflow.id.toLowerCase().includes(term),
      )
    : workflows;

  return (
    <section
      aria-label="Saved workflows"
      data-testid="saved-workflow-palette"
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <h3 className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Saved workflows
        </h3>
        <input
          type="text"
          aria-label="Filter saved workflows"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter…"
          className="ml-auto h-6 w-32 rounded border bg-background px-1.5 text-[11px] placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        />
      </div>

      {listError ? (
        // #62/#6.8: a list that could not be read degrades to a named state and
        // never takes the surface down with it.
        <p role="alert" className="text-[11px] text-destructive">
          The saved-workflow list could not be read: {listError}
        </p>
      ) : workflows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No saved workflows yet. Save one from this builder and it will appear here.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No saved workflow matches “{filter}”.</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {visible.map((workflow) => {
            const busy = busyWorkflowId === workflow.id;
            return (
              <li key={workflow.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid={`saved-workflow-add-${workflow.id}`}
                  // Pointer affordance, layered ON TOP of the button — never
                  // instead of it.
                  draggable={canAddPhase}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(SAVED_WORKFLOW_DRAG_MIME, workflow.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  disabled={!canAddPhase || busy}
                  title={canAddPhase ? `Add ${workflow.name} as a new phase` : cannotAddPhaseReason}
                  onClick={() => onAddPhase(workflow.id)}
                  className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md border px-2 py-1 text-left text-[11px] hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
                >
                  <span className="min-w-0 truncate font-medium">{workflow.name}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">
                    rev {workflow.revision}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {busy ? "adding…" : "add as phase"}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid={`saved-workflow-reference-${workflow.id}`}
                  disabled
                  aria-describedby="saved-workflow-reference-reason"
                  title={REFERENCE_INSERT_DISABLED_REASON}
                  className="shrink-0 rounded-md border px-1.5 py-1 text-[10px] text-muted-foreground disabled:cursor-not-allowed"
                >
                  as reference
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!canAddPhase && cannotAddPhaseReason && workflows.length > 0 && (
        <p className="text-[10px] text-muted-foreground">{cannotAddPhaseReason}</p>
      )}

      <p
        id="saved-workflow-reference-reason"
        data-testid="saved-workflow-reference-reason"
        className="text-[10px] text-muted-foreground"
      >
        “As reference” is unavailable: {REFERENCE_INSERT_DISABLED_REASON}
      </p>
    </section>
  );
}
