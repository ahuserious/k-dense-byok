"use client";

/**
 * Where the subscription bar's numbers come from.
 *
 * Two sources, in order of preference:
 *
 *  1. `GET /subscription-usage` — the project-wide rollup over every session's
 *     ledger (server/src/api/subscription-usage.ts). OFF BY DEFAULT: see
 *     `PROJECT_ROLLUP_ROUTE_ENABLED` below.
 *  2. The session ledger rows the app shell already holds (`summary.entries`,
 *     fetched by `GET /sessions/:id/costs`, registered today). Narrower scope,
 *     same shape, real numbers.
 *
 * Provider *definitions* always come from `GET /model-providers`, which is
 * registered today — so the names, account labels and the honest "why there is
 * no percentage" notes are the server's, never a client-side copy that could
 * drift from `server/src/agent/provider-auth.ts`.
 *
 * Nothing here throws on a malformed body (#62): every payload goes through a
 * structural guard and a failure becomes a rendered state.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch, useProjectScopeId } from "@/lib/projects";
import type { CostEntry } from "@/lib/use-session-cost";
import {
  parseProviderDefinitions,
  parseSubscriptionUsageSnapshot,
  rollupSubscriptionUsage,
  type SubscriptionProviderDefinition,
  type SubscriptionUsageSnapshot,
} from "@/lib/subscription-usage";

/**
 * Whether to ask the backend for the project-wide rollup.
 *
 * Dest merge applies F8 INTEGRATION items 1–2 (`registerSubscriptionUsageRoutes`
 * plus the `/subscription-usage` e2e mock) in the same commit, so this is on.
 * The session-ledger fallback remains for 404/503 and for unit tests that pass
 * `{ projectRollupEnabled: false }`.
 */
export const PROJECT_ROLLUP_ROUTE_ENABLED = true;

export type SubscriptionUsageStatus = "loading" | "ready" | "unavailable";

export interface SubscriptionUsageState {
  status: SubscriptionUsageStatus;
  snapshot: SubscriptionUsageSnapshot | null;
  definitions: SubscriptionProviderDefinition[];
  /** Names the user's next action. Never contains a filesystem path (#71). */
  detail: string | null;
  reload: () => void;
}

const UNAVAILABLE_DETAIL =
  "Subscription usage could not be read. Check that the Kady backend is running, then retry.";

export function useSubscriptionUsage(
  entries: readonly CostEntry[] | undefined,
  refreshKey: number,
  projectRollupEnabled: boolean = PROJECT_ROLLUP_ROUTE_ENABLED,
): SubscriptionUsageState {
  const projectId = useProjectScopeId();
  const [definitions, setDefinitions] = useState<SubscriptionProviderDefinition[]>([]);
  const [projectSnapshot, setProjectSnapshot] =
    useState<SubscriptionUsageSnapshot | null>(null);
  const [status, setStatus] = useState<SubscriptionUsageStatus>("loading");
  const [detail, setDetail] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setReloadKey((previous) => previous + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setStatus("loading");
      setDetail(null);

      let loadedDefinitions: SubscriptionProviderDefinition[] | null = null;
      try {
        const response = await apiFetch("/model-providers", {}, projectId);
        if (response.ok) {
          loadedDefinitions = parseProviderDefinitions(await response.json());
        }
      } catch {
        // Network failure is a rendered state, not an exception. Handled below.
      }

      // The project-wide rollup is an upgrade, not a requirement. A 404 means
      // the route is not registered in this tree; the session-scoped fallback
      // still produces real numbers, so it is not an error.
      let loadedProjectSnapshot: SubscriptionUsageSnapshot | null = null;
      if (projectRollupEnabled) {
        try {
          const response = await apiFetch("/subscription-usage", {}, projectId);
          if (response.ok) {
            loadedProjectSnapshot = parseSubscriptionUsageSnapshot(await response.json());
          }
        } catch {
          // Same: degrade to the session ledger.
        }
      }

      if (cancelled) return;
      if (!loadedDefinitions) {
        setDefinitions([]);
        setProjectSnapshot(null);
        setStatus("unavailable");
        setDetail(UNAVAILABLE_DETAIL);
        return;
      }
      setDefinitions(loadedDefinitions);
      setProjectSnapshot(loadedProjectSnapshot);
      setStatus("ready");
      setDetail(null);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey, refreshKey, projectRollupEnabled]);

  const snapshot =
    status !== "ready"
      ? null
      : projectSnapshot ?? rollupSubscriptionUsage(entries, definitions, "session");

  return { status, snapshot, definitions, detail, reload };
}
