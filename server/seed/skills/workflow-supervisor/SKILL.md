---
name: workflow-supervisor
description: >-
  Configure and operate Kady's single durability watcher for live workflows:
  observe compaction, context rot, hallucination, stalled progress, failed
  scripts, and failed skill fires; use preset IDs for watcher/rescue policy;
  escalate, lateral-pass, restart, or stop only through /durability endpoints.
argument-hint: "[workflow run id]"
---

# Workflow supervisor

Drive the existing durability watcher. Do not create another watcher, model
default, journal, escalation client, lateral-pass implementation, or stop path.

## Authoritative API

- `GET /durability/settings`
- `PUT /durability/settings`
- `GET /durability/signals`
- `GET /durability/state`
- `GET /durability/runs/<runId>/timeline?after=<seq>&limit=<n>`
- `POST /durability/runs/<runId>/stop`

If `GET /durability/settings` returns 404, the server half is not wired on this
build. Render the whole editor disabled with:

> Durability settings endpoint not available on this build.

Do not create local settings so the controls appear to work.

## Model policy

Persist model preset ids, never copied provider/model details:

```json
{
  "kind": "preset",
  "presetId": "preset-id-from-model-presets",
  "effort": "high"
}
```

Resolve presets at dispatch time through the model-preset system. If a preset
does not resolve, fail closed with the server's reason. Do not replace it with
an embedded model id.

Direct model selections are accepted only when the durability API returns them
as resolved. An unpriced OpenRouter model or unknown 1M-context capacity is not
a usable rescue selection.

The owner's desired watcher/rescue names are policy intent, not constants.
Never guess among similarly named models.

## Configure the one watcher

1. Read `/durability/signals` before rendering controls.
2. For each signal, use its `observability` and `supportedActions`:
   - `full`: normal control.
   - `partial`: control remains legible with `unobservableReason`.
   - `none`: disabled, with `unobservableReason` connected through
     `aria-describedby`.
3. Read `/durability/settings`; do not synthesize missing defaults.
4. Keep the master switch off until watcher and rescue selections resolve for
   the actions that need them.
5. Store watcher/rescue choices as preset ids where possible.
6. Keep `rescueEffort`, `minRescueContextWindow`, `stallMs`, signal thresholds,
   and `stopPolicy` user-overridable.
7. PUT only the fields the user changed. Re-read settings and resolution after
   the PUT; the readback is the effective state.

## Interpret the timeline

- `durability.watch.started`: observation began.
- `durability.signal.fired`: a persisted condition crossed its threshold.
- `durability.action.dispatched`: an existing action path was called.
- `durability.escalation.started`: in progress, not success.
- `durability.escalation.completed`: a repaired revision was deployed and a
  replacement run exists.
- `durability.escalation.deferred`: only an unapplied proposal exists. Say
  “waiting for approval,” never “the run continued.”
- `durability.action.failed`: show the safe detail and stop automatic repeats
  at the configured bound.
- `durability.stop.completed`: stopped by watcher/operator; distinguish it from
  a generic failure.

The run's own event stream remains authoritative for run status. The durability
timeline records watcher observations; it is not another RunState.

## Worked configuration change

After fetching current settings and model-preset choices, an operator may
enable one observed signal:

```json
{
  "enabled": true,
  "watcherModel": {
    "kind": "preset",
    "presetId": "preset_cheap-reasoning",
    "effort": "high"
  },
  "signals": {
    "hallucination": {
      "enabled": true,
      "action": "observe",
      "threshold": 1
    }
  }
}
```

This is illustrative. Use ids returned by the live preset list; never assume
the example id exists.

## Stop authority

Before enabling `action: "stop"`:

1. Confirm `stopPolicy.allowStop`.
2. Confirm `maxStopsPerRun` is positive and bounded.
3. Read `/durability/state.stopAvailability` for the selected run.
4. Disable the control when `canStop` is false and show its `reason`.
5. POST a bounded reason to `/durability/runs/<runId>/stop`.
6. Trust the returned stop receipt and subsequent run state, not the click.

Never stop a different run automatically. Never express stop by killing a
process.

## Failure handling

- 404 settings route: disabled adapter; no local store.
- Unset/unresolvable model: disable model-dependent actions with the exact
  reason and next action.
- Unknown pricing/context window: fail closed.
- Signal `observability: "none"`: never enable it through a handcrafted PUT.
- `escalation.deferred`: preserve the proposal id and request approval.
- Stop unavailable/conflict: re-read state; do not retry blindly.
- Malformed response: stop editing and show a safe error. Do not apply cached
  settings as though they were current.
- Timeline gap: display the missing sequence range; do not infer what happened.
