import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";

/**
 * Durability configuration is pipeline/workflow-level OPERATOR configuration.
 *
 * It is deliberately NOT part of NodeSpec and adds no field to the frozen
 * workflow `settings` object: the run schema (`schema.ts`, `validate.ts`,
 * `run-state.ts`) is owned elsewhere and stays untouched. Durability persists
 * through this module and is served by `api/durability.ts`.
 */
export const DURABILITY_SETTINGS_VERSION = 1 as const;

/**
 * The error code a durability stop writes into the run's terminal event, so a
 * watcher stop is distinguishable from a user cancel (`USER_CANCELLED`) and
 * from a failure (`run_failed`) inside the authoritative run event stream.
 */
export const DURABILITY_STOP_ERROR_CODE = "DurabilityWatcherStop";

export const DURABILITY_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type DurabilityEffort = (typeof DURABILITY_EFFORTS)[number];

export const DURABILITY_SIGNAL_IDS = [
  "compaction",
  "context-rot",
  "hallucination",
  "paused-no-progress",
  "failed-script-run",
  "failed-skill-fire",
] as const;
export type DurabilitySignalId = (typeof DURABILITY_SIGNAL_IDS)[number];

export const DURABILITY_ACTIONS = [
  "observe",
  "restart",
  "escalate",
  "lateral-pass",
  "stop",
] as const;
export type DurabilityAction = (typeof DURABILITY_ACTIONS)[number];

export type DurabilityObservability = "full" | "partial" | "none";

/**
 * A model is referenced by preset id (Team A's F1 preset system, resolved at
 * dispatch time and never copied) or by a direct provider-qualified ref.
 * `unset` is a first-class state so a default the owner named but that does not
 * resolve to exactly one id can ship honestly instead of being guessed.
 */
export type DurabilityModelSelection =
  | { kind: "preset"; presetId: string; effort?: DurabilityEffort }
  | { kind: "direct"; ref: string; effort?: DurabilityEffort }
  | { kind: "unset"; reason: string };

export interface DurabilitySignalSetting {
  enabled: boolean;
  action: DurabilityAction;
  threshold: number;
}

export interface DurabilitySettingsV1 {
  version: typeof DURABILITY_SETTINGS_VERSION;
  enabled: boolean;
  watcherModel: DurabilityModelSelection;
  rescueModel: DurabilityModelSelection;
  rescueEffort: DurabilityEffort;
  minRescueContextWindow: number;
  stallMs: number;
  stopPolicy: { allowStop: boolean; maxStopsPerRun: number };
  signals: Record<DurabilitySignalId, DurabilitySignalSetting>;
}

export type DurabilitySettingsErrorCode = "INVALID_SETTINGS" | "SIGNAL_NOT_OBSERVABLE";

export class DurabilitySettingsError extends Error {
  constructor(readonly code: DurabilitySettingsErrorCode, message: string) {
    super(message);
    this.name = "DurabilitySettingsError";
  }
}

export interface DurabilitySignalDescriptor {
  id: DurabilitySignalId;
  label: string;
  observable: boolean;
  observability: DurabilityObservability;
  unobservableReason?: string;
  observationSource: string;
  firesWhen: string;
  supportedActions: DurabilityAction[];
  thresholdLabel: string;
}

/**
 * The owner's named watcher default, resolved live against
 * https://openrouter.ai/api/v1/models on 2026-08-18: "Qwen 3.8 27B" is exactly
 * one live id, `qwen/qwen3.8-27b` (context 262144, carries reasoning_effort).
 */
export const DURABILITY_DEFAULT_WATCHER_REF = "openrouter/qwen/qwen3.8-27b";

/**
 * ...and it is ABSENT from this build's vendored pricing catalogue
 * (`web/src/data/models.json`, 154 entries). An uncatalogued OpenRouter model
 * prices at $0 (`agent/models.ts:146-163`), so every watcher call would record
 * a zero cost and the project spend cap would never accrue against it.
 *
 * Round 1 surfaced that as `pricing: "unpriced"` and asked Team C for the
 * catalogue row. That is not enough: a SHIPPED DEFAULT that quietly disables a
 * budget control is not made safe by a field the UI may or may not render. So
 * the watcher slot now ships unset for exactly the same reason the rescue slot
 * does: nothing is guessed, nothing is substituted, and the API names the
 * user's next action. Add the catalogue row (INTEGRATION.md section 5) or choose a
 * priced model, and the owner's default works as named.
 */
export const DURABILITY_WATCHER_UNSET_REASON =
  'The default watcher model "Qwen 3.8 27B" (' + DURABILITY_DEFAULT_WATCHER_REF + ") resolves on " +
  "OpenRouter but is missing from this build's pricing catalogue, so its calls would cost $0 on " +
  "paper and the project spend limit would never count them. It is not selected for you. Pick a " +
  "priced watcher model in Pipeline options \u25b8 Durability \u25b8 Watcher model.";

/**
 * The owner's named rescue default does NOT resolve. There is no
 * `openai/gpt-5.6-pro`; three live ids carry the "GPT-5.6 … Pro" name. Rather
 * than hardcode an id nobody verified, the default ships unset and fails closed
 * with the message below, which the API returns and the UI renders verbatim.
 */
export const DURABILITY_RESCUE_UNSET_REASON =
  'The default rescue model "GPT-5.6 Pro" matches three different OpenRouter models ' +
  "(GPT-5.6 Luna Pro, GPT-5.6 Terra Pro, GPT-5.6 Sol Pro), so it cannot be chosen for you. " +
  "Pick one in Pipeline options ▸ Durability ▸ Rescue model before escalation can run.";

const SKILL_FIRE_UNOBSERVABLE_REASON =
  "This build cannot observe skill failures. Skills are activated by reading their SKILL.md " +
  "rather than by a skill-invocation event, so no success or failure is recorded anywhere the " +
  "watcher can read. Enable this signal once the agent runtime reports skill invocations.";

/**
 * Verified by grep over `server/src`, `server/pi-packages` and `server/vendor`
 * on 2026-08-19: `run_paused` and `run_blocked` exist only as frozen literals
 * and reducer cases in `run-state.ts`; NOTHING appends them. The single
 * emitter of a stalled state is `prompt-opt-interview-contract.ts:144`, which
 * appends `run_waiting` when a prompt-optimization node awaits durable
 * structured answers. So one third of this signal's trigger set is reachable
 * and two thirds are not, and the API says so rather than shipping a
 * fully-enabled toggle over a condition that cannot occur.
 */
const STALL_PARTIAL_REASON =
  "Only a run waiting on a durable prompt-optimization answer can stall in this build. Paused " +
  "and blocked runs are never produced \u2014 no code appends run_paused or run_blocked \u2014 so two of " +
  "this signal's three trigger statuses cannot occur. It still fires on a waiting run that stops " +
  "advancing. Enable it once a pause or block can be recorded.";

const SCRIPT_RUN_PARTIAL_REASON =
  "Script failures are observed only for workflow nodes that run an external process. This build " +
  "has no CI integration, so failed CI runs cannot be observed. Connect a CI provider to widen " +
  "this signal.";

/**
 * The static signal catalogue. `observable` is a fact about this build, not a
 * preference: the UI renders a non-observable signal disabled with the reason
 * served here, and `PUT /durability/settings` refuses to enable it.
 */
export const DURABILITY_SIGNALS: readonly DurabilitySignalDescriptor[] = [
  {
    id: "compaction",
    label: "Compaction",
    observable: true,
    observability: "full",
    observationSource:
      "the vendored dag-fusion compaction audit, delivered by the existing compaction event sink",
    firesWhen: "a compaction occurred and one of its fingerprint checks failed",
    supportedActions: ["observe", "restart", "escalate", "lateral-pass", "stop"],
    thresholdLabel: "Failed checks before firing",
  },
  {
    id: "context-rot",
    label: "Context rot",
    observable: true,
    observability: "full",
    observationSource:
      "the watcher model's semantic verdict over the exact pre- and post-compaction record",
    firesWhen: "the semantic verdict is context-rot",
    supportedActions: ["observe", "restart", "escalate", "lateral-pass", "stop"],
    thresholdLabel: "Findings before firing",
  },
  {
    id: "hallucination",
    label: "Hallucination",
    observable: true,
    observability: "full",
    observationSource:
      "durable run events (evidence checks and gates reporting an unsupported output), plus " +
      "invented facts reported by the watcher model",
    firesWhen: "an evidence check or gate reports an unsupported output",
    supportedActions: ["observe", "restart", "escalate", "lateral-pass", "stop"],
    thresholdLabel: "Unsupported outputs before firing",
  },
  {
    id: "paused-no-progress",
    label: "Paused with no progress",
    observable: true,
    observability: "partial",
    unobservableReason: STALL_PARTIAL_REASON,
    observationSource: "durable run state: the run status and its last event sequence",
    firesWhen:
      "the run is waiting and its last event sequence has not moved for the configured stall " +
      "time. Paused and blocked runs would also fire, but this build never produces those two " +
      "statuses",
    supportedActions: ["observe", "restart", "escalate", "lateral-pass", "stop"],
    thresholdLabel: "Stalled observations before firing",
  },
  {
    id: "failed-script-run",
    label: "Failed scripts and CI runs",
    observable: true,
    observability: "partial",
    unobservableReason: SCRIPT_RUN_PARTIAL_REASON,
    observationSource:
      "durable run events: a failed node whose kind runs an external process",
    firesWhen: "such a node fails",
    supportedActions: ["observe", "restart", "escalate", "lateral-pass", "stop"],
    thresholdLabel: "Failures before firing",
  },
  {
    id: "failed-skill-fire",
    label: "Failed skill fires",
    observable: false,
    observability: "none",
    unobservableReason: SKILL_FIRE_UNOBSERVABLE_REASON,
    observationSource: "none in this build",
    firesWhen: "never in this build",
    supportedActions: ["observe"],
    thresholdLabel: "Failures before firing",
  },
];

const SIGNAL_BY_ID = new Map<DurabilitySignalId, DurabilitySignalDescriptor>(
  DURABILITY_SIGNALS.map((signal) => [signal.id, signal]),
);

export function durabilitySignalDescriptor(
  id: DurabilitySignalId,
): DurabilitySignalDescriptor {
  return SIGNAL_BY_ID.get(id)!;
}

export function defaultDurabilitySettings(): DurabilitySettingsV1 {
  return {
    version: DURABILITY_SETTINGS_VERSION,
    enabled: false,
    watcherModel: { kind: "unset", reason: DURABILITY_WATCHER_UNSET_REASON },
    rescueModel: { kind: "unset", reason: DURABILITY_RESCUE_UNSET_REASON },
    rescueEffort: "xhigh",
    minRescueContextWindow: 1_000_000,
    stallMs: 300_000,
    stopPolicy: { allowStop: true, maxStopsPerRun: 1 },
    signals: {
      "compaction": { enabled: true, action: "escalate", threshold: 1 },
      "context-rot": { enabled: true, action: "escalate", threshold: 1 },
      "hallucination": { enabled: false, action: "observe", threshold: 1 },
      "paused-no-progress": { enabled: false, action: "restart", threshold: 1 },
      "failed-script-run": { enabled: false, action: "observe", threshold: 1 },
      "failed-skill-fire": { enabled: false, action: "observe", threshold: 1 },
    },
  };
}

const MODEL_REF_PATTERN = /^[a-z0-9][a-z0-9._-]*\/.+$/;
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REF_LENGTH = 256;
const MAX_REASON_LENGTH = 2_048;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): never {
  throw new DurabilitySettingsError("INVALID_SETTINGS", message);
}

function parseEffort(value: unknown, field: string): DurabilityEffort {
  if (typeof value !== "string" || !DURABILITY_EFFORTS.includes(value as DurabilityEffort)) {
    invalid(`${field} must be one of ${DURABILITY_EFFORTS.join(", ")}.`);
  }
  return value as DurabilityEffort;
}

function parseModelSelection(value: unknown, field: string): DurabilityModelSelection {
  if (!plainRecord(value)) invalid(`${field} must be a model selection object.`);
  const kind = value.kind;
  if (kind === "direct") {
    const ref = typeof value.ref === "string" ? value.ref.trim() : "";
    if (!ref || ref.length > MAX_REF_LENGTH || !MODEL_REF_PATTERN.test(ref)) {
      invalid(
        `${field}.ref must be a provider-qualified model reference such as ` +
          "openrouter/qwen/qwen3.8-27b.",
      );
    }
    return {
      kind: "direct",
      ref,
      ...(value.effort === undefined ? {} : { effort: parseEffort(value.effort, `${field}.effort`) }),
    };
  }
  if (kind === "preset") {
    const presetId = typeof value.presetId === "string" ? value.presetId.trim() : "";
    if (!presetId || !PRESET_ID_PATTERN.test(presetId)) {
      invalid(`${field}.presetId must be a model preset id.`);
    }
    return {
      kind: "preset",
      presetId,
      ...(value.effort === undefined ? {} : { effort: parseEffort(value.effort, `${field}.effort`) }),
    };
  }
  if (kind === "unset") {
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (!reason || reason.length > MAX_REASON_LENGTH) {
      invalid(`${field}.reason must explain why no model is selected.`);
    }
    return { kind: "unset", reason };
  }
  invalid(`${field}.kind must be "preset", "direct", or "unset".`);
}

function parseSignalSetting(
  value: unknown,
  descriptor: DurabilitySignalDescriptor,
): DurabilitySignalSetting {
  if (!plainRecord(value)) invalid(`signals.${descriptor.id} must be an object.`);
  if (typeof value.enabled !== "boolean") {
    invalid(`signals.${descriptor.id}.enabled must be true or false.`);
  }
  if (
    typeof value.action !== "string" ||
    !DURABILITY_ACTIONS.includes(value.action as DurabilityAction)
  ) {
    invalid(`signals.${descriptor.id}.action must be one of ${DURABILITY_ACTIONS.join(", ")}.`);
  }
  const action = value.action as DurabilityAction;
  if (!descriptor.supportedActions.includes(action)) {
    invalid(
      `signals.${descriptor.id} cannot use the ${action} action. Choose one of ` +
        `${descriptor.supportedActions.join(", ")}.`,
    );
  }
  if (
    !Number.isSafeInteger(value.threshold) ||
    (value.threshold as number) < 1 ||
    (value.threshold as number) > 1_000
  ) {
    invalid(`signals.${descriptor.id}.threshold must be an integer from 1 through 1000.`);
  }
  if (value.enabled && descriptor.observability === "none") {
    throw new DurabilitySettingsError(
      "SIGNAL_NOT_OBSERVABLE",
      descriptor.unobservableReason ??
        `The ${descriptor.label} signal cannot be observed in this build.`,
    );
  }
  return { enabled: value.enabled, action, threshold: value.threshold as number };
}

/**
 * Merge a caller patch over stored settings and validate the result. Missing
 * fields keep their stored value, so a UI can send one changed toggle.
 */
export function parseDurabilitySettings(
  patch: unknown,
  base: DurabilitySettingsV1 = defaultDurabilitySettings(),
): DurabilitySettingsV1 {
  if (!plainRecord(patch)) invalid("Durability settings must be a JSON object.");
  const allowed = [
    "version",
    "enabled",
    "watcherModel",
    "rescueModel",
    "rescueEffort",
    "minRescueContextWindow",
    "stallMs",
    "stopPolicy",
    "signals",
  ];
  const unknownKey = Object.keys(patch).find((key) => !allowed.includes(key));
  if (unknownKey) invalid(`Durability settings do not accept the field "${unknownKey}".`);
  if (patch.version !== undefined && patch.version !== DURABILITY_SETTINGS_VERSION) {
    invalid(`Durability settings version must be ${DURABILITY_SETTINGS_VERSION}.`);
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    invalid("enabled must be true or false.");
  }
  if (
    patch.minRescueContextWindow !== undefined && (
      !Number.isSafeInteger(patch.minRescueContextWindow) ||
      (patch.minRescueContextWindow as number) < 1_024 ||
      (patch.minRescueContextWindow as number) > 100_000_000
    )
  ) {
    invalid("minRescueContextWindow must be an integer from 1024 through 100000000.");
  }
  if (
    patch.stallMs !== undefined && (
      !Number.isSafeInteger(patch.stallMs) ||
      (patch.stallMs as number) < 1_000 ||
      (patch.stallMs as number) > 24 * 60 * 60_000
    )
  ) {
    invalid("stallMs must be an integer from 1000 through 86400000 milliseconds.");
  }

  let stopPolicy = base.stopPolicy;
  if (patch.stopPolicy !== undefined) {
    const value = patch.stopPolicy;
    if (
      !plainRecord(value) || typeof value.allowStop !== "boolean" ||
      !Number.isSafeInteger(value.maxStopsPerRun) ||
      (value.maxStopsPerRun as number) < 0 || (value.maxStopsPerRun as number) > 100
    ) {
      invalid("stopPolicy requires allowStop and an integer maxStopsPerRun from 0 through 100.");
    }
    stopPolicy = { allowStop: value.allowStop, maxStopsPerRun: value.maxStopsPerRun as number };
  }

  const signals = { ...base.signals };
  if (patch.signals !== undefined) {
    if (!plainRecord(patch.signals)) invalid("signals must be an object.");
    for (const key of Object.keys(patch.signals)) {
      if (!DURABILITY_SIGNAL_IDS.includes(key as DurabilitySignalId)) {
        invalid(`"${key}" is not a durability signal.`);
      }
    }
    for (const id of DURABILITY_SIGNAL_IDS) {
      const provided = (patch.signals as Record<string, unknown>)[id];
      if (provided === undefined) continue;
      // A non-object here used to merge as {} and return 200 with nothing
      // changed, which reads to the caller as "saved". Name the field instead.
      if (!plainRecord(provided)) {
        invalid(`signals.${id} must be an object with enabled, action, and threshold.`);
      }
      signals[id] = parseSignalSetting(
        { ...signals[id], ...provided },
        durabilitySignalDescriptor(id),
      );
    }
  }

  return {
    version: DURABILITY_SETTINGS_VERSION,
    enabled: patch.enabled === undefined ? base.enabled : (patch.enabled as boolean),
    watcherModel: patch.watcherModel === undefined
      ? base.watcherModel
      : parseModelSelection(patch.watcherModel, "watcherModel"),
    rescueModel: patch.rescueModel === undefined
      ? base.rescueModel
      : parseModelSelection(patch.rescueModel, "rescueModel"),
    rescueEffort: patch.rescueEffort === undefined
      ? base.rescueEffort
      : parseEffort(patch.rescueEffort, "rescueEffort"),
    minRescueContextWindow: patch.minRescueContextWindow === undefined
      ? base.minRescueContextWindow
      : (patch.minRescueContextWindow as number),
    stallMs: patch.stallMs === undefined ? base.stallMs : (patch.stallMs as number),
    stopPolicy,
    signals,
  };
}

function settingsFile(projectId: string): string {
  return path.join(resolvePaths(projectId).workflowsDir, "durability", "settings.json");
}

export interface DurabilitySettingsStore {
  read(projectId: string): DurabilitySettingsV1;
  write(projectId: string, settings: DurabilitySettingsV1): DurabilitySettingsV1;
}

/**
 * Settings live beside the project's workflow state, not in the run schema. A
 * corrupt or older file degrades to the defaults rather than taking a request
 * down (#62): the durability panel must never be the reason the app breaks.
 */
export class FileDurabilitySettingsStore implements DurabilitySettingsStore {
  read(projectId: string): DurabilitySettingsV1 {
    const file = settingsFile(projectId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return defaultDurabilitySettings();
    }
    try {
      return parseDurabilitySettings(JSON.parse(raw), defaultDurabilitySettings());
    } catch {
      return defaultDurabilitySettings();
    }
  }

  write(projectId: string, settings: DurabilitySettingsV1): DurabilitySettingsV1 {
    const file = settingsFile(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return settings;
  }
}

/** Test double: same contract, no filesystem. */
export class MemoryDurabilitySettingsStore implements DurabilitySettingsStore {
  readonly #settings = new Map<string, DurabilitySettingsV1>();

  read(projectId: string): DurabilitySettingsV1 {
    return this.#settings.get(projectId) ?? defaultDurabilitySettings();
  }

  write(projectId: string, settings: DurabilitySettingsV1): DurabilitySettingsV1 {
    this.#settings.set(projectId, settings);
    return settings;
  }
}
