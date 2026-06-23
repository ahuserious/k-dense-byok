// danbot-byok — web/src/components/console/console-panel.tsx
//
// The "Console" top-level tab. It embeds Archon's own run-centric console (/console) —
// where long-running goal loops + workflow runs are observed. Raindrop is now its OWN
// top-level tab (see raindrop-panel.tsx), so the Console no longer has Agents/Raindrop
// sub-tabs; it is the agent console directly.

"use client";

import { ArchonIframePanel } from "@/components/archon-iframe-panel";
import { ARCHON_URL } from "@/lib/embed-config";
import { pipelineHealth } from "@/lib/pipelines";

export function ConsolePanel() {
  return (
    // Raindrop-styled agent surface: black + monospace, matching the rest of the
    // agent chrome.
    <div className="flex h-full min-h-0 flex-col bg-black font-mono text-[#d5dadd]">
      <ArchonIframePanel
        src={`${ARCHON_URL}/console`}
        title="Console"
        healthCheck={pipelineHealth}
        engineLabel="agent console engine (Archon)"
      />
    </div>
  );
}
