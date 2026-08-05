"use client";

import { apiFetch } from "@/lib/projects";

export type RaindropReference =
  | { kind: "run"; id: string }
  | { kind: "session"; id: string };

export interface RaindropChatSessionSummary {
  id: string;
  title: string;
  created: string | number;
  modified: string | number;
  messageCount: number;
}

export interface RaindropOpenChatSession {
  id: string;
  title: string;
  active: boolean;
}

export interface RaindropContextResponse {
  source: RaindropReference;
  context: string;
  truncated: boolean;
  observedEntries: number;
  totalEntries: number;
}

interface SessionListItem {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  modified?: unknown;
  messageCount?: unknown;
  firstMessage?: unknown;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RUN_ID_PATTERN = /^wrun_[a-f0-9]{32}$/;

export function isRaindropReference(value: unknown): value is RaindropReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "id")) return false;
  if (typeof record.id !== "string") return false;
  return record.kind === "run"
    ? RUN_ID_PATTERN.test(record.id)
    : record.kind === "session" && SESSION_ID_PATTERN.test(record.id);
}

export function raindropReferenceKey(reference: RaindropReference): string {
  return `${reference.kind}:${reference.id}`;
}

function titleForSession(session: SessionListItem): string {
  const raw = (
    typeof session.name === "string"
      ? session.name
      : typeof session.firstMessage === "string"
        ? session.firstMessage
        : ""
  ).replace(/\s+/g, " ").trim();
  if (!raw) return "Untitled chat";
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { detail?: unknown };
  return new Error(typeof body.detail === "string" ? body.detail : fallback);
}

export async function listRaindropChatSessions(
  projectId: string,
): Promise<RaindropChatSessionSummary[]> {
  const response = await apiFetch("/sessions", {}, projectId);
  if (!response.ok) {
    throw await errorFromResponse(response, `Chat-session list failed (${response.status}).`);
  }
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) throw new Error("Chat-session list returned an invalid payload.");
  return body.flatMap((candidate): RaindropChatSessionSummary[] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const session = candidate as SessionListItem;
    if (
      typeof session.id !== "string" ||
      !SESSION_ID_PATTERN.test(session.id) ||
      (typeof session.created !== "string" && typeof session.created !== "number") ||
      (typeof session.modified !== "string" && typeof session.modified !== "number") ||
      !Number.isSafeInteger(session.messageCount) ||
      (session.messageCount as number) < 1
    ) return [];
    return [{
      id: session.id,
      title: titleForSession(session),
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount as number,
    }];
  }).sort((left, right) =>
    new Date(right.modified).getTime() - new Date(left.modified).getTime() ||
    left.id.localeCompare(right.id)
  );
}

export async function loadRaindropContext(
  projectId: string,
  source: RaindropReference,
  signal?: AbortSignal,
): Promise<RaindropContextResponse> {
  if (!isRaindropReference(source)) throw new Error("Invalid Raindrop log reference.");
  const response = await apiFetch(
    "/helper-sessions/raindrop/context",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(source),
      signal,
    },
    projectId,
  );
  if (!response.ok) {
    throw await errorFromResponse(response, `Raindrop context failed (${response.status}).`);
  }
  const body = await response.json() as Partial<RaindropContextResponse>;
  if (
    !isRaindropReference(body.source) ||
    raindropReferenceKey(body.source) !== raindropReferenceKey(source) ||
    typeof body.context !== "string" ||
    body.context.length > 64 * 1024 ||
    typeof body.truncated !== "boolean" ||
    !Number.isSafeInteger(body.observedEntries) ||
    !Number.isSafeInteger(body.totalEntries)
  ) {
    throw new Error("Raindrop context returned an invalid payload.");
  }
  return body as RaindropContextResponse;
}
