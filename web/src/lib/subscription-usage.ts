/**
 * Subscription usage — the per-provider rollup the subscription bar renders,
 * plus the usage-percentage display semantics.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE. `normalizeUsagePercentageDisplay`, `clampUsedPercent`,
 * `getDisplayedUsagePercentage` and `normalizeStatusBarUsageMode` below are
 * ported from Orca, a separate MIT-licensed codebase, from:
 *
 *   <orca>/src/shared/usage-percentage-display.ts
 *   <orca>/src/shared/status-bar-usage-mode.ts
 *
 * Their round-before-complement rule (Orca #7574) and non-finite clamping are
 * preserved exactly, because getting them wrong is a 1% drift between the bar
 * width and its own label. Orca's IPC/runtime layer is deliberately NOT ported:
 * this app is a Fastify server plus a Next.js client, not an Electron
 * main/renderer pair. The 60/80 severity thresholds are reimplemented from
 * <orca>/src/renderer/src/components/status-bar/usage-roster-formatting.ts
 * (`usageTextColorClass`); its Tailwind palette classes are NOT ported, because
 * this repo's §6.1 wants semantic tokens and §6.6 forbids colour-only state.
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ---------------------------------------------------------------------------
 */
import type { CostEntry } from "@/lib/use-session-cost";

// ---------------------------------------------------------------------------
// Ported from Orca — see the provenance block above.
// ---------------------------------------------------------------------------

export type UsagePercentageDisplay = "used" | "remaining";

export const DEFAULT_USAGE_PERCENTAGE_DISPLAY: UsagePercentageDisplay = "used";

export function normalizeUsagePercentageDisplay(
  value: unknown,
): UsagePercentageDisplay {
  return value === "used" || value === "remaining"
    ? value
    : DEFAULT_USAGE_PERCENTAGE_DISPLAY;
}

export type StatusBarUsageMode = "verbose" | "compact";

export const DEFAULT_STATUS_BAR_USAGE_MODE: StatusBarUsageMode = "verbose";

export function normalizeStatusBarUsageMode(value: unknown): StatusBarUsageMode {
  return value === "verbose" || value === "compact"
    ? value
    : DEFAULT_STATUS_BAR_USAGE_MODE;
}

/**
 * Single clamp+round for bar width and label, so the bar and its own tooltip
 * share one rounding. A non-finite provider value must never reach a CSS width
 * as `NaN%`.
 */
export function clampUsedPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

/**
 * The used percentage or its complement. The used value is rounded *before* the
 * complement is taken, so a raw and a pre-clamped input resolve identically —
 * rounding after the complement makes `Math.round(100 - 20.5)` (80) disagree
 * with `100 - Math.round(20.5)` (79) at a .5 fraction (Orca #7574).
 */
export function getDisplayedUsagePercentage(
  usedPercent: number,
  display: UsagePercentageDisplay,
): number {
  // Invalid provider data must not be presented as 100% remaining capacity.
  if (!Number.isFinite(usedPercent)) return 0;
  const boundedUsedPercent = Math.min(100, Math.max(0, usedPercent));
  const roundedUsedPercent = Math.round(boundedUsedPercent);
  return display === "used" ? roundedUsedPercent : 100 - roundedUsedPercent;
}

/**
 * Orca's status bar switches tone at 60% and 80%. The thresholds are reused so
 * a number and its bar always agree; the *rendering* pairs every level with
 * text and an icon, because §6.6 forbids meaning carried by colour alone.
 */
export type UsageSeverity = "normal" | "elevated" | "critical";

export function usageSeverity(usedPercent: number): UsageSeverity {
  const bounded = clampUsedPercent(usedPercent);
  if (bounded >= 80) return "critical";
  if (bounded >= 60) return "elevated";
  return "normal";
}

// ---------------------------------------------------------------------------
// This repo's own model: what a provider's quota position actually is.
// ---------------------------------------------------------------------------

/**
 * Why a provider has, or does not have, a percentage.
 *
 * - `readable`    — a real ceiling and a real numerator exist. Nothing on this
 *                   machine is `readable` today; the type exists so that when a
 *                   quota source lands the bar upgrades without a redesign.
 * - `unreadable`  — the provider manages the ceiling and does not expose it to
 *                   us. The meter renders DISABLED with `reason` visible.
 * - `no-ceiling`  — metered per token; there is no denominator to be a
 *                   percentage of. Also DISABLED, with a different reason.
 */
export type QuotaAvailability = "readable" | "unreadable" | "no-ceiling";

export interface QuotaPosition {
  availability: QuotaAvailability;
  /** Non-null iff availability === "readable". */
  usedPercent: number | null;
  /** Null iff availability === "readable". Rendered verbatim to the user. */
  reason: string | null;
}

export interface SubscriptionProviderUsage {
  providerId: string;
  /** Render this, never `providerId`. */
  name: string;
  accountLabel: string;
  billingMode: "subscription" | "metered_oauth" | "unknown";
  /** Tokens really recorded in the ledger for this provider. */
  tokens: number;
  /** Pi list-price equivalent of provider-managed usage, in USD. */
  listPriceUsd: number;
  /** USD that counted against the project spend cap (metered_oauth only). */
  billableUsd: number;
  calls: number;
  quota: QuotaPosition;
  /**
   * False when the ledger holds rows for a provider that has no definition in
   * the server's subscription-provider table. Those tokens are shown anyway:
   * dropping real consumed tokens because a display table lacks a row is the
   * same class of dishonesty as inventing a percentage.
   */
  listed: boolean;
}

export interface SubscriptionUsageSnapshot {
  version: 1;
  /** Which ledger the numbers came from. */
  scope: "session" | "project";
  providers: SubscriptionProviderUsage[];
  totalTokens: number;
  totalListPriceUsd: number;
}

/** The subset of `GET /model-providers` this module consumes. */
export interface SubscriptionProviderDefinition {
  id: string;
  name: string;
  accountLabel: string;
  billingMode: string;
  billingNote: string;
  connected?: boolean;
  needsReauth?: boolean;
}

const METERED_NO_CEILING_SUFFIX =
  "There is no subscription ceiling to measure against; this usage is billed per token and counts toward the project spend limit.";

const UNLISTED_PROVIDER_REASON =
  "This provider is not in the subscription-provider table, so no quota position is known for it. The tokens below were still recorded.";

export function quotaPositionFor(
  definition: SubscriptionProviderDefinition | undefined,
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

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedBillingMode(
  raw: string | undefined,
): SubscriptionProviderUsage["billingMode"] {
  return raw === "subscription" || raw === "metered_oauth" ? raw : "unknown";
}

/**
 * Roll a session's real ledger rows up per provider.
 *
 * Only `subscription` and `metered_oauth` rows participate — `payg`, `local`
 * and `compute` spend is the project cost pill's subject, not this one's, and
 * folding them together is exactly the "two cost widgets saying different
 * things" failure row 14 exists to stop.
 *
 * Every field is coerced. One malformed row must not poison a total or reach a
 * CSS width as `NaN%` (#62 in spirit: validate before rendering).
 */
export function rollupSubscriptionUsage(
  entries: readonly CostEntry[] | undefined,
  definitions: readonly SubscriptionProviderDefinition[],
  scope: SubscriptionUsageSnapshot["scope"] = "session",
): SubscriptionUsageSnapshot {
  const byId = new Map<string, SubscriptionProviderUsage>();

  // Every defined provider gets a row even at zero usage: "you have no recorded
  // usage" is information, and a row that appears only once money moves makes
  // the bar non-persistent.
  for (const definition of definitions) {
    byId.set(definition.id, {
      providerId: definition.id,
      name: definition.name,
      accountLabel: definition.accountLabel,
      billingMode: normalizedBillingMode(definition.billingMode),
      tokens: 0,
      listPriceUsd: 0,
      billableUsd: 0,
      calls: 0,
      quota: quotaPositionFor(definition),
      listed: true,
    });
  }

  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const billingMode = entry.billingMode;
    if (billingMode !== "subscription" && billingMode !== "metered_oauth") continue;
    const providerId =
      typeof entry.provider === "string" && entry.provider.trim().length > 0
        ? entry.provider
        : "unknown";
    let row = byId.get(providerId);
    if (!row) {
      row = {
        providerId,
        name: providerId,
        accountLabel: "",
        billingMode: normalizedBillingMode(billingMode),
        tokens: 0,
        listPriceUsd: 0,
        billableUsd: 0,
        calls: 0,
        quota: quotaPositionFor(undefined),
        listed: false,
      };
      byId.set(providerId, row);
    }
    row.tokens += finite(entry.totalTokens);
    row.listPriceUsd += finite(entry.listPriceUsd);
    row.billableUsd += finite(entry.costUsd);
    row.calls += 1;
  }

  const providers = [...byId.values()];
  return {
    version: 1,
    scope,
    providers,
    totalTokens: providers.reduce((sum, row) => sum + row.tokens, 0),
    totalListPriceUsd: providers.reduce((sum, row) => sum + row.listPriceUsd, 0),
  };
}

/**
 * Structural guard for a `/subscription-usage` payload.
 *
 * #62: a malformed-but-200 response must not throw in render phase. This
 * returns null instead, and the caller degrades to an error state.
 */
export function parseSubscriptionUsageSnapshot(
  raw: unknown,
): SubscriptionUsageSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 1) return null;
  if (candidate.scope !== "session" && candidate.scope !== "project") return null;
  if (!Array.isArray(candidate.providers)) return null;

  const providers: SubscriptionProviderUsage[] = [];
  for (const item of candidate.providers) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.providerId !== "string" || row.providerId.length === 0) return null;
    if (typeof row.name !== "string" || row.name.length === 0) return null;
    const quota = row.quota as Record<string, unknown> | undefined;
    if (!quota || typeof quota !== "object") return null;
    const availability = quota.availability;
    if (
      availability !== "readable" &&
      availability !== "unreadable" &&
      availability !== "no-ceiling"
    ) {
      return null;
    }
    providers.push({
      providerId: row.providerId,
      name: row.name,
      accountLabel: typeof row.accountLabel === "string" ? row.accountLabel : "",
      billingMode: normalizedBillingMode(
        typeof row.billingMode === "string" ? row.billingMode : undefined,
      ),
      tokens: finite(row.tokens),
      listPriceUsd: finite(row.listPriceUsd),
      billableUsd: finite(row.billableUsd),
      calls: finite(row.calls),
      quota: {
        availability,
        usedPercent:
          availability === "readable" ? clampUsedPercent(finite(quota.usedPercent)) : null,
        reason: typeof quota.reason === "string" ? quota.reason : null,
      },
      listed: row.listed !== false,
    });
  }

  return {
    version: 1,
    scope: candidate.scope,
    providers,
    totalTokens: providers.reduce((sum, row) => sum + row.tokens, 0),
    totalListPriceUsd: providers.reduce((sum, row) => sum + row.listPriceUsd, 0),
  };
}

/** Structural guard for the `providers` array of `GET /model-providers`. */
export function parseProviderDefinitions(
  raw: unknown,
): SubscriptionProviderDefinition[] | null {
  if (!raw || typeof raw !== "object") return null;
  const providers = (raw as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return null;
  const parsed: SubscriptionProviderDefinition[] = [];
  for (const item of providers) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) return null;
    if (typeof row.name !== "string" || row.name.length === 0) return null;
    parsed.push({
      id: row.id,
      name: row.name,
      accountLabel: typeof row.accountLabel === "string" ? row.accountLabel : "",
      billingMode: typeof row.billingMode === "string" ? row.billingMode : "",
      billingNote: typeof row.billingNote === "string" ? row.billingNote : "",
      connected: row.connected === true,
      needsReauth: row.needsReauth === true,
    });
  }
  return parsed;
}
