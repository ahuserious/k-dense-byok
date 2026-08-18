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
// Cancel abandons it and writes nothing. Create issues exactly one
// `PUT /dag-workflows/:id` with `If-None-Match: *` — the typed route's create
// half of its CAS contract — and reports what the server said. A rejected
// document is shown verbatim, including the validator's `path: message` list,
// because a promote that silently produced an unusable workflow would be worse
// than no promote at all.
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
  | { phase: "failed"; status: number | null; detail: string; code?: string };

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
  const canCreate = idValid && plan.document !== null && outcome.phase === "preview";

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
          status: error.status,
          detail: error.detail,
          ...(error.code !== undefined ? { code: error.code } : {}),
        });
        return;
      }
      setOutcome({
        phase: "failed",
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
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-2xl" data-testid="promote-dialog">
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
                <code>{outcome.saved.definition.revision}</code>. Open it in the Builder to
                edit or run it.
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
            {outcome.phase === "failed" ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">
                  The typed route rejected this document
                  {outcome.status === null ? "" : ` (HTTP ${outcome.status}`}
                  {outcome.code ? `, ${outcome.code}` : ""}
                  {outcome.status === null ? "" : ")"}. Nothing was created.
                  <span className="mt-1 block whitespace-pre-wrap break-words font-mono text-[10px]">
                    {outcome.detail}
                  </span>
                </span>
              </p>
            ) : null}

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

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-md border border-border/70 px-3 py-1 text-[11px] transition-colors hover:bg-foreground/5"
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
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
