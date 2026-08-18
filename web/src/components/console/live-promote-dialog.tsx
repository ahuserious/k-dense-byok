// danbot-byok — web/src/components/console/live-promote-dialog.tsx
//
// "Turn this chat into a DAG": the review-then-create step for
// lib/session-dag-projection-promote.ts.
//
// The dialog exists because the conversion is lossy in ways the reader has to
// see BEFORE anything is written. It shows, in this order:
//   * the workflow id that will be created (editable, validated against the
//     server's own id syntax before the button is live)
//   * every node it will create, with the turn it came from and the prompt text
//   * everything in the session it CANNOT represent, with the reason for each
//   * the model, workspace isolation, and limits the draft will carry
//
// Cancel abandons it and writes nothing — and it can only be pressed while
// that is true, because every way out of this dialog is gated on the same
// phase the Create button is. Create issues exactly one
// `PUT /dag-workflows/:id` with `If-None-Match: *` — the typed route's create
// half of its CAS contract — and reports what the server said. A rejected
// document is shown verbatim, including the validator's `path: message` list,
// because a promote that silently produced an unusable workflow would be worse
// than no promote at all.
//
// What it reports is bounded by what it can know. A create ends in one of five
// ways: the route accepts it and returns a readable definition; the route
// refuses it (4xx, decided before the store writes); the route accepts the
// write but answers with an envelope the client cannot read (2xx,
// MALFORMED_SAVE_RESPONSE); the route fails rather than decides (5xx); or no
// answer the client can read arrives at all. Only the 4xx ending entitles this
// surface to say that nothing was created — see `failedCreateClaim` below.
//
// That list is complete only because the dialog cannot be dismissed while the
// write is in flight. It used to be dismissable, and then there was a sixth
// ending, the worst one: Cancel, Escape, the overlay or the header's close
// control unmounted this component while `create()` was still awaiting, the
// write went on to commit, and the `setOutcome` that would have reported it
// was discarded by React. A workflow existed that this surface never mentioned
// — not in a banner, not in an alert, not on reopen. Nothing here can abort
// the request (`saveDagWorkflowDefinition` takes no `AbortSignal`), so the fix
// is the other side of it: a create cannot outlive the surface that has to
// account for it. See `canDismiss`. The one path that leaves is the console
// unmounting the whole session view underneath an open dialog — discovery
// dropping the session, the Console tab going away — which no control on this
// dialog can cause.
//
// A refusal is not a dead end. The create button is gated on whether a create
// is POSSIBLE — a syntactically valid id, a document to send, and no write in
// flight — never on whether an earlier attempt happened. A 409 telling the
// reader to pick another id would be worthless if it also disabled the button
// that sends the new one. The refusal message names the id it was refused for,
// so it stays true after the reader retypes.
//
// Nothing here touches the source session or its run.

"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangleIcon, CheckIcon, GitBranchIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DagWorkflowApiError,
  saveDagWorkflowDefinition,
  type SavedDagWorkflowDefinition,
} from "@/lib/dag-workflows";
import {
  isPromotableWorkflowId,
  planSessionPromotion,
  promotedWorkflowId,
  WORKFLOW_ID_PATTERN,
  type SessionPromotionPlan,
} from "@/lib/session-dag-projection-promote";
import type {
  SessionFrame,
  SessionGraphProjection,
} from "@/lib/session-dag-projection";
import { cn } from "@/lib/utils";

type PromoteOutcome =
  | { phase: "preview" }
  | { phase: "saving" }
  | { phase: "saved"; saved: SavedDagWorkflowDefinition }
  | {
      phase: "failed";
      /** The id this attempt was refused for — not necessarily the one in the input now. */
      workflowId: string;
      status: number | null;
      detail: string;
      code?: string;
    };

function PlanSummary({ plan }: { plan: SessionPromotionPlan }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
      <dt>model</dt>
      <dd className="text-foreground">
        Kady Current (exact) — the chat did not record a provider or model, so none is invented
      </dd>
      <dt>workspace</dt>
      <dd className="text-foreground">read-only on every node, no write paths</dd>
      <dt>limits</dt>
      <dd className="text-foreground">
        {plan.document
          ? `${plan.document.limits.maxModelCalls} model calls · ${plan.document.limits.maxIterations} iterations · parallelism ${plan.document.limits.maxParallelism} · ≤$${plan.document.limits.maxCostUsd}`
          : "—"}
      </dd>
      <dt>shape</dt>
      <dd className="text-foreground">
        {plan.nodes.length} agent node{plan.nodes.length === 1 ? "" : "s"} chained in
        conversation order, {plan.edges.length} edge{plan.edges.length === 1 ? "" : "s"}
      </dd>
    </dl>
  );
}

/**
 * The failure copy, split by what the route actually did — because only one of
 * these four endings entitles this surface to say "Nothing was created".
 *
 * `saveDagWorkflowDefinition` raises `DagWorkflowApiError` from two different
 * places, and only one of them is a refusal:
 *   * `parseResponse` throws for `!response.ok`, so a 4xx status is the store's
 *     own decision about the request, taken before it writes anything;
 *   * the envelope check throws `MALFORMED_SAVE_RESPONSE` *after* `parseResponse`
 *     has already let the response through, so that error is reachable only on a
 *     2xx — the store accepted the write and the client could not read the answer.
 * A 5xx is not a decision either: the route failed rather than refused, and
 * nothing in that answer says which side of the commit it failed on (an
 * intermediary's 502/504 can arrive after the origin already wrote). Anything
 * that is not a 4xx therefore leaves the outcome unknown, and the surface says so.
 *
 * `status === null` is every error that is not a `DagWorkflowApiError`. Three
 * different things land here, and only the first of them is a request that
 * never reached the store: a request that never left (offline, DNS, refused,
 * CORS); a connection that died after the request was sent and before any
 * response header arrived, where the origin may well have committed; and a
 * response whose body died while `parseResponse` was reading it, which did
 * reach a status this surface never holds. The copy therefore says nothing
 * about where the failure happened — only that no answer it could read arrived.
 *
 * Every retry this dialog can issue is a create (`If-None-Match: *`), so none of
 * the unknown cases can be made worse by pressing Create again: the write cannot
 * overwrite a workflow that does exist. A retry of the same id that comes back
 * 409 is how the reader finds out that it does.
 */
function failedCreateClaim(
  status: number | null,
): "no-answer" | "accepted-but-unreadable" | "refused" | "no-decision" {
  if (status === null) return "no-answer";
  if (status >= 200 && status < 300) return "accepted-but-unreadable";
  if (status >= 400 && status < 500) return "refused";
  return "no-decision";
}

function FailedCreateAlert({
  outcome,
}: {
  outcome: Extract<PromoteOutcome, { phase: "failed" }>;
}) {
  const httpAnswer = `HTTP ${outcome.status}${outcome.code ? `, ${outcome.code}` : ""}`;
  const claim = failedCreateClaim(outcome.status);
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        {claim === "no-answer" ? (
          <>
            The create of <code>{outcome.workflowId}</code> ended without an
            answer this surface could read, so it cannot say whether anything
            was written. Retrying is safe: the write carries the create
            precondition, so it cannot overwrite an existing workflow.
          </>
        ) : claim === "accepted-but-unreadable" ? (
          <>
            The typed route accepted the create of{" "}
            <code>{outcome.workflowId}</code> ({httpAnswer}) but answered with
            something this surface could not read, so it cannot say whether the
            workflow now exists. Retrying is safe: the write carries the create
            precondition, so it cannot overwrite an existing workflow — a retry
            of the same id that comes back 409 is how to tell that it was
            created.
          </>
        ) : claim === "refused" ? (
          <>
            The typed route rejected the create of{" "}
            <code>{outcome.workflowId}</code> ({httpAnswer}). Nothing was
            created.
          </>
        ) : (
          <>
            The typed route failed on the create of{" "}
            <code>{outcome.workflowId}</code> ({httpAnswer}) rather than
            refusing it, so this surface cannot say whether the workflow was
            created. Retrying is safe: the write carries the create
            precondition, so it cannot overwrite an existing workflow.
          </>
        )}
        <span className="mt-1 block whitespace-pre-wrap break-words font-mono text-[10px]">
          {outcome.detail}
        </span>
      </span>
    </p>
  );
}

export function LivePromoteDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  sessionId,
  sessionTitle,
  projection,
  frames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  projection: SessionGraphProjection;
  frames: readonly SessionFrame[];
}) {
  const [workflowId, setWorkflowId] = useState(() => promotedWorkflowId(sessionId));
  const [outcome, setOutcome] = useState<PromoteOutcome>({ phase: "preview" });

  const plan = useMemo(
    () =>
      planSessionPromotion(projection, frames, {
        workflowId,
        sessionId,
        sessionTitle,
        projectName,
      }),
    [frames, projectName, projection, sessionId, sessionTitle, workflowId],
  );

  const idValid = isPromotableWorkflowId(workflowId);
  // Deliberately NOT `outcome.phase === "preview"`. A refusal must leave the
  // surface usable: the only state that may disable this button is a write
  // already in flight. (`saved` renders its own branch, so it never gets here.)
  const canCreate = idValid && plan.document !== null && outcome.phase !== "saving";
  // The same phase gates every exit. A create that outlives this component
  // finishes into a `setOutcome` on an unmounted tree, which React discards —
  // so the write commits and nothing on this surface ever says so. The request
  // cannot be recalled once sent, so the only way to keep "Cancel writes
  // nothing" true is to make Cancel unpressable while a write is in flight.
  // This gates Cancel, Escape, the overlay and the header's close control.
  const canDismiss = outcome.phase !== "saving";

  const create = useCallback(async () => {
    if (!plan.document) return;
    setOutcome({ phase: "saving" });
    try {
      const saved = await saveDagWorkflowDefinition(
        projectId,
        plan.workflowId,
        plan.document,
        { kind: "create" },
      );
      setOutcome({ phase: "saved", saved });
    } catch (error) {
      if (error instanceof DagWorkflowApiError) {
        setOutcome({
          phase: "failed",
          workflowId: plan.workflowId,
          status: error.status,
          detail: error.detail,
          ...(error.code !== undefined ? { code: error.code } : {}),
        });
        return;
      }
      setOutcome({
        phase: "failed",
        workflowId: plan.workflowId,
        status: null,
        detail: error instanceof Error ? error.message : "The workflow write failed.",
      });
    }
  }, [plan.document, plan.workflowId, projectId]);

  const close = useCallback(() => {
    setOutcome({ phase: "preview" });
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else if (canDismiss) close();
      }}
    >
      <DialogContent
        className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-2xl"
        data-testid="promote-dialog"
        showCloseButton={canDismiss}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitBranchIcon className="size-4 text-cyan-500" aria-hidden />
            Turn this chat into a DAG
          </DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            Nothing is created until you choose Create. This reads the chat&apos;s retained
            logs and writes a new typed workflow definition; the chat session and any run
            it has are left untouched.
          </DialogDescription>
        </DialogHeader>

        {outcome.phase === "saved" ? (
          <section aria-label="Promotion result" className="space-y-2">
            <p className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-800 dark:text-emerald-200">
              <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                The typed route accepted it: <code>{outcome.saved.outcome}</code> workflow{" "}
                <code>{outcome.saved.definition.id}</code> at revision{" "}
                <code>{outcome.saved.definition.revision}</code>. Open it under Scientific
                Pipelines → Workflow registry → Details &amp; run to review it and run it.
              </span>
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              graph sha256 {outcome.saved.definition.graphSha256}
            </p>
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border/70 px-3 py-1 text-[11px] transition-colors hover:bg-foreground/5"
            >
              Done
            </button>
          </section>
        ) : (
          <>
            {outcome.phase === "failed" ? <FailedCreateAlert outcome={outcome} /> : null}

            <label className="block space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Workflow id
              </span>
              <input
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
                aria-label="Workflow id"
                aria-invalid={!idValid}
                spellCheck={false}
                className={cn(
                  "w-full rounded-md border bg-transparent px-2 py-1 font-mono text-[11px] outline-none",
                  idValid ? "border-border/70" : "border-destructive",
                )}
              />
              {idValid ? null : (
                <span className="block text-[10px] text-destructive">
                  A workflow id must match {WORKFLOW_ID_PATTERN.source} — the server rejects
                  anything else.
                </span>
              )}
            </label>

            {plan.document === null ? (
              <p
                role="alert"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200"
              >
                {plan.blockedReason}
              </p>
            ) : (
              <PlanSummary plan={plan} />
            )}

            <section aria-label="Nodes to create" className="space-y-1">
              <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Will create {plan.nodes.length} node{plan.nodes.length === 1 ? "" : "s"}
              </h3>
              <ul className="space-y-1">
                {plan.nodes.map((node) => (
                  <li
                    key={node.id}
                    data-promoted-node-id={node.id}
                    className="rounded-md border border-border/70 px-2 py-1.5"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <code className="rounded bg-muted px-1 font-mono text-[10px]">
                        {node.id}
                      </code>
                      <span className="text-[11px] font-medium">{node.name}</span>
                      <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                        agent{node.terminal ? " · terminal" : ""}
                      </span>
                      <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                        from {node.sourceNodeId}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                      {node.prompt}
                    </p>
                    {node.observedWork.length > 0 ? (
                      <p className="mt-1 font-mono text-[9px] text-muted-foreground/80">
                        observed in this turn: {node.observedWork.join(", ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label="Not represented" className="space-y-1">
              <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {plan.unrepresented.length === 0
                  ? "Everything in this session is represented"
                  : `${plan.unrepresented.length} part${plan.unrepresented.length === 1 ? "" : "s"} of this session cannot become a node`}
              </h3>
              {plan.unrepresented.length > 0 ? (
                <ul className="space-y-1">
                  {plan.unrepresented.map((part) => (
                    <li
                      key={part.sourceNodeId}
                      data-unrepresented-id={part.sourceNodeId}
                      className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          {part.kind}
                        </span>
                        <span className="text-[11px] font-medium">{part.label}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                        {part.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">
                The exact document that will be sent
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                {JSON.stringify(plan.document, null, 2)}
              </pre>
            </details>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={close}
                disabled={!canDismiss}
                className="rounded-md border border-border/70 px-3 py-1 text-[11px] transition-colors hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={!canCreate}
                className="rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1 text-[11px] text-cyan-800 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-cyan-200"
              >
                {outcome.phase === "saving" ? "Creating…" : "Create workflow"}
              </button>
              {outcome.phase === "saving" ? (
                <span className="text-[10px] leading-relaxed text-muted-foreground">
                  The write has already been sent and cannot be recalled, so this dialog
                  stays until the typed route answers — leaving now would create a workflow
                  nothing here could tell you about.
                </span>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
