"use client";

import { apiFetch } from "@/lib/projects";

export type DurabilityEffort = "low" | "medium" | "high" | "xhigh";
export type DurabilityAction = "observe" | "restart" | "escalate" | "lateral-pass" | "stop";
export type DurabilitySignalId =
  | "compaction"
  | "context-rot"
  | "hallucination"
  | "paused-no-progress"
  | "failed-script-run"
  | "failed-skill-fire";

export type DurabilityModelSelection =
  | { kind: "preset"; presetId: string; effort?: DurabilityEffort }
  | { kind: "direct"; ref: string; effort?: DurabilityEffort }
  | { kind: "unset"; reason: string };

export interface DurabilitySignalSetting {
  enabled: boolean;
  action: DurabilityAction;
  threshold: number;
}

export interface DurabilitySettings {
  version: 1;
  enabled: boolean;
  watcherModel: DurabilityModelSelection;
  rescueModel: DurabilityModelSelection;
  rescueEffort: DurabilityEffort;
  minRescueContextWindow: number;
  stallMs: number;
  stopPolicy: { allowStop: boolean; maxStopsPerRun: number };
  signals: Record<DurabilitySignalId, DurabilitySignalSetting>;
}

export interface DurabilitySignalDescriptor {
  id: DurabilitySignalId;
  label: string;
  observable: boolean;
  observability: "full" | "partial" | "none";
  unobservableReason?: string;
  observationSource: string;
  firesWhen: string;
  supportedActions: DurabilityAction[];
  thresholdLabel?: string;
}

export interface DurabilityModelResolution {
  status: "resolved" | "unset" | "unresolvable";
  ref?: string;
  effort?: DurabilityEffort;
  contextWindow?: number;
  pricing: "priced" | "unpriced" | "unknown";
  warning?: string;
  reason?: string;
  nextAction?: string;
}

export interface DurabilityResolutionReport {
  watcher: DurabilityModelResolution;
  rescue: DurabilityModelResolution;
}

export interface DurabilitySettingsResponse {
  settings: DurabilitySettings;
  resolution: DurabilityResolutionReport;
}

export interface DurabilityStopAvailability {
  runId: string;
  canStop: boolean;
  reason?: string;
}

export interface DurabilityState {
  enabled: boolean;
  resolution: DurabilityResolutionReport;
  watchedRuns: Array<{
    runId: string;
    status: string;
    lastSeq: number;
    lastObservedAt: number;
    firedSignals: DurabilitySignalId[];
    stops: number;
  }>;
  stopPolicy: { allowStop: boolean; maxStopsPerRun: number };
  stopAvailability: DurabilityStopAvailability[];
}

export type DurabilityEventName =
  | "durability.watch.started"
  | "durability.signal.fired"
  | "durability.signal.suppressed"
  | "durability.action.dispatched"
  | "durability.action.completed"
  | "durability.action.failed"
  | "durability.escalation.started"
  | "durability.escalation.completed"
  | "durability.escalation.deferred"
  | "durability.stop.requested"
  | "durability.stop.completed"
  | "durability.model.unresolved"
  | "durability.watch.stopped";

export interface DurabilityTimelineEvent {
  seq: number;
  ts: number;
  name: DurabilityEventName;
  runId: string;
  runLastSeq: number;
  signal?: DurabilitySignalId;
  action?: DurabilityAction;
  model?: string;
  effort?: DurabilityEffort;
  proposalId?: string;
  detail: string;
  ok?: boolean;
}

export interface DurabilityTimelinePage {
  runId: string;
  events: DurabilityTimelineEvent[];
  lastSeq: number;
  hasMore: boolean;
}

export interface DurabilityStopReceipt {
  runId: string;
  stopped: boolean;
  terminalStatus: "cancelled";
  stoppedBy: "durability-watcher" | "operator";
  reason: string;
  distinguishedInRunEvents: boolean;
  detail: string;
}

export class DurabilityApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DurabilityApiError";
  }
}

const SIGNAL_IDS: readonly DurabilitySignalId[] = [
  "compaction",
  "context-rot",
  "hallucination",
  "paused-no-progress",
  "failed-script-run",
  "failed-skill-fire",
];
const ACTIONS: readonly DurabilityAction[] = [
  "observe",
  "restart",
  "escalate",
  "lateral-pass",
  "stop",
];
const EFFORTS: readonly DurabilityEffort[] = ["low", "medium", "high", "xhigh"];
const EVENT_NAMES: readonly DurabilityEventName[] = [
  "durability.watch.started",
  "durability.signal.fired",
  "durability.signal.suppressed",
  "durability.action.dispatched",
  "durability.action.completed",
  "durability.action.failed",
  "durability.escalation.started",
  "durability.escalation.completed",
  "durability.escalation.deferred",
  "durability.stop.requested",
  "durability.stop.completed",
  "durability.model.unresolved",
  "durability.watch.stopped",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseModelSelection(value: unknown): DurabilityModelSelection | null {
  if (!isRecord(value)) return null;
  const effort = isOneOf(value.effort, EFFORTS) ? value.effort : undefined;
  if (value.kind === "direct" && typeof value.ref === "string" && value.ref.length > 0) {
    return { kind: "direct", ref: value.ref, ...(effort ? { effort } : {}) };
  }
  if (
    value.kind === "preset" &&
    typeof value.presetId === "string" &&
    value.presetId.length > 0
  ) {
    return { kind: "preset", presetId: value.presetId, ...(effort ? { effort } : {}) };
  }
  if (value.kind === "unset" && typeof value.reason === "string") {
    return { kind: "unset", reason: value.reason };
  }
  return null;
}

function parseSignalSetting(value: unknown): DurabilitySignalSetting | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return null;
  if (!isOneOf(value.action, ACTIONS)) return null;
  const threshold = positiveInteger(value.threshold);
  return threshold === null ? null : { enabled: value.enabled, action: value.action, threshold };
}

export function parseDurabilitySettings(value: unknown): DurabilitySettings | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean") return null;
  const watcherModel = parseModelSelection(value.watcherModel);
  const rescueModel = parseModelSelection(value.rescueModel);
  if (!watcherModel || !rescueModel || !isOneOf(value.rescueEffort, EFFORTS)) return null;
  const minRescueContextWindow = positiveInteger(value.minRescueContextWindow);
  const stallMs = positiveInteger(value.stallMs);
  if (!minRescueContextWindow || !stallMs || !isRecord(value.stopPolicy)) return null;
  const maxStopsPerRun = positiveInteger(value.stopPolicy.maxStopsPerRun);
  if (typeof value.stopPolicy.allowStop !== "boolean" || !maxStopsPerRun) return null;
  if (!isRecord(value.signals)) return null;

  const signals = {} as Record<DurabilitySignalId, DurabilitySignalSetting>;
  for (const id of SIGNAL_IDS) {
    const setting = parseSignalSetting(value.signals[id]);
    if (!setting) return null;
    signals[id] = setting;
  }
  return {
    version: 1,
    enabled: value.enabled,
    watcherModel,
    rescueModel,
    rescueEffort: value.rescueEffort,
    minRescueContextWindow,
    stallMs,
    stopPolicy: { allowStop: value.stopPolicy.allowStop, maxStopsPerRun },
    signals,
  };
}

function parseResolution(value: unknown): DurabilityModelResolution | null {
  if (!isRecord(value)) return null;
  if (!isOneOf(value.status, ["resolved", "unset", "unresolvable"] as const)) return null;
  if (!isOneOf(value.pricing, ["priced", "unpriced", "unknown"] as const)) return null;
  return {
    status: value.status,
    pricing: value.pricing,
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(isOneOf(value.effort, EFFORTS) ? { effort: value.effort } : {}),
    ...(positiveInteger(value.contextWindow)
      ? { contextWindow: value.contextWindow as number }
      : {}),
    ...(typeof value.warning === "string" ? { warning: value.warning } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.nextAction === "string" ? { nextAction: value.nextAction } : {}),
  };
}

function parseResolutionReport(value: unknown): DurabilityResolutionReport | null {
  if (!isRecord(value)) return null;
  const watcher = parseResolution(value.watcher);
  const rescue = parseResolution(value.rescue);
  return watcher && rescue ? { watcher, rescue } : null;
}

function parseSettingsResponse(value: unknown): DurabilitySettingsResponse | null {
  if (!isRecord(value)) return null;
  const settings = parseDurabilitySettings(value.settings);
  const resolution = parseResolutionReport(value.resolution);
  return settings && resolution ? { settings, resolution } : null;
}

function parseSignalDescriptor(value: unknown): DurabilitySignalDescriptor | null {
  if (!isRecord(value) || !isOneOf(value.id, SIGNAL_IDS) || typeof value.label !== "string") {
    return null;
  }
  if (
    typeof value.observable !== "boolean" ||
    !isOneOf(value.observability, ["full", "partial", "none"] as const) ||
    typeof value.observationSource !== "string" ||
    typeof value.firesWhen !== "string" ||
    !Array.isArray(value.supportedActions)
  ) {
    return null;
  }
  const supportedActions = value.supportedActions.filter(
    (entry): entry is DurabilityAction => isOneOf(entry, ACTIONS),
  );
  return {
    id: value.id,
    label: value.label,
    observable: value.observable,
    observability: value.observability,
    observationSource: value.observationSource,
    firesWhen: value.firesWhen,
    supportedActions,
    ...(typeof value.unobservableReason === "string"
      ? { unobservableReason: value.unobservableReason }
      : {}),
    ...(typeof value.thresholdLabel === "string"
      ? { thresholdLabel: value.thresholdLabel }
      : {}),
  };
}

function errorDetail(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.detail === "string" ? value.detail : fallback;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  return await response.json().catch(() => null);
}

export async function readDurabilitySettings(): Promise<DurabilitySettingsResponse> {
  const response = await apiFetch("/durability/settings");
  const body = await jsonOrNull(response);
  if (!response.ok) {
    throw new DurabilityApiError(response.status, errorDetail(body, "Durability settings are unavailable."));
  }
  const parsed = parseSettingsResponse(body);
  if (!parsed) throw new DurabilityApiError(502, "The durability settings response was malformed.");
  return parsed;
}

export async function writeDurabilitySettings(
  settings: DurabilitySettings,
): Promise<DurabilitySettingsResponse> {
  const response = await apiFetch("/durability/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const body = await jsonOrNull(response);
  if (!response.ok) {
    throw new DurabilityApiError(response.status, errorDetail(body, "Durability settings were refused."));
  }
  const parsed = parseSettingsResponse(body);
  if (!parsed) throw new DurabilityApiError(502, "The saved durability response was malformed.");
  return parsed;
}

export async function readDurabilitySignals(): Promise<DurabilitySignalDescriptor[]> {
  const response = await apiFetch("/durability/signals");
  const body = await jsonOrNull(response);
  if (!response.ok) {
    throw new DurabilityApiError(response.status, errorDetail(body, "Durability signals are unavailable."));
  }
  if (!isRecord(body) || !Array.isArray(body.signals)) {
    throw new DurabilityApiError(502, "The durability signal response was malformed.");
  }
  const signals = body.signals.map(parseSignalDescriptor);
  if (signals.some((entry) => entry === null)) {
    throw new DurabilityApiError(502, "The durability signal response was malformed.");
  }
  return signals as DurabilitySignalDescriptor[];
}

export async function readDurabilityState(): Promise<DurabilityState> {
  const response = await apiFetch("/durability/state");
  const body = await jsonOrNull(response);
  if (!response.ok) {
    throw new DurabilityApiError(response.status, errorDetail(body, "Durability state is unavailable."));
  }
  if (
    !isRecord(body) ||
    typeof body.enabled !== "boolean" ||
    !Array.isArray(body.watchedRuns) ||
    !Array.isArray(body.stopAvailability) ||
    !isRecord(body.stopPolicy)
  ) {
    throw new DurabilityApiError(502, "The durability state response was malformed.");
  }
  const resolution = parseResolutionReport(body.resolution);
  const maxStopsPerRun = positiveInteger(body.stopPolicy.maxStopsPerRun);
  if (!resolution || typeof body.stopPolicy.allowStop !== "boolean" || !maxStopsPerRun) {
    throw new DurabilityApiError(502, "The durability state response was malformed.");
  }
  const watchedRuns = body.watchedRuns.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.runId !== "string" ||
      typeof entry.status !== "string" ||
      !Number.isSafeInteger(entry.lastSeq) ||
      typeof entry.lastObservedAt !== "number" ||
      !Array.isArray(entry.firedSignals) ||
      !Number.isSafeInteger(entry.stops)
    ) return [];
    return [{
      runId: entry.runId,
      status: entry.status,
      lastSeq: entry.lastSeq as number,
      lastObservedAt: entry.lastObservedAt,
      firedSignals: entry.firedSignals.filter(
        (signal): signal is DurabilitySignalId => isOneOf(signal, SIGNAL_IDS),
      ),
      stops: entry.stops as number,
    }];
  });
  const stopAvailability = body.stopAvailability.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.runId !== "string" || typeof entry.canStop !== "boolean") {
      return [];
    }
    return [{
      runId: entry.runId,
      canStop: entry.canStop,
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    }];
  });
  return {
    enabled: body.enabled,
    resolution,
    watchedRuns,
    stopPolicy: { allowStop: body.stopPolicy.allowStop, maxStopsPerRun },
    stopAvailability,
  };
}

function parseTimelineEvent(value: unknown): DurabilityTimelineEvent | null {
  if (
    !isRecord(value) ||
    !positiveInteger(value.seq) ||
    typeof value.ts !== "number" ||
    !isOneOf(value.name, EVENT_NAMES) ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.runLastSeq) ||
    typeof value.detail !== "string"
  ) {
    return null;
  }
  return {
    seq: value.seq as number,
    ts: value.ts,
    name: value.name,
    runId: value.runId,
    runLastSeq: value.runLastSeq as number,
    ...(isOneOf(value.signal, SIGNAL_IDS) ? { signal: value.signal } : {}),
    ...(isOneOf(value.action, ACTIONS) ? { action: value.action } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(isOneOf(value.effort, EFFORTS) ? { effort: value.effort } : {}),
    ...(typeof value.proposalId === "string" ? { proposalId: value.proposalId } : {}),
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    detail: value.detail,
  };
}

export function parseDurabilityTimeline(value: unknown): DurabilityTimelinePage | null {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    !Array.isArray(value.events) ||
    !Number.isSafeInteger(value.lastSeq) ||
    typeof value.hasMore !== "boolean"
  ) {
    return null;
  }
  const events = value.events.map(parseTimelineEvent);
  if (events.some((event) => event === null)) return null;
  return {
    runId: value.runId,
    events: events as DurabilityTimelineEvent[],
    lastSeq: value.lastSeq as number,
    hasMore: value.hasMore,
  };
}

export async function readDurabilityTimeline(runId: string): Promise<DurabilityTimelinePage> {
  const response = await apiFetch(
    `/durability/runs/${encodeURIComponent(runId)}/timeline?limit=200`,
  );
  const body = await jsonOrNull(response);
  if (!response.ok) {
    throw new DurabilityApiError(response.status, errorDetail(body, "Durability timeline is unavailable."));
  }
  const parsed = parseDurabilityTimeline(body);
  if (!parsed) throw new DurabilityApiError(502, "The durability timeline response was malformed.");
  return parsed;
}

export async function stopDurabilityRun(
  runId: string,
  reason: string,
): Promise<DurabilityStopReceipt> {
  const response = await apiFetch(`/durability/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const body = await jsonOrNull(response);
  if (!response.ok) {
    throw new DurabilityApiError(response.status, errorDetail(body, "The durability stop was refused."));
  }
  if (
    !isRecord(body) ||
    typeof body.runId !== "string" ||
    typeof body.stopped !== "boolean" ||
    body.terminalStatus !== "cancelled" ||
    !isOneOf(body.stoppedBy, ["durability-watcher", "operator"] as const) ||
    typeof body.reason !== "string" ||
    typeof body.distinguishedInRunEvents !== "boolean" ||
    typeof body.detail !== "string"
  ) {
    throw new DurabilityApiError(502, "The durability stop response was malformed.");
  }
  return body as unknown as DurabilityStopReceipt;
}
