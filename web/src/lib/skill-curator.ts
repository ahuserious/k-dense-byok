"use client";

import { apiFetch } from "@/lib/projects";

export type CuratorSkillMode = "auto" | "auto-manual" | "manual";
export type CuratorMimeographMode = "auto" | "manual";
export type AutoresearchMonitorMode = "interactive" | "autonomous";

export interface SkillCuratorCapabilities {
  promptElevation: {
    available: boolean;
    interfaceDocument: string;
    endpoint: string;
    engine: string;
    reason: string | null;
  };
  harness: {
    available: boolean;
    endpoint: string;
    reason: string | null;
  };
  runStateCritiques: {
    readsLiveRunState: boolean;
    persistedToRunState: boolean;
    reason: string;
  };
  durability: {
    available: boolean;
    settingsEndpoint: string;
    signalsEndpoint: string;
    ownsStore: boolean;
    reason: string | null;
  };
  modelPresets: {
    available: boolean;
    endpoint: string;
  };
}

export interface CuratorSkill {
  ref: string;
  description: string;
  scope: "project" | "global";
  featured: boolean;
}

export interface CuratorPersonality {
  ref: string;
  title: string;
}

export interface CuratorNode {
  id: string;
  name: string;
  kind: string;
  skillsMode: CuratorSkillMode;
  skillRefs: string[];
  mimeographsMode: CuratorMimeographMode;
  personalityRefs: string[];
}

export interface SkillCuratorSnapshot {
  definition: {
    id: string;
    revision: number;
    graphSha256: string;
  };
  skills: CuratorSkill[];
  personalities: {
    available: boolean;
    storeRef: string | null;
    personalities: CuratorPersonality[];
    reason: string | null;
  };
  nodes: CuratorNode[];
}

export interface ApplySkillCurationInput {
  expectedRevision: number;
  nodeIds: string[];
  skillRefs: string[];
  skillsMode: CuratorSkillMode;
  writeMode?: "merge" | "replace";
  mimeographs?: {
    mode: CuratorMimeographMode;
    personalityRefs: string[];
  };
}

export interface AutoresearchCritique {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  source:
    | { kind: "run-state"; lastSeq: number }
    | { kind: "run-event"; seq: number; eventId: string; eventType: string };
}

export interface AutoresearchEvaluation {
  runId: string;
  mode: AutoresearchMonitorMode;
  cycle: number;
  maxEvaluations: number;
  remainingEvaluations: number;
  state: {
    status: string;
    lastSeq: number;
    recoverable: boolean;
    terminal: boolean;
    canStopRun: boolean;
  };
  critiques: AutoresearchCritique[];
  nextAfterSeq: number;
  needsUserInput: boolean;
  question: string | null;
  persistedToRunState: false;
  runStatePersistenceReason: string;
}

export type DurabilityEffort = "low" | "medium" | "high" | "xhigh";
export type DurabilitySignalId =
  | "compaction"
  | "context-rot"
  | "hallucination"
  | "paused-no-progress"
  | "failed-script-run"
  | "failed-skill-fire";
export type DurabilityAction = "observe" | "restart" | "escalate" | "lateral-pass" | "stop";

export type DurabilityModelSelection =
  | { kind: "preset"; presetId: string; effort?: DurabilityEffort }
  | { kind: "direct"; ref: string; effort?: DurabilityEffort }
  | { kind: "unset"; reason: string };

export interface DurabilitySettingsV1 {
  version: 1;
  enabled: boolean;
  watcherModel: DurabilityModelSelection;
  rescueModel: DurabilityModelSelection;
  rescueEffort: DurabilityEffort;
  minRescueContextWindow: number;
  stallMs: number;
  stopPolicy: { allowStop: boolean; maxStopsPerRun: number };
  signals: Record<
    DurabilitySignalId,
    { enabled: boolean; action: DurabilityAction; threshold: number }
  >;
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

export interface DurabilityAdapterState {
  available: boolean;
  settings: DurabilitySettingsV1 | null;
  signals: DurabilitySignalDescriptor[];
  resolution: unknown;
  reason: string | null;
}

export interface ModelPresetOption {
  id: string;
  name: string;
}

export interface ModelPresetAdapterState {
  available: boolean;
  presets: ModelPresetOption[];
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseFailure(response: Response, label: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as
    | { detail?: unknown; code?: unknown }
    | null;
  const detail =
    typeof body?.detail === "string" ? body.detail : `${label} returned ${response.status}.`;
  return new Error(detail);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCuratorNode(value: unknown): value is CuratorNode {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    ["auto", "auto-manual", "manual"].includes(String(value.skillsMode)) &&
    isStringArray(value.skillRefs) &&
    ["auto", "manual"].includes(String(value.mimeographsMode)) &&
    isStringArray(value.personalityRefs)
  );
}

export async function getSkillCuratorCapabilities(
  projectId?: string,
): Promise<SkillCuratorCapabilities> {
  const response = await apiFetch("/skills/curator/capabilities", {}, projectId);
  if (!response.ok) throw await responseFailure(response, "Skill curator capabilities");
  const body = await response.json() as unknown;
  if (
    !isRecord(body) ||
    !isRecord(body.promptElevation) ||
    typeof body.promptElevation.available !== "boolean" ||
    typeof body.promptElevation.interfaceDocument !== "string" ||
    typeof body.promptElevation.endpoint !== "string" ||
    typeof body.promptElevation.engine !== "string" ||
    !isRecord(body.harness) ||
    typeof body.harness.available !== "boolean" ||
    typeof body.harness.endpoint !== "string" ||
    !isRecord(body.runStateCritiques) ||
    typeof body.runStateCritiques.readsLiveRunState !== "boolean" ||
    typeof body.runStateCritiques.persistedToRunState !== "boolean" ||
    typeof body.runStateCritiques.reason !== "string" ||
    !isRecord(body.durability) ||
    typeof body.durability.available !== "boolean" ||
    !isRecord(body.modelPresets) ||
    typeof body.modelPresets.available !== "boolean"
  ) {
    throw new Error("Skill curator capabilities returned malformed data.");
  }
  return body as unknown as SkillCuratorCapabilities;
}

export async function getSkillCuratorSnapshot(
  workflowId: string,
  projectId?: string,
): Promise<SkillCuratorSnapshot> {
  const response = await apiFetch(
    `/skills/curator/workflows/${encodeURIComponent(workflowId)}`,
    {},
    projectId,
  );
  if (!response.ok) throw await responseFailure(response, "Skill curator");
  const body = await response.json() as unknown;
  if (
    !isRecord(body) ||
    !isRecord(body.definition) ||
    typeof body.definition.id !== "string" ||
    !Number.isSafeInteger(body.definition.revision) ||
    typeof body.definition.graphSha256 !== "string" ||
    !Array.isArray(body.skills) ||
    !body.skills.every((skill) =>
      isRecord(skill) &&
      typeof skill.ref === "string" &&
      typeof skill.description === "string" &&
      (skill.scope === "project" || skill.scope === "global") &&
      typeof skill.featured === "boolean"
    ) ||
    !isRecord(body.personalities) ||
    typeof body.personalities.available !== "boolean" ||
    !Array.isArray(body.personalities.personalities) ||
    !Array.isArray(body.nodes) ||
    !body.nodes.every(isCuratorNode)
  ) {
    throw new Error("Skill curator returned malformed data.");
  }
  return body as unknown as SkillCuratorSnapshot;
}

export async function applySkillCuration(
  workflowId: string,
  input: ApplySkillCurationInput,
  projectId?: string,
): Promise<{ definition: { revision: number; graphSha256: string } }> {
  const response = await apiFetch(
    `/skills/curator/workflows/${encodeURIComponent(workflowId)}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    projectId,
  );
  if (!response.ok) throw await responseFailure(response, "Apply skill curation");
  const body = await response.json() as unknown;
  if (
    !isRecord(body) ||
    !isRecord(body.definition) ||
    !Number.isSafeInteger(body.definition.revision) ||
    typeof body.definition.graphSha256 !== "string"
  ) {
    throw new Error("Apply skill curation returned malformed data.");
  }
  return body as { definition: { revision: number; graphSha256: string } };
}

export async function evaluateAutoresearchRun(
  runId: string,
  input: {
    mode: AutoresearchMonitorMode;
    cycle: number;
    maxEvaluations: number;
    afterSeq?: number;
    userInput?: string;
  },
  projectId?: string,
): Promise<AutoresearchEvaluation> {
  const response = await apiFetch(
    `/skills/curator/autoresearch/runs/${encodeURIComponent(runId)}/evaluate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    projectId,
  );
  if (!response.ok) throw await responseFailure(response, "Autoresearch evaluation");
  const body = await response.json() as unknown;
  if (
    !isRecord(body) ||
    typeof body.runId !== "string" ||
    !Number.isSafeInteger(body.cycle) ||
    !Number.isSafeInteger(body.maxEvaluations) ||
    !isRecord(body.state) ||
    typeof body.state.status !== "string" ||
    !Number.isSafeInteger(body.state.lastSeq) ||
    !Array.isArray(body.critiques) ||
    typeof body.persistedToRunState !== "boolean" ||
    body.persistedToRunState !== false ||
    typeof body.runStatePersistenceReason !== "string"
  ) {
    throw new Error("Autoresearch evaluation returned malformed data.");
  }
  return body as unknown as AutoresearchEvaluation;
}

export async function getDurabilityAdapterState(
  projectId?: string,
): Promise<DurabilityAdapterState> {
  const settingsResponse = await apiFetch("/durability/settings", {}, projectId);
  if (settingsResponse.status === 404) {
    return {
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: "Durability settings endpoint not available on this build.",
    };
  }
  if (!settingsResponse.ok) {
    return {
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: (await responseFailure(settingsResponse, "Durability settings")).message,
    };
  }
  const settingsBody = await settingsResponse.json() as unknown;
  if (
    !isRecord(settingsBody) ||
    !isRecord(settingsBody.settings) ||
    settingsBody.settings.version !== 1
  ) {
    return {
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: "Durability settings returned malformed data.",
    };
  }

  const signalsResponse = await apiFetch("/durability/signals", {}, projectId);
  if (!signalsResponse.ok) {
    return {
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: (await responseFailure(signalsResponse, "Durability signals")).message,
    };
  }
  const signalsBody = await signalsResponse.json() as unknown;
  if (
    !isRecord(signalsBody) ||
    !Array.isArray(signalsBody.signals)
  ) {
    return {
      available: false,
      settings: null,
      signals: [],
      resolution: null,
      reason: "Durability signals returned malformed data.",
    };
  }
  return {
    available: true,
    settings: settingsBody.settings as unknown as DurabilitySettingsV1,
    signals: signalsBody.signals as DurabilitySignalDescriptor[],
    resolution: settingsBody.resolution,
    reason: null,
  };
}

export async function saveDurabilitySettings(
  settings: Partial<DurabilitySettingsV1>,
  projectId?: string,
): Promise<DurabilityAdapterState> {
  const response = await apiFetch(
    "/durability/settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    },
    projectId,
  );
  if (!response.ok) throw await responseFailure(response, "Save durability settings");
  return getDurabilityAdapterState(projectId);
}

export async function getModelPresetAdapterState(
  projectId?: string,
): Promise<ModelPresetAdapterState> {
  const response = await apiFetch("/model-presets", {}, projectId);
  if (response.status === 404) {
    return {
      available: false,
      presets: [],
      reason: "Model presets are not available on this build.",
    };
  }
  if (!response.ok) {
    return {
      available: false,
      presets: [],
      reason: (await responseFailure(response, "Model presets")).message,
    };
  }
  const body = await response.json() as unknown;
  if (
    !isRecord(body) ||
    !Array.isArray(body.presets) ||
    !body.presets.every((preset) =>
      isRecord(preset) &&
      typeof preset.id === "string" &&
      typeof preset.name === "string"
    )
  ) {
    return {
      available: false,
      presets: [],
      reason: "Model presets returned malformed data.",
    };
  }
  return {
    available: true,
    presets: body.presets.map((preset) => ({
      id: String((preset as Record<string, unknown>).id),
      name: String((preset as Record<string, unknown>).name),
    })),
    reason: null,
  };
}
