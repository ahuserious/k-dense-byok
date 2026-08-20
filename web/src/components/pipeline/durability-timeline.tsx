"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DurabilityApiError,
  readDurabilityState,
  readDurabilityTimeline,
  stopDurabilityRun,
  type DurabilityStopAvailability,
  type DurabilityTimelineEvent,
} from "@/lib/durability";

const POLL_INTERVAL_MS = 3_000;

function eventLabel(event: DurabilityTimelineEvent): string {
  switch (event.name) {
    case "durability.watch.started":
      return "Watcher started";
    case "durability.signal.fired":
      return `Signal fired${event.signal ? `: ${event.signal}` : ""}`;
    case "durability.signal.suppressed":
      return `Signal suppressed${event.signal ? `: ${event.signal}` : ""}`;
    case "durability.action.dispatched":
      return event.action === "lateral-pass"
        ? "Lateral pass dispatched"
        : `Action dispatched${event.action ? `: ${event.action}` : ""}`;
    case "durability.action.completed":
      return "Action completed";
    case "durability.action.failed":
      return "Action failed";
    case "durability.escalation.started":
      return "Rescue escalation started";
    case "durability.escalation.completed":
      return "Repair deployed and replacement run continued";
    case "durability.escalation.deferred":
      return "Rescue proposal waiting for approval";
    case "durability.stop.requested":
      return "Stop requested";
    case "durability.stop.completed":
      return "Stopped by durability watcher";
    case "durability.model.unresolved":
      return "Model unresolved";
    case "durability.watch.stopped":
      return "Watcher stopped";
  }
}

export function DurabilityTimeline({ runId }: { runId: string }) {
  const [events, setEvents] = useState<DurabilityTimelineEvent[]>([]);
  const [availability, setAvailability] = useState<DurabilityStopAvailability | null>(null);
  const [wired, setWired] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopStatus, setStopStatus] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopped = useRef(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const [timeline, state] = await Promise.all([
        readDurabilityTimeline(runId),
        readDurabilityState(),
      ]);
      setEvents(timeline.events);
      setAvailability(
        state.stopAvailability.find((entry) => entry.runId === runId) ?? null,
      );
      setWired(true);
      setError(null);
      const watching = state.watchedRuns.some((entry) => entry.runId === runId);
      const ended = timeline.events.some(
        (event) => event.name === "durability.watch.stopped",
      );
      return watching && !ended;
    } catch (cause) {
      if (cause instanceof DurabilityApiError && cause.status === 404) {
        setWired(false);
        setError(null);
      } else {
        setWired(true);
        setError(cause instanceof Error ? cause.message : "Durability timeline is unavailable.");
      }
      return false;
    }
  }, [runId]);

  useEffect(() => {
    stopped.current = false;
    setEvents([]);
    setAvailability(null);
    setWired(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const continuePolling = await refresh();
      if (continuePolling && !stopped.current) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      const receipt = await stopDurabilityRun(
        runId,
        "Stopped by the operator from workflow run details.",
      );
      setStopStatus(receipt.detail);
      setAvailability({
        runId,
        canStop: false,
        reason: "This run is already stopped.",
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The durability stop was refused.");
    } finally {
      setStopping(false);
    }
  };

  if (wired === null) {
    return (
      <p className="border-t px-4 py-2 text-[10px] text-muted-foreground">
        Checking durability timeline…
      </p>
    );
  }
  if (!wired) return null;
  if (events.length === 0 && !availability && !error) return null;

  return (
    <section
      aria-labelledby={`durability-timeline-${runId}`}
      data-testid="durability-timeline"
      className="border-t px-4 py-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 id={`durability-timeline-${runId}`} className="font-mono text-[11px] font-medium">
            Durability timeline
          </h4>
          <p className="text-[10px] text-muted-foreground">
            Watcher observations are interleaved by their recorded run sequence.
          </p>
        </div>
        {availability && (
          <div className="text-right">
            <button
              type="button"
              onClick={() => void stop()}
              disabled={!availability.canStop || stopping}
              aria-describedby={!availability.canStop ? `durability-stop-reason-${runId}` : undefined}
              className="rounded-md border px-2 py-1 text-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed"
            >
              {stopping ? "Stopping…" : "Stop watched run"}
            </button>
            {!availability.canStop && availability.reason && (
              <p
                id={`durability-stop-reason-${runId}`}
                className="mt-1 max-w-56 text-[10px] text-muted-foreground"
              >
                {availability.reason}
              </p>
            )}
          </div>
        )}
      </div>

      <ol className="mt-2 flex flex-col gap-1">
        {events.map((event) => (
          <li key={event.seq} className="rounded-md border px-2 py-1.5 text-[10px]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{eventLabel(event)}</span>
              <span className="font-mono text-muted-foreground">
                run seq {event.runLastSeq}
              </span>
              {event.model && (
                <span className="font-mono text-muted-foreground">{event.model}</span>
              )}
            </div>
            <p className="mt-0.5 text-muted-foreground">{event.detail}</p>
            {event.name === "durability.escalation.deferred" && event.proposalId && (
              <p className="mt-0.5 font-mono text-muted-foreground">
                Proposal {event.proposalId} is unapplied.
              </p>
            )}
          </li>
        ))}
      </ol>
      {stopStatus && <p role="status" className="mt-2 text-[10px] text-muted-foreground">{stopStatus}</p>}
      {error && <p role="alert" className="mt-2 text-[10px] text-destructive">{error}</p>}
    </section>
  );
}
