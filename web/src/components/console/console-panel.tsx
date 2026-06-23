// danbot-byok — web/src/components/console/console-panel.tsx
//
// The "Console" view (renamed from "Agent Console"). It lets the user watch
// agents/workflows in progress and inspect their traces, via two sub-tabs:
//
//   • Agents   — Archon's own run-centric console (/console), embedded. This is
//                where long-running goal loops + workflow runs are observed.
//   • Raindrop — the local Raindrop Workshop UI (:5899), the OSS agent-trace
//                debugger. Local-only: traces stay in a local SQLite DB, nothing
//                egresses. Health is probed through Kady's /raindrop/health proxy
//                (Workshop is a different origin from Archon).
//
// Per the design, the WHOLE console shell adopts Raindrop's visual style (a dark
// slate surface with a teal accent) so the two tabs feel like one tool. Each
// sub-tab's iframe is mounted on first visit and then kept mounted (hidden) so
// switching tabs is instant and doesn't reload the embedded SPA.

"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ArchonIframePanel } from "@/components/archon-iframe-panel";
import { ARCHON_URL, RAINDROP_URL } from "@/lib/embed-config";
import { pipelineHealth } from "@/lib/pipelines";
import { raindropHealth } from "@/lib/raindrop";

type ConsoleSub = "agents" | "raindrop";

const SUB_TABS: { id: ConsoleSub; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "raindrop", label: "Raindrop" },
];

export function ConsolePanel() {
  const [activeSub, setActiveSub] = useState<ConsoleSub>("agents");
  // Mount each sub-tab's iframe on first visit, then keep it mounted (hidden) so
  // switching back is instant (no reload). Agents is visited on initial render.
  const [visited, setVisited] = useState<Record<ConsoleSub, boolean>>({
    agents: true,
    raindrop: false,
  });

  const selectSub = (id: ConsoleSub) => {
    setActiveSub(id);
    setVisited((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  };

  return (
    // Raindrop-styled shell: pure-black surface, light cool-gray monospace text,
    // white/10 hairlines and white-overlay surfaces — matching the Raindrop Workshop
    // UI so the two tabs read as one tool. Kept self-contained (its own colors, not
    // Kady's theme tokens) on purpose.
    <div className="flex h-full min-h-0 flex-col bg-black font-mono text-[#d5dadd]">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-3 py-1.5">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectSub(tab.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-[13px] transition-colors",
              activeSub === tab.id
                ? "bg-white/10 text-white"
                : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="relative min-h-0 flex-1">
        {visited.agents && (
          <div className={cn("absolute inset-0 flex flex-col", activeSub !== "agents" && "hidden")}>
            <ArchonIframePanel
              src={`${ARCHON_URL}/console`}
              title="Agents"
              healthCheck={pipelineHealth}
              engineLabel="agent console engine (Archon)"
            />
          </div>
        )}
        {visited.raindrop && (
          <div className={cn("absolute inset-0 flex flex-col", activeSub !== "raindrop" && "hidden")}>
            <ArchonIframePanel
              src={RAINDROP_URL}
              title="Raindrop"
              healthCheck={raindropHealth}
              engineLabel="Raindrop Workshop"
            />
          </div>
        )}
      </div>
    </div>
  );
}
