---
name: autoresearch-graph-architect
description: >-
  Design a bounded autoresearch DAG in Kady's typed WorkflowGraphDocument v1,
  validate it through /dag-workflows/validate, and save it through
  /dag-workflows/:workflowId. Use when a user wants an iterative research,
  experiment, critique, evidence-gate, or research-until-goal workflow rather
  than a one-off answer.
argument-hint: "[research objective]"
---

# Autoresearch graph architect

Turn a research objective into the smallest typed Kady graph that can make
progress, disprove itself, and stop. The output is a real
`WorkflowGraphDocument` with `schemaVersion: "1.0"`, not prose that merely
describes a graph.

## Authoritative surfaces

- Validate without writing: `POST /dag-workflows/validate` with the graph as the
  JSON body.
- Save: `PUT /dag-workflows/<workflowId>` with `If-None-Match: *` for creation,
  or `If-Match: "<revision>"` for an update.
- Read back: `GET /dag-workflows/<workflowId>`.
- Start only after an explicit user action:
  `POST /dag-workflows/<workflowId>/runs`.
- Observe: `GET /dag-workflow-runs/<runId>` and
  `GET /dag-workflow-runs/<runId>/events`.

Never write directly below `.kady/workflows`; the workflow store owns
validation, revisions, digests, atomic replacement, and run snapshots.

## Procedure

1. Restate the objective as a falsifiable goal. Record the expected artifact,
   evidence threshold, and an observable stopping condition.
2. Inventory inputs and tool boundaries. A missing data source is a precondition
   or a first acquisition node, never an assumption hidden in a prompt.
3. Set graph-wide bounds before adding nodes:
   `maxIterations`, `maxModelCalls`, `maxParallelism`, `maxSubagents`,
   `timeoutMs`, `maxTokens`, `maxCostUsd`, and `maxRetries`.
4. Use existing node kinds:
   - `research-until-goal` for iterative progress against explicit
     `completionCriteria`.
   - `agent` for one bounded reasoning or synthesis step.
   - `best-of-n` for several candidates plus one evaluator.
   - `council` or `fusion` only when independent perspectives materially
     reduce risk.
   - `evidence-gate` for citation, artifact, claim-support, or
     unsupported-output checks.
   - `lean4` for a theorem that needs machine verification.
5. Put a skill on the node that consumes it:
   `settings.skills = { mode: "manual", list: ["skill-name"] }`. Keep the list
   within 64 references. Do not invent a second graph-level skill field.
6. Put reusable scientist personas on the deliberating node through
   `settings.deliberation.mimeographs`. In manual mode, set
   `bestOfNPersonalityCount` equal to the number of unique
   `personalityRefs` (maximum 32).
7. Route evidence failure explicitly. Use a failure edge or the existing
   rescue policy; do not rely on a prompt saying “retry.”
8. Ensure exactly one entry node, at least one reachable terminal node, no
   cycles outside node kinds that own iteration, and no write path shared by
   parallel nodes.
9. Validate. Treat every validation issue's JSON pointer as actionable and
   change only the named field.
10. Show the validated graph and its estimated bounds. Save only after the user
    confirms. Read back the stored revision and graph digest before saying it
    was saved.

## Worked example

`references/minimal-autoresearch.json` is a complete two-stage example:

1. `research` uses `research-until-goal` with explicit completion criteria and
   this skill attached in `settings.skills.list`.
2. `verify` is a terminal `evidence-gate` that rejects unsupported claims.

Validate it:

```bash
curl -sS -X POST http://localhost:8000/dag-workflows/validate \
  -H 'content-type: application/json' \
  --data-binary @references/minimal-autoresearch.json
```

Save it only after confirmation:

```bash
curl -sS -X PUT http://localhost:8000/dag-workflows/autoresearch-example \
  -H 'content-type: application/json' \
  -H 'if-none-match: *' \
  --data-binary @references/minimal-autoresearch.json
```

The exact host/port can differ; use the active Kady backend origin. Do not send
credentials in a graph.

## Review checklist

- Every model request has an explicit auth kind and resolution policy.
- Every autonomous loop has a numeric bound and a terminal condition.
- Every expensive or externally mutating step has a preceding gate when the
  user requested one.
- Evidence gates consume real run artifacts or source ids; model prose cannot
  declare itself supported.
- A failure route cannot accidentally re-enter the successful branch forever.
- Node `settings.skills.list` names enabled skills that Pi can load.
- The saved graph readback still contains those exact references.

## Failure handling

- Validation failure: do not save. Fix the first structural issue, revalidate,
  and preserve the remaining diagnostics.
- Revision conflict (`409`): read the current definition, show the competing
  revision, merge deliberately, and retry with its ETag. Never overwrite
  unconditionally.
- Missing skill: install/enable it through Settings ▸ Skills or the existing
  Skills API, then attach it. Do not create an empty placeholder.
- Unresolved model/provider: fail closed and ask the user to select a configured
  model or preset. Never silently substitute a different model.
- Budget too small: reduce graph work or ask for an explicit new bound. Never
  raise a cost cap on the user's behalf.
- Run failure: preserve the run id, first failing event sequence, node,
  attempt, and error code. Propose a bounded graph revision; do not rewrite the
  immutable run snapshot.
