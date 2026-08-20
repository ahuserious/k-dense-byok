import { describe, expect, it } from "vitest";

import type { CostEntry } from "@/lib/use-session-cost";
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  normalizeStatusBarUsageMode,
  normalizeUsagePercentageDisplay,
  parseProviderDefinitions,
  parseSubscriptionUsageSnapshot,
  quotaPositionFor,
  rollupSubscriptionUsage,
  usageSeverity,
  type SubscriptionProviderDefinition,
} from "@/lib/subscription-usage";

const CODEX: SubscriptionProviderDefinition = {
  id: "openai-codex",
  name: "OpenAI Codex",
  accountLabel: "ChatGPT Plus/Pro",
  billingMode: "subscription",
  billingNote:
    "Uses provider-managed ChatGPT subscription limits. Kady cannot read remaining quota or overages.",
};

const ANTHROPIC: SubscriptionProviderDefinition = {
  id: "anthropic",
  name: "Anthropic",
  accountLabel: "Claude Pro/Max",
  billingMode: "metered_oauth",
  billingNote:
    "Pi documents third-party Claude subscription use as extra usage billed per token.",
};

function entry(overrides: Partial<CostEntry>): CostEntry {
  return {
    entryId: "e",
    ts: 1,
    sessionId: "s",
    role: "agent",
    model: "test/model",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

/**
 * The percentage-display assertions below are ported from Orca's own
 * `usage-percentage-display.test.ts` (MIT, Copyright (c) 2026 Lovecast Inc.;
 * see the notice in subscription-usage.ts). They are the cheapest available
 * specification of the semantics and are kept verbatim in intent so a future
 * refactor cannot quietly reintroduce the #7574 rounding drift.
 */
describe("usage percentage display (ported from Orca)", () => {
  it("defaults unknown persisted values to the current used-capacity behaviour", () => {
    expect(normalizeUsagePercentageDisplay(undefined)).toBe("used");
    expect(normalizeUsagePercentageDisplay("left")).toBe("used");
  });

  it("shows either the provider value or its complement", () => {
    expect(getDisplayedUsagePercentage(6, "used")).toBe(6);
    expect(getDisplayedUsagePercentage(6, "remaining")).toBe(94);
  });

  it("rounds and bounds percentages for display", () => {
    expect(getDisplayedUsagePercentage(20.5, "used")).toBe(21);
    // The complement is taken from the rounded used value (21), so remaining is
    // 79 — it must not round the complement independently to 80 (#7574).
    expect(getDisplayedUsagePercentage(20.5, "remaining")).toBe(79);
    expect(getDisplayedUsagePercentage(120, "remaining")).toBe(0);
    expect(getDisplayedUsagePercentage(-20, "used")).toBe(0);
    expect(getDisplayedUsagePercentage(Number.NaN, "remaining")).toBe(0);
  });

  it("clamps non-finite values to 0 for bar width and labels", () => {
    // Math.round/min/max propagate NaN into a CSS width (`NaN%`) and into copy.
    expect(clampUsedPercent(Number.NaN)).toBe(0);
    expect(clampUsedPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampUsedPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("agrees whether given a raw or a pre-clamped used percent", () => {
    for (const raw of [20.5, 6.5, 79.5, 0.5, 99.5]) {
      for (const display of ["used", "remaining"] as const) {
        expect(getDisplayedUsagePercentage(clampUsedPercent(raw), display)).toBe(
          getDisplayedUsagePercentage(raw, display),
        );
      }
    }
  });

  it("defaults missing and invalid status-bar modes to verbose", () => {
    expect(normalizeStatusBarUsageMode(undefined)).toBe("verbose");
    expect(normalizeStatusBarUsageMode("expanded")).toBe("verbose");
    expect(normalizeStatusBarUsageMode("compact")).toBe("compact");
  });

  it("changes severity at Orca's 60 and 80 thresholds", () => {
    expect(usageSeverity(59.4)).toBe("normal");
    expect(usageSeverity(60)).toBe("elevated");
    expect(usageSeverity(79.4)).toBe("elevated");
    expect(usageSeverity(80)).toBe("critical");
    expect(usageSeverity(Number.NaN)).toBe("normal");
  });
});

describe("quotaPositionFor", () => {
  it("never yields a percentage, whatever the provider", () => {
    for (const definition of [CODEX, ANTHROPIC, undefined]) {
      const position = quotaPositionFor(definition);
      expect(position.usedPercent).toBeNull();
      expect(position.availability).not.toBe("readable");
      expect(position.reason).toBeTruthy();
    }
  });

  it("distinguishes an unreadable ceiling from no ceiling at all", () => {
    expect(quotaPositionFor(CODEX).availability).toBe("unreadable");
    expect(quotaPositionFor(CODEX).reason).toContain(
      "Kady cannot read remaining quota or overages",
    );
    expect(quotaPositionFor(ANTHROPIC).availability).toBe("no-ceiling");
    expect(quotaPositionFor(ANTHROPIC).reason).toContain(
      "no subscription ceiling to measure against",
    );
  });
});

describe("rollupSubscriptionUsage", () => {
  it("lists every defined provider even with no usage at all", () => {
    const snapshot = rollupSubscriptionUsage([], [CODEX, ANTHROPIC]);
    expect(snapshot.providers.map((row) => row.providerId)).toEqual([
      "openai-codex",
      "anthropic",
    ]);
    expect(snapshot.totalTokens).toBe(0);
  });

  it("sums only subscription-shaped rows, per provider", () => {
    const snapshot = rollupSubscriptionUsage(
      [
        entry({
          provider: "openai-codex",
          billingMode: "subscription",
          totalTokens: 400,
          listPriceUsd: 0.2,
        }),
        entry({
          provider: "openai-codex",
          billingMode: "subscription",
          totalTokens: 100,
          listPriceUsd: 0.05,
        }),
        entry({ provider: "openrouter", billingMode: "payg", totalTokens: 9_000, costUsd: 3 }),
        entry({ provider: "ollama", billingMode: "local", totalTokens: 1_000 }),
      ],
      [CODEX, ANTHROPIC],
    );
    const codex = snapshot.providers.find((row) => row.providerId === "openai-codex");
    expect(codex?.tokens).toBe(500);
    expect(codex?.calls).toBe(2);
    expect(codex?.listPriceUsd).toBeCloseTo(0.25, 10);
    expect(snapshot.totalTokens).toBe(500);
    expect(snapshot.providers.some((row) => row.providerId === "openrouter")).toBe(false);
  });

  it("keeps an undefined provider's tokens rather than dropping them", () => {
    const snapshot = rollupSubscriptionUsage(
      [entry({ provider: "nvidia", billingMode: "subscription", totalTokens: 640 })],
      [CODEX],
    );
    const nvidia = snapshot.providers.find((row) => row.providerId === "nvidia");
    expect(nvidia?.tokens).toBe(640);
    expect(nvidia?.listed).toBe(false);
    expect(nvidia?.name).toBe("nvidia");
  });

  it("coerces malformed numbers so no total can become NaN", () => {
    const snapshot = rollupSubscriptionUsage(
      [
        entry({
          provider: "xai",
          billingMode: "subscription",
          totalTokens: Number.NaN,
          listPriceUsd: -3,
        }),
        entry({ provider: "xai", billingMode: "subscription", totalTokens: 7 }),
      ],
      [],
    );
    const xai = snapshot.providers.find((row) => row.providerId === "xai");
    expect(xai?.tokens).toBe(7);
    expect(xai?.listPriceUsd).toBe(0);
    expect(Number.isFinite(snapshot.totalTokens)).toBe(true);
  });

  it("tolerates a missing entries array", () => {
    expect(rollupSubscriptionUsage(undefined, [CODEX]).totalTokens).toBe(0);
  });
});

/**
 * #62: a malformed-but-200 body must not throw in render phase. Every shape
 * below must come back as `null`, never as a partially-built object and never
 * as an exception.
 */
describe("parseSubscriptionUsageSnapshot", () => {
  it("accepts a well-formed payload", () => {
    const parsed = parseSubscriptionUsageSnapshot({
      version: 1,
      scope: "project",
      providers: [
        {
          providerId: "xai",
          name: "xAI",
          accountLabel: "SuperGrok",
          billingMode: "subscription",
          tokens: 12,
          listPriceUsd: 0,
          billableUsd: 0,
          calls: 1,
          quota: { availability: "unreadable", usedPercent: null, reason: "because" },
          listed: true,
        },
      ],
    });
    expect(parsed?.scope).toBe("project");
    expect(parsed?.totalTokens).toBe(12);
    expect(parsed?.providers[0]?.quota.usedPercent).toBeNull();
  });

  it("rejects every malformed shape instead of throwing", () => {
    for (const bad of [
      null,
      undefined,
      "nope",
      {},
      { version: 2, scope: "project", providers: [] },
      { version: 1, scope: "galaxy", providers: [] },
      { version: 1, scope: "project", providers: "no" },
      { version: 1, scope: "project", providers: [null] },
      { version: 1, scope: "project", providers: [{ providerId: "", name: "x", quota: {} }] },
      {
        version: 1,
        scope: "project",
        providers: [{ providerId: "x", name: "x", quota: { availability: "maybe" } }],
      },
    ]) {
      expect(() => parseSubscriptionUsageSnapshot(bad)).not.toThrow();
      expect(parseSubscriptionUsageSnapshot(bad)).toBeNull();
    }
  });

  it("clamps a readable percentage rather than trusting it", () => {
    const parsed = parseSubscriptionUsageSnapshot({
      version: 1,
      scope: "session",
      providers: [
        {
          providerId: "x",
          name: "X",
          quota: { availability: "readable", usedPercent: 412.6, reason: null },
        },
      ],
    });
    expect(parsed?.providers[0]?.quota.usedPercent).toBe(100);
  });
});

describe("parseProviderDefinitions", () => {
  it("accepts the registered /model-providers shape", () => {
    const parsed = parseProviderDefinitions({
      providers: [{ ...CODEX, connected: true, needsReauth: false, modelCount: 4 }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.name).toBe("OpenAI Codex");
    expect(parsed?.[0]?.connected).toBe(true);
  });

  it("returns null rather than throwing on a malformed body", () => {
    for (const bad of [null, {}, { providers: {} }, { providers: [{ id: "" }] }]) {
      expect(() => parseProviderDefinitions(bad)).not.toThrow();
      expect(parseProviderDefinitions(bad)).toBeNull();
    }
  });
});
