/**
 * F11 is only an entry point into F5's prompt-elevation engine.
 *
 * F5 owns `server/src/workflows/elevate-to-dag.ts`. F9's chat affordance is
 * another entry point into that same engine. This adapter never implements
 * elevation; it reports whether dest published F5's HTTP route. A missing
 * dest-index registration stays disabled so Chat, the node kind, and this
 * skill cannot grow three elevators.
 */

export const F5_PROMPT_ELEVATION_INTERFACE =
  "wave-f/interfaces/F5-elevate-to-dag.md";

export const F5_ELEVATE_TO_DAG_ENDPOINT = "/elevate-to-dag";

export const F5_ELEVATE_TO_DAG_ENGINE =
  "server/src/workflows/elevate-to-dag.ts";

export const F2_HARNESS_LIST_ENDPOINT = "/harnesses";

export interface DestRouteProbe {
  hasRoute(route: { method: string; url: string }): boolean;
}

export interface PromptElevationAdapterStatus {
  available: boolean;
  interfaceDocument: string;
  endpoint: string;
  engine: string;
  reason: string | null;
}

export interface DestHarnessAdapterStatus {
  available: boolean;
  endpoint: string;
  reason: string | null;
}

export function destIndexPublishes(
  app: DestRouteProbe,
  method: string,
  url: string,
): boolean {
  return app.hasRoute({ method, url });
}

export function promptElevationAdapterStatus(
  app: DestRouteProbe,
): PromptElevationAdapterStatus {
  const published = destIndexPublishes(app, "POST", F5_ELEVATE_TO_DAG_ENDPOINT);
  return {
    available: published,
    interfaceDocument: F5_PROMPT_ELEVATION_INTERFACE,
    endpoint: F5_ELEVATE_TO_DAG_ENDPOINT,
    engine: F5_ELEVATE_TO_DAG_ENGINE,
    reason: published
      ? null
      : "POST /elevate-to-dag is unpublished on this dest index. F5 owns elevate-to-dag.ts; F11 will not create a parallel elevator.",
  };
}

export function destHarnessAdapterStatus(
  app: DestRouteProbe,
): DestHarnessAdapterStatus {
  const published = destIndexPublishes(app, "GET", F2_HARNESS_LIST_ENDPOINT);
  return {
    available: published,
    endpoint: F2_HARNESS_LIST_ENDPOINT,
    reason: published
      ? null
      : "GET /harnesses is unpublished on this dest index.",
  };
}
