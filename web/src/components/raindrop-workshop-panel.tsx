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

import { ArchonIframePanel } from "@/components/archon-iframe-panel";
import { RAINDROP_URL } from "@/lib/embed-config";
import { raindropHealth } from "@/lib/raindrop-workshop";

export function RaindropWorkshopPanel() {
  return (
    <ArchonIframePanel
      src={RAINDROP_URL}
      title="Raindrop Workshop"
      healthCheck={raindropHealth}
      engineLabel="Raindrop Workshop"
    />
  );
}
