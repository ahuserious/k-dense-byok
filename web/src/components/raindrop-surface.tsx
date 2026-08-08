// danbot-byok — web/src/components/raindrop-surface.tsx
//
// The "Raindrop" view host. The target-native session-trace panel
// (raindrop-panel.tsx) is and stays the default. When the OPTIONAL local
// Raindrop Workshop (:5899, external sibling checkout) answers the
// /raindrop/health probe, a mode toggle appears and the ported Workshop embed
// (raindrop-workshop-panel.tsx) becomes available as a second mode.
//
// With no Workshop running the probe fails silently and this host renders the
// native panel with NO extra chrome — the tab is unchanged from today
// (additive mandate). The embed mounts on first use and stays mounted
// (display toggled) so mode flips don't hard-reload the Workshop SPA.

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { raindropHealth } from "@/lib/raindrop-workshop";
import { RaindropWorkshopPanel } from "@/components/raindrop-workshop-panel";

type RaindropMode = "native" | "workshop";

const MODE_SEGMENTS: { id: RaindropMode; label: string }[] = [
  { id: "native", label: "Session traces" },
  { id: "workshop", label: "Workshop" },
];

export function RaindropSurface({
  nativePanel,
}: {
  /** The native session-trace viewer, rendered by the parent with its own props. */
  nativePanel: ReactNode;
}) {
  const [mode, setMode] = useState<RaindropMode>("native");
  // null = probing; the toggle appears only once the Workshop answered.
  const [workshopUp, setWorkshopUp] = useState<boolean | null>(null);
  // Mount the embed lazily, then keep it mounted across toggles.
  const [workshopVisited, setWorkshopVisited] = useState(false);
  useEffect(() => {
    if (mode === "workshop") setWorkshopVisited(true);
  }, [mode]);

  // One probe on mount. The Workshop is a manually-started sidecar; if it
  // comes up later, revisiting the view (remount) or reloading picks it up.
  // No poll here — the embed's own EngineIframePanel polls once it's chosen.
  useEffect(() => {
    let cancelled = false;
    void raindropHealth().then((up) => {
      if (!cancelled) setWorkshopUp(up);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {workshopUp === true && (
        <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1 font-mono">
          {MODE_SEGMENTS.map((segment) => (
            <button
              key={segment.id}
              type="button"
              onClick={() => setMode(segment.id)}
              aria-pressed={mode === segment.id}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                mode === segment.id
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              {segment.label}
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          "min-h-0 flex-1 flex-col overflow-hidden",
          mode === "native" ? "flex" : "hidden",
        )}
      >
        {nativePanel}
      </div>
      {workshopVisited && (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col overflow-hidden",
            mode === "workshop" ? "flex" : "hidden",
          )}
        >
          <RaindropWorkshopPanel />
        </div>
      )}
    </div>
  );
}
