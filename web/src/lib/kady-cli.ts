"use client";

/**
 * Client for the harness registry published in
 * `W/interfaces/F2-harness-and-nodecontrol.md` (lane F2, STATUS: DRAFT).
 *
 * Built strictly to that document, not to a guess about it:
 *
 *  - `GET /harnesses` returns all eight harnesses, always, in contract order.
 *  - `label` is rendered; `id` never is.
 *  - `availability === "ready"` is the WHOLE selectability rule. Not derived
 *    from `hasAdapter`, not from `resolvedExecutable`.
 *  - A non-`ready` harness is rendered disabled with its `detail` visible —
 *    never hidden, never live.
 *  - `systemPromptMaxBytes` is read from the response, never hardcoded.
 *  - Every mutation returns the FULL list; state is replaced from that response
 *    rather than from a follow-up GET, so a concurrent change cannot be lost.
 *  - `400 unresolvable-path` means nothing was persisted: the field stays dirty
 *    and `detail` is shown. No optimistic apply.
 *  - `503 harness-settings-unavailable` renders as unavailable-with-retry, not
 *    as an empty list.
 *
 * THE ROUTES DO NOT EXIST IN THIS TREE. `server/src/api/harness.ts` is lane F2's
 * and its two registration lines belong in `server/src/index.ts`, which lane F8
 * does not own. Every request below therefore 404s here today. A 404 is mapped
 * to the same honest unavailable-with-retry state as a 503 — not to a crash, not
 * to an empty list, and not to a live-looking picker. When F2 lands, this file
 * works unchanged.
 */

import { apiFetch } from "@/lib/projects";

export const HARNESS_IDS = [
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "copilot",
  "deepseek",
  "grok-cli",
  "oh-my-pi",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export type HarnessAvailability = "ready" | "not-found" | "no-adapter" | "rejected";

export type HarnessBinaryPathSource =
  | "override"
  | "env"
  | "native-installer"
  | "path";

export interface HarnessBinaryPathState {
  /** The one field in this contract that carries a server filesystem path. */
  resolvedPath: string | null;
  source: HarnessBinaryPathSource | null;
  override: string | null;
  systemPrompt: string | null;
  /** 16384 today. Read it; do not hardcode it. */
  systemPromptMaxBytes: number;
  state: "resolved" | "not-found" | "rejected";
  detail: string | null;
}

export interface HarnessUnboundControl {
  control: string;
  /** Renderable sentence from F2; never a filesystem path. */
  reason: string;
}

export interface HarnessListEntry {
  id: HarnessId;
  label: string;
  summary: string;
  executables: string[];
  adapter: string | null;
  hasAdapter: boolean;
  availability: HarnessAvailability;
  resolvedExecutable: string | null;
  detail: string | null;
  supportsBinaryPathOverride: boolean;
  binaryPath: HarnessBinaryPathState | null;
  /** Controls this adapter accepts but cannot apply; always an array. */
  unboundControls: HarnessUnboundControl[];
}

export interface HarnessListResponse {
  version: 1;
  harnesses: HarnessListEntry[];
}

/** Exactly the wording F2's §3 specifies for each resolution source. */
export function binaryPathSourceLabel(
  source: HarnessBinaryPathSource | null,
): string | null {
  switch (source) {
    case "override":
      return "Set here";
    case "env":
      return "From the CLAUDE_BIN_PATH environment variable";
    case "native-installer":
      return "Found at the default install location";
    case "path":
      return "Found on PATH";
    default:
      return null;
  }
}

/**
 * The two validation refusals F2 §5 asks lane F8 to surface verbatim when a
 * hosted-Fusion node's whole call ceiling is served by the OpenRouter router,
 * so no CLI process is started and a non-`pi` harness cannot be reached.
 */
export const UNREACHABLE_NODE_HARNESS = "unreachable-node-harness";
export const UNREACHABLE_INHERITED_HARNESS = "unreachable-inherited-harness";

/**
 * F2 §4: `claude -p` has no sampling flags, so the relay refuses a node that
 * carries them rather than dropping the values.
 */
export const WORKFLOW_HARNESS_NOT_BOUND = "WORKFLOW_HARNESS_NOT_BOUND";

// ---------------------------------------------------------------------------
// Structural guards. #62: a malformed-but-successful body must not throw in
// render phase, so every payload is validated before it can reach a component.
// ---------------------------------------------------------------------------

function isAvailability(value: unknown): value is HarnessAvailability {
  return (
    value === "ready" ||
    value === "not-found" ||
    value === "no-adapter" ||
    value === "rejected"
  );
}

function parseBinaryPath(raw: unknown): HarnessBinaryPathState | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const state = row.state;
  if (state !== "resolved" && state !== "not-found" && state !== "rejected") return null;
  if (typeof row.systemPromptMaxBytes !== "number") return null;
  if (!Number.isFinite(row.systemPromptMaxBytes) || row.systemPromptMaxBytes <= 0) {
    return null;
  }
  const source = row.source;
  return {
    resolvedPath: typeof row.resolvedPath === "string" ? row.resolvedPath : null,
    source:
      source === "override" ||
      source === "env" ||
      source === "native-installer" ||
      source === "path"
        ? source
        : null,
    override: typeof row.override === "string" ? row.override : null,
    systemPrompt: typeof row.systemPrompt === "string" ? row.systemPrompt : null,
    systemPromptMaxBytes: row.systemPromptMaxBytes,
    state,
    detail: typeof row.detail === "string" ? row.detail : null,
  };
}

export function parseHarnessListResponse(raw: unknown): HarnessListResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 1) return null;
  if (!Array.isArray(candidate.harnesses)) return null;

  const harnesses: HarnessListEntry[] = [];
  for (const item of candidate.harnesses) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (!HARNESS_IDS.includes(row.id as HarnessId)) return null;
    if (typeof row.label !== "string" || row.label.length === 0) return null;
    if (!isAvailability(row.availability)) return null;
    if (!Array.isArray(row.unboundControls)) return null;
    const unboundControls: HarnessUnboundControl[] = [];
    for (const item of row.unboundControls) {
      if (!item || typeof item !== "object") return null;
      const control = (item as Record<string, unknown>).control;
      const reason = (item as Record<string, unknown>).reason;
      if (typeof control !== "string" || control.length === 0) return null;
      if (typeof reason !== "string" || reason.length === 0) return null;
      unboundControls.push({ control, reason });
    }
    const supportsBinaryPathOverride = row.supportsBinaryPathOverride === true;
    const binaryPath = supportsBinaryPathOverride ? parseBinaryPath(row.binaryPath) : null;
    if (supportsBinaryPathOverride && !binaryPath) return null;
    harnesses.push({
      id: row.id as HarnessId,
      label: row.label,
      summary: typeof row.summary === "string" ? row.summary : "",
      executables: Array.isArray(row.executables)
        ? row.executables.filter((value): value is string => typeof value === "string")
        : [],
      adapter: typeof row.adapter === "string" ? row.adapter : null,
      hasAdapter: row.hasAdapter === true,
      availability: row.availability,
      resolvedExecutable:
        typeof row.resolvedExecutable === "string" ? row.resolvedExecutable : null,
      detail: typeof row.detail === "string" ? row.detail : null,
      supportsBinaryPathOverride,
      binaryPath,
      unboundControls,
    });
  }
  // F2 guarantees all eight rows in contract order. Treat a partial/duplicate
  // 200 as unavailable rather than silently hiding a harness from Settings.
  if (harnesses.length !== HARNESS_IDS.length) return null;
  for (let index = 0; index < HARNESS_IDS.length; index += 1) {
    if (harnesses[index]?.id !== HARNESS_IDS[index]) return null;
  }
  return { version: 1, harnesses };
}

/**
 * `availability === "ready"` is the whole rule. Deliberately does not look at
 * `hasAdapter` or `resolvedExecutable`: `availability` already folds in adapter
 * presence, machine discovery and a rejected override, and it is the field that
 * keeps meaning what it says as adapters land.
 */
export function isSelectable(entry: HarnessListEntry): boolean {
  return entry.availability === "ready";
}

/** The reason a row is not selectable, for the disabled state's visible text. */
export function unselectableReason(entry: HarnessListEntry): string | null {
  if (isSelectable(entry)) return null;
  return entry.detail ?? "This harness is not available on this machine.";
}

// ---------------------------------------------------------------------------
// Fetch layer
// ---------------------------------------------------------------------------

export type HarnessFetchOutcome =
  | { kind: "ok"; response: HarnessListResponse }
  | { kind: "unavailable"; detail: string }
  | { kind: "invalid-request"; detail: string }
  | { kind: "unresolvable-path"; detail: string };

const NOT_REGISTERED_DETAIL =
  "Harness settings are not available from this backend yet. Retry once the harness settings service is running.";

const MALFORMED_DETAIL =
  "The harness list came back in an unexpected shape and was not applied. Retry, and if it persists the backend needs a restart.";

const UNREACHABLE_DETAIL =
  "Could not reach the Kady backend to read harness settings. Check that it is running, then retry.";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorDetail(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const detail = (body as Record<string, unknown>).detail;
    // The interface guarantees `detail` names the user's next action and never
    // carries a filesystem path (#71). It is rendered verbatim.
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return fallback;
}

async function request(
  path: string,
  init: RequestInit,
  projectId?: string,
): Promise<HarnessFetchOutcome> {
  let response: Response;
  try {
    response = await apiFetch(path, init, projectId);
  } catch {
    return { kind: "unavailable", detail: UNREACHABLE_DETAIL };
  }

  const body = await readJson(response);

  if (response.status === 404) {
    // Expected in an unpatched tree: F2's routes are not registered. Honest
    // "not available yet", not an empty list and not a crash.
    return { kind: "unavailable", detail: NOT_REGISTERED_DETAIL };
  }
  if (response.status === 503) {
    return { kind: "unavailable", detail: errorDetail(body, NOT_REGISTERED_DETAIL) };
  }
  if (response.status === 400) {
    const error = (body as Record<string, unknown> | null)?.error;
    if (error === "unresolvable-path") {
      // Nothing was persisted. The caller keeps the field dirty.
      return {
        kind: "unresolvable-path",
        detail: errorDetail(body, "That path does not name an executable."),
      };
    }
    return {
      kind: "invalid-request",
      detail: errorDetail(body, "That value was rejected."),
    };
  }
  if (!response.ok) {
    return { kind: "unavailable", detail: UNREACHABLE_DETAIL };
  }

  const parsed = parseHarnessListResponse(body);
  if (!parsed) return { kind: "unavailable", detail: MALFORMED_DETAIL };
  return { kind: "ok", response: parsed };
}

export function fetchHarnesses(projectId?: string): Promise<HarnessFetchOutcome> {
  return request("/harnesses", {}, projectId);
}

export function saveClaudeBinaryPath(
  binaryPath: string,
  projectId?: string,
): Promise<HarnessFetchOutcome> {
  return request(
    "/harnesses/claude-code/binary-path",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binaryPath }),
    },
    projectId,
  );
}

export function clearClaudeBinaryPath(
  projectId?: string,
): Promise<HarnessFetchOutcome> {
  return request(
    "/harnesses/claude-code/binary-path",
    { method: "DELETE" },
    projectId,
  );
}

export function saveClaudeSystemPrompt(
  systemPrompt: string,
  projectId?: string,
): Promise<HarnessFetchOutcome> {
  return request(
    "/harnesses/claude-code/system-prompt",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt }),
    },
    projectId,
  );
}

export function clearClaudeSystemPrompt(
  projectId?: string,
): Promise<HarnessFetchOutcome> {
  return request(
    "/harnesses/claude-code/system-prompt",
    { method: "DELETE" },
    projectId,
  );
}

/** UTF-8 byte length, so the counter matches the server's `systemPromptMaxBytes`. */
export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  // Node < 11 / exotic runtimes: this path is not reached in the browser.
  return Buffer.byteLength(value, "utf8");
}
