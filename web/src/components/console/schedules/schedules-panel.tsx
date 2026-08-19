// danbot-byok — web/src/components/console/schedules/schedules-panel.tsx
//
// The Console's schedules surface (lane F13, matrix row 52): a list of
// schedules with create / edit / enable / disable / delete, the server-computed
// next fire time, the fire history, and BOTH stop controls — pausing the
// schedule so no further window fires, and cancelling the run a window already
// started.
//
// It follows kady-console.tsx's idiom exactly: same 3000 ms poll, same
// black/monospace raindrop surface, same "error is a string in state, rendered
// as text" pattern. Every response is validated in lib/schedules.ts before it
// reaches state, so a malformed-but-200 body degrades to the error line instead
// of throwing in render phase (defect #62).
//
// Status is never expressed by colour alone (§6.6): every state is a word, and
// the glyph in front of it is redundant reinforcement, not the signal.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  createSchedule,
  deleteSchedule,
  listSchedulableWorkflows,
  listScheduleFires,
  listSchedules,
  runScheduleNow,
  setScheduleEnabled,
  stopSchedule,
  updateSchedule,
  type Schedule,
  type ScheduleFire,
  type SchedulableWorkflow,
} from "@/lib/schedules";
import {
  BUTTON_CLASS,
  ScheduleForm,
  browserTimeZone,
  type ScheduleFormValues,
} from "./schedule-form";

const POLL_MS = 3000;

/** Reason → the sentence shown in the fire history's Outcome column. */
const REASON_LABEL: Record<string, string> = {
  dispatched: "started a run",
  disabled: "paused, not run",
  "overlap-skipped": "skipped, previous run still going",
  "catchup-skipped": "skipped, older missed window",
  "catchup-expired": "skipped, past the catch-up grace period",
  "catchup-truncated": "too many missed windows to enumerate",
  "capacity-deferred": "deferred, tick fire limit reached",
  "duplicate-window": "already run for this local time",
  "controller-absent": "not run, execution disabled in this server",
  "definition-missing": "not run, workflow no longer exists",
  conflict: "not run, window already used with other settings",
  error: "not run, see the reason",
};

function emptyFormValues(): ScheduleFormValues {
  return {
    workflowId: "",
    name: "",
    expression: "every:5m",
    timezone: browserTimeZone(),
    overlapPolicy: "skip",
    goal: "",
  };
}

function formValuesOf(schedule: Schedule): ScheduleFormValues {
  return {
    workflowId: schedule.workflow_id,
    name: schedule.name,
    expression: schedule.expression,
    timezone: schedule.timezone,
    overlapPolicy: schedule.overlap_policy,
    goal: schedule.goal,
  };
}

/** Absolute local time plus a relative hint; both, because either alone lies. */
function whenLabel(iso: string | null): string {
  if (iso === null) return "never";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "unknown";
  const seconds = Math.round((parsed - Date.now()) / 1000);
  const absolute = new Date(parsed).toLocaleString();
  if (seconds >= 0) {
    if (seconds < 60) return `${absolute} (in ${seconds}s)`;
    if (seconds < 3600) return `${absolute} (in ${Math.round(seconds / 60)}m)`;
    return `${absolute} (in ${Math.round(seconds / 3600)}h)`;
  }
  const ago = -seconds;
  if (ago < 60) return `${absolute} (${ago}s ago)`;
  if (ago < 3600) return `${absolute} (${Math.round(ago / 60)}m ago)`;
  return `${absolute} (${Math.round(ago / 3600)}h ago)`;
}

export function SchedulesPanel() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [workflows, setWorkflows] = useState<SchedulableWorkflow[]>([]);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [schedulerRunning, setSchedulerRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [fires, setFires] = useState<ScheduleFire[]>([]);
  const [firesError, setFiresError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const listing = await listSchedules();
      if (!mounted.current) return;
      setSchedules(listing.schedules);
      setSchedulerRunning(listing.schedulerRunning);
      setError(null);
    } catch (caught) {
      if (mounted.current) setError((caught as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const refreshWorkflows = useCallback(async () => {
    try {
      const available = await listSchedulableWorkflows();
      if (!mounted.current) return;
      setWorkflows(available);
      setWorkflowsError(
        available.length === 0
          ? "No workflows exist in this project yet. Create one in Scientific Pipelines first."
          : null,
      );
    } catch (caught) {
      if (mounted.current) setWorkflowsError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshWorkflows();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh, refreshWorkflows]);

  const loadFires = useCallback(async (scheduleId: string) => {
    try {
      const history = await listScheduleFires(scheduleId, 20);
      if (!mounted.current) return;
      setFires(history);
      setFiresError(null);
    } catch (caught) {
      if (mounted.current) {
        setFires([]);
        setFiresError((caught as Error).message);
      }
    }
  }, []);

  useEffect(() => {
    if (historyFor === null) return;
    void loadFires(historyFor);
    const id = setInterval(() => void loadFires(historyFor), POLL_MS);
    return () => clearInterval(id);
  }, [historyFor, loadFires]);

  async function withBusy(scheduleId: string, action: () => Promise<string | null>) {
    setBusyId(scheduleId);
    setNotice(null);
    try {
      const message = await action();
      if (!mounted.current) return;
      setError(null);
      if (message) setNotice(message);
      await refresh();
    } catch (caught) {
      if (mounted.current) setError((caught as Error).message);
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function submitCreate(values: ScheduleFormValues) {
    setFormError(null);
    setBusyId("new");
    try {
      await createSchedule({
        workflowId: values.workflowId,
        name: values.name,
        expression: values.expression,
        timezone: values.timezone,
        overlapPolicy: values.overlapPolicy,
        ...(values.goal ? { goal: values.goal } : {}),
      });
      if (!mounted.current) return;
      setCreating(false);
      await refresh();
    } catch (caught) {
      if (mounted.current) setFormError((caught as Error).message);
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function submitEdit(scheduleId: string, values: ScheduleFormValues) {
    setFormError(null);
    setBusyId(scheduleId);
    try {
      await updateSchedule(scheduleId, {
        workflowId: values.workflowId,
        name: values.name,
        expression: values.expression,
        timezone: values.timezone,
        overlapPolicy: values.overlapPolicy,
        goal: values.goal,
      });
      if (!mounted.current) return;
      setEditingId(null);
      await refresh();
    } catch (caught) {
      if (mounted.current) setFormError((caught as Error).message);
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  return (
    <section className="border-b border-white/10" aria-label="Schedules">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          Schedules
        </span>
        <span className="text-[11px] text-zinc-400">
          {schedules.length} schedule{schedules.length === 1 ? "" : "s"}
        </span>
        {schedulerRunning === false && (
          <span className="text-[11px] text-amber-300">
            ⚠ ticker stopped — nothing will fire
          </span>
        )}
        <button
          type="button"
          className={cn(BUTTON_CLASS, "ml-auto")}
          onClick={() => {
            setFormError(null);
            setEditingId(null);
            setCreating((open) => !open);
          }}
          aria-expanded={creating}
        >
          {creating ? "Close new schedule" : "New schedule"}
        </button>
      </div>

      {creating && (
        <ScheduleForm
          heading="New schedule"
          submitLabel="Create schedule"
          initialValues={emptyFormValues()}
          workflows={workflows}
          workflowsUnavailableReason={workflowsError}
          busy={busyId === "new"}
          error={formError}
          onSubmit={(values) => void submitCreate(values)}
          onCancel={() => {
            setCreating(false);
            setFormError(null);
          }}
        />
      )}

      {error !== null && (
        <p role="alert" className="px-3 py-1.5 text-[11px] text-red-400">
          Couldn&apos;t reach the schedules API: {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="px-3 py-1.5 text-[11px] text-amber-300">
          {notice}
        </p>
      )}

      {loading && schedules.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-zinc-400">Loading schedules…</p>
      ) : schedules.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-zinc-400">
          No schedules yet. Use “New schedule” to run a workflow on a cron expression or a fixed
          interval.
        </p>
      ) : (
        <table className="w-full border-collapse text-[11px]">
          <caption className="sr-only">
            Schedules, their next fire time and their controls
          </caption>
          <thead>
            <tr className="text-left text-zinc-400">
              <th className="px-2 py-1 font-normal">Name</th>
              <th className="px-2 py-1 font-normal">When</th>
              <th className="px-2 py-1 font-normal">State</th>
              <th className="px-2 py-1 font-normal">Next fire</th>
              <th className="px-2 py-1 font-normal">Last fire</th>
              <th className="px-2 py-1 font-normal">Controls</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((schedule) => (
              <tr key={schedule.id} className="border-t border-white/5 align-top">
                <td className="px-2 py-1.5">
                  <div className="text-zinc-100">{schedule.name}</div>
                  <div className="text-zinc-400">{schedule.workflow_id}</div>
                </td>
                <td className="px-2 py-1.5">
                  <div className="text-zinc-200">{schedule.expression}</div>
                  <div className="text-zinc-400">{schedule.timezone}</div>
                </td>
                <td className="px-2 py-1.5">
                  <span
                    className={schedule.enabled ? "text-emerald-400" : "text-zinc-400"}
                    data-testid={`schedule-state-${schedule.id}`}
                  >
                    {schedule.enabled ? "● enabled" : "‖ paused"}
                  </span>
                  <div className="text-zinc-400">
                    overlap: {schedule.overlap_policy === "skip" ? "skip" : "allow"}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-zinc-200">
                  {schedule.enabled ? whenLabel(schedule.next_fire_at) : "paused"}
                </td>
                <td className="px-2 py-1.5">
                  <div className="text-zinc-200">{whenLabel(schedule.last_fire_at)}</div>
                  {schedule.last_fire_reason !== null && (
                    <div
                      className={
                        schedule.last_fire_reason === "dispatched"
                          ? "text-zinc-400"
                          : "text-amber-300"
                      }
                    >
                      {REASON_LABEL[schedule.last_fire_reason] ?? schedule.last_fire_reason}
                      {schedule.last_run_status ? ` · ${schedule.last_run_status}` : ""}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      disabled={busyId === schedule.id}
                      onClick={() =>
                        void withBusy(schedule.id, async () => {
                          await setScheduleEnabled(schedule.id, !schedule.enabled);
                          return null;
                        })
                      }
                    >
                      {schedule.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      disabled={busyId === schedule.id}
                      onClick={() =>
                        void withBusy(schedule.id, async () => {
                          const fire = await runScheduleNow(schedule.id);
                          return fire.reason === "dispatched"
                            ? "Run started."
                            : `Did not run: ${fire.detail}`;
                        })
                      }
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      disabled={busyId === schedule.id}
                      title="Pause the schedule and cancel any run it already started"
                      onClick={() =>
                        void withBusy(schedule.id, async () => {
                          const result = await stopSchedule(schedule.id);
                          return result.cancelledRunIds.length === 0
                            ? "Schedule paused. No run of it was still going."
                            : `Schedule paused and ${result.cancelledRunIds.length} run(s) cancelled.`;
                        })
                      }
                    >
                      Stop everything
                    </button>
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      disabled={busyId === schedule.id}
                      aria-expanded={editingId === schedule.id}
                      onClick={() => {
                        setFormError(null);
                        setCreating(false);
                        setEditingId((current) => (current === schedule.id ? null : schedule.id));
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={BUTTON_CLASS}
                      aria-expanded={historyFor === schedule.id}
                      onClick={() =>
                        setHistoryFor((current) => (current === schedule.id ? null : schedule.id))
                      }
                    >
                      History
                    </button>
                    {confirmingDeleteId === schedule.id ? (
                      <>
                        <button
                          type="button"
                          className={cn(BUTTON_CLASS, "text-red-400")}
                          disabled={busyId === schedule.id}
                          onClick={() =>
                            void withBusy(schedule.id, async () => {
                              await deleteSchedule(schedule.id);
                              setConfirmingDeleteId(null);
                              if (historyFor === schedule.id) setHistoryFor(null);
                              return "Schedule deleted.";
                            })
                          }
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => setConfirmingDeleteId(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        disabled={busyId === schedule.id}
                        onClick={() => setConfirmingDeleteId(schedule.id)}
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  {editingId === schedule.id && (
                    <ScheduleForm
                      heading={`Edit ${schedule.name}`}
                      submitLabel="Save changes"
                      initialValues={formValuesOf(schedule)}
                      workflows={workflows}
                      workflowsUnavailableReason={workflowsError}
                      busy={busyId === schedule.id}
                      error={formError}
                      onSubmit={(values) => void submitEdit(schedule.id, values)}
                      onCancel={() => {
                        setEditingId(null);
                        setFormError(null);
                      }}
                    />
                  )}

                  {historyFor === schedule.id && (
                    <div className="pt-2" aria-label={`Fire history for ${schedule.name}`}>
                      {firesError !== null ? (
                        <p role="alert" className="text-[11px] text-red-400">
                          Couldn&apos;t read the fire history: {firesError}
                        </p>
                      ) : fires.length === 0 ? (
                        <p className="text-[11px] text-zinc-400">
                          Nothing has fired yet. The next window is shown in the Next fire column.
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {fires.map((fire) => (
                            <li key={fire.fire_id} className="text-[11px] text-zinc-200">
                              <span className="text-zinc-400">{fire.window_key}</span>
                              {" · "}
                              <span
                                className={
                                  fire.reason === "dispatched" ? "text-emerald-400" : "text-amber-300"
                                }
                              >
                                {REASON_LABEL[fire.reason] ?? fire.reason}
                              </span>
                              {fire.run_id !== null && (
                                <>
                                  {" · "}
                                  <span className="text-zinc-200">{fire.run_id}</span>
                                  {fire.run_status !== null && (
                                    <span className="text-zinc-400"> ({fire.run_status})</span>
                                  )}
                                </>
                              )}
                              {fire.reason !== "dispatched" && (
                                <div className="text-zinc-400">{fire.detail}</div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
