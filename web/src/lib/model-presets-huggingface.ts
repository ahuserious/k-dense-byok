"use client";

/**
 * Hugging Face model search for the Modal preset editor (matrix row 6).
 *
 * Written against the WIRE CONTRACT in lane F12's FINAL `F12-huggingface.md`,
 * not against F12's module: `web/src/lib/integrations.ts` lives on F12's branch
 * and does not exist in this tree, so importing `searchHuggingFaceModels` from
 * it would not compile here. The endpoint, the query parameters, the 200 shape
 * and the 503 `NOT_CONFIGURED` body below are quoted from that interface. When
 * F12 merges, this file should be replaced by an import of their helper — the
 * follow-up is recorded in INTEGRATION.md.
 *
 * Fail-closed, the same rule Groq and Cerebras already follow: no token is read
 * or named here beyond the variable NAME the server reports, and every failure
 * resolves to a state the editor renders as a DISABLED control with a visible
 * reason rather than a free-text fallback (§6.7). F12's interface is explicit
 * that a free-text fallback is the accepted-then-discarded pattern this wave
 * exists to stop.
 */

import { apiFetch } from "@/lib/projects";

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
  | { ok: false; kind: "unconfigured"; envVar: string; detail: string }
  | { ok: false; kind: "unavailable"; detail: string };

/**
 * The reason the chooser shows when Hugging Face is not configured. F12's
 * interface names this exact sentence; it is repeated here rather than imported
 * because their module is not in this tree.
 */
export const HF_NOT_CONFIGURED_REASON = "Set HF_TOKEN to search Hugging Face models";

/**
 * The reason the chooser shows in THIS clone, where F12's route is not
 * registered yet and a search 404s. Naming the cause honestly beats reporting
 * it as a Hugging Face outage.
 */
export const HF_ROUTE_ABSENT_REASON =
  "Hugging Face model search is not available in this build yet. Add it, or set the model id from a Modal job once the integration lands.";

function summaryFrom(raw: unknown): HuggingFaceModelSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  const gated = record.gated;
  return {
    id: record.id,
    pipelineTag: typeof record.pipelineTag === "string" ? record.pipelineTag : null,
    libraryName: typeof record.libraryName === "string" ? record.libraryName : null,
    gated: gated === "manual" || gated === "auto" ? gated : false,
    downloads: typeof record.downloads === "number" ? record.downloads : null,
    likes: typeof record.likes === "number" ? record.likes : null,
  };
}

/**
 * One search. Never throws — every outcome is a state the caller renders.
 *
 * A malformed-but-200 body degrades to `unavailable` rather than throwing in
 * render phase (#62), and a row missing `id` is dropped rather than rendered as
 * a blank option.
 */
export async function searchHuggingFaceModels(
  search: string,
  limit = 20,
): Promise<HuggingFaceSearchResult> {
  const query = search.trim();
  if (!query) return { ok: true, models: [] };
  let response: Response;
  try {
    response = await apiFetch(
      `/integrations/huggingface/models?search=${encodeURIComponent(query)}&limit=${limit}`,
    );
  } catch {
    return {
      ok: false,
      kind: "unavailable",
      detail: "Kady could not reach the server to search Hugging Face. Check that it is running.",
    };
  }
  if (response.status === 503) {
    let envVar = "HF_TOKEN";
    let detail = HF_NOT_CONFIGURED_REASON;
    try {
      const body = (await response.json()) as { envVar?: unknown; detail?: unknown };
      if (typeof body?.envVar === "string" && body.envVar.trim()) envVar = body.envVar;
      if (typeof body?.detail === "string" && body.detail.trim()) detail = body.detail;
    } catch {
      // Keep the interface's own wording; the body is advisory.
    }
    return { ok: false, kind: "unconfigured", envVar, detail };
  }
  if (response.status === 404) {
    return { ok: false, kind: "unavailable", detail: HF_ROUTE_ABSENT_REASON };
  }
  if (!response.ok) {
    let detail = "Hugging Face search failed. Try again in a moment.";
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail.trim()) detail = body.detail;
    } catch {
      // Fall through to the generic sentence; never echo an unparsed body.
    }
    return { ok: false, kind: "unavailable", detail };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      kind: "unavailable",
      detail: "Hugging Face returned a response Kady could not read.",
    };
  }
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) {
    return {
      ok: false,
      kind: "unavailable",
      detail: "Hugging Face returned a response Kady could not read.",
    };
  }
  return {
    ok: true,
    models: models.map(summaryFrom).filter((model): model is HuggingFaceModelSummary =>
      Boolean(model),
    ),
  };
}
