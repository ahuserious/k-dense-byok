// danbot-byok — web/src/components/agent-console/agent-console-panel.tsx
//
// The "Agent Console" view: surfaces Archon's own real console UI inside Kady via a
// full-bleed iframe, rather than rebuilding a synthetic loop/run dashboard. danbot owns
// the chat + cost UI; Archon owns goal-loop orchestration and the console that observes it.
// When the Archon sidecar is down the iframe would just show a connection error, so we
// health-gate it (matching the Pipeline Builder panel) and show a small setup message instead.
//
// Mirrors pipeline-builder-panel.tsx exactly: same health gate (pipelineHealth, which probes
// the same Archon sidecar) and full-bleed iframe shape.

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

  const checkHealth = useCallback(async () => {
    setHealthy(null);
    setHealthy(await pipelineHealth());
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // When healthy, the iframe is full-bleed — no header chrome (title/badge/link/reload), so the
  // embedded Archon console fills the panel. We keep the health gate so a down sidecar still shows
  // a small setup message instead of a broken cross-origin frame.
  if (healthy === false) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <p className="text-xs text-muted-foreground">
          The Agent Console engine (Archon) isn&apos;t reachable, so the console can&apos;t load.
          Start the Archon sidecar to continue.
        </p>
      </div>
    );
  }

  return (
    <iframe
      src={CONSOLE_URL}
      title="Agent Console"
      className="min-h-0 w-full flex-1 border-0"
    />
  );
}
