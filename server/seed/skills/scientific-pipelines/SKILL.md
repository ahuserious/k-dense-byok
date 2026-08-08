---
name: scientific-pipelines
description: >-
  Operate Kady's Scientific Pipelines system: list and inspect workflows, start
  or monitor runs, handle approval gates, diagnose engine health, and explain
  run state. Use for pipeline operations after a workflow has been designed.
argument-hint: "[operation or pipeline name]"
---

# Scientific Pipelines

Use Kady's native `/pipelines` proxy for operational work. Keep the user in
scientific language and treat the separate pipeline engine as an implementation
detail.

## Boundaries

- Use `scientific-dag-studio` when the user wants to design or edit a workflow.
- Use this skill to list, inspect, run, monitor, approve, reject, cancel, or
  diagnose an existing workflow.
- Never claim that a workflow started unless the run endpoint returned a run
  identifier.
- Never treat a failed health probe as an empty workflow library. Report the
  engine as unavailable and preserve the distinction.

## Operational sequence

1. Check `GET http://localhost:8000/pipelines/health` before a mutating call.
2. List workflows with `GET http://localhost:8000/pipelines` or inspect one with
   `GET http://localhost:8000/pipelines/<name>`.
3. Start a run with `POST http://localhost:8000/pipelines/<name>/run`, passing a
   fresh `conversationId`, the user's message, and the selected model reference.
4. Read current state with `GET http://localhost:8000/pipelines/runs/<runId>`.
5. For an explicit human gate, use the run's approve or reject endpoint only
   after showing the gate prompt and receiving the user's decision.
6. Cancel or abandon only the exact run the user named. Confirm the run id before
   the request.

## Failure handling

- HTTP 503 means the local pipeline engine is unavailable. Tell the user to
  start Kady's workflow-engine service and retry; do not fabricate cached data.
- For any other non-2xx response, surface the status and returned error detail.
- If a response shape is unfamiliar, stop and report it rather than guessing at
  status, cost, or completion.

When reporting a run, include its workflow name, run id, current state, active
or failed node when available, and any approval action still required.
