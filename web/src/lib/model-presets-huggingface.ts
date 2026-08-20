"use client";

/**
 * Hugging Face model search for the Modal preset editor (matrix row 6).
 *
 * F12 owns the actual HTTP client in `web/src/lib/integrations.ts`. This file is
 * deliberately only a state adapter for the preset editor: it converts F12's
 * `ok/detail/envVar` result into the editor's designed unconfigured/unavailable
 * states and catches transport rejection. There is one request implementation,
 * not two copies that can drift.
 *
 * Fail-closed, the same rule Groq and Cerebras already follow: no token is read
 * or named here beyond the variable NAME the server reports, and every failure
 * resolves to a state the editor renders as a DISABLED control with a visible
 * reason rather than a free-text fallback (§6.7). F12's interface is explicit
 * that a free-text fallback is the accepted-then-discarded pattern this wave
 * exists to stop.
 */

import {
  searchHuggingFaceModels as searchIntegratedHuggingFaceModels,
  type HuggingFaceModelSummary,
} from "@/lib/integrations";

export type { HuggingFaceModelSummary } from "@/lib/integrations";

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

/**
 * One search through F12's shared client. Never throws — every outcome is a
 * state the caller renders. F12 validates malformed success bodies before this
 * adapter sees them, preserving the #62 render boundary.
 */
export async function searchHuggingFaceModels(
  search: string,
  limit = 20,
): Promise<HuggingFaceSearchResult> {
  const query = search.trim();
  if (!query) return { ok: true, models: [] };
  let result: Awaited<ReturnType<typeof searchIntegratedHuggingFaceModels>>;
  try {
    result = await searchIntegratedHuggingFaceModels(query, limit);
  } catch {
    return {
      ok: false,
      kind: "unavailable",
      detail: "Kady could not reach the server to search Hugging Face. Check that it is running.",
    };
  }
  if (result.ok) {
    return {
      ok: true,
      models: result.models.filter((model) => model.id.trim().length > 0),
    };
  }
  if (result.envVar) {
    return {
      ok: false,
      kind: "unconfigured",
      envVar: result.envVar,
      detail: result.detail || HF_NOT_CONFIGURED_REASON,
    };
  }
  return {
    ok: false,
    kind: "unavailable",
    detail: /\(404\)/.test(result.detail) ? HF_ROUTE_ABSENT_REASON : result.detail,
  };
}
