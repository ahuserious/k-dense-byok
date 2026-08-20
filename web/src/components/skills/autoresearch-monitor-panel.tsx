"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cancelDagWorkflowRun } from "@/lib/dag-workflows";
import { useProjects } from "@/lib/use-projects";
import {
  evaluateAutoresearchRun,
  type AutoresearchEvaluation,
  type AutoresearchMonitorMode,
} from "@/lib/skill-curator";
import { F11_FOCUS_SCOPE } from "./focus-scope";

export interface AutoresearchMonitorPanelProps {
  projectId?: string;
  pollIntervalMs?: number;
}

export function AutoresearchMonitorPanel({
  projectId: explicitProjectId,
  pollIntervalMs = 2_000,
}: AutoresearchMonitorPanelProps) {
  const { activeProjectId } = useProjects();
  const projectId = explicitProjectId ?? activeProjectId;
  const [runId, setRunId] = useState("");
  const [mode, setMode] = useState<AutoresearchMonitorMode>("interactive");
  const [maxEvaluations, setMaxEvaluations] = useState(4);
  const [userInput, setUserInput] = useState("");
  const [evaluations, setEvaluations] = useState<AutoresearchEvaluation[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const monitorGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
      monitorGeneration.current += 1;
    };
  }, []);

  const wait = useCallback(
    () => new Promise<void>((resolve) => window.setTimeout(resolve, pollIntervalMs)),
    [pollIntervalMs],
  );

  const runAutonomous = useCallback(
    async (selectedRunId: string, bound: number) => {
      const generation = monitorGeneration.current + 1;
      monitorGeneration.current = generation;
      setMonitoring(true);
      let afterSeq = 0;
      try {
        for (let cycle = 1; cycle <= bound; cycle += 1) {
          if (monitorGeneration.current !== generation) break;
          const evaluation = await evaluateAutoresearchRun(
            selectedRunId,
            {
              mode: "autonomous",
              cycle,
              maxEvaluations: bound,
              afterSeq,
            },
            projectId,
          );
          if (!mounted.current || monitorGeneration.current !== generation) return;
          setEvaluations((current) => [...current, evaluation]);
          afterSeq = evaluation.nextAfterSeq;
          if (evaluation.state.terminal || cycle === bound) break;
          await wait();
        }
        if (mounted.current && monitorGeneration.current === generation) {
          setNotice("Autonomous monitoring stopped at its explicit evaluation bound or terminal state.");
        }
      } catch (cause) {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : "Autoresearch monitoring failed.");
        }
      } finally {
        if (mounted.current && monitorGeneration.current === generation) {
          setMonitoring(false);
        }
      }
    },
    [projectId, wait],
  );

  const evaluateInteractive = useCallback(async () => {
    const selectedRunId = runId.trim();
    if (!selectedRunId) {
      setError("Enter a workflow run id.");
      return;
    }
    setMonitoring(true);
    setError(null);
    setNotice(null);
    try {
      const evaluation = await evaluateAutoresearchRun(
        selectedRunId,
        {
          mode: "interactive",
          cycle: 1,
          maxEvaluations: 1,
          afterSeq: evaluations.at(-1)?.nextAfterSeq ?? 0,
          ...(userInput.trim() ? { userInput: userInput.trim() } : {}),
        },
        projectId,
      );
      setEvaluations((current) => [...current, evaluation]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Interactive evaluation failed.");
    } finally {
      setMonitoring(false);
    }
  }, [evaluations, projectId, runId, userInput]);

  const start = useCallback(() => {
    const selectedRunId = runId.trim();
    if (!selectedRunId) {
      setError("Enter a workflow run id.");
      return;
    }
    setError(null);
    setNotice(null);
    if (mode === "interactive") {
      void evaluateInteractive();
    } else {
      setEvaluations([]);
      void runAutonomous(selectedRunId, maxEvaluations);
    }
  }, [evaluateInteractive, maxEvaluations, mode, runAutonomous, runId]);

  const stopMonitoring = useCallback(() => {
    monitorGeneration.current += 1;
    setMonitoring(false);
    setNotice("Monitoring stopped. The workflow run was not changed.");
  }, []);

  const stopRun = useCallback(async () => {
    const selectedRunId = runId.trim();
    if (!selectedRunId) {
      setError("Enter a workflow run id.");
      return;
    }
    monitorGeneration.current += 1;
    setMonitoring(false);
    setStoppingRun(true);
    setError(null);
    try {
      const stopped = await cancelDagWorkflowRun(projectId, selectedRunId);
      setNotice(`Run ${selectedRunId} now reports ${stopped.state.status}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run could not be stopped.");
    } finally {
      setStoppingRun(false);
    }
  }, [projectId, runId]);

  const latest = evaluations.at(-1);

  return (
    <section
      aria-labelledby="autoresearch-monitor-title"
      className={`space-y-3 rounded-lg border p-3 ${F11_FOCUS_SCOPE}`}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="autoresearch-monitor-title" className="text-sm font-medium">
            Autoresearch² live monitor
          </h3>
          <Badge variant="outline" className="text-[10px]">
            RunState attached
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Critique a real run interactively or for a bounded number of autonomous cycles.
          Stop monitoring and Stop run are separate controls.
        </p>
      </div>

      <label className="block space-y-1 text-xs font-medium">
        Workflow run id
        <Input
          aria-label="Workflow run id"
          className="h-8 font-mono text-xs"
          value={runId}
          placeholder="wrun_…"
          disabled={monitoring}
          onChange={(event) => setRunId(event.target.value)}
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">Monitoring mode</legend>
        <div className="flex flex-wrap gap-2">
          {(["interactive", "autonomous"] as const).map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={mode === candidate ? "default" : "outline"}
              className="h-7 text-[11px]"
              aria-pressed={mode === candidate}
              disabled={monitoring}
              onClick={() => setMode(candidate)}
            >
              {candidate}
            </Button>
          ))}
        </div>
      </fieldset>

      {mode === "interactive" ? (
        <label className="block space-y-1 text-xs font-medium">
          User direction (answer the monitor&apos;s question)
          <Textarea
            aria-label="Interactive evaluation direction"
            className="min-h-20 text-xs"
            value={userInput}
            disabled={monitoring}
            placeholder="What outcome, assumption, or failure should be challenged?"
            onChange={(event) => setUserInput(event.target.value)}
          />
        </label>
      ) : (
        <label className="block space-y-1 text-xs font-medium">
          Maximum autonomous evaluations (1–20)
          <Input
            aria-label="Maximum autonomous evaluations"
            type="number"
            min={1}
            max={20}
            className="h-8 w-28 text-xs"
            value={maxEvaluations}
            disabled={monitoring}
            onChange={(event) => {
              const value = Number(event.target.value);
              setMaxEvaluations(Number.isFinite(value) ? Math.min(20, Math.max(1, value)) : 1);
            }}
          />
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={monitoring || stoppingRun} onClick={start}>
          {monitoring ? "Monitoring…" : mode === "interactive" ? "Evaluate with user" : "Start bounded monitor"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!monitoring}
          onClick={stopMonitoring}
        >
          Stop monitoring
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={stoppingRun || !runId.trim() || latest?.state.canStopRun === false}
          aria-describedby={
            latest?.state.canStopRun === false ? "autoresearch-stop-run-reason" : undefined
          }
          onClick={() => void stopRun()}
        >
          {stoppingRun ? "Stopping run…" : "Stop run"}
        </Button>
      </div>

      {latest?.state.canStopRun === false && (
        <p id="autoresearch-stop-run-reason" className="text-[11px] text-muted-foreground">
          Stop run is unavailable because the authoritative run state is terminal.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-destructive/50 p-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border bg-muted p-2 text-xs text-foreground">
          {notice}
        </p>
      )}

      {latest && (
        <div className="space-y-2" aria-live="polite">
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Badge variant="secondary">state: {latest.state.status}</Badge>
            <Badge variant="outline">last seq: {latest.state.lastSeq}</Badge>
            <Badge variant="outline">
              cycle {latest.cycle}/{latest.maxEvaluations}
            </Badge>
          </div>
          {latest.needsUserInput && latest.question && (
            <p className="rounded-md border p-2 text-xs">{latest.question}</p>
          )}
          <p className="rounded-md border p-2 text-[11px] text-muted-foreground">
            {latest.runStatePersistenceReason}
          </p>
          <ul className="space-y-1" aria-label="Autoresearch critiques">
            {latest.critiques.map((critique) => (
              <li key={critique.id} className="rounded-md border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{critique.title}</span>
                  <Badge variant="outline" className="text-[9px]">
                    {critique.severity}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{critique.detail}</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {critique.source.kind === "run-state"
                    ? `run-state lastSeq=${critique.source.lastSeq}`
                    : `event seq=${critique.source.seq} · ${critique.source.eventType}`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
