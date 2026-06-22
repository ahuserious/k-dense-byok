// danbot-byok — web/src/components/agent-console/agent-console-panel.tsx
//
// The "Agent Console" view: surfaces Archon's own real console UI inside Kady via a
// full-height iframe, rather than rebuilding a synthetic loop/run dashboard. danbot owns
// the chat + cost UI; Archon owns goal-loop orchestration and the console that observes it.
// When the Archon sidecar is down the iframe would just show a connection error, so we
// health-gate it (matching the Pipeline Builder panel) and offer a link-out + reload instead.
//
// Mirrors pipeline-builder-panel.tsx exactly: same health gate (pipelineHealth, which probes
// the same Archon sidecar), reload-by-remount, "Open in new tab" link-out, and iframe shape.

"use client";

import { useCallback, useEffect, useState } from "react";
import { pipelineHealth } from "@/lib/pipelines";

// Where Archon's web UI is served. Overridable so the embed works regardless of the port
// the sidecar was pinned to.
const ARCHON_URL = process.env.NEXT_PUBLIC_ARCHON_URL ?? "http://localhost:3091";

// Archon's redesigned console (the default UI; "/" hard-redirects here) lives under /console.
const CONSOLE_URL = `${ARCHON_URL}/console`;

export function AgentConsolePanel() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  // Bumping this key remounts the iframe, which is how you force-reload an embedded
  // cross-origin frame in React (we can't read/poke its contentWindow across origins).
  const [reloadKey, setReloadKey] = useState(0);

  const checkHealth = useCallback(async () => {
    setHealthy(null);
    setHealthy(await pipelineHealth());
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // Re-check health and remount the iframe so the console reloads from a clean state.
  const reload = useCallback(() => {
    setReloadKey((previous) => previous + 1);
    void checkHealth();
  }, [checkHealth]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Agent Console</h2>
        <span
          className={
            "rounded px-1.5 py-0.5 text-[11px] " +
            (healthy === null
              ? "bg-muted text-muted-foreground"
              : healthy
                ? "bg-emerald-500/15 text-emerald-600"
                : "bg-red-500/15 text-red-600")
          }
        >
          {healthy === null ? "checking…" : healthy ? "engine online" : "engine offline"}
        </span>
        <a
          href={CONSOLE_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
        >
          Open in new tab ↗
        </a>
        <button
          type="button"
          onClick={reload}
          className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
        >
          Reload
        </button>
      </div>

      {healthy === false ? (
        <p className="text-xs text-muted-foreground">
          The Agent Console engine (Archon) isn&apos;t reachable, so the console can&apos;t load.
          Start the Archon sidecar, then Reload — or use “Open in new tab” to reach it directly.
        </p>
      ) : (
        <iframe
          key={reloadKey}
          src={CONSOLE_URL}
          title="Agent Console"
          className="min-h-0 w-full flex-1 rounded-md border"
        />
      )}
    </div>
  );
}
