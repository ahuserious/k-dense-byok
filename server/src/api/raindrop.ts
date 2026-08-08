/**
 * Kady "Raindrop" route: a same-origin health proxy for the local Raindrop Workshop UI.
 *
 * The Console's Raindrop tab embeds Workshop (a different origin, :5899) in an iframe. A
 * browser fetch straight at :5899 can't read the response status cross-origin, so the tab
 * probes health through here instead — Kady does the fetch server-side (no CORS wall) and
 * reports a simple {healthy} boolean, mirroring /pipelines/health. We never proxy Workshop's
 * UI or its trace data through Kady; the iframe loads it directly. This is health only.
 */
import type { FastifyInstance } from "fastify";
import { RAINDROP_BASE_URL } from "../config.ts";

export async function registerRaindropRoutes(app: FastifyInstance): Promise<void> {
  app.get("/raindrop/health", async () => {
    try {
      // Short timeout so a down Workshop fails fast rather than hanging the tab's probe.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(RAINDROP_BASE_URL, { signal: controller.signal });
        return { healthy: res.ok };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { healthy: false };
    }
  });
}
