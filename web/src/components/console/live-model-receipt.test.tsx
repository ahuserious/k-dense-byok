import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ModelReceiptCard,
  modelReceiptsFrom,
  parseModelReceipt,
} from "./live-model-receipt";

/**
 * Shaped exactly as the runner writes it:
 * `data: { modelCallSlotId, receipt }` on a `model_resolved` event
 * (server/src/workflows/runner.ts:924-933), with `receipt` the
 * `WorkflowModelResolutionReceipt` of server/src/workflows/run-state.ts:128-133.
 */
const FALLBACK_EVENT_DATA = {
  modelCallSlotId: "primary",
  receipt: {
    request: {
      requested: {
        source: "fixed",
        provider: "anthropic",
        model: "claude-opus-5",
        auth: { kind: "oauth", profile: "work" },
        reasoning: "high",
      },
      resolution: {
        mode: "explicit-fallback",
        alternatives: [
          {
            source: "fixed",
            provider: "anthropic",
            model: "claude-sonnet-5",
            auth: { kind: "api-key" },
            reasoning: "high",
          },
        ],
        reason: "Opus may fall back to Sonnet under load.",
      },
    },
    resolved: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      auth: { kind: "api-key" },
      reasoning: "high",
      runtime: "pi",
    },
    fallbackUsed: true,
    resolutionReason: "Requested model was rate limited.",
  },
};

const EXACT_EVENT_DATA = {
  modelCallSlotId: "primary",
  receipt: {
    request: {
      requested: {
        source: "kady-current",
        auth: { kind: "kady-current" },
        reasoning: "high",
      },
      resolution: { mode: "exact" },
    },
    resolved: {
      provider: "openai",
      model: "gpt-5.4",
      auth: { kind: "api-key", profile: "personal" },
      reasoning: "high",
      runtime: "pi",
    },
    fallbackUsed: false,
  },
};

describe("parseModelReceipt", () => {
  it("reads exactly the fields the receipt carries", () => {
    const receipt = parseModelReceipt(FALLBACK_EVENT_DATA);
    expect(receipt).toEqual({
      requestedProvider: "anthropic",
      requestedModel: "claude-opus-5",
      requestedSource: "fixed",
      requestedAuthKind: "oauth",
      requestedAuthProfile: "work",
      requestedReasoning: "high",
      resolutionMode: "explicit-fallback",
      resolutionReasonFromRequest: "Opus may fall back to Sonnet under load.",
      resolvedProvider: "anthropic",
      resolvedModel: "claude-sonnet-5",
      resolvedAuthKind: "api-key",
      resolvedAuthProfile: null,
      resolvedReasoning: "high",
      resolvedRuntime: "pi",
      fallbackUsed: true,
      resolutionReason: "Requested model was rate limited.",
      slotId: "primary",
    });
  });

  it("is not a receipt without a resolved provider, model, and fallbackUsed", () => {
    expect(parseModelReceipt(undefined)).toBeNull();
    expect(parseModelReceipt({})).toBeNull();
    expect(parseModelReceipt({ receipt: {} })).toBeNull();
    expect(
      parseModelReceipt({ receipt: { resolved: { provider: "openai" }, fallbackUsed: false } }),
    ).toBeNull();
    expect(
      parseModelReceipt({ receipt: { resolved: { provider: "openai", model: "gpt-5.4" } } }),
    ).toBeNull();
    // A node_started event carries data, but not a receipt.
    expect(parseModelReceipt({ nodeId: "analyze", attempt: 1 })).toBeNull();
  });

  it("collects only the payloads that carry receipts", () => {
    expect(
      modelReceiptsFrom([undefined, { nodeId: "a" }, FALLBACK_EVENT_DATA, EXACT_EVENT_DATA]),
    ).toHaveLength(2);
  });
});

describe("ModelReceiptCard", () => {
  it("renders requested beside resolved, and calls a fallback a fallback", () => {
    const receipt = parseModelReceipt(FALLBACK_EVENT_DATA);
    render(<ModelReceiptCard receipt={receipt!} />);
    expect(screen.getByText("anthropic / claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("anthropic / claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("fallback taken")).toBeInTheDocument();
    expect(screen.getByText("oauth · work → api-key")).toBeInTheDocument();
    expect(screen.getByText(/Requested model was rate limited\./)).toBeInTheDocument();
    expect(screen.getByText(/Opus may fall back to Sonnet under load\./)).toBeInTheDocument();
    expect(screen.getByText("runtime pi")).toBeInTheDocument();
  });

  it("says a Kady Current request had no fixed model rather than printing a blank", () => {
    const receipt = parseModelReceipt(EXACT_EVENT_DATA);
    render(<ModelReceiptCard receipt={receipt!} />);
    expect(screen.getByText("Kady Current (no fixed model)")).toBeInTheDocument();
    expect(screen.getByText("openai / gpt-5.4")).toBeInTheDocument();
    expect(screen.getByText("as requested")).toBeInTheDocument();
    expect(screen.getByText("kady-current → api-key · personal")).toBeInTheDocument();
  });
});
