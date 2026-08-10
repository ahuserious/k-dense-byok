"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  InterviewPayload,
  InterviewQuestion,
} from "@/components/interview-form";
import { apiFetch, useProjectScopeId } from "@/lib/projects";

interface PromptOptimizationInterviewState {
  stateVersion: 1;
  runId: string;
  nodeId: string;
  status: "pending" | "answered" | "cancelled" | "timed-out";
  questions: InterviewPayload;
  deadlineAt: number;
}

type AnswerValue = string | string[];
const POLL_INTERVAL_MS = 2_000;
const FAILURE_BACKOFF_START_MS = 500;
const FAILURE_BACKOFF_CAP_MS = 8_000;

function optionLabel(option: string | { label: string }): string {
  return typeof option === "string" ? option : option.label;
}

function initialValue(question: InterviewQuestion): AnswerValue {
  if (question.type === "multi") return [];
  if (question.conviction === "strong" && typeof question.recommended === "string") {
    return question.recommended;
  }
  return "";
}

/** Durable workflow-run interview UI; it never posts to the chat-session tool route. */
export function PromptOptimizationInterview({
  runId,
  nodeId,
  projectId,
  runActive,
}: {
  runId: string;
  nodeId: string;
  projectId?: string;
  runActive: boolean;
}) {
  const scopedProjectId = useProjectScopeId();
  const effectiveProjectId = projectId ?? scopedProjectId;
  const [state, setState] = useState<PromptOptimizationInterviewState | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const basePath = `/dag-workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/prompt-opt-interview`;

  useEffect(() => {
    if (!runActive) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const controller = new AbortController();
    const schedule = (delayMs: number) => {
      if (!disposed && runActive) timer = setTimeout(refresh, delayMs);
    };
    async function refresh() {
      try {
        const response = await apiFetch(basePath, { signal: controller.signal }, effectiveProjectId);
        const body = await response.json() as { state?: PromptOptimizationInterviewState | null };
        if (!response.ok) throw new Error("Unable to load prompt optimization interview.");
        if (disposed) return;
        consecutiveFailures = 0;
        setError(null);
        setState(body.state ?? null);
        if (!body.state || body.state.status === "pending") schedule(POLL_INTERVAL_MS);
      } catch (cause) {
        if (disposed || controller.signal.aborted) return;
        consecutiveFailures += 1;
        setError(cause instanceof Error ? cause.message : "Interview failed.");
        schedule(Math.min(
          FAILURE_BACKOFF_CAP_MS,
          FAILURE_BACKOFF_START_MS * (2 ** (consecutiveFailures - 1)),
        ));
      }
    }
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [basePath, effectiveProjectId, runActive]);

  useEffect(() => {
    if (!state) return;
    setAnswers((current) => {
      const next = { ...current };
      for (const question of state.questions.questions) {
        if (question.type !== "info" && next[question.id] === undefined) {
          next[question.id] = initialValue(question);
        }
      }
      return next;
    });
  }, [state]);

  const answerableQuestions = useMemo(
    () => state?.questions.questions.filter((question) => question.type !== "info") ?? [],
    [state],
  );

  const submit = async (cancelled: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const body = cancelled
        ? { cancelled: true }
        : {
            cancelled: false,
            responses: answerableQuestions.map((question) => ({
              id: question.id,
              value: answers[question.id] ?? initialValue(question),
            })),
          };
      const response = await apiFetch(`${basePath}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, effectiveProjectId);
      const result = await response.json() as { state?: PromptOptimizationInterviewState; detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "Unable to submit interview answers.");
      if (result.state) setState(result.state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Interview submission failed.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!runActive) return null;
  if (!state) return error ? <p className="text-xs text-destructive">{error}</p> : null;
  if (state.status !== "pending") {
    return (
      <p className="text-xs text-muted-foreground" data-prompt-opt-interview-status={state.status}>
        {state.status === "answered"
          ? "Optimization interview answered."
          : state.status === "cancelled"
            ? "Optimization interview dismissed."
            : "Optimization interview timed out."}
      </p>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border p-3" data-prompt-optimization-interview="true">
      <div>
        <h3 className="text-sm font-semibold">{state.questions.title}</h3>
        {state.questions.description && (
          <p className="text-xs text-muted-foreground">{state.questions.description}</p>
        )}
      </div>
      {state.questions.questions.map((question) => (
        <div key={question.id} className="space-y-1.5">
          <p className="text-sm font-medium">{question.question}</p>
          {question.context && <p className="text-xs text-muted-foreground">{question.context}</p>}
          {(question.type === "single" || question.type === "multi") && (
            <div className="flex flex-wrap gap-2">
              {(question.options ?? []).map((option) => {
                const label = optionLabel(option);
                const selected = question.type === "single"
                  ? answers[question.id] === label
                  : Array.isArray(answers[question.id]) && answers[question.id].includes(label);
                return (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    disabled={submitting}
                    onClick={() => setAnswers((current) => {
                      if (question.type === "single") return { ...current, [question.id]: label };
                      const existing = current[question.id];
                      const values = Array.isArray(existing) ? existing : [];
                      return {
                        ...current,
                        [question.id]: selected
                          ? values.filter((value) => value !== label)
                          : [...values, label],
                      };
                    })}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          )}
          {question.type === "text" && (
            <Textarea
              value={((answer) => (typeof answer === "string" ? answer : ""))(answers[question.id])}
              disabled={submitting}
              onChange={(event) => setAnswers((current) => ({
                ...current,
                [question.id]: event.target.value,
              }))}
            />
          )}
        </div>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={submitting} onClick={() => void submit(false)}>
          Submit answers
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={() => void submit(true)}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
