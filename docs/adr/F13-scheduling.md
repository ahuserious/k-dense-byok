# ADR F13 — a durable scheduler that decides *when*, and reuses everything else

- **Lane:** F13 (requirement matrix row 52 — "cron jobs: add & configure in the Console")
- **Status:** accepted, implemented in this lane
- **Base:** `b702a8b`
- **Scope:** `server/src/scheduling/**`, `server/src/api/schedules.ts`,
  `web/src/components/console/schedules/**`, `web/src/lib/schedules.ts`

## Context

Row 52 is one of the few genuinely greenfield items in Wave F: `grep -riE '\bcron\b'` over
`server/src` and `web/src` returns nothing, and the 55 `schedul*` hits are all node-scheduling inside
one run, poll debounces, or comments. The reachability audit
(`…/wave-f/reports/F13-audit.md`) has the full evidence.

Greenfield at the *scheduling* layer does not mean greenfield below it. The tree already has a
durable run store with lifecycle locking, idempotent run creation, budget/limit inheritance, a run
controller with cancellation, and a Console that observes runs. Building a second copy of any of that
would be the worst outcome available to this wave. The decisions below are mostly decisions about
what **not** to write.

---

## Decision 1 — the fire path is the existing run-creation route, dispatched in-process

At fire time the ticker issues `app.inject({ method: "POST", url: "/dag-workflows/<id>/runs", … })`
against its own Fastify instance, rather than calling `workflowStore.createRun` + `controller.start`
itself.

**Why.** It is byte-for-byte the same handler a user hits from the UI, so a scheduled run is not
*claimed* to behave like a manual one — it *is* one. Revision checks, run-file precondition
validation, `effectiveLimits` inheritance and the controller hand-off all come from the same code.
It also needs no reference to `workflowController`, which is constructed inside `server/src/index.ts`
(not this lane's file) and handed only to `registerDagWorkflowRoutes`.

**Cost.** `app.inject` is light-my-request, usually seen in tests. It builds one synthetic request
object per fire — a handful per minute at most — and runs the real plugin chain, including the
project-scope `preHandler` (the ticker passes `X-Project-Id` explicitly).

**Consequence.** The route hard-codes `requestedBy: "user"` (`api/dag-workflows.ts:476`) and offers
no way for a caller to change it. See decision 3.

## Decision 2 — idempotency is a property of the requestId, not a table

`requestId = schedule:<scheduleId>:<windowKey>`. `store.ts:1265` derives the run id from
`sha256(projectId \0 requestId)`, and `store.ts:2368-2377` returns the **existing** manifest when a
run for that id already exists with the same request intent. Therefore a window fired twice — by a
restart replaying it, a duplicated timer, or two racing processes — yields **one** run, with no dedup
table, no lock and no bookkeeping of ours.

Window keys differ by expression kind, which is what makes decision 5 fall out for free:

| kind | window key | example |
|---|---|---|
| `every:<n>{s,m,h}` | the epoch-aligned UTC instant | `1787109600000` |
| `cron:<5 fields>` | the **local wall-clock minute** | `2026-11-01T01:30` |

Proved by `server/test/scheduling.test.ts` → *"fires the same window twice and gets ONE run"*, which
rewinds the cursor and asserts a single run id and a single run in the store.

**Known limit.** Idempotency is per *window*, not per *schedule*: two different windows of an
`overlapPolicy: "allow"` schedule are two runs, deliberately.

**Known limit.** `createRun` throws `CONFLICT` when the same requestId is reused with a *different*
intent. Editing a schedule's `input` and then re-firing an already-used window therefore does not
create a second run; it is recorded as `conflict` with a sentence saying so, rather than swallowed.

## Decision 3 — `requestedBy: "user"`, no contract change requested, and what that costs

`requestedBy` is the frozen union `"user" | "agent" | "api"` (`store.ts:181`, `run-state.ts:169`),
enforced at runtime by `validateCreateRunInput`. RunState v1 is orchestrator-only and frozen, so
adding `"schedule"` would be a cross-team contract request and a blocking dependency. **This lane
requests no contract change.**

Orchestrator E's brief specified `requestedBy: "api"`. Decision 1 makes that unreachable: the
run-creation route hard-codes `"user"` and this lane does not own that file. The deviation is in the
safe direction — the brief's point was that provenance must not require a contract change, and it
does not.

**The honest cost:** a reader of a run manifest alone **cannot** distinguish a scheduled fire from a
manual one except by parsing the `requestId` for the `schedule:` prefix. `requestedBy` is not a
discriminator for scheduled runs and must not be used as one. The deterministic and unattended-fire
tests assert the persisted value is `"user"` so evidence cannot silently call it `"api"`. Closing
this properly without letting public callers spoof audit origin needs a trusted shared dispatch
function used by both the route and scheduler; that is Team B's and is recorded in `INTEGRATION.md`
as a non-blocking follow-up.

## Decision 4 — catch-up: at most one, most-recent-only, inside a stated grace period

Each schedule persists `cursorMs`: *every firing opportunity at or before this instant has been
considered.*

- The **most recent** window at or before now is the only candidate for a fire, and it is computed
  **independently of any enumeration**, by `latestWindowAtOrBefore` (`scheduling/expression.ts`).
  The search starts at `max(cursorMs, now - grace)`, so it costs the same after a week down as after
  a minute, and the cursor jumps straight to that window: **the backlog drains in ONE tick whatever
  its size**.
- Every older window gets its own `catchup-skipped` fire record. A silent skip is as bad as a
  stampede, so the skips are enumerated, not summarised away — but the enumeration is capped at
  `MAX_ENUMERATED_MISSED_WINDOWS` (50) and the cap is recorded as `catchup-truncated`, naming the
  window that WAS caught up. **The cap governs the audit detail only. It has no influence on which
  window fires.**
- If nothing at all falls inside `DEFAULT_CATCH_UP_GRACE_MS` (15 minutes) the whole backlog is
  refused with one `catchup-expired` record that says how many windows were passed over, and the
  cursor moves to *now* so the refusal is not repeated once per tick. A backend that was down for a
  week does not wake up firing.
- A **paused** schedule accrues no windows at all. Its cursor stands still and its record is written
  exactly once (the first window passed over, recorded as `disabled`); the enable route re-anchors
  `cursorMs` to now, which is what makes resuming safe without a per-tick write.

### Round-1 defect and why the algorithm changed

Round 1 derived the target from `windowsBetween(...).windows[length - 1]`. `windowsBetween` truncates
to the **fifty oldest** windows, so above the cap that expression selects the fiftieth-oldest window,
not the most recent: an `every:1s` schedule ten minutes behind fired a window 550 s stale — still
inside the grace period, so it really did dispatch — and advanced the cursor only fifty windows,
repeating once per tick until the backlog drained (~6 runs for five minutes down, ~18 for the full
grace). The `catchup-truncated` record simultaneously claimed "only the most recent is considered for
catch-up", which was false exactly when it was written. The row's non-negotiable property is *a
missed window must not stampede on restart*, so the fix is the independent computation above, and the
regression tests (`server/test/scheduling.test.ts`) now drive 600, 900 and 60 missed windows — all
above the cap — and assert ONE dispatch, ONE run manifest and ONE tick to drain.

## Decision 5 — timezone and DST, stated explicitly

A schedule stores an IANA timezone. All conversion is `Intl.DateTimeFormat` with the `timeZone`
option (`server/src/scheduling/timezone.ts`); no dependency was added and no offset arithmetic is
hand-rolled. Local wall time → instant is not a function, so `instantsForWallClock` returns a **list**:

- **Spring-forward gap** (02:30 on the day 02:00 jumps to 03:00): zero instants. **Policy: the
  window is skipped that day.** A `cron:30 2 * * *` schedule in `America/New_York` fires on
  2026-03-07 and 2026-03-09, not on the 8th.
- **Autumn fall-back repeat** (01:30 happens twice): two instants, one hour apart. Both carry the
  **same window key** (the wall minute), so the same requestId, so the same run. **Policy: it fires
  once, on the first occurrence.** The second is recorded as `duplicate-window`.

Both are asserted in `server/test/scheduling.test.ts` → *"timezone and daylight saving"*.

Interval (`every:`) schedules are unaffected by DST by construction: they live on the absolute time
line and are aligned to the Unix epoch.

**Editing the zone re-anchors the cursor**, exactly as editing the expression does. Changing the zone
moves every window's absolute instant, so a `cron:0 9 * * *` schedule moved to a zone several hours
behind can find today's 09:00 already in the past and inside the catch-up grace — it would fire on
the next tick, which is not what "I changed the time zone" means. `PATCH` therefore sets
`cursorMs = Date.now()` when, and only when, the zone actually changes
(`server/src/api/schedules.ts`), proved by *"re-anchors the cursor when the zone changes, and when
the schedule is resumed"*.

**`input` is replaced, not merged**, on `PATCH`. This is a decision, not an oversight: the Console's
edit form always submits the displayed goal and preserves stored variables verbatim, while an API
client can replace the whole object. A merging PATCH would leave no way to remove a variable. It is
stated as the contract in `docs/schedules.md` under "Creating one".

## Decision 6 — overlap policy

`skip` (default) and `allow`.

`skip` consults the schedule's last dispatched run through
`isTerminalWorkflowRunStatus(run.state.status)` (`run-state.ts:502`) — the tree's own definition of
terminal, not a copy of the status list. A window that lands while the previous run is still going is
recorded as `overlap-skipped` with the reason, and no second run is created.

`allow` starts a run for every window. Two windows are two requestIds, so two real runs.

## Decision 7 — blast radius

- **Limits are inherited, not re-specified.** `effectiveLimits: structuredClone(definition.graph.limits)`
  (`store.ts:2427`) — the run manifest has no way to carry per-request limits at all, so a scheduled
  run *cannot* exceed a manual one. A schedule that wanted its own budget could not have one; the API
  deliberately does not offer the field rather than accepting and dropping it.
- **A per-tick fire cap** (`DEFAULT_MAX_CONCURRENT_FIRES = 4`) bounds how many schedules can start a
  run at the same instant. Over-cap windows are recorded as `capacity-deferred` and keep their
  cursor, so the next tick runs them — the cap defers work, it never drops it.
- **A per-project schedule cap** of 200.
- **Both meanings of "stop" are reachable from the Console.** `POST /schedules/:id/disable` stops
  future windows; `POST /schedules/:id/stop` does that *and* cancels every run the schedule started
  that is not yet terminal, through the existing `POST /dag-workflow-runs/:runId/cancel`. A control
  that only paused the schedule while a runaway run kept burning budget would be dishonest, so the
  Console's button is labelled "Stop everything" and reports how many runs it cancelled.

## Decision 8 — lifecycle: nothing survives `app.close()` (defect #41)

One `setInterval` per registration, `.unref()`ed, cleared from a `preClose` hook registered by
`server/src/api/schedules.ts` itself. `preClose` is deliberate: Fastify runs it before application
`onClose` hooks release resources.

`unref()` is deliberate: an unref'd interval holds no event-loop reference, so a pending tick can
never be the reason a backend process refuses to exit. That is precisely the failure mode behind the
three supervisor processes orphaned since 2026-08-12. The shape mirrors `agent/skills-sync.ts`, which
already does interval + `unref` + explicit clear.

`stop()` is **async and awaits the tick in flight**. Clearing an interval does not unwind a tick that
is already past its re-entry guard, and that tick dispatches by `app.inject`. Registration order
matters here: avvio runs same-scope `onClose` hooks in reverse registration order, so the run
controller's later hook would run before a scheduler `onClose` hook. The scheduler therefore stops
in Fastify's earlier `preClose` phase, while the controller is still available. `stop()` sets a
stopped flag that `#dispatch` checks before its first await, clears the timer, and then waits. A
window refused that way is recorded as `shutdown` and **keeps its cursor**, so the next process
reconsiders it; the requestId is unchanged, so the retry cannot double-fire. Calls to `tick()` after
stop are inert and write no audit records.

## Decision 9 — fail closed, with the reason, when execution is not enabled

**The brief's §2.4 is wrong in one load-bearing detail** and this decision exists because of it. The
run-creation route does **not** fail closed: `options.controller?.start(…)`
(`api/dag-workflows.ts:493`) is optional chaining, so with no controller it returns 202 with a run
whose state stays `queued` forever. Cancel and resume *do* fail closed.

So the ticker asks first, with a side-effect-free probe against a route that does fail closed and
that checks the controller **before** looking a run up (`dag-workflows.ts:596-602`):

```
POST /dag-workflow-runs/wrun_000…000/cancel  → 503 CONTROLLER_CLOSED ⇒ execution off
                                             → 404 RUN_NOT_FOUND     ⇒ execution on
```

With execution off, **no run is created**, the window is recorded as `controller-absent` with a
sentence naming the user's next action, and the Console shows it. Three other fail-closed reasons are
distinct and recorded: `definition-missing` (the workflow id no longer exists), `conflict`, and
`error`. A 404 from the project-scope hook is **not** reported as a missing definition: that hook
answers an unknown project with `reason: "unknown_project"` before the route runs (`index.ts:210`),
and the ticker reads that field and records `project-missing` instead, so a reader is not sent to fix
the wrong thing.

## Decision 10 — an own fire-audit store, and why the journal did not fit

`server/src/workflows/supervisor/journal.ts` (853 lines) was read. It cannot express a schedule fire:

- `OPERATION_KINDS = ["pi-subagent", "hosted-fusion"]` is a closed union (`journal.ts:21`).
- Its records are keyed on `backendEpoch` + `ownerRunId` + `nodeId` + `reservationId`
  (`journal.ts:49-61`) — the identity of a node executing *inside* a run. A fire that produced no run
  at all has no `ownerRunId`.
- Its state machine (`prepared → running → terminal|quarantined`) and settlement statuses are about
  budget reconciliation, which a fire has none of.
- It is deliberately content-free, and the audit needs the window, the reason and a human sentence.

So: an append-only JSONL log at `<project>/sandbox/.kady/schedules/fires.jsonl`, following the idiom
of `agent/runs-index.ts` rather than inventing a new one. It records per fire: schedule id, the
window it was **for**, when it actually fired, the requestId, and either the run id or one reason
from a closed set. The **outcome is not stored** — it is derived at read time from
`workflowStore.readRun(...).state.status`, so the trail can never disagree with the run it points at
and no background poller is needed.

## Decision 11 — registration lives in `api/console.ts`, not `index.ts`

`server/src/index.ts` is not this lane's file. `server/src/api/console.ts` is (exact-path handoff
from lane S8) and `index.ts:278` already calls `registerConsoleRoutes(app)`. Because decision 1
removed any need for a controller reference, registering there is complete, not a stub: the feature
is reachable in a normally-booted backend today, with zero edits to `index.ts`.

`INTEGRATION.md` carries the alternative `index.ts` lines for the orchestrator, with the warning that
taking them means removing the `console.ts` line in the same change or Fastify throws
`FST_ERR_DUPLICATED_ROUTE`.

## Decision 12 — two expression kinds

`cron:` (five fields, wall clock, timezone-aware) is the row's headline requirement. `every:` exists
because cron cannot express sub-minute periods, and a *demonstrable* unattended fire — the actual
acceptance evidence for row 52 — needs one. `every:` is also the honest choice for "run this
roughly every N minutes", where cron's wall-clock alignment is a false promise.

## What was considered and rejected

- **A dedicated dedup/lock table for fires.** Rejected: `createRun` is already idempotent by
  construction; a second mechanism would be a duplicate of an existing capability.
- **Building on `agent/goal-loop.ts` / the Console's loops.** Rejected: `api/console.ts:18-24` states
  that loop *execution* is not wired — a created loop is recorded but nothing is dispatched.
  Scheduling onto it would produce a surface that implies a capability it does not have.
- **A cron dependency (`cron-parser`, `croner`).** Rejected: five-field parsing plus `Intl` is ~200
  lines, fully testable, and adds no supply-chain surface to a repo with a token ban and a vendored
  engine.
- **Computing the next fire time in the browser.** Rejected as the exact failure this wave exists to
  stop: a displayed time that can disagree with the instant the server acts on. `next_fire_at` comes
  from `scheduleNextFireAt`, the ticker's own function.
- **A per-schedule budget/limit override.** Rejected: the run manifest cannot carry one, so the field
  would be accepted and dropped — defects #55 and #54 all over again. The API does not offer it.
