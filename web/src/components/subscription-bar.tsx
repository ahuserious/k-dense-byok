"use client";

/**
 * The subscription manager bar (master-brief row 14).
 *
 * ONE widget, not two. Row 14 asks for a persistent per-provider subscription
 * bar and says it must be "reconciled with the existing session-cost-pill.tsx
 * so there are not two cost widgets". The reconciliation is containment: this
 * bar *is* the header widget, and the project/session cost readout is a segment
 * of it. `session-cost-pill.tsx` re-exports this component under its old name
 * and prop shape, so the app shell's mount (`web/src/app/page.tsx:1017`, a file
 * lane F8 does not own) needs no change and no second trigger appears.
 *
 * Cost spent and subscription quota consumed are DIFFERENT quantities, so both
 * are shown with a stated division of labour:
 *   · "Project billable spend" — USD measured against the project spend cap.
 *     This is the only real percentage on this surface, because it is the only
 *     one with a real denominator.
 *   · "Subscription usage" — tokens providers bill outside that cap. Real,
 *     measured, and deliberately WITHOUT a percentage: see below.
 *
 * Why there is no per-provider percentage (§6.7, and row 14's Gate B):
 * `server/src/agent/provider-auth.ts` states in its own `billingNote` fields
 * that Kady cannot read remaining quota or overages for `openai-codex`,
 * `github-copilot` or `xai`, and `anthropic` is metered per token with no
 * ceiling at all. Each provider's quota meter is therefore rendered DISABLED
 * with the provider's own sentence as the visible reason. An invented
 * percentage is the worst outcome available to this row and there is no code
 * path here that can produce one.
 *
 * Accessibility notes that are load-bearing, not decoration (§6.6):
 *   · The overlay is a Popover, not a HoverCard. The previous pill used a
 *     HoverCard, whose content is unreachable by keyboard and does not trap
 *     focus, restore it, or close on Escape. Popover does all four.
 *   · Severity is never carried by colour alone: every tone change is paired
 *     with an icon and a sentence.
 *   · No state is expressed through `opacity`; a dimmed ring is an invisible
 *     ring, and that has already failed this build twice.
 *   · Bars are `role="meter"` with real `aria-valuenow`/`aria-valuetext`, so
 *     the number exists for a screen reader and not only for the eye.
 */

import { AlertTriangleIcon, InfoIcon, LockIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn, formatCompactTokens, formatUsd } from "@/lib/utils";
import type { ProjectCostSummary } from "@/lib/use-project-cost";
import type { CostEntry, SessionCostSummary } from "@/lib/use-session-cost";
import { clampUsedPercent, usageSeverity } from "@/lib/subscription-usage";
import type { SubscriptionProviderUsage } from "@/lib/subscription-usage";
import { useSubscriptionUsage } from "@/lib/subscription-usage-source";

/**
 * A focus indicator that actually meets §6.6.
 *
 * Measured against this repo's own tokens: `--ring` is 2.59:1 on a light
 * background and 1.54:1 at the 50% alpha `ui/button.tsx` applies; `--foreground`
 * is 19.79:1 light and 18.96:1 dark. Never expressed through opacity — a dimmed
 * ring is an invisible ring, which is the exact defect V1 round 4 had to fix.
 */
const FOCUS_RING =
  "focus-visible:border-foreground focus-visible:ring-foreground focus-visible:ring-[3px] focus-visible:outline-none";

export interface SubscriptionBarProps {
  summary: SessionCostSummary;
  projectSummary?: ProjectCostSummary;
  limitUsd?: number | null;
  loading?: boolean;
  className?: string;
  /**
   * Ask the backend for the project-wide rollup instead of folding the session
   * ledger. Defaults to `PROJECT_ROLLUP_ROUTE_ENABLED`, which is off until the
   * route registration and the e2e fixture line in INTEGRATION.md are applied.
   */
  projectRollupEnabled?: boolean;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return formatCompactTokens(n);
}

function shortModel(model: string): string {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

export function SubscriptionBar({
  summary,
  projectSummary,
  limitUsd: limitUsdProp,
  loading = false,
  className,
  projectRollupEnabled,
}: SubscriptionBarProps) {
  // The cap is enforced against *committed* money — ledgered spend plus compute
  // reservations plus runs still in flight. Showing only ledgered spend meant
  // the widget could read "$4.10 / $5.00" while the server refused new work,
  // with nothing on screen to explain why.
  const spentUsd = projectSummary?.spentUsd ?? projectSummary?.totalUsd ?? 0;
  const projectTotal =
    projectSummary?.budget?.committedUsd ??
    projectSummary?.budget?.totalUsd ??
    spentUsd;
  const heldUsd = Math.max(0, projectTotal - spentUsd);
  const reservedUsd = projectSummary?.budget?.reservedUsd ?? 0;
  const inFlightUsd = projectSummary?.budget?.inFlightUsd ?? 0;
  const sessionTotal = summary.totalUsd ?? 0;
  const limitUsd =
    limitUsdProp !== undefined ? limitUsdProp : projectSummary?.limitUsd ?? null;

  const budgetState = projectSummary?.budget?.state ?? "ok";
  const capUsedPercent =
    limitUsd !== null && limitUsd > 0
      ? clampUsedPercent((projectTotal / limitUsd) * 100)
      : null;
  const capSeverity = capUsedPercent === null ? "normal" : usageSeverity(capUsedPercent);

  const warnTone = budgetState === "warn" || capSeverity === "elevated";
  const blockedTone = budgetState === "exceeded";

  const usage = useSubscriptionUsage(
    summary.entries,
    summary.entries.length,
    projectRollupEnabled,
  );
  const providers = usage.snapshot?.providers ?? [];
  const subscriptionTokens =
    usage.snapshot?.totalTokens ??
    (projectSummary?.subscriptionTokens ?? summary.subscriptionTokens ?? 0);

  const hasCostData =
    summary.entries.length > 0 ||
    sessionTotal > 0 ||
    projectTotal > 0 ||
    (summary.subscriptionTokens ?? 0) > 0 ||
    (projectSummary?.subscriptionTokens ?? 0) > 0 ||
    (projectSummary?.sessionCount ?? 0) > 0;

  // The bar is persistent by design (row 14: "persistent bar in the app shell").
  // It renders whenever there is anything honest to say, which is as soon as the
  // provider list resolves — a widget that only appears once money has moved is
  // not a bar, it is a notification.
  if (!hasCostData && usage.status === "loading") return null;

  const triggerLabel = [
    limitUsd !== null
      ? `Project billable cost ${formatUsd(projectTotal)} of ${formatUsd(limitUsd)}`
      : `Project billable cost ${formatUsd(projectTotal)}`,
    capUsedPercent !== null ? `${String(capUsedPercent)} percent of the spend limit` : "",
    heldUsd > 0 ? `including ${formatUsd(heldUsd)} held for work in progress` : "",
    `session billable cost ${formatUsd(sessionTotal)}`,
    subscriptionTokens > 0
      ? `${formatTokens(subscriptionTokens)} subscription tokens, quota not readable`
      : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Spend and subscription usage. ${triggerLabel}`}
          className={cn(
            "h-auto gap-2 px-2.5 py-1 font-mono text-[11px] tabular-nums",
            // The shadcn base ring is `--ring` at 50% alpha, which measures
            // 1.54:1 against a light background — below the 3:1 §6.6 requires of
            // a focus indicator, and invisible in practice. `--foreground`
            // measures 19.79:1 light / 18.96:1 dark. Overridden here rather than
            // in ui/button.tsx, which lane F8 does not own.
            FOCUS_RING,
            warnTone && !blockedTone && "border-primary/60",
            blockedTone && "border-destructive text-destructive",
            className,
          )}
        >
          <div className="flex items-center gap-2">
            {blockedTone && <LockIcon className="size-3 shrink-0" aria-hidden />}
            {warnTone && !blockedTone && (
              <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            )}
            <div className="flex flex-col items-end leading-tight">
              <span className="flex items-baseline gap-1">
                <span className="text-muted-foreground">proj</span>
                <span className="font-semibold">{formatUsd(projectTotal)}</span>
                {limitUsd !== null && (
                  <span className="text-muted-foreground">/ {formatUsd(limitUsd)}</span>
                )}
              </span>
              <span className="flex items-baseline gap-1">
                <span className="text-muted-foreground">sess</span>
                <span className="font-semibold">{formatUsd(sessionTotal)}</span>
              </span>
              {subscriptionTokens > 0 ? (
                <span className="flex items-baseline gap-1">
                  <span className="text-muted-foreground">sub</span>
                  <span className="font-semibold">
                    {formatTokens(subscriptionTokens)} tok
                  </span>
                </span>
              ) : null}
            </div>
          </div>
          {capUsedPercent !== null && (
            <SpendMeter
              usedPercent={capUsedPercent}
              blocked={blockedTone}
              className="ml-0.5 w-10"
              label={`Spend limit ${String(capUsedPercent)} percent used`}
            />
          )}
          {loading && <span className="sr-only">Refreshing</span>}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-96 p-0">
        <div className="max-h-[70dvh] overflow-y-auto">
          {projectSummary && (
            <section className="border-b p-4" aria-labelledby="subscription-bar-spend">
              <h3
                id="subscription-bar-spend"
                className="text-muted-foreground text-xs uppercase tracking-wide"
              >
                Project billable spend
              </h3>
              <div className="mt-1 flex items-baseline gap-2">
                <div className="font-mono text-2xl font-semibold tabular-nums">
                  {formatUsd(projectTotal)}
                </div>
                {limitUsd !== null && (
                  <div className="text-muted-foreground font-mono text-sm tabular-nums">
                    / {formatUsd(limitUsd)}
                  </div>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {formatTokens(projectSummary.totalTokens)} tokens across{" "}
                {projectSummary.sessionCount} session
                {projectSummary.sessionCount === 1 ? "" : "s"}
              </p>
              {heldUsd > 0 && (
                <p className="text-muted-foreground mt-1 text-xs">
                  {formatUsd(spentUsd)} recorded
                  {reservedUsd > 0
                    ? ` · ${formatUsd(reservedUsd)} held for compute jobs`
                    : ""}
                  {inFlightUsd > 0
                    ? ` · ${formatUsd(inFlightUsd)} in the current run`
                    : ""}
                </p>
              )}
              {capUsedPercent !== null && (
                <div className="mt-2">
                  <SpendMeter
                    usedPercent={capUsedPercent}
                    blocked={blockedTone}
                    className="w-full"
                    label={`Spend limit ${String(capUsedPercent)} percent used`}
                  />
                  <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                    {capUsedPercent}% of the spend limit used
                  </p>
                </div>
              )}
              {blockedTone && (
                <p className="border-destructive text-destructive mt-2 flex gap-1.5 rounded-md border px-2 py-1.5 text-xs">
                  <LockIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>
                    Spend limit reached. New billable API and compute work is blocked
                    until the limit is raised; provider-managed subscription and local
                    runs can continue.
                  </span>
                </p>
              )}
              {warnTone && !blockedTone && (
                <p className="border-border text-foreground mt-2 flex gap-1.5 rounded-md border px-2 py-1.5 text-xs">
                  <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>Approaching the spend limit (≥80% committed).</span>
                </p>
              )}
            </section>
          )}

          <section
            className="border-b p-4"
            aria-labelledby="subscription-bar-subscriptions"
          >
            <h3
              id="subscription-bar-subscriptions"
              className="text-muted-foreground text-xs uppercase tracking-wide"
            >
              Subscription usage
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Tokens your providers bill under their own subscription, separately from
              the spend above.
              {usage.snapshot?.scope === "session"
                ? " Scope: this session."
                : usage.snapshot?.scope === "project"
                  ? " Scope: this project."
                  : ""}
            </p>

            {usage.status === "loading" && (
              <p className="text-muted-foreground mt-2 text-xs">Reading providers…</p>
            )}

            {usage.status === "unavailable" && (
              <div className="border-border mt-2 rounded-md border p-2">
                <p className="text-foreground flex gap-1.5 text-xs">
                  <InfoIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>{usage.detail}</span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("mt-2 h-7 text-xs", FOCUS_RING)}
                  onClick={usage.reload}
                >
                  <RefreshCwIcon className="size-3" aria-hidden />
                  Retry
                </Button>
              </div>
            )}

            {usage.status === "ready" && providers.length === 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                No subscription providers are configured. Connect one in Settings ▸ Model
                providers.
              </p>
            )}

            {usage.status === "ready" && providers.length > 0 && (
              <ul className="mt-2 space-y-2">
                {providers.map((provider) => (
                  <ProviderUsageRow key={provider.providerId} provider={provider} />
                ))}
              </ul>
            )}
          </section>

          <section className="border-b p-4" aria-labelledby="subscription-bar-session">
            <h3
              id="subscription-bar-session"
              className="text-muted-foreground text-xs uppercase tracking-wide"
            >
              This session
            </h3>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {formatUsd(sessionTotal)}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {formatTokens(summary.totalTokens)} tokens across {summary.entries.length}{" "}
              call{summary.entries.length === 1 ? "" : "s"}
            </p>
            <div className="mt-2">
              <CostRow label="Agent" costUsd={summary.agentUsd} />
              {summary.subagentUsd > 0 && (
                <CostRow label="Subagents" costUsd={summary.subagentUsd} />
              )}
              {summary.computeUsd > 0 && (
                <CostRow label="Compute (Modal)" costUsd={summary.computeUsd} />
              )}
              {(summary.subscriptionTokens ?? 0) > 0 ? (
                <div className="flex items-baseline justify-between py-1 text-sm">
                  <span className="text-muted-foreground">Subscription usage</span>
                  <span className="font-mono tabular-nums">
                    {formatTokens(summary.subscriptionTokens ?? 0)} tokens
                  </span>
                </div>
              ) : null}
            </div>
          </section>

          <div className="p-2">
            {summary.entries.length === 0 ? (
              <p className="text-muted-foreground px-2 py-1 text-xs">
                No call-level breakdown yet.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {summary.entries.map((entry, idx) => (
                  <EntryRow key={entry.entryId ?? idx} entry={entry} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The one real meter on this surface. `role="meter"` carries the number for
 * assistive tech; the fill carries it for the eye; the caller always renders a
 * sentence beside it, so the tone is never the only signal.
 */
function SpendMeter({
  usedPercent,
  blocked,
  className,
  label,
}: {
  usedPercent: number;
  blocked: boolean;
  className?: string;
  label: string;
}) {
  const width = clampUsedPercent(usedPercent);
  return (
    <span
      role="meter"
      aria-valuenow={width}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${String(width)} percent`}
      aria-label={label}
      // No border: `--border` against `--popover` measures 1.26:1 light /
      // 1.32:1 dark and carries no information (§6.4). The boundary that DOES
      // carry the value — fill against track — measures 16.42:1 light and
      // 12.00:1 dark, and the same number is printed as text and as
      // `aria-valuenow`, so it is never carried by the graphic alone.
      className={cn("bg-muted block h-1.5 overflow-hidden rounded-full", className)}
    >
      <span
        className={cn(
          "block h-full rounded-full motion-safe:transition-[width]",
          blocked ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${String(width)}%` }}
      />
    </span>
  );
}

/**
 * A provider's real consumption, and an explicitly empty quota track.
 *
 * The empty track is rendered rather than omitted on purpose: a reader who
 * expects a percentage needs to see that the meter exists and has no value, and
 * why. It is dashed rather than merely paler, so the "no value" state does not
 * depend on colour or on opacity.
 */
function ProviderUsageRow({ provider }: { provider: SubscriptionProviderUsage }) {
  const quotaLabel =
    provider.quota.availability === "no-ceiling"
      ? "No quota ceiling"
      : "Quota not readable";
  return (
    <li className="border-border rounded-md border p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{provider.name}</span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {formatTokens(provider.tokens)} tok
          {provider.listPriceUsd > 0 ? ` · ${formatUsd(provider.listPriceUsd)} list` : ""}
          {provider.billableUsd > 0 ? ` · ${formatUsd(provider.billableUsd)} billed` : ""}
        </span>
      </div>
      {provider.accountLabel ? (
        <p className="text-muted-foreground mt-0.5 text-xs">{provider.accountLabel}</p>
      ) : null}
      <div
        role="meter"
        aria-disabled="true"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={quotaLabel}
        aria-label={`${provider.name} quota. ${quotaLabel}.`}
        // Dashed and drawn in `--muted-foreground` (4.73:1 light, 6.91:1 dark):
        // an empty meter has no fill to carry contrast, so its own outline has
        // to clear 3:1 on its own. `--border` would have been 1.26:1.
        className="border-muted-foreground mt-1.5 h-1.5 w-full rounded-full border border-dashed"
      />
      <p className="text-muted-foreground mt-1 flex gap-1.5 text-xs">
        <InfoIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>
          <span className="text-foreground font-medium">{quotaLabel}.</span>{" "}
          {provider.quota.reason}
        </span>
      </p>
    </li>
  );
}

function CostRow({ label, costUsd }: { label: string; costUsd: number }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatUsd(costUsd)}</span>
    </div>
  );
}

function EntryRow({ entry }: { entry: CostEntry }) {
  const roleLabel =
    entry.role === "agent" ? "agent" : entry.role === "compute" ? "compute" : entry.role;
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-2 px-2 py-1 text-[11px]">
      <span
        className="flex min-w-0 items-center gap-1 truncate"
        title={`${entry.role} · ${entry.model}`}
      >
        {/* The role is spelled out rather than encoded as a coloured dot: §6.6
            forbids meaning carried by colour alone, and three dots that differ
            only in hue were exactly that. */}
        <span className="shrink-0 uppercase tracking-wide">{roleLabel}</span>
        <span className="truncate">{shortModel(entry.model)}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums">
        {formatTokens(entry.totalTokens)} ·{" "}
        {entry.billingMode === "subscription"
          ? "subscription"
          : entry.billingMode === "local"
            ? "local"
            : formatUsd(entry.costUsd)}
      </span>
    </li>
  );
}
