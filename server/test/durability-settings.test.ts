import { describe, expect, it } from "vitest";
import {
  DURABILITY_DEFAULT_WATCHER_REF,
  DURABILITY_SIGNALS,
  DURABILITY_WATCHER_UNSET_REASON,
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
  it("ships BOTH model slots unset, each with an honest reason, and nothing guessed", () => {
    const settings = defaultDurabilitySettings();
    // Round 1 shipped the owner's watcher model as a live default. It resolves
    // on OpenRouter but is absent from this build's pricing catalogue, so its
    // calls record $0 and the project spend cap never accrues against them —
    // a shipped default that silently disables a budget control. It is now
    // unset for exactly the reason the rescue slot is: nothing is guessed.
    expect(settings.watcherModel).toEqual({
      kind: "unset",
      reason: DURABILITY_WATCHER_UNSET_REASON,
    });
    expect(settings.watcherModel.kind === "unset" && settings.watcherModel.reason)
      .toContain(DURABILITY_DEFAULT_WATCHER_REF);
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

  it("narrows paused-no-progress to what this build can actually produce", () => {
    // `run_paused` and `run_blocked` have NO emitter anywhere in server/src,
    // server/pi-packages or server/vendor: they exist only as frozen literals
    // and reducer cases in run-state.ts. Only `run_waiting` is ever appended
    // (prompt-opt-interview-contract.ts:144). Two thirds of this signal's
    // trigger set cannot occur, so it is not "full".
    const descriptor = durabilitySignalDescriptor("paused-no-progress");
    expect(descriptor.observability).toBe("partial");
    expect(descriptor.unobservableReason).toContain("run_paused");
    expect(descriptor.unobservableReason).toContain("run_blocked");
    expect(descriptor.firesWhen).toContain("waiting");
    expect(descriptor.firesWhen).toContain("never produces those two statuses");
    // ...and it is still enableable, because the waiting third is real.
    expect(descriptor.observable).toBe(true);
    expect(parseDurabilitySettings({
      signals: { "paused-no-progress": { enabled: true } },
    }).signals["paused-no-progress"].enabled).toBe(true);
  });

  it("tallies the catalogue as 3 full, 2 partial, 1 none", () => {
    const tally = { full: 0, partial: 0, none: 0 };
    for (const descriptor of DURABILITY_SIGNALS) tally[descriptor.observability] += 1;
    expect(tally).toEqual({ full: 3, partial: 2, none: 1 });
  });

  it("rejects a non-object signal value with a named field instead of a silent 200", () => {
    // Round 1 merged a non-object as {} and returned the settings unchanged,
    // which reads to the caller as "saved".
    expect(() => parseDurabilitySettings({ signals: { compaction: "yes" } }))
      .toThrow(/signals\.compaction must be an object/);
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
  it("refuses an unpriced OpenRouter model rather than silently disabling the spend cap", () => {
    // The owner's named watcher model. It resolves live on OpenRouter and is
    // absent from this build's 154-entry pricing catalogue, so `models.ts`
    // would price it at $0 and `assertBudgetAdmission` would compare against a
    // total these calls never increase. Surfacing that as a field is not
    // enough — a control that is silently off must fail closed.
    const resolution = resolveDurabilityModel(
      { kind: "direct", ref: DURABILITY_DEFAULT_WATCHER_REF, effort: "high" },
      { slotLabel: "watcher model" },
    );
    expect(resolution.status).toBe("unresolvable");
    expect(resolution.pricing).toBe("unpriced");
    expect(resolution.reason).toContain("pricing catalogue");
    expect(resolution.reason).toContain("$0");
    expect(resolution.nextAction).toContain("priced watcher model");
    expect(() => requireDurabilityModel("watcher", resolution))
      .toThrow(DurabilityModelUnavailableError);
  });

  it("resolves a priced watcher model, and says so", () => {
    const resolution = resolveDurabilityModel(
      { kind: "direct", ref: "openrouter/qwen/qwen3.6-27b", effort: "high" },
      { slotLabel: "watcher model" },
    );
    expect(resolution).toMatchObject({
      status: "resolved",
      ref: "openrouter/qwen/qwen3.6-27b",
      effort: "high",
      pricing: "priced",
      contextWindow: 262_144,
    });
  });

  it('reports a non-OpenRouter ref as pricing "unknown" with a warning, never as priced', () => {
    // Round 1 left `pricing` absent on this branch, so F6 could not tell
    // "priced", "unpriced" and "we cannot see" apart. It is always populated.
    const resolution = resolveDurabilityModel(
      { kind: "direct", ref: "ollama/qwen3:32b" },
      { slotLabel: "watcher model" },
    );
    expect(resolution.status).toBe("resolved");
    expect(resolution.pricing).toBe("unknown");
    expect(resolution.warning).toContain("not an OpenRouter model");
  });

  it("fails the 1M floor closed when a model's context window cannot be established", () => {
    // The floor's whole purpose is row 44's "large 1M-context model". Round 1
    // only checked a KNOWN window, so this passed silently for every ref the
    // catalogue does not carry — the exact case the floor exists for.
    for (const ref of ["openai/gpt-4o-mini", "openrouter/vendor/model-nobody-catalogued"]) {
      const resolution = resolveDurabilityModel(
        { kind: "direct", ref, effort: "xhigh" },
        { slotLabel: "rescue model", minContextWindow: 1_000_000 },
      );
      expect(resolution.status, `${ref} must not pass a 1M floor it cannot prove.`)
        .toBe("unresolvable");
      expect(resolution.pricing).toBeTruthy();
      expect(() => requireDurabilityModel("rescue", resolution))
        .toThrow(DurabilityModelUnavailableError);
    }
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

  it("fails closed on BOTH shipped defaults, naming what the operator must do", () => {
    const report = resolveDurabilityModels(defaultDurabilitySettings());
    expect(report.watcher.status).toBe("unset");
    expect(report.watcher.reason).toContain("pricing catalogue");
    expect(() => requireDurabilityModel("watcher", report.watcher))
      .toThrow(DurabilityModelUnavailableError);
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
