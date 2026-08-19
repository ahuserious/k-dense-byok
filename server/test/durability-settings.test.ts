import { describe, expect, it } from "vitest";
import {
  DURABILITY_DEFAULT_WATCHER_REF,
  DURABILITY_SIGNALS,
  DurabilitySettingsError,
  defaultDurabilitySettings,
  durabilitySignalDescriptor,
  parseDurabilitySettings,
} from "../src/workflows/durability-settings.ts";
import {
  DurabilityModelUnavailableError,
  requireDurabilityModel,
  resolveDurabilityModel,
  resolveDurabilityModels,
} from "../src/workflows/durability-model-policy.ts";

describe("durability settings", () => {
  it("ships the owner's watcher default and an honest unset rescue default", () => {
    const settings = defaultDurabilitySettings();
    expect(settings.watcherModel).toEqual({
      kind: "direct",
      ref: DURABILITY_DEFAULT_WATCHER_REF,
      effort: "high",
    });
    expect(settings.rescueModel.kind).toBe("unset");
    expect(settings.rescueEffort).toBe("xhigh");
    expect(settings.minRescueContextWindow).toBe(1_000_000);
    // Durability is off until an operator switches it on: a watcher that
    // spends money does not enable itself.
    expect(settings.enabled).toBe(false);
  });

  it("merges a partial patch over stored settings", () => {
    const base = defaultDurabilitySettings();
    const merged = parseDurabilitySettings({ enabled: true }, base);
    expect(merged.enabled).toBe(true);
    expect(merged.stallMs).toBe(base.stallMs);
    expect(merged.signals.compaction).toEqual(base.signals.compaction);
  });

  it("refuses to enable a signal this build cannot observe, with the reason the UI shows", () => {
    const descriptor = durabilitySignalDescriptor("failed-skill-fire");
    expect(descriptor.observable).toBe(false);
    expect(descriptor.observability).toBe("none");

    let thrown: unknown;
    try {
      parseDurabilitySettings({
        signals: { "failed-skill-fire": { enabled: true } },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DurabilitySettingsError);
    expect((thrown as DurabilitySettingsError).code).toBe("SIGNAL_NOT_OBSERVABLE");
    expect((thrown as Error).message).toBe(descriptor.unobservableReason);
  });

  it("rejects malformed settings by naming the field and the fix", () => {
    expect(() => parseDurabilitySettings({ watcherModel: { kind: "direct", ref: "qwen" } }))
      .toThrow(/provider-qualified model reference/);
    expect(() => parseDurabilitySettings({ stallMs: 10 })).toThrow(/stallMs/);
    expect(() => parseDurabilitySettings({ signals: { nonsense: { enabled: true } } }))
      .toThrow(/not a durability signal/);
    expect(() => parseDurabilitySettings({ surprise: true })).toThrow(/do not accept the field/);
    expect(() =>
      parseDurabilitySettings({ signals: { "failed-skill-fire": { action: "stop" } } })
    ).toThrow(/cannot use the stop action/);
  });

  it("describes every signal with a source, a firing condition, and an honest flag", () => {
    expect(DURABILITY_SIGNALS).toHaveLength(6);
    for (const descriptor of DURABILITY_SIGNALS) {
      expect(descriptor.observationSource.length).toBeGreaterThan(0);
      expect(descriptor.firesWhen.length).toBeGreaterThan(0);
      if (descriptor.observability !== "full") {
        expect(descriptor.unobservableReason).toBeTruthy();
        // The reason names the user's next action and no filesystem path (#71).
        expect(descriptor.unobservableReason).not.toMatch(/[/\\][A-Za-z0-9_.-]+[/\\]/);
      }
    }
  });
});

describe("durability model policy — resolve, or fail closed", () => {
  it("resolves the owner's watcher model and reports that it is unpriced here", () => {
    const resolution = resolveDurabilityModel(
      { kind: "direct", ref: DURABILITY_DEFAULT_WATCHER_REF, effort: "high" },
      { slotLabel: "watcher model" },
    );
    expect(resolution.status).toBe("resolved");
    expect(resolution.ref).toBe(DURABILITY_DEFAULT_WATCHER_REF);
    expect(resolution.effort).toBe("high");
    // Absent from this build's pricing catalogue, so spend caps will not accrue
    // for it. Reported, never hidden.
    expect(resolution.pricing).toBe("unpriced");
  });

  it("resolves a real 1M-context rescue model with its price", () => {
    const resolution = resolveDurabilityModel(
      { kind: "direct", ref: "openrouter/openai/gpt-5.6-luna-pro", effort: "xhigh" },
      { slotLabel: "rescue model", minContextWindow: 1_000_000 },
    );
    expect(resolution).toMatchObject({
      status: "resolved",
      contextWindow: 1_050_000,
      pricing: "priced",
    });
  });

  it("fails closed on the shipped rescue default, naming the three candidates", () => {
    const report = resolveDurabilityModels(defaultDurabilitySettings());
    expect(report.rescue.status).toBe("unset");
    expect(report.rescue.reason).toContain("GPT-5.6 Luna Pro");
    expect(report.rescue.reason).toContain("GPT-5.6 Terra Pro");
    expect(report.rescue.reason).toContain("GPT-5.6 Sol Pro");
    expect(report.rescue.nextAction).toContain("Pipeline options");
    expect(() => requireDurabilityModel("rescue", report.rescue))
      .toThrow(DurabilityModelUnavailableError);
  });

  it("fails closed on a preset id while Team A's resolver is absent", () => {
    const resolution = resolveDurabilityModel(
      { kind: "preset", presetId: "preset-123" },
      { slotLabel: "rescue model" },
    );
    expect(resolution.status).toBe("unresolvable");
    expect(resolution.reason).toContain("Model presets are not available");
    expect(resolution.nextAction).toContain("Model presets");
  });

  it("uses Team A's resolver once it is installed", () => {
    const resolution = resolveDurabilityModel(
      { kind: "preset", presetId: "preset-123" },
      {
        slotLabel: "rescue model",
        presetResolver: {
          resolve: (presetId) =>
            presetId === "preset-123"
              ? { ref: "openrouter/openai/gpt-5.6-terra-pro", effort: "xhigh" }
              : undefined,
        },
      },
    );
    expect(resolution).toMatchObject({
      status: "resolved",
      ref: "openrouter/openai/gpt-5.6-terra-pro",
      effort: "xhigh",
    });
  });

  it("rejects a rescue model below the 1M context floor instead of discovering it mid-rescue", () => {
    const resolution = resolveDurabilityModel(
      { kind: "direct", ref: "openrouter/openai/gpt-5.4-mini" },
      { slotLabel: "rescue model", minContextWindow: 1_000_000 },
    );
    expect(resolution.status).toBe("unresolvable");
    expect(resolution.reason).toContain("context window");
    expect(resolution.nextAction).toContain("larger rescue model");
  });

  it("never substitutes a model when one cannot be resolved", () => {
    const report = resolveDurabilityModels({
      ...defaultDurabilitySettings(),
      rescueModel: { kind: "preset", presetId: "missing" },
    });
    expect(report.rescue.ref).toBeUndefined();
    expect(report.rescue.status).toBe("unresolvable");
  });
});
