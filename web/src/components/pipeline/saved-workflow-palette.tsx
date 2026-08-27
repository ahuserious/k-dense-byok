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
//   "Insert as reference" — LIVE. Authors a `workflow-ref` node (schema.ts:632)
//                         whose `workflowId` and `expectedRevision` pin the
//                         saved workflow's id and the revision listed here.
//                         Expansion is a run-creation snapshot
//                         (`store.ts:2864,2914`;
//                         `kinds/workflow-ref-expand.ts:42`): the executor
//                         never sees a leftover `workflow-ref`, and a later
//                         edit of the referenced workflow does not change an
//                         already-created run.
//
// DRAG IS NOT THE ONLY ROUTE (§6.6). Row 19 says "draggable nodes", and a drag
// is a keyboard trap on its own. Every item here is a real `<button>`: it is in
// the tab order, Enter and Space activate it, and it carries `draggable` as an
// ADDITION for pointer users rather than as the only way in. The keyboard path
// and the pointer path call the same handler, so they cannot diverge.

"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DagWorkflowDefinitionSummary } from "@/lib/dag-workflows";

/** MIME the canvas would read if a drop lands there; also the a11y fallback. */
export const SAVED_WORKFLOW_DRAG_MIME = "application/kady-saved-workflow";

export function SavedWorkflowPalette({
  workflows,
  onAddPhase,
  onInsertReference,
  busyWorkflowId,
  canAddPhase,
  cannotAddPhaseReason,
  listError,
}: {
  workflows: readonly DagWorkflowDefinitionSummary[];
  /** Stitch this saved workflow onto the loaded document as a new phase. */
  onAddPhase: (workflowId: string) => void;
  /**
   * Insert a `workflow-ref` node pinned to this saved workflow's id and the
   * revision shown in the palette (snapshot semantics).
   */
  onInsertReference: (workflow: DagWorkflowDefinitionSummary) => void;
  busyWorkflowId?: string | null;
  canAddPhase: boolean;
  /** Why "Add as phase" is unavailable — shown, never implied. */
  cannotAddPhaseReason?: string;
  listError?: string | null;
}) {
  const [filter, setFilter] = useState("");
  const [pendingPhaseWorkflow, setPendingPhaseWorkflow] =
    useState<DagWorkflowDefinitionSummary | null>(null);

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
                  // BF-57. The keyboard-accessible add path used to stitch
                  // immediately while the drag path showed a confirmation.
                  // Both routes now tell the user what will happen first.
                  onClick={() => setPendingPhaseWorkflow(workflow)}
                  // BF-31. THE NAME GETS ITS OWN LINE, AND THE ARITHMETIC IS WHY.
                  //
                  // This row used to be one flex line — name, `rev N`, `add as
                  // phase` — and the name was the only child that could shrink
                  // (`min-w-0`, default `flex-shrink: 1`; the other two are
                  // `shrink-0`). Measured on the served build inside the
                  // Builder's fixed 248px column (builder-left-menu.tsx:41):
                  //
                  //   panel content            227px
                  //   − "as reference" button   88px  (shrink-0 sibling)
                  //   − row gap                  6px
                  //   = this button             133px → 131px padding box
                  //   − px-2                    16px
                  //   = content width          115px
                  //   furniture: rev N 34 + "add as phase" 81 + 2 × gap-2 16
                  //                          = 131px  > 115px
                  //
                  // Flexbox therefore clamped the name to max(0, 115 − 131) = 0
                  // and the button overflowed anyway (scrollWidth 139 vs
                  // clientWidth 131). The name span measured `clientWidth: 0`
                  // against a `scrollWidth` of whatever the name is wide — 54px
                  // for the gate's "B48 Host" row. The text was in the DOM,
                  // which is why `toContainText`
                  // (e2e/wave-f/f6/compose.spec.ts:183-187) stayed green while
                  // the user dragged an unlabelled row.
                  //
                  // The row is now TWO lines and 43.5px tall instead of 26.5px.
                  // The palette's `ul` above is a fixed 160px `max-h-40` box, so
                  // it shows 3 whole rows where it showed 5, and a project with
                  // four or five saved workflows scrolls where it did not. That
                  // was measured and accepted, not overlooked; `max-h-40` is the
                  // one line that would give it back, and it is a sizing
                  // decision for whoever owns the palette's height rather than
                  // something this fix should change on its way past.
                  //
                  // No single-line arrangement can fix that: 131px of furniture
                  // does not fit in 115px whatever the name does. So the name
                  // takes the whole first line — as a column flex item it is
                  // stretched to the button's content width, which makes its
                  // `truncate` meaningful instead of degenerate — and the
                  // secondary metadata drops to a second line that WRAPS rather
                  // than overflows, so no word is ever clipped away.
                  className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border px-2 py-1 text-left text-[11px] hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
                >
                  <span className="w-full min-w-0 truncate font-medium">{workflow.name}</span>
                  <span className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 text-[10px] text-muted-foreground">
                    <span className="font-mono">rev {workflow.revision}</span>
                    <span className="ml-auto">{busy ? "adding…" : "add as phase"}</span>
                  </span>
                </button>

                <button
                  type="button"
                  data-testid={`saved-workflow-reference-${workflow.id}`}
                  disabled={!canAddPhase || busy}
                  aria-describedby="saved-workflow-reference-reason"
                  title={
                    canAddPhase
                      ? `Insert ${workflow.name} as a workflow reference (revision ${String(workflow.revision)})`
                      : (cannotAddPhaseReason
                        ?? "Load a workflow first — a reference is added to the workflow you are editing.")
                  }
                  onClick={() => onInsertReference(workflow)}
                  className="shrink-0 rounded-md border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
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
        “As reference” inserts a workflow-ref node pinned to the listed
        revision. Expansion happens at run creation.
      </p>

      <Dialog
        open={pendingPhaseWorkflow !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPhaseWorkflow(null);
        }}
      >
        <DialogContent
          data-testid="saved-workflow-add-phase-dialog"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>
              Add “{pendingPhaseWorkflow?.name ?? "saved workflow"}” as a phase?
            </DialogTitle>
            <DialogDescription>
              This adds revision {String(pendingPhaseWorkflow?.revision ?? "")} after the loaded
              workflow. The builder will connect the loaded workflow&apos;s handover nodes to the
              new phase so it remains reachable. The canvas will be marked unsaved; nothing is
              stored until you save the workflow.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              data-testid="saved-workflow-add-phase-confirm"
              onClick={() => {
                const workflow = pendingPhaseWorkflow;
                if (workflow === null) return;
                setPendingPhaseWorkflow(null);
                onAddPhase(workflow.id);
              }}
            >
              Add phase
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
