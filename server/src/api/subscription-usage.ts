/**
 * `GET /subscription-usage` — the project-wide per-provider subscription rollup
 * the app-shell subscription bar renders (web/src/components/subscription-bar.tsx).
 *
 * Registration lives in `server/src/index.ts` (applied on dest merge). A 503
 * here still lets the client fall back to the session-scoped ledger.
 *
 * Error bodies carry no filesystem path (#71). `resolvePaths` throws for an
 * invalid project id and that message could name a directory, so it is caught
 * and replaced with a fixed sentence naming the user's next action.
 */
import type { FastifyInstance } from "fastify";

import { currentProjectId } from "../scope.ts";
import { subscriptionUsageSnapshot } from "../agent/subscription-usage.ts";

export async function registerSubscriptionUsageRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/subscription-usage", async (_req, reply) => {
    try {
      return subscriptionUsageSnapshot(currentProjectId());
    } catch {
      reply.code(503);
      return {
        error: "subscription-usage-unavailable",
        detail:
          "Subscription usage could not be read for this project. Reselect the project, then retry.",
      };
    }
  });
}
