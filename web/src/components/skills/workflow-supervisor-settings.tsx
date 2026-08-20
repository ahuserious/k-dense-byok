"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useProjects } from "@/lib/use-projects";
import {
  getDurabilityAdapterState,
  getModelPresetAdapterState,
  getSkillCuratorCapabilities,
  saveDurabilitySettings,
  type DurabilityAction,
  type DurabilityEffort,
  type DurabilitySettingsV1,
  type ModelPresetOption,
} from "@/lib/skill-curator";
import { F11_FOCUS_SCOPE } from "./focus-scope";

export interface WorkflowSupervisorSettingsProps {
  projectId?: string;
  compact?: boolean;
  /** F8 may pass its already-loaded F1 preset list to avoid a second request. */
  presetOptions?: ModelPresetOption[];
}

function modelPresetId(
  selection: DurabilitySettingsV1["watcherModel"],
): string {
  return selection.kind === "preset" ? selection.presetId : "";
}

export function WorkflowSupervisorSettings({
  projectId: explicitProjectId,
  compact = false,
  presetOptions,
}: WorkflowSupervisorSettingsProps) {
  const { activeProjectId } = useProjects();
  const projectId = explicitProjectId ?? activeProjectId;
  const [settings, setSettings] = useState<DurabilitySettingsV1 | null>(null);
  const [signals, setSignals] = useState<
    Awaited<ReturnType<typeof getDurabilityAdapterState>>["signals"]
  >([]);
  const [presets, setPresets] = useState<ModelPresetOption[]>(presetOptions ?? []);
  const [available, setAvailable] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [presetReason, setPresetReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const capabilities = await getSkillCuratorCapabilities(projectId);
    if (!capabilities.durability.available) {
      setAvailable(false);
      setReason("Durability settings endpoint not available on this build.");
      setSettings(null);
      setSignals([]);
      setPresets(presetOptions ?? []);
      setPresetReason(
        presetOptions || capabilities.modelPresets.available
          ? null
          : "Model presets are not available on this build.",
      );
      setLoading(false);
      return;
    }
    const [durability, presetState] = await Promise.all([
      getDurabilityAdapterState(projectId),
      presetOptions
        ? Promise.resolve({ available: true, presets: presetOptions, reason: null })
        : capabilities.modelPresets.available
          ? getModelPresetAdapterState(projectId)
          : Promise.resolve({
            available: false,
            presets: [],
            reason: "Model presets are not available on this build.",
          }),
    ]);
    setAvailable(durability.available);
    setReason(durability.reason);
    setSettings(durability.settings);
    setSignals(durability.signals);
    setPresets(presetState.presets);
    setPresetReason(presetState.available ? null : presetState.reason);
    setLoading(false);
  }, [presetOptions, projectId]);

  useEffect(() => {
    let cancelled = false;
    void load().catch((cause: unknown) => {
      if (!cancelled) {
        setLoading(false);
        setAvailable(false);
        setError(cause instanceof Error ? cause.message : "Could not load durability settings.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const update = useCallback(
    (change: (current: DurabilitySettingsV1) => DurabilitySettingsV1) => {
      setSettings((current) => (current ? change(current) : current));
      setNotice(null);
    },
    [],
  );

  const save = useCallback(async () => {
    if (!settings || !available) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveDurabilitySettings(settings, projectId);
      setSettings(saved.settings);
      setSignals(saved.signals);
      setAvailable(saved.available);
      setReason(saved.reason);
      setNotice("Saved through the shared durability settings API.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save durability settings.");
    } finally {
      setSaving(false);
    }
  }, [available, projectId, settings]);

  const disabled = loading || !available || !settings;

  return (
    <section
      aria-labelledby="workflow-supervisor-settings-title"
      className={`${compact ? "space-y-3" : "space-y-4 rounded-lg border p-3"} ${F11_FOCUS_SCOPE}`}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="workflow-supervisor-settings-title" className="text-sm font-medium">
            Workflow supervisor
          </h3>
          <Badge variant="outline" className="text-[10px]">
            shared durability watcher
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          This is a view over F14&apos;s one watcher and store. Models are referenced by
          F1 preset id; this component owns no model defaults.
        </p>
      </div>

      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading shared durability settings…
        </p>
      )}
      {!loading && !available && (
        <div className="space-y-2 rounded-md border p-2">
          <p id="durability-settings-disabled-reason" className="text-xs text-muted-foreground">
            {reason ?? "Durability settings endpoint not available on this build."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            aria-describedby="durability-settings-disabled-reason"
          >
            Enable workflow supervisor
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-destructive/50 p-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border bg-muted p-2 text-xs text-foreground">
          {notice}
        </p>
      )}

      {settings && (
        <fieldset disabled={disabled || saving} className="space-y-4">
          <legend className="sr-only">Workflow supervisor settings</legend>

          <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-xs">
            <span>
              <span className="block font-medium">Watch workflow runs</span>
              <span className="block text-[11px] text-muted-foreground">
                Spending stays off until an operator enables it.
              </span>
            </span>
            <Switch
              aria-label="Watch workflow runs"
              checked={settings.enabled}
              onCheckedChange={(checked) =>
                update((current) => ({ ...current, enabled: checked }))
              }
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            {(["watcherModel", "rescueModel"] as const).map((field) => {
              const selection = settings[field];
              const selectedId = modelPresetId(selection);
              const label = field === "watcherModel" ? "Watcher preset" : "Rescue preset";
              const unavailableReason =
                presetReason ??
                (selection.kind === "unset" ? selection.reason : null);
              return (
                <label key={field} className="space-y-1 text-xs font-medium">
                  {label}
                  <select
                    aria-label={label}
                    className="h-9 w-full rounded-md border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-100"
                    value={selectedId}
                    disabled={presets.length === 0}
                    aria-describedby={
                      unavailableReason ? `${field}-unavailable-reason` : undefined
                    }
                    onChange={(event) => {
                      const presetId = event.target.value;
                      if (!presetId) return;
                      update((current) => ({
                        ...current,
                        [field]: {
                          kind: "preset",
                          presetId,
                          effort:
                            current[field].kind === "preset" ||
                              current[field].kind === "direct"
                              ? current[field].effort
                              : field === "watcherModel"
                                ? "high"
                                : current.rescueEffort,
                        },
                      }));
                    }}
                  >
                    <option value="">Select a preset id</option>
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} ({preset.id})
                      </option>
                    ))}
                  </select>
                  {unavailableReason && (
                    <span
                      id={`${field}-unavailable-reason`}
                      className="block text-[11px] font-normal text-muted-foreground"
                    >
                      {unavailableReason}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs font-medium">
              Rescue effort
              <select
                aria-label="Rescue effort"
                className="h-9 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={settings.rescueEffort}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    rescueEffort: event.target.value as DurabilityEffort,
                  }))
                }
              >
                {(["low", "medium", "high", "xhigh"] as const).map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium">
              Minimum rescue context
              <Input
                aria-label="Minimum rescue context"
                type="number"
                min={1}
                className="h-9 text-xs"
                value={settings.minRescueContextWindow}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    minRescueContextWindow: Math.max(1, Number(event.target.value) || 1),
                  }))
                }
              />
            </label>
            <label className="space-y-1 text-xs font-medium">
              Stall threshold (ms)
              <Input
                aria-label="Stall threshold"
                type="number"
                min={1}
                className="h-9 text-xs"
                value={settings.stallMs}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    stallMs: Math.max(1, Number(event.target.value) || 1),
                  }))
                }
              />
            </label>
          </div>

          <div className="space-y-2">
            <h4 className="text-xs font-medium">Signals and effects</h4>
            {signals.map((descriptor) => {
              const value = settings.signals[descriptor.id];
              const cannotObserve = descriptor.observability === "none";
              const reasonId = `${descriptor.id}-observability-reason`;
              return (
                <div key={descriptor.id} className="space-y-2 rounded-md border p-2">
                  <div className="flex items-start justify-between gap-3">
                    <span>
                      <span className="flex flex-wrap items-center gap-1 text-xs font-medium">
                        {descriptor.label}
                        <Badge variant="outline" className="text-[9px]">
                          {descriptor.observability}
                        </Badge>
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {descriptor.firesWhen}
                      </span>
                    </span>
                    <Switch
                      aria-label={`Enable ${descriptor.label}`}
                      checked={value.enabled}
                      disabled={cannotObserve}
                      aria-describedby={
                        descriptor.unobservableReason ? reasonId : undefined
                      }
                      onCheckedChange={(checked) =>
                        update((current) => ({
                          ...current,
                          signals: {
                            ...current.signals,
                            [descriptor.id]: {
                              ...current.signals[descriptor.id],
                              enabled: checked,
                            },
                          },
                        }))
                      }
                    />
                  </div>
                  {descriptor.unobservableReason && (
                    <p id={reasonId} className="text-[11px] text-muted-foreground">
                      {descriptor.unobservableReason}
                    </p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-[11px] font-medium">
                      Action
                      <select
                        aria-label={`${descriptor.label} action`}
                        className="h-8 w-full rounded-md border bg-background px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={value.action}
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            signals: {
                              ...current.signals,
                              [descriptor.id]: {
                                ...current.signals[descriptor.id],
                                action: event.target.value as DurabilityAction,
                              },
                            },
                          }))
                        }
                      >
                        {descriptor.supportedActions.map((action) => (
                          <option key={action} value={action}>
                            {action}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-[11px] font-medium">
                      {descriptor.thresholdLabel ?? "Threshold"}
                      <Input
                        aria-label={`${descriptor.label} threshold`}
                        type="number"
                        min={1}
                        className="h-8 text-[11px]"
                        value={value.threshold}
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            signals: {
                              ...current.signals,
                              [descriptor.id]: {
                                ...current.signals[descriptor.id],
                                threshold: Math.max(1, Number(event.target.value) || 1),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-xs">
              <span>
                <span className="block font-medium">Allow watcher stop</span>
                <span className="block text-[11px] text-muted-foreground">
                  Uses F14 stop authority, not process termination.
                </span>
              </span>
              <Switch
                aria-label="Allow watcher stop"
                checked={settings.stopPolicy.allowStop}
                onCheckedChange={(checked) =>
                  update((current) => ({
                    ...current,
                    stopPolicy: { ...current.stopPolicy, allowStop: checked },
                  }))
                }
              />
            </label>
            <label className="space-y-1 text-xs font-medium">
              Maximum stops per run
              <Input
                aria-label="Maximum stops per run"
                type="number"
                min={0}
                className="h-9 text-xs"
                value={settings.stopPolicy.maxStopsPerRun}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    stopPolicy: {
                      ...current.stopPolicy,
                      maxStopsPerRun: Math.max(0, Number(event.target.value) || 0),
                    },
                  }))
                }
              />
            </label>
          </div>

          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save shared supervisor settings"}
          </Button>
        </fieldset>
      )}
    </section>
  );
}
