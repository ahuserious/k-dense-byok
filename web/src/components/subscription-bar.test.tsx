import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SubscriptionBar } from "./subscription-bar";
import type { SessionCostSummary } from "@/lib/use-session-cost";

/**
 * What `session-cost-pill.test.tsx` does not cover: the upgrade path to the
 * project-wide rollup, and what happens when that route answers with rubbish.
 */

const PROVIDERS = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    accountLabel: "ChatGPT Plus/Pro",
    billingMode: "subscription",
    billingNote: "Kady cannot read remaining quota or overages.",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function emptySummary(): SessionCostSummary {
  return {
    sessionId: "sess",
    totalUsd: 0,
    totalTokens: 0,
    agentUsd: 0,
    subagentUsd: 0,
    computeUsd: 0,
    entries: [],
  };
}

function stubFetch(usageBody: unknown, usageStatus: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/model-providers")) return jsonResponse({ providers: PROVIDERS });
      if (url.includes("/subscription-usage")) return jsonResponse(usageBody, usageStatus);
      return jsonResponse({}, 404);
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("SubscriptionBar project-scope upgrade", () => {
  it("prefers the project-wide rollup and says so", async () => {
    const user = userEvent.setup();
    stubFetch(
      {
        version: 1,
        scope: "project",
        providers: [
          {
            providerId: "openai-codex",
            name: "OpenAI Codex",
            accountLabel: "ChatGPT Plus/Pro",
            billingMode: "subscription",
            tokens: 12_345,
            listPriceUsd: 3,
            billableUsd: 0,
            calls: 9,
            quota: {
              availability: "unreadable",
              usedPercent: null,
              reason: "Kady cannot read remaining quota or overages.",
            },
            listed: true,
          },
        ],
      },
      200,
    );
    render(<SubscriptionBar summary={emptySummary()} projectRollupEnabled />);
    await user.click(await screen.findByRole("button"));

    expect(await screen.findByText(/Scope: this project\./)).toBeInTheDocument();
    // Once the project rollup lands it drives BOTH the trigger's `sub` total and
    // the provider row, so the header can never disagree with the detail.
    expect(screen.getAllByText(/12\.3k tok/)).toHaveLength(2);
  });

  it("falls back to the session ledger, without an error, when the route 404s", async () => {
    const user = userEvent.setup();
    stubFetch({}, 404);
    render(<SubscriptionBar summary={emptySummary()} projectRollupEnabled />);
    await user.click(await screen.findByRole("button"));

    expect(await screen.findByText(/Scope: this session\./)).toBeInTheDocument();
    // A missing upgrade route is not an error state — the fallback is real data.
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("ignores a malformed-but-200 rollup instead of throwing in render (#62)", async () => {
    const user = userEvent.setup();
    stubFetch({ version: 1, scope: "project", providers: [{ nope: true }] }, 200);
    expect(() =>
      render(<SubscriptionBar summary={emptySummary()} projectRollupEnabled />),
    ).not.toThrow();
    await user.click(await screen.findByRole("button"));

    // Degrades to the session rollup rather than rendering a half-parsed body.
    expect(await screen.findByText(/Scope: this session\./)).toBeInTheDocument();
    expect(screen.getByText("OpenAI Codex")).toBeInTheDocument();
  });
});

describe("SubscriptionBar meters", () => {
  it("gives the spend meter a real aria-valuenow and the quota meters none", async () => {
    const user = userEvent.setup();
    stubFetch({}, 404);
    render(
      <SubscriptionBar
        summary={emptySummary()}
        projectSummary={{
          projectId: "p",
          totalUsd: 4,
          totalTokens: 0,
          sessionCount: 1,
          limitUsd: 8,
          budget: { totalUsd: 4, limitUsd: 8, ratio: 0.5, state: "ok" },
        }}
        limitUsd={8}
      />,
    );

    const trigger = await screen.findByRole("button");
    await user.click(trigger);

    const meters = await screen.findAllByRole("meter");
    const spend = meters.filter((meter) => meter.hasAttribute("aria-valuenow"));
    const quota = meters.filter((meter) => meter.getAttribute("aria-disabled") === "true");
    expect(spend.length).toBeGreaterThan(0);
    expect(spend[0]).toHaveAttribute("aria-valuenow", "50");
    expect(quota).toHaveLength(1);
    expect(quota[0]).not.toHaveAttribute("aria-valuenow");
  });

  it("never emits a NaN width from a nonsense limit", async () => {
    const user = userEvent.setup();
    stubFetch({}, 404);
    render(
      <SubscriptionBar
        summary={emptySummary()}
        projectSummary={{
          projectId: "p",
          totalUsd: Number.NaN,
          totalTokens: 0,
          sessionCount: 1,
          limitUsd: 10,
          budget: { totalUsd: Number.NaN, limitUsd: 10, ratio: null, state: "ok" },
        }}
        limitUsd={10}
      />,
    );
    await user.click(await screen.findByRole("button"));
    for (const meter of await screen.findAllByRole("meter")) {
      expect(meter.innerHTML).not.toContain("NaN");
      const value = meter.getAttribute("aria-valuenow");
      if (value !== null) expect(Number.isFinite(Number(value))).toBe(true);
    }
  });
});
