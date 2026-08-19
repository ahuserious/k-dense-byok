"use client";

/**
 * Integration registry API client (matrix rows 48, 49, 50).
 *
 * Mirrors the wire shape published in wave-f/interfaces/F12-*.md. Every reader
 * here validates before returning, so a malformed-but-200 backend response
 * degrades to an error state instead of throwing in a component's render phase
 * (#62). Nothing in this module handles a credential value — only names.
 */

import { apiFetch } from "@/lib/projects";

export type IntegrationId = "infranodus" | "huggingface" | "modal";

export interface IntegrationEnvVarStatus {
  /** The variable NAME. Values never cross this boundary. */
  name: string;
  purpose: string;
  present: boolean;
}

export interface IntegrationMcpStatus {
  serverName: string;
  toolPrefix: string;
  registered: boolean;
  /**
   * The connector is in the project's disabled store. Distinct from
   * `registered: false`, which means it was never connected — offering a live
   * Connect for a disabled connector writes its name into both stores.
   */
  disabled: boolean;
  enabled: boolean;
  toolDiscovery: "on-connect";
}

export interface IntegrationCliStatus {
  binary: string;
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface IntegrationStatus {
  id: IntegrationId;
  displayName: string;
  summary: string;
  kind: "mcp" | "http" | "compute";
  configured: boolean;
  missingEnvVars: string[];
  envVars: IntegrationEnvVarStatus[];
  reaches: string;
  notConfiguredReason: string | null;
  mcp?: IntegrationMcpStatus;
  cli?: IntegrationCliStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseEnvVars(value: unknown): IntegrationEnvVarStatus[] {
  if (!Array.isArray(value)) return [];
  const parsed: IntegrationEnvVarStatus[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    parsed.push({
      name: entry.name,
      purpose: typeof entry.purpose === "string" ? entry.purpose : "",
      present: entry.present === true,
    });
  }
  return parsed;
}

function parseMcp(value: unknown): IntegrationMcpStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.serverName !== "string" || typeof value.toolPrefix !== "string") return undefined;
  return {
    serverName: value.serverName,
    toolPrefix: value.toolPrefix,
    registered: value.registered === true,
    disabled: value.disabled === true,
    enabled: value.enabled === true,
    toolDiscovery: "on-connect",
  };
}

function parseCli(value: unknown): IntegrationCliStatus | undefined {
  if (!isRecord(value) || typeof value.binary !== "string") return undefined;
  return {
    binary: value.binary,
    found: value.found === true,
    path: typeof value.path === "string" ? value.path : null,
    version: typeof value.version === "string" ? value.version : null,
  };
}

const KNOWN_IDS: readonly IntegrationId[] = ["infranodus", "huggingface", "modal"];
const KNOWN_KINDS: readonly IntegrationStatus["kind"][] = ["mcp", "http", "compute"];

/** Returns null for a row the panel cannot render honestly, rather than a half-row. */
function parseIntegration(value: unknown): IntegrationStatus | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== "string" || !KNOWN_IDS.includes(id as IntegrationId)) return null;
  const kind = KNOWN_KINDS.includes(value.kind as IntegrationStatus["kind"])
    ? (value.kind as IntegrationStatus["kind"])
    : "http";
  return {
    id: id as IntegrationId,
    displayName: typeof value.displayName === "string" ? value.displayName : id,
    summary: typeof value.summary === "string" ? value.summary : "",
    kind,
    configured: value.configured === true,
    missingEnvVars: asStringArray(value.missingEnvVars),
    envVars: parseEnvVars(value.envVars),
    reaches: typeof value.reaches === "string" ? value.reaches : "",
    notConfiguredReason:
      typeof value.notConfiguredReason === "string" ? value.notConfiguredReason : null,
    mcp: parseMcp(value.mcp),
    cli: parseCli(value.cli),
  };
}

export async function getIntegrations(): Promise<IntegrationStatus[]> {
  const res = await apiFetch("/integrations");
  if (!res.ok) throw new Error(`getIntegrations ${res.status}`);
  const data: unknown = await res.json();
  if (!isRecord(data) || !Array.isArray(data.integrations)) {
    throw new Error("The integrations response was not in the expected shape.");
  }
  return data.integrations
    .map(parseIntegration)
    .filter((entry): entry is IntegrationStatus => entry !== null);
}

export interface RegisterIntegrationResult {
  ok: boolean;
  serverName?: string;
  toolPrefix?: string;
  detail?: string;
  /** The variable NAME to set, when the failure was "not configured". */
  envVar?: string;
}

export async function registerIntegration(id: IntegrationId): Promise<RegisterIntegrationResult> {
  const res = await apiFetch(`/integrations/${encodeURIComponent(id)}/register`, {
    method: "POST",
  });
  const data: unknown = await res.json().catch(() => null);
  const record = isRecord(data) ? data : {};
  if (!res.ok) {
    return {
      ok: false,
      detail: typeof record.detail === "string" ? record.detail : `Register failed (${res.status})`,
      envVar: typeof record.envVar === "string" ? record.envVar : undefined,
    };
  }
  return {
    ok: true,
    serverName: typeof record.serverName === "string" ? record.serverName : undefined,
    toolPrefix: typeof record.toolPrefix === "string" ? record.toolPrefix : undefined,
  };
}

/**
 * The Modal CLI's local state: whether the program is installed, and which
 * workspace the configured tokens belong to.
 *
 * Served by GET /integrations/modal/cli rather than by GET /integrations,
 * because reading either one spawns a process. `profile.ok === false` always
 * carries a `detail` the panel renders as the reason the workspace is
 * unavailable — an unconfigured install gets the Modal manager's own message.
 */
export interface ModalCliProfile {
  ok: boolean;
  code: "NOT_CONFIGURED" | "CLI_NOT_FOUND" | "CLI_FAILED" | null;
  detail: string | null;
  stdout: string | null;
}

export interface ModalCliState {
  cli: IntegrationCliStatus | null;
  profile: ModalCliProfile;
}

function parseModalProfile(value: unknown): ModalCliProfile {
  if (!isRecord(value)) {
    return { ok: false, code: null, detail: null, stdout: null };
  }
  const code = value.code;
  return {
    ok: value.ok === true,
    code:
      code === "NOT_CONFIGURED" || code === "CLI_NOT_FOUND" || code === "CLI_FAILED"
        ? code
        : null,
    detail: typeof value.detail === "string" ? value.detail : null,
    stdout: typeof value.stdout === "string" ? value.stdout : null,
  };
}

/**
 * Reads the Modal CLI state. Throws only when the backend is unreachable or
 * answers non-200; a malformed-but-200 body degrades to "unavailable" rather
 * than throwing in a component's render phase (#62).
 */
export async function getModalCliState(): Promise<ModalCliState> {
  const res = await apiFetch("/integrations/modal/cli");
  if (!res.ok) throw new Error(`getModalCliState ${res.status}`);
  const data: unknown = await res.json();
  const record = isRecord(data) ? data : {};
  return {
    cli: parseCli(record.cli) ?? null,
    profile: parseModalProfile(record.profile),
  };
}

export interface HuggingFaceModelSummary {
  id: string;
  pipelineTag: string | null;
  libraryName: string | null;
  gated: "manual" | "auto" | false;
  downloads: number | null;
  likes: number | null;
}

export type HuggingFaceSearchResult =
  | { ok: true; models: HuggingFaceModelSummary[] }
  | { ok: false; detail: string; envVar?: string };

function parseModel(value: unknown): HuggingFaceModelSummary | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    pipelineTag: typeof value.pipelineTag === "string" ? value.pipelineTag : null,
    libraryName: typeof value.libraryName === "string" ? value.libraryName : null,
    gated: value.gated === "manual" || value.gated === "auto" ? value.gated : false,
    downloads: typeof value.downloads === "number" ? value.downloads : null,
    likes: typeof value.likes === "number" ? value.likes : null,
  };
}

/**
 * The query matrix row 6 (the Modal preset's model chooser) calls. When the
 * result carries `envVar`, the caller must render its control DISABLED with that
 * variable named as the reason — not fall back to an unvalidated free-text id.
 */
export async function searchHuggingFaceModels(
  search: string,
  limit?: number,
): Promise<HuggingFaceSearchResult> {
  const params = new URLSearchParams({ search });
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await apiFetch(`/integrations/huggingface/models?${params.toString()}`);
  const data: unknown = await res.json().catch(() => null);
  const record = isRecord(data) ? data : {};
  if (!res.ok) {
    return {
      ok: false,
      detail:
        typeof record.detail === "string" ? record.detail : `Model search failed (${res.status})`,
      envVar: typeof record.envVar === "string" ? record.envVar : undefined,
    };
  }
  if (!Array.isArray(record.models)) {
    return { ok: false, detail: "The model search response was not in the expected shape." };
  }
  return {
    ok: true,
    models: record.models
      .map(parseModel)
      .filter((model): model is HuggingFaceModelSummary => model !== null),
  };
}
