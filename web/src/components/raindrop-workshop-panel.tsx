// danbot-byok — web/src/components/raindrop-workshop-panel.tsx
//
// The optional Raindrop WORKSHOP embed: the local OSS agent-trace debugger UI
// (:5899) that the in-process Pi ships traces to when RAINDROP_LOCAL_DEBUGGER
// is set (local-only, no egress). Health is probed through Kady's
// /raindrop/health proxy (Workshop is a different origin, so the browser can't
// read its status cross-origin).
//
// It renders only when the Workshop is actually configured AND answering, so
// it carries no "not configured" state of its own — see the `url` prop below.
//
// NOTE: ported from the reference tree's raindrop-panel.tsx and RENAMED — the
// target's own raindrop-panel.tsx is the native session-trace viewer and must
// stay untouched (additive mandate). This embed appears only as a secondary
// mode of the Raindrop view when the Workshop is actually up
// (raindrop-surface.tsx).

"use client";

import { EngineIframePanel } from "@/components/engine-iframe-panel";
import { raindropHealth } from "@/lib/raindrop-workshop";

export function RaindropWorkshopPanel({
  /**
   * The configured Workshop origin. REQUIRED, and never defaulted: with no
   * NEXT_PUBLIC_RAINDROP_URL there is nothing this embed could honestly point
   * at, so raindrop-surface.tsx does not render it at all rather than letting
   * it guess a localhost port and frame whatever answers there. Passing the URL
   * in (instead of reading the module constant and branching on it here) is
   * what keeps that unreachable "not configured" state from existing.
   */
  url,
}: {
  url: string;
}) {
  return (
    <EngineIframePanel
      src={url}
      title="Raindrop Workshop"
      healthCheck={raindropHealth}
      engineLabel="Raindrop Workshop"
    />
  );
}
