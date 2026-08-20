# Schedules — running a workflow on a clock

A **schedule** runs one of your typed workflows again and again, on a cron expression or a fixed
interval, without anyone pressing anything. You create and operate schedules in the **Console** tab,
under **Agents & Loops**.

A scheduled run is an ordinary workflow run. It appears in the same run feed, obeys the same budget
and iteration limits, and is cancelled the same way. The schedule decides *when*; everything after
that is the workflow engine you already use.

---

## Creating one

1. Open **Console → Agents & Loops**.
2. Press **New schedule**.
3. Choose the **workflow**, give the schedule a **name**, write **when** it should run, set the
   **timezone**, and choose what happens if the previous run has not finished.
4. Optionally give a **goal**, which is passed to every run the schedule starts.
5. Press **Create schedule**.

The whole form is keyboard-operable and every field has a visible label. If the project has no typed
workflows yet, the workflow picker is **disabled and says so** — create a workflow in Scientific
Pipelines first.

**Editing replaces the input, it does not merge it.** The goal and variables you send when you edit a
schedule become the schedule's whole input; anything you leave out is dropped. That is deliberate:
the Console edit form submits the displayed goal and preserves any stored variables verbatim, while
an API client can replace both explicitly. Merging would leave no way to express "this schedule now
has no variables". Editing changes future windows only — a window that has already run keeps the
input it ran with.

## Writing "when"

Two forms are accepted.

### `cron:<minute> <hour> <day-of-month> <month> <day-of-week>`

Standard five-field cron, evaluated against the **wall clock of the timezone you chose**.

| example | meaning |
|---|---|
| `cron:0 9 * * 1-5` | 09:00 every weekday |
| `cron:30 6 * * *` | 06:30 every day |
| `cron:0,30 9-17 * * *` | on the hour and the half hour, 09:00–17:00 |
| `cron:0 3 1 * *` | 03:00 on the first of every month |

Fields accept `*`, a number, a range (`9-17`), a step (written after a slash, e.g. every third
minute), and comma-separated lists of those. Day-of-week is `0`–`6` with `0` = Sunday; `7` is also
accepted as Sunday.

**The day pair follows the usual cron rule:** if you restrict *both* day-of-month and day-of-week, a
day matches when **either** matches. If you restrict only one, only that one is consulted.

An expression that can never match — `cron:0 0 30 2 *`, the 30th of February — is accepted and
reported honestly: the Console shows its next fire time as **never**.

### `every:<n>s`, `every:<n>m`, `every:<n>h`

A fixed interval on absolute time: `every:30s`, `every:5m`, `every:2h`. Minimum one second, maximum
365 days.

Interval windows are aligned to the Unix epoch, so `every:5m` fires at :00, :05, :10 … regardless of
when you created it, and every process and every restart agrees on where the boundaries are.
Intervals ignore timezones and daylight saving by construction.

## Timezones and daylight saving

A schedule stores an IANA timezone (`Australia/Sydney`, `America/New_York`, `UTC`, …). Cron
expressions are evaluated against that zone's wall clock, which means twice a year a local time is
either missing or duplicated. The rules are:

- **A local time that daylight saving skips is skipped.** In `America/New_York` the clocks jump from
  02:00 to 03:00 on 2026-03-08, so 02:30 does not exist that day. A `cron:30 2 * * *` schedule fires
  on the 7th and the 9th and **not** on the 8th. It is not shifted to 01:30 or 03:30.
- **A local time that daylight saving repeats runs once.** On 2026-11-01 in `America/New_York`, 01:30
  happens twice. The schedule fires on the **first** occurrence. The second is recorded in the fire
  history as *"already run for this local time"*.

If you need a job to run exactly once per 24 hours with no DST edge cases at all, use `every:24h`
or set the schedule's timezone to `UTC`.

## What happens on a restart

Schedules live on disk, per project, so they survive a backend restart with their next fire time
unchanged.

Windows that came due while the backend was down are handled by an explicit catch-up policy:

- **At most one catch-up run per schedule, in one tick** — the **most recent** missed window only,
  and the backlog is drained in that single tick however large it is. Ten missed windows and ten
  thousand both produce exactly one run.
- It only runs if that window came due **within the last 15 minutes**. Anything older is recorded as
  *"skipped, past the catch-up grace period"* and is **not** run.
- **Every window that was deliberately skipped is recorded** in the fire history with its reason. A
  restart never produces a burst of catch-up runs, and it never hides what it skipped. Above 50
  missed windows the individual skips stop being listed one by one and a *"too many missed windows
  to enumerate"* entry says so, naming the window that was caught up; the enumeration limit affects
  the **audit detail only**, never which window runs.
- A **paused** schedule accrues no windows at all, so resuming one does not replay the pause. While
  it is paused its record is not rewritten and its "Last fire" time does not move.
- A schedule whose **time zone** is changed re-anchors the same way one whose expression is changed
  does: windows of the old zone that were never evaluated are not inherited, so a re-zoned schedule
  cannot fire the moment you save it.

## If the previous run is still going

Each schedule chooses:

- **Skip this window** (the default) — nothing is started while a previous run of that schedule is
  still going, and the window is recorded as *"skipped, previous run still going"*.
- **Start another run anyway** — every window starts its own run.

## Firing twice is safe

Each firing opportunity has a stable identity, and the run's id is derived from it. If the same
window is somehow fired twice — a restart replaying it, two processes racing, a double-clicked
**Run now** inside the same second — the second attempt returns the **existing** run instead of
creating a new one. There is no way to accidentally double-run a window.

## Stopping a runaway

There are two different things you may want, and the Console offers both:

| control | what it does |
|---|---|
| **Pause** | Stops future windows. A run that is already going keeps going. |
| **Stop everything** | Pauses the schedule **and** cancels every run it started that is still going. It reports how many runs it cancelled. |

**Delete** removes the schedule; it asks for confirmation first and does not cancel runs.

## Limits and budget

A scheduled run inherits the workflow definition's own limits — iterations, model calls, tokens,
cost, timeout, evidence policy — exactly as a run you start by hand does. A schedule cannot raise
them, and it is not offered a control that pretends it can.

Two other bounds apply:

- At most **4 schedules** start a run in any one tick. Over that, a window is recorded as
  *"deferred, tick fire limit reached"* and runs on the next tick — it is deferred, never dropped.
- At most **200 schedules** per project.

## The fire history

Press **History** on any schedule to see its recent windows. Each entry shows the window, what
happened, the resulting run and the run's current status. The outcome column reads the run's live
state, so it is never stale.

| what you may see | meaning |
|---|---|
| started a run | the window ran; the run id is shown |
| paused, not run | the schedule was paused when the window came due |
| skipped, previous run still going | overlap policy `skip` |
| skipped, older missed window | catch-up ran only the most recent missed window |
| skipped, past the catch-up grace period | the window was more than 15 minutes stale |
| too many missed windows to enumerate | more than 50 windows were missed; the entry names the one that was caught up |
| not run, server was shutting down | the backend closed mid-tick; the window is still due and is reconsidered on the next start |
| not run, project no longer exists | the schedule outlived its project; delete it, or re-create the project |
| deferred, tick fire limit reached | it will run on the next tick |
| already run for this local time | a daylight-saving fall-back repeat |
| not run, execution disabled in this server | this backend has no workflow controller |
| not run, workflow no longer exists | point the schedule at an existing workflow |
| not run, window already used with other settings | the window's run id was already used with a different input |

## When schedules cannot run at all

Some backends run without workflow execution enabled. In that case the scheduler **creates nothing**:
schedules stay listable and editable, every window is recorded as *"not run, execution disabled in
this server process"*, and the Console header says **ticker stopped** when the ticker itself is not
running. Nothing pretends to be scheduled that is not.
