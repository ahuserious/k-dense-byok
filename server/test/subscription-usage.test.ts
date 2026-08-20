/**
 * Gate B for master-brief row 14 — "reads real usage/quota state".
 *
 * These tests assert on the EFFECT, not on a schema accepting a field: real
 * `costs.jsonl` rows are written to a real project sandbox on disk, and the
 * assertions are about which provider's tokens came back, from which ledger,
 * with which quota position. Nothing is mocked — the rollup reads the same
 * files `projectCostSummary` reads.
 *
 * The route is registered onto a bare Fastify instance here because
 * `server/src/index.ts` is orchestrator-only, so `buildApp()` does not know
 * about it in this tree. The handler under test is byte-for-byte the one the
 * orchestrator will register.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PROJECT_ID, PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import type { CostEntry } from "../src/cost/ledger.ts";
import {
  accumulateSubscriptionUsage,
  subscriptionUsageSnapshot,
  type SubscriptionProviderUsage,
} from "../src/agent/subscription-usage.ts";
import { registerSubscriptionUsageRoutes } from "../src/api/subscription-usage.ts";

const app = Fastify();
await registerSubscriptionUsageRoutes(app);

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists(DEFAULT_PROJECT_ID);
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function writeLedger(
  sessionId: string,
  rows: Partial<CostEntry>[],
  projectId: string = DEFAULT_PROJECT_ID,
): void {
  const file = path.join(
    resolvePaths(projectId).sandbox,
    ".kady",
    "runs",
    sessionId,
    "costs.jsonl",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialized = rows
    .map((row, index) =>
      JSON.stringify({
        entryId: `${sessionId}-${String(index)}`,
        ts: 1_700_000_000_000 + index,
        sessionId,
        role: "agent",
        model: "test/model",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        ...row,
      }),
    )
    .join("\n");
  fs.writeFileSync(file, `${serialized}\n`, "utf-8");
}

function row(
  providers: readonly SubscriptionProviderUsage[],
  providerId: string,
): SubscriptionProviderUsage {
  const found = providers.find((candidate) => candidate.providerId === providerId);
  if (!found) throw new Error(`no rollup row for ${providerId}`);
  return found;
}

describe("subscription usage rollup reads the real ledger", () => {
  it("attributes subscription tokens to the provider that spent them, across sessions", () => {
    writeLedger("sess-a", [
      {
        provider: "openai-codex",
        billingMode: "subscription",
        totalTokens: 1_000,
        listPriceUsd: 0.4,
        costUsd: 0,
      },
      {
        provider: "github-copilot",
        billingMode: "subscription",
        totalTokens: 250,
        listPriceUsd: 0.1,
        costUsd: 0,
      },
    ]);
    writeLedger("sess-b", [
      {
        provider: "openai-codex",
        billingMode: "subscription",
        totalTokens: 500,
        listPriceUsd: 0.2,
        costUsd: 0,
      },
    ]);

    const snapshot = subscriptionUsageSnapshot(DEFAULT_PROJECT_ID);

    expect(snapshot.sessionCount).toBe(2);
    // 1000 in sess-a + 500 in sess-b — the sum crosses session boundaries,
    // which is the whole reason the project-scoped route exists.
    expect(row(snapshot.providers, "openai-codex").tokens).toBe(1_500);
    expect(row(snapshot.providers, "openai-codex").calls).toBe(2);
    expect(row(snapshot.providers, "openai-codex").listPriceUsd).toBeCloseTo(0.6, 10);
    expect(row(snapshot.providers, "github-copilot").tokens).toBe(250);
    expect(snapshot.totalTokens).toBe(1_750);
  });

  it("excludes pay-as-you-go, local and compute spend from the subscription rollup", () => {
    writeLedger("sess-mixed", [
      { provider: "openrouter", billingMode: "payg", totalTokens: 9_000, costUsd: 1.25 },
      { provider: "ollama", billingMode: "local", totalTokens: 4_000, costUsd: 0 },
      {
        provider: "modal",
        billingMode: "compute",
        role: "compute",
        totalTokens: 0,
        costUsd: 3,
      },
      {
        provider: "xai",
        billingMode: "subscription",
        totalTokens: 77,
        listPriceUsd: 0.05,
        costUsd: 0,
      },
    ]);

    const snapshot = subscriptionUsageSnapshot(DEFAULT_PROJECT_ID);

    // Only the xai row is subscription-shaped. If payg leaked in, this widget
    // and the cost pill would report different numbers for the same money.
    expect(snapshot.totalTokens).toBe(77);
    expect(row(snapshot.providers, "xai").tokens).toBe(77);
    expect(row(snapshot.providers, "openai-codex").tokens).toBe(0);
    expect(
      snapshot.providers.some((candidate) => candidate.providerId === "openrouter"),
    ).toBe(false);
  });

  it("counts anthropic's metered OAuth usage and keeps its billable USD", () => {
    writeLedger("sess-claude", [
      {
        provider: "anthropic",
        billingMode: "metered_oauth",
        totalTokens: 3_200,
        costUsd: 0.9,
      },
    ]);

    const anthropic = row(subscriptionUsageSnapshot(DEFAULT_PROJECT_ID).providers, "anthropic");

    expect(anthropic.tokens).toBe(3_200);
    // metered_oauth counts toward the project cap, so its USD is real spend and
    // must survive the rollup rather than being zeroed like list-price rows.
    expect(anthropic.billableUsd).toBeCloseTo(0.9, 10);
  });

  it("keeps tokens from a provider that has no definition row instead of dropping them", () => {
    writeLedger("sess-nvidia", [
      {
        provider: "nvidia",
        billingMode: "subscription",
        totalTokens: 640,
        listPriceUsd: 0,
        costUsd: 0,
      },
    ]);

    const nvidia = row(subscriptionUsageSnapshot(DEFAULT_PROJECT_ID).providers, "nvidia");

    expect(nvidia.tokens).toBe(640);
    expect(nvidia.listed).toBe(false);
    expect(nvidia.quota.availability).toBe("unreadable");
    expect(nvidia.quota.reason).toContain("not in the subscription-provider table");
  });

  it("survives malformed and missing numeric fields without poisoning a total", () => {
    writeLedger("sess-bad", [
      {
        provider: "openai-codex",
        billingMode: "subscription",
        totalTokens: Number.NaN as unknown as number,
        listPriceUsd: -5,
        costUsd: 0,
      },
      {
        provider: "openai-codex",
        billingMode: "subscription",
        totalTokens: 120,
        costUsd: 0,
      },
    ]);

    const codex = row(subscriptionUsageSnapshot(DEFAULT_PROJECT_ID).providers, "openai-codex");

    // NaN JSON-serialises to null; a negative list price is clamped. Neither
    // may reach a CSS width or a displayed total.
    expect(Number.isFinite(codex.tokens)).toBe(true);
    expect(codex.tokens).toBe(120);
    expect(codex.listPriceUsd).toBe(0);
  });

  it("returns every defined provider at zero when the project has no runs", () => {
    const snapshot = subscriptionUsageSnapshot(DEFAULT_PROJECT_ID);

    expect(snapshot.sessionCount).toBe(0);
    expect(snapshot.providers.map((candidate) => candidate.providerId)).toEqual([
      "openai-codex",
      "anthropic",
      "github-copilot",
      "xai",
    ]);
    expect(snapshot.providers.every((candidate) => candidate.tokens === 0)).toBe(true);
  });
});

describe("quota positions are honest, and no code path can invent one", () => {
  it("reports every provider as having no readable percentage, with its own reason", () => {
    const snapshot = subscriptionUsageSnapshot(DEFAULT_PROJECT_ID);

    for (const provider of snapshot.providers) {
      expect(provider.quota.usedPercent).toBeNull();
      expect(provider.quota.availability).not.toBe("readable");
      expect(provider.quota.reason).toBeTruthy();
    }
    // The reasons are the server's own words from provider-auth.ts, not the
    // UI's paraphrase of them.
    expect(row(snapshot.providers, "openai-codex").quota.reason).toContain(
      "Kady cannot read remaining quota or overages",
    );
    expect(row(snapshot.providers, "github-copilot").quota.reason).toContain(
      "Kady cannot read remaining premium requests or overages",
    );
    expect(row(snapshot.providers, "anthropic").quota.availability).toBe("no-ceiling");
    expect(row(snapshot.providers, "anthropic").quota.reason).toContain(
      "no subscription ceiling to measure against",
    );
  });
});

describe("GET /subscription-usage", () => {
  it("serves the rollup of what was really written to the ledger", async () => {
    writeLedger("sess-http", [
      {
        provider: "openai-codex",
        billingMode: "subscription",
        totalTokens: 2_048,
        listPriceUsd: 0.75,
        costUsd: 0,
      },
    ]);

    const response = await app.inject({ method: "GET", url: "/subscription-usage" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      version: number;
      scope: string;
      sessionCount: number;
      totalTokens: number;
      providers: SubscriptionProviderUsage[];
    };
    expect(body.version).toBe(1);
    expect(body.scope).toBe("project");
    expect(body.sessionCount).toBe(1);
    expect(body.totalTokens).toBe(2_048);
    expect(row(body.providers, "openai-codex").tokens).toBe(2_048);
    expect(row(body.providers, "openai-codex").quota.usedPercent).toBeNull();
  });

  it("never puts a filesystem path in a response body", async () => {
    writeLedger("sess-path", [
      { provider: "xai", billingMode: "subscription", totalTokens: 5, costUsd: 0 },
    ]);

    const response = await app.inject({ method: "GET", url: "/subscription-usage" });
    const raw = response.body;

    // #71: sandbox paths leaked in 500/502 bodies. The rollup reads files but
    // reports only aggregates, so neither the sandbox root nor a run directory
    // may appear anywhere in the payload.
    expect(raw).not.toContain(PROJECTS_ROOT);
    expect(raw).not.toContain("/sandbox/");
    expect(raw).not.toContain("costs.jsonl");
  });
});

describe("accumulateSubscriptionUsage", () => {
  it("is additive across calls so multi-session folding cannot double count", () => {
    const accumulator = new Map<string, SubscriptionProviderUsage>();
    const entry = (totalTokens: number): CostEntry => ({
      entryId: `e-${String(totalTokens)}`,
      ts: 1,
      sessionId: "s",
      role: "agent",
      model: "test/model",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens,
      cachedTokens: 0,
      costUsd: 0,
      provider: "xai",
      billingMode: "subscription",
    });

    accumulateSubscriptionUsage(accumulator, [entry(10)]);
    accumulateSubscriptionUsage(accumulator, [entry(32)]);

    expect(accumulator.get("xai")?.tokens).toBe(42);
    expect(accumulator.get("xai")?.calls).toBe(2);
  });
});
