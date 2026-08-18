// danbot-byok — web/src/components/console/live-model-receipt.tsx
//
// The requested-vs-resolved model/provider receipt, rendered as something a
// person reads.
//
// `dag-builder-combined-requirements.md:20` requires these receipts to "stay
// visible". They are durable and validated — `WorkflowModelResolutionReceipt`
// at `server/src/workflows/run-state.ts:128-133`, written by the runner's
// `ModelCallLedger.record()` (`server/src/workflows/runner.ts:924-933`) onto a
// `model_resolved` event as `data.receipt`, with the declaring
// `model_call_declared` event carrying `data.modelCallSlot` — but both consoles
// only ever showed them as `JSON.stringify(event.data)` inside a `<details>`.
//
// Every field below is read from the receipt as the server defines it. No field
// is derived, defaulted, or renamed:
//
//   request.requested.source              "fixed" | "kady-current"
//   request.requested.provider/model      present only on a `fixed` request
//   request.requested.auth.kind/.profile  the auth the DOCUMENT asked for
//   request.requested.reasoning           requested reasoning level
//   request.resolution.mode               "exact" | "explicit-fallback"
//   request.resolution.reason             why fallbacks were authorised
//   resolved.provider/.model              what the runtime actually used
//   resolved.auth.kind/.profile           the auth kind that actually served it
//   resolved.reasoning                    the reasoning level actually used
//   resolved.runtime                      pi | openrouter-fusion | kady-fusion | local | custom
//   fallbackUsed                          true when the resolved model is not the requested one
//   resolutionReason                      the runtime's own explanation
//
// The parser is fail-closed: a payload missing `resolved.provider`,
// `resolved.model`, or `fallbackUsed` is not a receipt and renders nothing, so
// the raw `<details>` stays the only account of it rather than a half-drawn one.

"use client";

import { ArrowRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ModelReceiptView {
  /** Present only when the request named a concrete provider/model. */
  requestedProvider: string | null;
  requestedModel: string | null;
  requestedSource: string;
  requestedAuthKind: string | null;
  requestedAuthProfile: string | null;
  requestedReasoning: string | null;
  resolutionMode: string | null;
  resolutionReasonFromRequest: string | null;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedAuthKind: string | null;
  resolvedAuthProfile: string | null;
  resolvedReasoning: string | null;
  resolvedRuntime: string | null;
  fallbackUsed: boolean;
  resolutionReason: string | null;
  /** `data.modelCallSlotId`, when the event carried one. */
  slotId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read a `model_resolved` event's `data` as a receipt, or null when it is not
 * one. Nothing is invented: only the fields the receipt type declares are read,
 * and the three the runner guarantees (`resolved.provider`, `resolved.model`,
 * `fallbackUsed`) are required for the payload to count as a receipt at all.
 */
export function parseModelReceipt(data: unknown): ModelReceiptView | null {
  const envelope = record(data);
  if (!envelope) return null;
  const receipt = record(envelope.receipt);
  if (!receipt) return null;
  const resolved = record(receipt.resolved);
  if (!resolved) return null;
  const resolvedProvider = text(resolved.provider);
  const resolvedModel = text(resolved.model);
  if (resolvedProvider === null || resolvedModel === null) return null;
  if (typeof receipt.fallbackUsed !== "boolean") return null;

  const request = record(receipt.request);
  const requested = request ? record(request.requested) : null;
  const requestedAuth = requested ? record(requested.auth) : null;
  const resolution = request ? record(request.resolution) : null;
  const resolvedAuth = record(resolved.auth);

  return {
    requestedProvider: requested ? text(requested.provider) : null,
    requestedModel: requested ? text(requested.model) : null,
    requestedSource: (requested ? text(requested.source) : null) ?? "unstated",
    requestedAuthKind: requestedAuth ? text(requestedAuth.kind) : null,
    requestedAuthProfile: requestedAuth ? text(requestedAuth.profile) : null,
    requestedReasoning: requested ? text(requested.reasoning) : null,
    resolutionMode: resolution ? text(resolution.mode) : null,
    resolutionReasonFromRequest: resolution ? text(resolution.reason) : null,
    resolvedProvider,
    resolvedModel,
    resolvedAuthKind: resolvedAuth ? text(resolvedAuth.kind) : null,
    resolvedAuthProfile: resolvedAuth ? text(resolvedAuth.profile) : null,
    resolvedReasoning: text(resolved.reasoning),
    resolvedRuntime: text(resolved.runtime),
    fallbackUsed: receipt.fallbackUsed,
    resolutionReason: text(receipt.resolutionReason),
    slotId: text(envelope.modelCallSlotId),
  };
}

function authLabel(kind: string | null, profile: string | null): string {
  if (kind === null) return "—";
  return profile === null ? kind : `${kind} · ${profile}`;
}

/**
 * `Kady Current` is a runtime selection: the document deliberately did not name
 * a provider or a model, so the requested side has none to print. Saying
 * "unstated" there would read as missing data; naming what the request actually
 * was is the honest column.
 */
function requestedModelLabel(receipt: ModelReceiptView): string {
  if (receipt.requestedProvider !== null && receipt.requestedModel !== null) {
    return `${receipt.requestedProvider} / ${receipt.requestedModel}`;
  }
  if (receipt.requestedSource === "kady-current") return "Kady Current (no fixed model)";
  return receipt.requestedSource;
}

/** One receipt, requested on the left and resolved on the right. */
export function ModelReceiptCard({
  receipt,
  className,
}: {
  receipt: ModelReceiptView;
  className?: string;
}) {
  return (
    <div
      data-model-receipt-slot={receipt.slotId ?? ""}
      data-fallback-used={String(receipt.fallbackUsed)}
      className={cn(
        "rounded-md border px-2 py-1.5",
        receipt.fallbackUsed
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-border/70",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          model receipt
        </span>
        {receipt.slotId ? (
          <code className="rounded bg-muted px-1 font-mono text-[9px]">{receipt.slotId}</code>
        ) : null}
        {receipt.fallbackUsed ? (
          <span className="rounded border border-amber-500/50 px-1 font-mono text-[9px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
            fallback taken
          </span>
        ) : (
          <span className="rounded border border-emerald-500/40 px-1 font-mono text-[9px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            as requested
          </span>
        )}
        {receipt.resolvedRuntime ? (
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
            runtime {receipt.resolvedRuntime}
          </span>
        ) : null}
      </div>

      {/* Requested above resolved rather than inline: the drawer is 280-720px
          wide and an inline pair wrapped mid-arrow at the default width. */}
      <dl className="mt-1 grid grid-cols-[4.5rem_1fr] items-baseline gap-x-2 font-mono text-[10px]">
        <dt className="text-muted-foreground">requested</dt>
        <dd data-receipt-requested className="truncate">
          {requestedModelLabel(receipt)}
        </dd>
        <dt className="flex items-center gap-1 text-muted-foreground">
          <ArrowRightIcon className="size-3 shrink-0" aria-hidden />
          resolved
        </dt>
        <dd data-receipt-resolved className="truncate font-semibold">
          {receipt.resolvedProvider} / {receipt.resolvedModel}
        </dd>
      </dl>

      <dl className="mt-1 grid grid-cols-[4.5rem_1fr] gap-x-2 font-mono text-[9px] text-muted-foreground">
        <dt>auth</dt>
        <dd data-receipt-auth>
          {authLabel(receipt.requestedAuthKind, receipt.requestedAuthProfile)} →{" "}
          {authLabel(receipt.resolvedAuthKind, receipt.resolvedAuthProfile)}
        </dd>
        <dt>reasoning</dt>
        <dd>
          {receipt.requestedReasoning ?? "—"} → {receipt.resolvedReasoning ?? "—"}
        </dd>
        {receipt.resolutionMode ? (
          <>
            <dt>resolution</dt>
            <dd>
              {receipt.resolutionMode}
              {receipt.resolutionReasonFromRequest
                ? ` — ${receipt.resolutionReasonFromRequest}`
                : ""}
            </dd>
          </>
        ) : null}
        {receipt.resolutionReason ? (
          <>
            <dt>why</dt>
            <dd className="whitespace-pre-wrap break-words">{receipt.resolutionReason}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** Every receipt carried by a list of event payloads, in the order given. */
export function modelReceiptsFrom(
  payloads: readonly (Record<string, unknown> | undefined)[],
): ModelReceiptView[] {
  const receipts: ModelReceiptView[] = [];
  for (const payload of payloads) {
    const receipt = parseModelReceipt(payload);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}
