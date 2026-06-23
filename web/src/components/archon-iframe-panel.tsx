// danbot-byok — web/src/components/archon-iframe-panel.tsx
//
// Shared full-bleed iframe panel for the local engines Kady embeds (Archon's
// visual builder + console, and Raindrop Workshop). It replaces the two
// near-identical hand-rolled panels (pipeline-builder + agent-console), whose
// flakiness had three concrete causes that this component fixes:
//
//   1. They rendered NOTHING while the health probe was pending (`healthy === null`),
//      so the panel flashed blank before the iframe mounted. Here `null` shows a
//      proper "Connecting…" skeleton, and the iframe fades in on its own `load`.
//   2. The probe was one-shot: if the engine came up a beat after Kady, the panel
//      stuck on "unreachable" forever. Here we POLL with backoff and stop once healthy,
//      plus a manual Retry. The poll is cancel-safe (cleared on unmount, no
//      setState-after-unmount).
//   3. They remounted the iframe on `key` churn / view-switch, hard-reloading the
//      embedded SPA every time. Here the iframe is stable; the PARENT keeps the
//      panel mounted (hidden) across view switches so returning to it is instant.
//
// `healthCheck` is optional and engine-specific (Archon vs Raindrop probe different
// origins) — when omitted the iframe renders immediately with just the load overlay.

"use client";

import { LoaderCircleIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 10; // ~30s of grace for a sidecar that starts a beat after Kady

export function ArchonIframePanel({
  src,
  title,
  healthCheck,
  engineLabel = "engine",
}: {
  /** The iframe target URL. */
  src: string;
  /** iframe title — also the Playwright assertion surface, so keep it stable. */
  title: string;
  /** Optional engine-specific health probe; omit to render the iframe ungated. */
  healthCheck?: () => Promise<boolean>;
  /** Human label for the engine, used in the loading + error copy. */
  engineLabel?: string;
}) {
  // null = probing (or no probe yet); true = reachable; false = gave up after retries.
  const [healthy, setHealthy] = useState<boolean | null>(healthCheck ? null : true);
  // The iframe has fired its `load` event — lets us fade out the skeleton.
  const [loaded, setLoaded] = useState(false);

  const mountedRef = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCount = useRef(0);

  const clearPoll = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const probe = useCallback(async () => {
    if (!healthCheck) return;
    const ok = await healthCheck();
    if (!mountedRef.current) return;
    if (ok) {
      setHealthy(true);
      clearPoll();
      return;
    }
    // Not up yet — keep the skeleton and retry until we exhaust the grace window.
    if (pollCount.current < MAX_POLLS) {
      pollCount.current += 1;
      pollTimer.current = setTimeout(() => void probe(), POLL_INTERVAL_MS);
    } else {
      setHealthy(false);
    }
  }, [healthCheck, clearPoll]);

  // Manual retry: reset the grace window and probe again from scratch.
  const retry = useCallback(() => {
    clearPoll();
    pollCount.current = 0;
    setHealthy(null);
    void probe();
  }, [clearPoll, probe]);

  useEffect(() => {
    mountedRef.current = true;
    void probe();
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
  }, [probe, clearPoll]);

  if (healthy === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-xs text-muted-foreground">
          The {engineLabel} isn&apos;t reachable, so this view can&apos;t load. Make sure it&apos;s
          running, then retry.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={retry}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
          >
            <RefreshCwIcon className="size-3.5" />
            Retry
          </button>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted/50"
          >
            <ExternalLinkIcon className="size-3.5" />
            Open in new tab
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 w-full flex-1">
      {/* Skeleton overlay: shown while probing (healthy === null) or until the
          iframe fires `load`. Fades out so there's no blank flash. */}
      {(healthy === null || !loaded) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          Connecting to {engineLabel}…
        </div>
      )}
      {/* Mount the iframe only once we believe the engine is up (or there's no
          probe), so we don't burn a cross-origin load against a down sidecar. */}
      {healthy !== null && (
        <iframe
          src={src}
          title={title}
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 h-full w-full border-0"
        />
      )}
    </div>
  );
}
