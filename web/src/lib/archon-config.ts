// danbot-byok — web/src/lib/archon-config.ts
//
// Thin client for Archon's own config + auth REST API, used by the Settings → Pipelines tab.
// Unlike lib/pipelines.ts (which goes through the Kady backend's /pipelines proxy), these
// settings have no Kady proxy seam, so we call Archon directly at the same base the embedded
// iframe panels use (NEXT_PUBLIC_ARCHON_URL, default http://localhost:3091).
//
// The assistant/model/effort settings live in Archon's config.yaml and are reachable via
// GET /api/config + PATCH /api/config/assistants WITHOUT a TOKEN_ENCRYPTION_KEY — so they work
// in a solo setup. Per-vendor provider keys (GET /api/auth/providers) are gated on that env on
// the Archon server; when it's absent the endpoint returns enabled:false and we surface a
// read-only note instead of key-management UI.

const ARCHON_URL = process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

/** Reasoning-effort levels Archon accepts for modelReasoningEffort. */
export const ARCHON_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ArchonEffort = (typeof ARCHON_EFFORTS)[number];

/** Per-provider model defaults stored under assistants.<provider> in config.yaml. */
export interface ArchonAssistantDefaults {
  model?: string;
  modelReasoningEffort?: ArchonEffort;
  webSearchMode?: string;
}

/** Shape of the slice of GET /api/config we read for the Pipelines tab. */
export interface ArchonConfig {
  /** Registered provider id used by default: claude | codex | pi. */
  assistant?: string;
  assistants?: Record<string, ArchonAssistantDefaults>;
}

/** Body accepted by PATCH /api/config/assistants. */
export interface ArchonAssistantsUpdate {
  assistant: string;
  assistants: Record<string, ArchonAssistantDefaults>;
}

/** One entry from GET /api/providers. */
export interface ArchonProvider {
  id: string;
  displayName: string;
  builtIn?: boolean;
}

/** Subset of GET /api/auth/providers we need to decide whether to show key management. */
export interface ArchonAuthProviders {
  /** false when the Archon server has no TOKEN_ENCRYPTION_KEY — key mgmt is unavailable. */
  enabled: boolean;
  /** Connected vendors (presence only; keys are never echoed). */
  connections?: { provider: string; label?: string }[];
  /** Connectable vendor catalog. */
  available?: { provider: string; displayName?: string }[];
}

async function archonFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ARCHON_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

/** Load the assistant/model/effort slice of Archon's config. */
export async function getArchonConfig(): Promise<ArchonConfig> {
  const res = await archonFetch("/api/config");
  if (!res.ok) throw new Error(`Archon /api/config failed (${res.status})`);
  const data = (await res.json()) as { config?: ArchonConfig };
  return data.config ?? {};
}

/** Persist default assistant + per-provider model defaults. */
export async function updateArchonAssistants(
  update: ArchonAssistantsUpdate,
): Promise<void> {
  const res = await archonFetch("/api/config/assistants", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Archon save failed (${res.status})`);
  }
}

/** List the assistant providers Archon has registered (claude/codex/pi + any others). */
export async function getArchonProviders(): Promise<ArchonProvider[]> {
  const res = await archonFetch("/api/providers");
  if (!res.ok) return [];
  const data = (await res.json()) as { providers?: ArchonProvider[] } | ArchonProvider[];
  return Array.isArray(data) ? data : (data.providers ?? []);
}

/** Report whether per-vendor key management is available, and what's connected. */
export async function getArchonAuthProviders(): Promise<ArchonAuthProviders> {
  const res = await archonFetch("/api/auth/providers");
  if (!res.ok) return { enabled: false };
  return (await res.json()) as ArchonAuthProviders;
}
