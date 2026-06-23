// danbot-byok — web/src/components/raindrop-panel.tsx
//
// The "Raindrop" top-level tab: embeds the local Raindrop Workshop UI (:5899) — the OSS
// agent-trace debugger that KADY's in-process Pi ships traces to (local-only, no egress).
// Health is probed through Kady's /raindrop/health proxy (Workshop is a different origin,
// so the browser can't read its status cross-origin).

"use client";

import { ArchonIframePanel } from "@/components/archon-iframe-panel";
import { RAINDROP_URL } from "@/lib/embed-config";
import { raindropHealth } from "@/lib/raindrop";

export function RaindropPanel() {
  return (
    <ArchonIframePanel
      src={RAINDROP_URL}
      title="Raindrop"
      healthCheck={raindropHealth}
      engineLabel="Raindrop Workshop"
    />
  );
}
