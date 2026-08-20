import { describe, expect, it } from "vitest";

import {
  parseDurabilitySettings,
  parseDurabilityTimeline,
  type DurabilitySignalId,
} from "./durability";

const SIGNAL_IDS: DurabilitySignalId[] = [
  "compaction",
  "context-rot",
  "hallucination",
  "paused-no-progress",
  "failed-script-run",
  "failed-skill-fire",
];

function settings() {
  return {
    version: 1,
    enabled: false,
    watcherModel: { kind: "unset", reason: "Pick a priced watcher model." },
    rescueModel: { kind: "unset", reason: "Pick a rescue model." },
    rescueEffort: "xhigh",
    minRescueContextWindow: 1_000_000,
    stallMs: 300_000,
    stopPolicy: { allowStop: true, maxStopsPerRun: 1 },
    signals: Object.fromEntries(
      SIGNAL_IDS.map((id) => [id, { enabled: id === "compaction", action: "observe", threshold: 1 }]),
    ),
  };
}

describe("parseDurabilitySettings", () => {
  it("accepts the complete F14 settings contract", () => {
    expect(parseDurabilitySettings(settings())).toMatchObject({
      version: 1,
      enabled: false,
      rescueEffort: "xhigh",
      minRescueContextWindow: 1_000_000,
      stopPolicy: { allowStop: true, maxStopsPerRun: 1 },
    });
  });

  it("fails closed when one signal is missing or malformed (#62)", () => {
    const missing = settings();
    delete missing.signals["failed-skill-fire"];
    expect(parseDurabilitySettings(missing)).toBeNull();

    const malformed = settings();
    malformed.signals.compaction = {
      enabled: true,
      action: "observe",
      threshold: 0,
    };
    expect(parseDurabilitySettings(malformed)).toBeNull();
  });
});

describe("parseDurabilityTimeline", () => {
  it("preserves deferred escalation as a distinct non-success outcome", () => {
    const parsed = parseDurabilityTimeline({
      runId: "wrun_123",
      lastSeq: 4,
      hasMore: false,
      events: [{
        seq: 4,
        ts: 100,
        name: "durability.escalation.deferred",
        runId: "wrun_123",
        runLastSeq: 9,
        proposalId: "proposal-1",
        detail: "A rescue proposal is waiting for approval.",
        ok: false,
      }],
    });
    expect(parsed?.events[0]).toMatchObject({
      name: "durability.escalation.deferred",
      proposalId: "proposal-1",
      ok: false,
    });
  });

  it("rejects an unknown event instead of rendering a half-valid row", () => {
    expect(parseDurabilityTimeline({
      runId: "wrun_123",
      lastSeq: 1,
      hasMore: false,
      events: [{
        seq: 1,
        ts: 100,
        name: "durability.made-up",
        runId: "wrun_123",
        runLastSeq: 1,
        detail: "not real",
      }],
    })).toBeNull();
  });
});
