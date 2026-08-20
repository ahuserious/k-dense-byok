---
name: autoresearch-squared
description: >-
  Monitor and critique a live Kady autoresearch run through its authoritative
  RunState and event stream. Supports one-at-a-time interactive evaluation and
  explicitly bounded autonomous evaluation, with controls to stop monitoring
  or cancel the exact run.
argument-hint: "<run id>"
---

# Autoresearch²

Observe an already-created DAG run. Do not create a shadow run state, infer
success from silence, or mutate the frozen RunState event vocabulary.

## Authoritative surfaces

- Current run: `GET /dag-workflow-runs/<runId>`
- New durable events:
  `GET /dag-workflow-runs/<runId>/events?after=<lastSeq>&limit=200`
- One bounded critique pass:
  `POST /skills/curator/autoresearch/runs/<runId>/evaluate`
- Stop the run:
  `POST /dag-workflow-runs/<runId>/cancel`

The evaluator reads the same `WorkflowStore` used by the runner. Its critique is
an adjacent observation, not a new RunState event. On builds whose frozen
RunState has no critique/evaluation channel, the response carries
`persistedToRunState: false` and a visible reason. Never report it as persisted.

## Choose a mode before starting

### Interactive

Use for consequential scientific decisions or when the user wants to steer the
review.

1. Set `mode: "interactive"`, `cycle: 1`, `maxEvaluations: 1`.
2. If the response has `needsUserInput: true`, show its `question`.
3. Wait for the user's answer. Do not invent one.
4. Repeat the same cycle with `userInput` set to the answer.
5. Present critiques with their run-state `lastSeq` or event `seq` and ask what
   action, if any, the user wants.

### Autonomous

Use only after the user chooses a numeric bound.

1. Choose `maxEvaluations` from 1 through 20.
2. Start at `cycle: 1` and `afterSeq: 0`.
3. After each response, store only the returned `nextAfterSeq` in the active
   monitor view and increment `cycle`.
4. Stop when the run is terminal, the user presses **Stop monitoring**, or
   `cycle === maxEvaluations`.
5. Never restart the counter automatically. Increasing the bound is a new user
   decision.

The autonomous mode observes and critiques. It does not gain permission to
change a graph, raise a budget, select a model, or dismiss an evidence failure.

## Worked requests

Interactive first pass:

```json
{
  "mode": "interactive",
  "cycle": 1,
  "maxEvaluations": 1,
  "afterSeq": 0
}
```

Bounded autonomous pass 2 of 4:

```json
{
  "mode": "autonomous",
  "cycle": 2,
  "maxEvaluations": 4,
  "afterSeq": 17
}
```

Send either body to:

```text
POST /skills/curator/autoresearch/runs/<runId>/evaluate
```

## How to critique the projection

1. Read `state.diagnostics` first. A fatal diagnostic means the reducer stopped
   trusting part of the log; do not build a causal story past it.
2. Order events by `seq`, not by timestamp.
3. Locate the first observed `node_failed`, unsupported `gate_evaluated` /
   `evidence_checked`, failed compaction check, or terminal run error.
4. Separate root cause from cascade. A downstream skip is routing, not another
   root failure.
5. Name absent evidence: missing event ranges, missing model-resolution
   receipts, unknown node outcomes, and unreadable artifacts.
6. A response saying no recognized failure exists is not a correctness verdict.
   It describes only the bounded persisted projection.
7. Give the smallest next check that could falsify the current interpretation.

Every critique must cite one of:

- `run-state lastSeq=<n>`
- `event seq=<n>, eventId=<id>, type=<type>`

## Stop controls

There are two different stops and the UI exposes both:

- **Stop monitoring** ends the local polling/evaluation loop immediately and
  spends no further evaluation cycles. It does not alter the run.
- **Stop run** calls the existing cancel endpoint for the exact run id. The run
  is stopped only when the returned authoritative state is `cancelled` or a
  durable cancellation intent is acknowledged.

Never simulate either stop by hiding the panel. Never call cancel for a run id
copied from another project or inferred from a workflow id.

## Failure handling

- `404 RUN_NOT_FOUND`: stop monitoring and ask the user to choose a run from the
  current project.
- `400 EVALUATION_BOUND_REACHED`: the autonomous budget is exhausted. Do not
  silently reset it.
- Malformed-but-200 response: stop, display a safe error, and preserve the last
  valid event cursor.
- Revision/run replacement: continue following the immutable run id selected by
  the user; do not jump to a newer run automatically.
- Terminal state: stop polling. Summarize the terminal event and remaining
  uncertainty.
- Cancellation conflict: the run became terminal or otherwise unavailable.
  Re-read it and report the real state.
- `persistedToRunState: false`: show the supplied reason. Do not call the
  critique a RunState event until Team B publishes and implements a
  document-first contract extension.
