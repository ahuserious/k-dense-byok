// danbot-byok — web/src/lib/engine-config.ts
//
// Thin client for Pipeline engine's own config + auth REST API, used by the Settings → Pipelines tab.
// Unlike lib/pipelines.ts (which goes through the Kady backend's /pipelines proxy), these
// settings have no Kady proxy seam, so we call Pipeline engine directly at the same base the embedded
// iframe panels use (NEXT_PUBLIC_PIPELINE_ENGINE_URL, default http://localhost:3091).
//
// The assistant/model/effort settings live in Pipeline engine's config.yaml and are reachable via
// GET /api/config + PATCH /api/config/assistants WITHOUT a TOKEN_ENCRYPTION_KEY — so they work
// in a solo setup. Per-vendor provider keys (GET /api/auth/providers) are gated on that env on
// the Pipeline engine server; when it's absent the endpoint returns enabled:false and we surface a
// read-only note instead of key-management UI.

import { PIPELINE_ENGINE_URL } from "./embed-config";

/** Reasoning-effort levels Pipeline engine accepts for modelReasoningEffort. */
export const PIPELINE_ENGINE_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type PipelineEngineEffort = (typeof PIPELINE_ENGINE_EFFORTS)[number];

/** Per-provider model defaults stored under assistants.<provider> in config.yaml. */
export interface PipelineEngineAssistantDefaults {
  model?: string;
  modelReasoningEffort?: PipelineEngineEffort;
  webSearchMode?: string;
}

/** Shape of the slice of GET /api/config we read for the Pipelines tab. */
export interface PipelineEngineConfig {
  /** Registered provider id used by default: claude | codex | pi. */
  assistant?: string;
  assistants?: Record<string, PipelineEngineAssistantDefaults>;
}

/** Body accepted by PATCH /api/config/assistants. */
export interface PipelineEngineAssistantsUpdate {
  assistant: string;
  assistants: Record<string, PipelineEngineAssistantDefaults>;
}

/** One entry from GET /api/providers. */
export interface PipelineEngineProvider {
  id: string;
  displayName: string;
  builtIn?: boolean;
}

/** Subset of GET /api/auth/providers we need to decide whether to show key management. */
export interface PipelineEngineAuthProviders {
  /** false when the Pipeline engine server has no TOKEN_ENCRYPTION_KEY — key mgmt is unavailable. */
  enabled: boolean;
  /** Connected vendors (presence only; keys are never echoed). */
  connections?: { provider: string; label?: string }[];
  /** Connectable vendor catalog. */
  available?: { provider: string; displayName?: string }[];
}

async function pipelineEngineFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PIPELINE_ENGINE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

/** Load the assistant/model/effort slice of Pipeline engine's config. */
export async function getPipelineEngineConfig(): Promise<PipelineEngineConfig> {
  const res = await pipelineEngineFetch("/api/config");
  if (!res.ok) throw new Error(`Pipeline engine /api/config failed (${res.status})`);
  const data = (await res.json()) as { config?: PipelineEngineConfig };
  return data.config ?? {};
}

/** Persist default assistant + per-provider model defaults. */
export async function updatePipelineEngineAssistants(
  update: PipelineEngineAssistantsUpdate,
): Promise<void> {
  const res = await pipelineEngineFetch("/api/config/assistants", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Pipeline engine save failed (${res.status})`);
  }
}

/** List the assistant providers Pipeline engine has registered (claude/codex/pi + any others). */
export async function getPipelineEngineProviders(): Promise<PipelineEngineProvider[]> {
  const res = await pipelineEngineFetch("/api/providers");
  if (!res.ok) return [];
  const data = (await res.json()) as { providers?: PipelineEngineProvider[] } | PipelineEngineProvider[];
  return Array.isArray(data) ? data : (data.providers ?? []);
}

/** Report whether per-vendor key management is available, and what's connected. */
export async function getPipelineEngineAuthProviders(): Promise<PipelineEngineAuthProviders> {
  const res = await pipelineEngineFetch("/api/auth/providers");
  if (!res.ok) return { enabled: false };
  return (await res.json()) as PipelineEngineAuthProviders;
}
