// danbot-byok — web/src/components/raindrop-workshop-panel.tsx
//
// The optional Raindrop WORKSHOP embed: the local OSS agent-trace debugger UI
// (:5899) that the in-process Pi ships traces to when RAINDROP_LOCAL_DEBUGGER
// is set (local-only, no egress). Health is probed through Kady's
// /raindrop/health proxy (Workshop is a different origin, so the browser can't
// read its status cross-origin).
//
// NOTE: ported from the reference tree's raindrop-panel.tsx and RENAMED — the
// target's own raindrop-panel.tsx is the native session-trace viewer and must
// stay untouched (additive mandate). This embed appears only as a secondary
// mode of the Raindrop view when the Workshop is actually up
// (raindrop-surface.tsx).

"use client";

import { EngineIframePanel } from "@/components/engine-iframe-panel";
import { RAINDROP_URL } from "@/lib/embed-config";
import { raindropHealth } from "@/lib/raindrop-workshop";

export const RAINDROP_WORKSHOP_UNCONFIGURED_MESSAGE =
  "Raindrop Workshop is not configured (set NEXT_PUBLIC_RAINDROP_URL)";

export function RaindropWorkshopPanel() {
  // Without a configured URL there is nothing this embed could honestly point
  // at, so it states that and issues no request at all — it never guesses a
  // localhost port and frames whatever answers there.
  if (!RAINDROP_URL) {
    return (
      <div
        data-testid="raindrop-workshop-unconfigured"
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6"
      >
        <p role="status" className="max-w-sm text-center text-xs text-muted-foreground">
          {RAINDROP_WORKSHOP_UNCONFIGURED_MESSAGE}
        </p>
      </div>
    );
  }

  return (
    <EngineIframePanel
      src={RAINDROP_URL}
      title="Raindrop Workshop"
      healthCheck={raindropHealth}
      engineLabel="Raindrop Workshop"
    />
  );
}
