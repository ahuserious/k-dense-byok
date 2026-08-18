/**
 * Kady "Raindrop" route: a same-origin health proxy for the OPTIONAL local Raindrop Workshop UI.
 *
 * The Console's Raindrop tab embeds Workshop (a different origin, conventionally :5899) in an
 * iframe. A browser fetch straight at it can't read the response status cross-origin, so the tab
 * probes health through here instead — Kady does the fetch server-side (no CORS wall) and
 * reports a simple {healthy} boolean, mirroring /pipelines/health. We never proxy Workshop's
 * UI or its trace data through Kady; the iframe loads it directly. This is health only.
 *
 * Workshop is an external sibling checkout, so "no RAINDROP_BASE_URL" is the normal case rather
 * than a misconfiguration: there is no address to probe, so nothing is fetched and the route
 * says so. `configured` is reported alongside `healthy` the way /openai-compatible/models
 * reports it alongside `available`.
 */
import type { FastifyInstance } from "fastify";
import { RAINDROP_BASE_URL } from "../config.ts";

export async function registerRaindropRoutes(app: FastifyInstance): Promise<void> {
  app.get("/raindrop/health", async () => {
    // Unconfigured: a first-class state, not an error and not a probe of nothing. No fetch is
    // attempted at all, so an unconfigured install never reaches out to whatever happens to be
    // listening locally. `healthy: false` keeps the client contract intact (raindropHealth()
    // reads only that field), so the Raindrop view simply keeps its native session-trace panel.
    if (!RAINDROP_BASE_URL) return { healthy: false, configured: false };
    try {
      // Short timeout so a down Workshop fails fast rather than hanging the tab's probe.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(RAINDROP_BASE_URL, { signal: controller.signal });
        return { healthy: res.ok, configured: true };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { healthy: false, configured: true };
    }
  });
}
