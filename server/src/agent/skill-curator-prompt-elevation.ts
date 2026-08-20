/**
 * F11 is only an entry point into F5's prompt-elevation engine.
 *
 * Keep this adapter deliberately tiny: the current integration does not contain
 * F5's interface or endpoint, so the only truthful behavior is disabled. Once
 * F5 lands, the follow-up changes this file to call that single API; no skill,
 * route, or UI needs to grow an elevation algorithm of its own.
 */

export interface PromptElevationAdapterStatus {
  available: boolean;
  interfaceDocument: string;
  endpoint: string | null;
  reason: string | null;
}

export const F5_PROMPT_ELEVATION_INTERFACE =
  "wave-f/interfaces/F5-elevate-to-dag.md";

export function promptElevationAdapterStatus(): PromptElevationAdapterStatus {
  return {
    available: false,
    interfaceDocument: F5_PROMPT_ELEVATION_INTERFACE,
    endpoint: null,
    reason:
      "Prompt elevation is unavailable on this build because F5's single elevation API has not landed. The skill will not create a parallel elevator.",
  };
}
