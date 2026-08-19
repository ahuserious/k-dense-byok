// danbot-byok — web/src/components/console/schedules/schedule-form.tsx
//
// The create/edit form for one schedule. Inline, not an overlay: everything it
// asks for fits on the Console surface, and an inline form has no focus trap to
// get wrong. Every field carries a visible <label> (not just an aria-label), so
// the current value, the units and the validity are legible without hovering.
//
// Design notes (Gate D):
//   - Colours are Tailwind palette utilities matching the surrounding raindrop
//     surface (kady-console.tsx: bg-black, monospace, white-overlay rows). No
//     raw hex/rgb/hsl literal is introduced anywhere in this lane.
//   - Secondary text is text-zinc-400, not the text-zinc-500 the neighbouring
//     rows use: zinc-500 on black measures 4.34:1, below the 4.5:1 body-text
//     floor. zinc-400 measures 8.2:1.
//   - Focus is a 2px amber-300 ring with a black offset — a real ring, never an
//     opacity change (§6.6: a dimmed ring is an invisible ring).

"use client";

import { useEffect, useId, useState } from "react";
import type { ScheduleOverlapPolicy } from "@/lib/schedules";

export interface ScheduleFormValues {
  workflowId: string;
  name: string;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  goal: string;
}

export interface ScheduleFormProps {
  heading: string;
  submitLabel: string;
  initialValues: ScheduleFormValues;
  workflows: Array<{ id: string; name: string }>;
  workflowsUnavailableReason: string | null;
  busy: boolean;
  error: string | null;
  onSubmit: (values: ScheduleFormValues) => void;
  onCancel: () => void;
}

export const FIELD_CLASS =
  "w-full rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-zinc-100 " +
  "placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black";

export const BUTTON_CLASS =
  "rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/10 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-black " +
  "disabled:cursor-not-allowed disabled:border-white/10 disabled:text-zinc-400";

/** The browser's own zone, so the default is the one the user actually lives in. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ScheduleForm({
  heading,
  submitLabel,
  initialValues,
  workflows,
  workflowsUnavailableReason,
  busy,
  error,
  onSubmit,
  onCancel,
}: ScheduleFormProps) {
  const [values, setValues] = useState<ScheduleFormValues>(initialValues);
  const fieldPrefix = useId();

  useEffect(() => {
    setValues(initialValues);
  }, [initialValues]);

  const workflowFieldId = `${fieldPrefix}-workflow`;
  const nameFieldId = `${fieldPrefix}-name`;
  const expressionFieldId = `${fieldPrefix}-expression`;
  const timezoneFieldId = `${fieldPrefix}-timezone`;
  const overlapFieldId = `${fieldPrefix}-overlap`;
  const goalFieldId = `${fieldPrefix}-goal`;
  const workflowHintId = `${fieldPrefix}-workflow-hint`;

  return (
    <form
      className="border-b border-white/10 px-3 py-2"
      aria-label={heading}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {heading}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block pb-0.5 text-[10px] text-zinc-400" htmlFor={workflowFieldId}>
            Workflow
          </label>
          <select
            id={workflowFieldId}
            className={FIELD_CLASS}
            value={values.workflowId}
            disabled={workflowsUnavailableReason !== null}
            aria-describedby={workflowsUnavailableReason ? workflowHintId : undefined}
            onChange={(event) => setValues({ ...values, workflowId: event.target.value })}
          >
            <option value="">Choose a workflow…</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name} ({workflow.id})
              </option>
            ))}
          </select>
          {workflowsUnavailableReason !== null && (
            <p id={workflowHintId} className="pt-0.5 text-[10px] text-amber-300">
              {workflowsUnavailableReason}
            </p>
          )}
        </div>

        <div>
          <label className="block pb-0.5 text-[10px] text-zinc-400" htmlFor={nameFieldId}>
            Name
          </label>
          <input
            id={nameFieldId}
            className={FIELD_CLASS}
            value={values.name}
            placeholder="Nightly evidence sweep"
            onChange={(event) => setValues({ ...values, name: event.target.value })}
          />
        </div>

        <div>
          <label className="block pb-0.5 text-[10px] text-zinc-400" htmlFor={expressionFieldId}>
            When
          </label>
          <input
            id={expressionFieldId}
            className={FIELD_CLASS}
            value={values.expression}
            placeholder="cron:0 9 * * 1-5"
            onChange={(event) => setValues({ ...values, expression: event.target.value })}
          />
          <p className="pt-0.5 text-[10px] text-zinc-400">
            Five-field cron in the timezone below, or an interval: every:30s, every:5m, every:2h.
          </p>
        </div>

        <div>
          <label className="block pb-0.5 text-[10px] text-zinc-400" htmlFor={timezoneFieldId}>
            Timezone
          </label>
          <input
            id={timezoneFieldId}
            className={FIELD_CLASS}
            value={values.timezone}
            placeholder="Australia/Sydney"
            onChange={(event) => setValues({ ...values, timezone: event.target.value })}
          />
          <p className="pt-0.5 text-[10px] text-zinc-400">
            A local time that daylight saving skips is skipped; a local time that repeats runs once.
          </p>
        </div>

        <div>
          <label className="block pb-0.5 text-[10px] text-zinc-400" htmlFor={overlapFieldId}>
            If the previous run is still going
          </label>
          <select
            id={overlapFieldId}
            className={FIELD_CLASS}
            value={values.overlapPolicy}
            onChange={(event) =>
              setValues({
                ...values,
                overlapPolicy: event.target.value === "allow" ? "allow" : "skip",
              })
            }
          >
            <option value="skip">Skip this window</option>
            <option value="allow">Start another run anyway</option>
          </select>
        </div>

        <div>
          <label className="block pb-0.5 text-[10px] text-zinc-400" htmlFor={goalFieldId}>
            Goal passed to each run (optional)
          </label>
          <input
            id={goalFieldId}
            className={FIELD_CLASS}
            value={values.goal}
            placeholder="Summarise yesterday's evidence"
            onChange={(event) => setValues({ ...values, goal: event.target.value })}
          />
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="pt-1.5 text-[11px] text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 pt-2">
        <button type="submit" className={BUTTON_CLASS} disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" className={BUTTON_CLASS} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
