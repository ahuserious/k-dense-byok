import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionCostPill } from "./session-cost-pill";
import type {
  CostEntry,
  SessionCostSummary,
} from "@/lib/use-session-cost";
import type {
  BudgetState,
  ProjectCostSummary,
} from "@/lib/use-project-cost";

/**
 * `SessionCostPill` is now an alias for the subscription bar (row 14's
 * reconciliation — see session-cost-pill.tsx). Every behaviour the old pill
 * pinned is still pinned here, against the new surface:
 *
 *  · money formatting and the proj/sess/sub readout,
 *  · the committed-money cap (reservations + in-flight), not just ledgered spend,
 *  · warn and blocked tones,
 *  · subscription tokens shown but never folded into project spend.
 *
 * Two contracts changed on purpose and are pinned as such:
 *
 *  1. The overlay is a Popover, not a HoverCard: it opens on click/Enter, traps
 *     focus, closes on Escape and restores focus to the trigger (§6.6). A
 *     HoverCard did none of those and its content was unreachable by keyboard.
 *  2. Tones are semantic tokens (`border-primary`, `border-destructive`) rather
 *     than the amber palette classes, and every tone is paired with an icon and
 *     a sentence, because §6.6 forbids meaning carried by colour alone.
 */

const PROVIDERS = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    accountLabel: "ChatGPT Plus/Pro",
    billingMode: "subscription",
    billingNote:
      "Uses provider-managed ChatGPT subscription limits. Kady cannot read remaining quota or overages.",
    connected: true,
    needsReauth: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    accountLabel: "Claude Pro/Max",
    billingMode: "metered_oauth",
    billingNote:
      "Pi documents third-party Claude subscription use as extra usage billed per token.",
    connected: false,
    needsReauth: false,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** `/model-providers` exists today; `/subscription-usage` 404s until registered. */
function installFetchStub(options: { providersFail?: boolean } = {}) {
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/model-providers")) {
      return options.providersFail
        ? jsonResponse({ detail: "nope" }, 500)
        : jsonResponse({ providers: PROVIDERS });
    }
    if (url.includes("/subscription-usage")) return jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installFetchStub();
});

function makeSummary(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
  return {
    sessionId: "sess",
    totalUsd: 0,
    totalTokens: 0,
    agentUsd: 0,
    subagentUsd: 0,
    computeUsd: 0,
    entries: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    entryId: "e1",
    ts: 1,
    sessionId: "sess",
    role: "agent",
    model: "openrouter/anthropic/claude-opus",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cachedTokens: 0,
    costUsd: 0.01,
    ...overrides,
  };
}

function makeProjectSummary(
  overrides: Partial<ProjectCostSummary> = {},
): ProjectCostSummary {
  const totalUsd = overrides.totalUsd ?? 0;
  const limitUsd = overrides.limitUsd ?? null;
  const state: BudgetState =
    overrides.budget?.state ??
    (limitUsd === null
      ? "ok"
      : totalUsd / limitUsd >= 1
        ? "exceeded"
        : totalUsd / limitUsd >= 0.8
          ? "warn"
          : "ok");
  return {
    projectId: "proj",
    totalUsd,
    totalTokens: 0,
    sessionCount: 1,
    limitUsd,
    budget: {
      totalUsd,
      limitUsd,
      ratio: limitUsd !== null ? totalUsd / limitUsd : null,
      state,
    },
    ...overrides,
  };
}

describe("SessionCostPill (subscription bar)", () => {
  it("renders nothing until there is either cost data or a provider list", () => {
    // Row 14 wants a *persistent* bar, so the only moment it is absent is the
    // one where it has nothing true to say yet: no spend, providers still
    // loading. It appears as soon as either resolves.
    const { container } = render(<SessionCostPill summary={makeSummary()} />);
    expect(container.firstChild).toBeNull();
  });

  it("becomes visible with zero spend once the provider list resolves", async () => {
    render(<SessionCostPill summary={makeSummary()} />);
    expect(await screen.findByRole("button")).toBeInTheDocument();
  });

  it("renders a formatted total when there is cost data", () => {
    const summary = makeSummary({
      totalUsd: 1.234,
      totalTokens: 1500,
      agentUsd: 1.234,
      entries: [makeEntry({ costUsd: 1.234, totalTokens: 1500 })],
    });

    render(<SessionCostPill summary={summary} />);
    expect(screen.getByRole("button")).toHaveTextContent("$1.23");
  });

  it("uses 4 decimals for very small costs", () => {
    const summary = makeSummary({
      totalUsd: 0.00123,
      totalTokens: 100,
      agentUsd: 0.00123,
      entries: [makeEntry({ costUsd: 0.00123, totalTokens: 100 })],
    });
    render(<SessionCostPill summary={summary} />);
    expect(screen.getByRole("button")).toHaveTextContent("$0.0012");
  });

  it("shows subscription token usage without treating it as project spend", async () => {
    const user = userEvent.setup();
    const summary = makeSummary({
      totalUsd: 0,
      totalTokens: 1_500,
      subscriptionTokens: 1_500,
      listPriceUsd: 2.5,
      entries: [
        makeEntry({
          provider: "openai-codex",
          model: "openai-codex/gpt-test",
          costUsd: 0,
          totalTokens: 1_500,
          billingMode: "subscription",
          listPriceUsd: 2.5,
        }),
      ],
    });
    render(<SessionCostPill summary={summary} />);

    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent("$0.00");
    expect(await screen.findByText(/sub/)).toBeInTheDocument();
    expect(trigger).toHaveAccessibleName(/1\.5k subscription tokens/i);

    await user.click(trigger);
    // "Subscription usage" is both the per-provider section heading and the
    // per-session ledger row label — the division of labour is deliberate, so
    // both are expected.
    await waitFor(() => {
      expect(screen.getAllByText("Subscription usage")).toHaveLength(2);
    });
    expect(screen.getByText("1.5k tokens")).toBeInTheDocument();
  });

  it("attributes session subscription tokens to the provider that spent them", async () => {
    const user = userEvent.setup();
    const summary = makeSummary({
      totalTokens: 1_500,
      subscriptionTokens: 1_500,
      entries: [
        makeEntry({
          provider: "openai-codex",
          billingMode: "subscription",
          totalTokens: 1_500,
          listPriceUsd: 2.5,
          costUsd: 0,
        }),
      ],
    });
    render(<SessionCostPill summary={summary} />);
    await user.click(screen.getByRole("button"));

    const row = (await screen.findByText("OpenAI Codex")).closest("li");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("1.5k tok");
    expect(row).toHaveTextContent("$2.50 list");
  });

  it("renders every provider quota as an explicitly disabled meter with its reason", async () => {
    const user = userEvent.setup();
    render(<SessionCostPill summary={makeSummary()} />);
    await user.click(await screen.findByRole("button"));

    // The single most important assertion in this file: no percentage is
    // invented for a provider whose ceiling this machine cannot read.
    const meters = await screen.findAllByRole("meter");
    const quotaMeters = meters.filter(
      (meter) => meter.getAttribute("aria-disabled") === "true",
    );
    expect(quotaMeters).toHaveLength(2);
    for (const meter of quotaMeters) {
      expect(meter).not.toHaveAttribute("aria-valuenow");
    }
    expect(
      screen.getByText(/Kady cannot read remaining quota or overages/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Quota not readable/).length).toBeGreaterThan(0);
    expect(screen.getByText(/no subscription ceiling to measure against/)).
      toBeInTheDocument();
  });

  it("renders an honest unavailable state with a retry when providers cannot be read", async () => {
    const user = userEvent.setup();
    vi.unstubAllGlobals();
    installFetchStub({ providersFail: true });

    const summary = makeSummary({
      totalUsd: 1,
      agentUsd: 1,
      entries: [makeEntry({ costUsd: 1 })],
    });
    render(<SessionCostPill summary={summary} />);
    await user.click(screen.getByRole("button"));

    expect(
      await screen.findByText(/Subscription usage could not be read/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders project total without a limit when spendLimit is unset", () => {
    const project = makeProjectSummary({ totalUsd: 2.5, sessionCount: 3 });
    const session = makeSummary({
      totalUsd: 1.0,
      agentUsd: 1.0,
      entries: [makeEntry({ costUsd: 1.0, totalTokens: 10 })],
    });
    render(<SessionCostPill summary={session} projectSummary={project} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("proj");
    expect(button).toHaveTextContent("$2.50");
    expect(button).toHaveTextContent("sess");
    expect(button).toHaveTextContent("$1.00");
    expect(button).not.toHaveTextContent("/");
  });

  it("shows limit and default tone when under 80% of cap", () => {
    const project = makeProjectSummary({ totalUsd: 3.0, limitUsd: 10.0 });
    const session = makeSummary({
      totalUsd: 0.25,
      agentUsd: 0.25,
      entries: [makeEntry({ costUsd: 0.25, totalTokens: 10 })],
    });
    render(
      <SessionCostPill summary={session} projectSummary={project} limitUsd={10.0} />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("proj");
    expect(button).toHaveTextContent("$3.00");
    expect(button).toHaveTextContent("/ $10.00");
    // Budget-specific overrides must be absent below the threshold. The
    // aria-invalid:* destructive classes come from the shadcn base and are not
    // budget state.
    // `classList` rather than a substring: the shadcn base carries
    // `aria-invalid:border-destructive`, which a substring match would hit.
    expect(button.classList.contains("border-destructive")).toBe(false);
    expect(button.classList.contains("text-destructive")).toBe(false);
    expect(button.classList.contains("border-primary/60")).toBe(false);
  });

  it("applies the warn tone when usage is between 80% and 100%", () => {
    const project = makeProjectSummary({ totalUsd: 8.5, limitUsd: 10.0 });
    const session = makeSummary({
      totalUsd: 0.5,
      agentUsd: 0.5,
      entries: [makeEntry({ costUsd: 0.5, totalTokens: 10 })],
    });
    render(
      <SessionCostPill summary={session} projectSummary={project} limitUsd={10.0} />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("border-primary/60");
    // Colour is never the only signal: the warning icon rides with it.
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("counts compute reservations and in-flight runs toward the displayed cap", async () => {
    const user = userEvent.setup();
    // The server admits work against committed money; showing only ledgered
    // spend made a blocked project look like it had room left.
    const project = makeProjectSummary({
      totalUsd: 2.0,
      spentUsd: 2.0,
      reservedUsd: 6.0,
      inFlightUsd: 1.0,
      committedUsd: 9.0,
      limitUsd: 10.0,
      budget: {
        totalUsd: 9.0,
        spentUsd: 2.0,
        reservedUsd: 6.0,
        inFlightUsd: 1.0,
        committedUsd: 9.0,
        limitUsd: 10.0,
        ratio: 0.9,
        state: "warn",
      },
    });
    render(
      <SessionCostPill summary={makeSummary()} projectSummary={project} limitUsd={10.0} />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("$9.00");
    expect(button).toHaveAccessibleName(/held for work in progress/i);
    expect(button.className).toContain("border-primary/60");

    await user.click(button);
    expect(await screen.findByText(/\$2\.00 recorded/)).toBeInTheDocument();
    expect(screen.getByText(/held for compute jobs/)).toBeInTheDocument();
    // 9 of 10 committed — the one real percentage on this surface.
    expect(screen.getByText(/90% of the spend limit used/)).toBeInTheDocument();
  });

  it("applies the destructive tone and lock icon when the budget is exceeded", () => {
    const project = makeProjectSummary({ totalUsd: 12.0, limitUsd: 10.0 });
    const session = makeSummary({
      totalUsd: 0.5,
      agentUsd: 0.5,
      entries: [makeEntry({ costUsd: 0.5, totalTokens: 10 })],
    });
    render(
      <SessionCostPill summary={session} projectSummary={project} limitUsd={10.0} />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("border-destructive");
    expect(button.className).toContain("text-destructive");
    // Lock icon is rendered as an inline SVG; check it's present
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("closes on Escape and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    const session = makeSummary({
      totalUsd: 1,
      agentUsd: 1,
      entries: [makeEntry({ costUsd: 1 })],
    });
    render(<SessionCostPill summary={session} />);
    const trigger = screen.getByRole("button");

    await user.click(trigger);
    expect(await screen.findByText("This session")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("This session")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });
});
