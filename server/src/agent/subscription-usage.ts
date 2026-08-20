/**
 * Per-provider subscription usage, rolled up from the REAL cost ledger.
 *
 * Row 14's Gate B is "reads real usage/quota state". Two halves, and they have
 * different honest answers on this machine:
 *
 *  USAGE — real and readable. Every finished run appends a row to
 *  `projects/<id>/sandbox/.kady/runs/<sessionId>/costs.jsonl` (cost/ledger.ts),
 *  and each row carries `provider`, `billingMode`, `totalTokens` and, for
 *  provider-managed usage, `listPriceUsd` (cost/billing.ts `normalizeUsageCost`
 *  parks the list price there because the money is external to the project cap).
 *  Aggregating those rows per provider is a measurement, not an estimate.
 *
 *  QUOTA — NOT readable, and the repo says so itself. `provider-auth.ts`'s own
 *  `billingNote` for `openai-codex`, `github-copilot` and `xai` is a variation on
 *  "Kady cannot read remaining quota or overages"; `anthropic` is `metered_oauth`,
 *  which has no ceiling to be a percentage of at all. Every quota position is
 *  therefore returned as `unreadable` or `no-ceiling` WITH the provider's own
 *  note as the reason, and the UI renders that meter disabled with the reason
 *  visible (§6.7). Inventing a percentage here is the single worst outcome
 *  available to this row, so `usedPercent` is `null` and there is no code path
 *  that can make it anything else.
 *
 * Providers with ledger rows but no definition (e.g. `nvidia`, which
 * `billing.ts` also classifies as `subscription`) are returned with
 * `listed: false` rather than dropped: discarding real consumed tokens because a
 * display table lacks a row is the same class of dishonesty as a fake percent.
 */
import fs from "node:fs";

import { resolvePaths } from "../projects.ts";
import { sessionCostSummary, type CostEntry } from "../cost/ledger.ts";
import { SUBSCRIPTION_PROVIDERS } from "./provider-auth.ts";

export type QuotaAvailability = "readable" | "unreadable" | "no-ceiling";

export interface QuotaPosition {
  availability: QuotaAvailability;
  /** Non-null iff `availability === "readable"`. Nothing is readable today. */
  usedPercent: number | null;
  /** Null iff `availability === "readable"`. Rendered verbatim to the user. */
  reason: string | null;
}

export interface SubscriptionProviderUsage {
  providerId: string;
  /** Rendered instead of `providerId`. */
  name: string;
  accountLabel: string;
  billingMode: string;
  tokens: number;
  listPriceUsd: number;
  billableUsd: number;
  calls: number;
  quota: QuotaPosition;
  listed: boolean;
}

export interface SubscriptionUsageSnapshot {
  version: 1;
  scope: "project";
  projectId: string;
  sessionCount: number;
  providers: SubscriptionProviderUsage[];
  totalTokens: number;
  totalListPriceUsd: number;
}

const METERED_NO_CEILING_SUFFIX =
  "There is no subscription ceiling to measure against; this usage is billed per token and counts toward the project spend limit.";

const UNLISTED_PROVIDER_REASON =
  "This provider is not in the subscription-provider table, so no quota position is known for it. The tokens below were still recorded.";

/**
 * Only these two modes are subscription-shaped. `payg`, `local` and `compute`
 * belong to the project cost widget; folding them in here would produce two
 * widgets disagreeing about the same money, which row 14 exists to prevent.
 */
function isSubscriptionShaped(mode: string | undefined): boolean {
  return mode === "subscription" || mode === "metered_oauth";
}

function quotaFor(
  definition: (typeof SUBSCRIPTION_PROVIDERS)[number] | undefined,
): QuotaPosition {
  if (!definition) {
    return {
      availability: "unreadable",
      usedPercent: null,
      reason: UNLISTED_PROVIDER_REASON,
    };
  }
  if (definition.billingMode === "metered_oauth") {
    return {
      availability: "no-ceiling",
      usedPercent: null,
      reason: `${definition.billingNote} ${METERED_NO_CEILING_SUFFIX}`,
    };
  }
  return {
    availability: "unreadable",
    usedPercent: null,
    reason: definition.billingNote,
  };
}

/** Coerce: one malformed row must not poison a total. Mirrors `ledger.finite`. */
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function emptyRow(
  definition: (typeof SUBSCRIPTION_PROVIDERS)[number],
): SubscriptionProviderUsage {
  return {
    providerId: definition.id,
    name: definition.name,
    accountLabel: definition.accountLabel,
    billingMode: definition.billingMode,
    tokens: 0,
    listPriceUsd: 0,
    billableUsd: 0,
    calls: 0,
    quota: quotaFor(definition),
    listed: true,
  };
}

/**
 * Fold one session's ledger entries into the accumulator.
 *
 * Exported so the aggregation can be exercised directly against synthetic rows
 * as well as through the route.
 */
export function accumulateSubscriptionUsage(
  accumulator: Map<string, SubscriptionProviderUsage>,
  entries: readonly CostEntry[],
): void {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (!isSubscriptionShaped(entry.billingMode)) continue;
    const providerId =
      typeof entry.provider === "string" && entry.provider.trim().length > 0
        ? entry.provider.trim()
        : "unknown";
    let row = accumulator.get(providerId);
    if (!row) {
      row = {
        providerId,
        name: providerId,
        accountLabel: "",
        billingMode: entry.billingMode ?? "unknown",
        tokens: 0,
        listPriceUsd: 0,
        billableUsd: 0,
        calls: 0,
        quota: quotaFor(undefined),
        listed: false,
      };
      accumulator.set(providerId, row);
    }
    row.tokens += finite(entry.totalTokens);
    row.listPriceUsd += finite(entry.listPriceUsd);
    row.billableUsd += finite(entry.costUsd);
    row.calls += 1;
  }
}

/**
 * Sum every session's ledger under a project and roll it up per provider.
 *
 * Enumerates the same runs directory `projectCostSummary` does, so the two
 * cannot disagree about which sessions exist.
 */
export function subscriptionUsageSnapshot(projectId: string): SubscriptionUsageSnapshot {
  const paths = resolvePaths(projectId);
  const accumulator = new Map<string, SubscriptionProviderUsage>();

  // Every defined provider gets a row even at zero usage: "no recorded usage"
  // is information, and a row that only appears once money has moved makes the
  // bar non-persistent.
  for (const definition of SUBSCRIPTION_PROVIDERS) {
    accumulator.set(definition.id, emptyRow(definition));
  }

  let sessionCount = 0;
  try {
    for (const dirent of fs.readdirSync(paths.runsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const summary = sessionCostSummary(dirent.name, projectId);
      if (summary.entries.length === 0) continue;
      sessionCount += 1;
      accumulateSubscriptionUsage(accumulator, summary.entries);
    }
  } catch (error) {
    // A project with no runs yet is an empty rollup, not a failure.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const providers = [...accumulator.values()];
  return {
    version: 1,
    scope: "project",
    projectId,
    sessionCount,
    providers,
    totalTokens: providers.reduce((sum, row) => sum + row.tokens, 0),
    totalListPriceUsd: providers.reduce((sum, row) => sum + row.listPriceUsd, 0),
  };
}
