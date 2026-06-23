// danbot-byok — web/src/lib/raindrop.ts
//
// Client for the Kady `/raindrop/health` proxy. The Raindrop Workshop UI is a
// DIFFERENT origin (:5899) from Archon (:3091), and a browser fetch straight at
// it can't read the response status cross-origin — so health is probed through
// the Kady backend (same-origin via apiFetch), which does a server-side fetch
// with no CORS wall. Mirrors pipelineHealth() in lib/pipelines.ts.

import { apiFetch } from "./projects";

/** True when the local Raindrop Workshop answers — lets the tab degrade gracefully. */
export async function raindropHealth(): Promise<boolean> {
  try {
    const res = await apiFetch("/raindrop/health");
    if (!res.ok) return false;
    const data = (await res.json()) as { healthy?: boolean };
    return Boolean(data.healthy);
  } catch {
    return false;
  }
}
