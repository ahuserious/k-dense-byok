"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DurabilityApiError,
  readDurabilitySettings,
  readDurabilitySignals,
  writeDurabilitySettings,
  type DurabilityEffort,
  type DurabilityModelSelection,
  type DurabilityResolutionReport,
  type DurabilitySettings,
  type DurabilitySignalDescriptor,
  type DurabilitySignalId,
} from "@/lib/durability";
import { useModels } from "@/lib/use-models";

const EFFORTS: DurabilityEffort[] = ["low", "medium", "high", "xhigh"];

function selectionValue(selection: DurabilityModelSelection): string {
  if (selection.kind === "direct") return selection.ref;
  if (selection.kind === "preset") return `preset:${selection.presetId}`;
  return "";
}

function withSelectionEffort(
  selection: DurabilityModelSelection,
  effort: DurabilityEffort,
): DurabilityModelSelection {
  if (selection.kind === "unset") return selection;
  return { ...selection, effort };
}

function unavailableDetail(error: unknown): string {
  if (error instanceof DurabilityApiError && error.status === 404) {
    return "Durability controls are not available in this server build yet.";
  }
  return error instanceof Error ? error.message : "Durability controls are unavailable.";
}

export function DurabilityOptions() {
  const { models, isModelAvailable } = useModels();
  const [settings, setSettings] = useState<DurabilitySettings | null>(null);
  const [resolution, setResolution] = useState<DurabilityResolutionReport | null>(null);
  const [signals, setSignals] = useState<DurabilitySignalDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResponse, signalResponse] = await Promise.all([
        readDurabilitySettings(),
        readDurabilitySignals(),
      ]);
      setSettings(settingsResponse.settings);
      setResolution(settingsResponse.resolution);
      setSignals(signalResponse);
      setDirty(false);
    } catch (cause) {
      setSettings(null);
      setResolution(null);
      setSignals([]);
      setError(unavailableDetail(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const availableModels = useMemo(
    () => models.filter((model) => !model.isFusion && isModelAvailable(model)),
    [isModelAvailable, models],
  );
  const rescueModels = useMemo(
    () =>
      availableModels.filter(
        (model) => !settings || model.context_length >= settings.minRescueContextWindow,
      ),
    [availableModels, settings],
  );

  const update = (next: DurabilitySettings) => {
    setSettings(next);
    setDirty(true);
    setStatus(null);
  };

  const chooseModel = (
    slot: "watcherModel" | "rescueModel",
    value: string,
  ) => {
    if (!settings) return;
    const previous = settings[slot];
    const effort = previous.kind === "unset"
      ? slot === "watcherModel" ? "high" : settings.rescueEffort
      : previous.effort;
    const next: DurabilityModelSelection = value.startsWith("preset:")
      ? {
          kind: "preset",
          presetId: value.slice("preset:".length),
          ...(effort ? { effort } : {}),
        }
      : value
        ? { kind: "direct", ref: value, ...(effort ? { effort } : {}) }
        : {
            kind: "unset",
            reason: slot === "watcherModel"
              ? "Pick a priced watcher model before enabling durability."
              : "Pick a rescue model before enabling escalation.",
          };
    update({ ...settings, [slot]: next });
  };

  const updateSignal = (
    id: DurabilitySignalId,
    patch: Partial<DurabilitySettings["signals"][DurabilitySignalId]>,
  ) => {
    if (!settings) return;
    update({
      ...settings,
      signals: {
        ...settings.signals,
        [id]: { ...settings.signals[id], ...patch },
      },
    });
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await writeDurabilitySettings(settings);
      setSettings(response.settings);
      setResolution(response.resolution);
      setDirty(false);
      setStatus("Durability settings saved.");
    } catch (cause) {
      setError(unavailableDetail(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section
        aria-label="Durability"
        className="rounded-md border px-2.5 py-2 text-[11px] text-muted-foreground"
      >
        Loading durability controls…
      </section>
    );
  }

  if (!settings) {
    return (
      <section aria-label="Durability" className="rounded-md border px-2.5 py-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Durability
            </h3>
            <p role="alert" className="mt-1 text-[10px] text-muted-foreground">
              {error} The controls stay disabled until the server exposes the durability API.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border px-2 py-1 text-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const modelsReady =
    settings.watcherModel.kind !== "unset" && settings.rescueModel.kind !== "unset";
  const masterReason = modelsReady
    ? undefined
    : settings.watcherModel.kind === "unset"
      ? settings.watcherModel.reason
      : settings.rescueModel.kind === "unset"
        ? settings.rescueModel.reason
        : undefined;

  return (
    <section aria-labelledby="durability-title" className="rounded-md border px-2.5 py-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="durability-title"
            className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            Durability
          </h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            One watcher observes real run events; escalation and lateral pass are distinct actions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="rounded-md border px-2 py-1 text-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save durability"}
        </button>
      </div>

      <label className="mt-2 flex items-start gap-2 text-[11px]">
        <input
          type="checkbox"
          data-testid="durability-enabled"
          checked={settings.enabled}
          disabled={!modelsReady}
          aria-describedby={masterReason ? "durability-master-reason" : undefined}
          onChange={(event) => update({ ...settings, enabled: event.target.checked })}
          className="mt-0.5 size-3.5 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        />
        <span>
          <span className="font-medium">Watch workflow runs</span>
          {masterReason && (
            <span id="durability-master-reason" className="block text-muted-foreground">
              Unavailable: {masterReason}
            </span>
          )}
        </span>
      </label>

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <ModelSlot
          label="Watcher model"
          value={selectionValue(settings.watcherModel)}
          selection={settings.watcherModel}
          resolution={resolution?.watcher}
          models={availableModels}
          onChange={(value) => chooseModel("watcherModel", value)}
          onEffortChange={(effort) =>
            update({
              ...settings,
              watcherModel: withSelectionEffort(settings.watcherModel, effort),
            })
          }
        />
        <ModelSlot
          label="Rescue model"
          value={selectionValue(settings.rescueModel)}
          selection={settings.rescueModel}
          resolution={resolution?.rescue}
          models={rescueModels}
          onChange={(value) => chooseModel("rescueModel", value)}
          onEffortChange={(effort) =>
            update({
              ...settings,
              rescueModel: withSelectionEffort(settings.rescueModel, effort),
              rescueEffort: effort,
            })
          }
        />
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <label className="text-[10px] text-muted-foreground">
          Stalled after (seconds)
          <input
            type="number"
            min={1}
            value={Math.max(1, Math.round(settings.stallMs / 1_000))}
            onChange={(event) =>
              update({
                ...settings,
                stallMs: Math.max(1, Number(event.target.value) || 1) * 1_000,
              })
            }
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Minimum rescue context
          <input
            type="number"
            min={1}
            value={settings.minRescueContextWindow}
            onChange={(event) =>
              update({
                ...settings,
                minRescueContextWindow: Math.max(1, Number(event.target.value) || 1),
              })
            }
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          />
        </label>
        <div className="rounded-md border px-2 py-1.5 text-[10px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.stopPolicy.allowStop}
              onChange={(event) =>
                update({
                  ...settings,
                  stopPolicy: {
                    ...settings.stopPolicy,
                    allowStop: event.target.checked,
                  },
                })
              }
              className="size-3.5 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            />
            Allow watcher stop
          </label>
          <label className="mt-1 block text-muted-foreground">
            Maximum stops per run
            <input
              type="number"
              min={1}
              value={settings.stopPolicy.maxStopsPerRun}
              onChange={(event) =>
                update({
                  ...settings,
                  stopPolicy: {
                    ...settings.stopPolicy,
                    maxStopsPerRun: Math.max(1, Number(event.target.value) || 1),
                  },
                })
              }
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            />
          </label>
        </div>
      </div>

      <ul className="mt-2 flex flex-col gap-1.5" aria-label="Durability signals">
        {signals.map((descriptor) => {
          const setting = settings.signals[descriptor.id];
          const disabled = !descriptor.observable;
          return (
            <li key={descriptor.id} className="rounded-md border px-2 py-1.5">
              <div className="grid items-start gap-2 md:grid-cols-[minmax(0,1fr)_9rem_7rem]">
                <label className="flex items-start gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    data-testid={`durability-signal-${descriptor.id}`}
                    checked={setting.enabled}
                    disabled={disabled}
                    onChange={(event) =>
                      updateSignal(descriptor.id, { enabled: event.target.checked })
                    }
                    className="mt-0.5 size-3.5 accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  />
                  <span>
                    <span className="font-medium">{descriptor.label}</span>
                    <span className="ml-1 rounded border px-1 text-[9px]">
                      {descriptor.observability}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {descriptor.firesWhen}
                    </span>
                    {descriptor.unobservableReason && (
                      <span
                        data-testid={`durability-signal-reason-${descriptor.id}`}
                        className="block text-[10px] text-muted-foreground"
                      >
                        {descriptor.unobservableReason}
                      </span>
                    )}
                  </span>
                </label>
                <label className="text-[10px] text-muted-foreground">
                  Action
                  <select
                    value={setting.action}
                    disabled={disabled || descriptor.supportedActions.length === 0}
                    onChange={(event) =>
                      updateSignal(descriptor.id, {
                        action: event.target.value as DurabilitySettings["signals"][DurabilitySignalId]["action"],
                      })
                    }
                    className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  >
                    {descriptor.supportedActions.map((action) => (
                      <option key={action} value={action}>{action}</option>
                    ))}
                  </select>
                </label>
                <label className="text-[10px] text-muted-foreground">
                  {descriptor.thresholdLabel ?? "Threshold"}
                  <input
                    type="number"
                    min={1}
                    value={setting.threshold}
                    disabled={disabled}
                    onChange={(event) =>
                      updateSignal(descriptor.id, {
                        threshold: Math.max(1, Number(event.target.value) || 1),
                      })
                    }
                    className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  />
                </label>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p role="alert" className="mt-2 text-[10px] text-destructive">{error}</p>}
      {status && <p role="status" className="mt-2 text-[10px] text-muted-foreground">{status}</p>}
    </section>
  );
}

function ModelSlot({
  label,
  value,
  selection,
  resolution,
  models,
  onChange,
  onEffortChange,
}: {
  label: string;
  value: string;
  selection: DurabilityModelSelection;
  resolution: DurabilityResolutionReport["watcher"] | undefined;
  models: Array<{ id: string; label: string; provider: string }>;
  onChange: (value: string) => void;
  onEffortChange: (effort: DurabilityEffort) => void;
}) {
  const effort = selection.kind === "unset" ? "high" : selection.effort ?? "high";
  return (
    <fieldset className="rounded-md border px-2 py-1.5">
      <legend className="px-1 text-[10px] font-medium">{label}</legend>
      <label className="block text-[10px] text-muted-foreground">
        Model
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <option value="">Choose a model…</option>
          {selection.kind === "preset" && (
            <option value={`preset:${selection.presetId}`}>
              Preset: {selection.presetId}
            </option>
          )}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.provider} · {model.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-1 block text-[10px] text-muted-foreground">
        Effort
        <select
          value={effort}
          disabled={selection.kind === "unset"}
          onChange={(event) => onEffortChange(event.target.value as DurabilityEffort)}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          {EFFORTS.map((candidate) => (
            <option key={candidate} value={candidate}>{candidate}</option>
          ))}
        </select>
      </label>
      {selection.kind === "unset" && (
        <p className="mt-1 text-[10px] text-muted-foreground">{selection.reason}</p>
      )}
      {resolution?.reason && (
        <p className="mt-1 text-[10px] text-muted-foreground">{resolution.reason}</p>
      )}
      {resolution?.warning && (
        <p className="mt-1 text-[10px] text-muted-foreground">{resolution.warning}</p>
      )}
    </fieldset>
  );
}
