# Operating the TYPED workflow runtime

The `SKILL.md` operational sequence covers the vendored pipeline engine behind
the `/pipelines` proxy. This app has a **second** workflow runtime — the typed
one — with its own endpoints, its own run states, and its own budget. Both feed
the same **Scientific Pipelines ▸ Workflow registry** the user is looking at, so
"list the pipelines" is ambiguous until you know which one they mean.

Ask, or check both. Do not report one runtime's empty library as "no pipelines".

Every route below was read out of `server/src/api/dag-workflows.ts` in this
build. Paths are relative to the backend origin, the same origin as `/pipelines`.

## Definitions

| Call | Route |
|---|---|
| List the typed library | `GET /dag-workflows` |
| Read one definition | `GET /dag-workflows/<workflowId>` |
| Create or update one | `PUT /dag-workflows/<workflowId>` |
| Evaluate a document without writing it | `POST /dag-workflows/validate` |
| Preview a legacy pipeline YAML as a typed document | `POST /dag-workflow-imports/legacy-pipeline/preview` |

`PUT` is conditional and the preconditions are not optional:

- **create** requires `If-None-Match: *`;
- **update** requires `If-Match: "<revision>"`, the revision from the definition
  you just read;
- sending both is a 400, sending neither on a create is a 428.

A read returns an `ETag` carrying the current revision. Use it. A blind write is
how two authors silently overwrite each other.

## Runs

| Call | Route |
|---|---|
| Start a run | `POST /dag-workflows/<workflowId>/runs` |
| List runs | `GET /dag-workflow-runs?limit=<n>` |
| Read one run | `GET /dag-workflow-runs/<runId>` |
| Read a run's budget | `GET /dag-workflow-runs/<runId>/budget` |
| Cancel a run | `POST /dag-workflow-runs/<runId>/cancel` |
| Resume a run | `POST /dag-workflow-runs/<runId>/resume` |

A successful start returns **201** with the run manifest, including the run id
and the immutable graph snapshot the run will execute. Do not tell the user a
run started without that id — the same rule the vendored side already has.

**There is no approve/reject endpoint here.** The typed runtime has no human
approval gate. If the user asks you to approve a typed run, the honest answer is
that this runtime has no gate to approve, and the workflow they are thinking of
is either a vendored-engine pipeline or one whose gate was dropped in
translation.

## Run states and what each one means

`queued`, `running`, `waiting`, `blocked`, `paused`, `interrupted`, `succeeded`,
`failed`, `cancelled`. The terminal ones are `succeeded`, `failed`, `cancelled`.

Read the run's event stream rather than guessing from the status:
`run_queued` → `run_started` → per node `node_started` → `model_call_declared`
→ `model_resolved` → `node_succeeded` or `node_failed` → `run_succeeded` or
`run_failed`. **The first unexpected event is the failure; everything after it
is cascade.** Report the first one.

## Budget — the failure that looks like nothing happening

Typed runs reserve budget **before** dispatching a model call. A workflow whose
`limits.maxCostUsd` is `0` refuses every cap-counted call before it is made, so
the run fails with nodes that appear never to have started.

Every pipeline that arrived through the legacy import path lands with
`maxCostUsd: 0` deliberately — it is imported for review, not for execution.
When a user reports "it just fails immediately", check the budget first, and
tell them the fix is to set a real cap on the definition, not to retry.

## Reporting a typed run

Workflow name and id, run id, current status, the node currently executing or
the first node that failed, the resolved model for that node from its
resolution receipt (not the model in the document — they differ when a fallback
was used), and the budget state. If any of those is unavailable, say which.
