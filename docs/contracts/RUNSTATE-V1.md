# RunState v1 — FROZEN

**FROZEN:** S8 and later lanes may extend this contract only through a change
that updates this document and `RunStateV1Schema` together. The chat adapter and UI
are deliberately outside this contract-freeze lane.

**How "together" is satisfied here (amended 2026-08-19, same rule as NodeSpec v1).**
This repository has no pull requests — lanes are standalone clones reviewed by
independent adversarial agents and the orchestrator merges locally — so the earlier
"through a PR" wording named nothing. **The document leads:** an orchestrator commit
describing the new fields (touching only orchestrator files, `docs/contracts/` being
uninventoried and therefore orchestrator-only) lands BEFORE the lane merge that adds
them to `RunStateV1Schema`. A document ahead of its schema is a specification awaiting
implementation and is harmless; a schema ahead of its document is the misleading
direction, and the ordering makes that state unreachable. Rationale and history:
`docs/adr/S11-contract-freeze-mechanism.md`. Verified per commit by
`s11/lane-briefs-20260818/freeze-check.sh` on every pushed ref.

RunState v1 is the JSON-safe live-run projection exposed through
`server/src/api/workflow-run-state.ts`. It is distinct from the durable
event-reducer `WorkflowRunState` used for storage and replay.

**One other document describes this union, and it is subordinate to this one (V-5, 2026-08-18).**
`docs/inventory/run-state-v1-event-taxonomy.md` was derived from code rather than from this contract, so for
a while two documents described one frozen union with only one of them under the freeze. That file now opens
by saying it does not extend, narrow, or amend the union, that a change to the union may not be recorded
there, and that where the two disagree this contract is right and that file is stale. Its §1 mirrors the
union; its §§2-6 describe the *chat run* surface (`GET /sessions/:id/run/state`), which is a different
projection and is not frozen. If the union changes here, that taxonomy is the file to re-derive — never the
other way round.

| Field | Semantics |
| --- | --- |
| `schemaVersion` | Required literal `1` discriminator. |
| `runId` | Stable live-run identifier. |
| `workflowId` | Typed workflow definition identifier. |
| `workflowRevision` | Positive definition revision represented by this projection. |
| `status` | Current workflow status; every node and trailing-slot status must satisfy the coherence matrix below. |
| `nodes[].id` | Stable graph-node identifier; IDs are unique and every state node must exist in `topology.nodes`. |
| `nodes[].status` | Current per-node execution status, including waiting, blocked, interrupted, and cancelled states. |
| `nodes[].progress.completed` | Completed progress units; must not exceed `total`. |
| `nodes[].progress.total` | Positive total progress units. |
| `nodes[].progress.message` | Optional bounded human-readable progress label. |
| `nodes[].executionId` | Optional current durable execution identifier. |
| `topology.nodes[]` | Current graph node IDs in the live projection. |
| `topology.edges[]` | Current directed edges with unique IDs; both endpoints must exist in `topology.nodes`. |
| `backgroundAgentTrailingNode` | Optional reserved trailing slot for the background/rescue agent; its optional `nodeId` must resolve in `topology.nodes`. |
| `errorRouting.source` | Literal `chat-stream`, identifying the originating error channel. |
| `errorRouting.surface` | Literal `true`, instructing S8 to surface the Scientific DAG graph when the signal exists. |
| `errorRouting.nodeId` | Optional node associated with the chat-stream error; when present it must resolve in `topology.nodes`. |
| `errorRouting.error` | Bounded code/message/retryability payload for the surfaced error. |
| `updatedAt` | Non-negative epoch-millisecond projection timestamp. |

## Recruitment and branch observability — authorised for lane F5 (2026-08-19, specification ahead of implementation)

Matrix row 30 requires that judge-initiated council recruitment be **observable in RunState**, and row 33
requires that a best-of-n split be renderable as n live parallel branches rather than a static fan-out
drawing. Neither is representable today: a `nodes[]` entry carries `id`, `status`, `progress` and
`executionId` under `additionalProperties: false`, so a run cannot say a head was recruited or that a
candidate branch is running.

The document leads (`docs/adr/S11-contract-freeze-mechanism.md`), so the two fields are described here
before `RunStateV1Schema` carries them. **Lane F5 may add exactly these, with exactly these names.** A
third field, a different name, or a new *top-level* key needs another orchestrator commit first — ask,
do not improvise.

| Field | Semantics |
| --- | --- |
| `nodes[].recruitment` | Optional. Present only on a node that can recruit (today: `council`). `{ recruited, maxRecruits, reason? }`: `recruited` is a non-negative count of heads added beyond the authored `members`, `maxRecruits` is the bound the node was admitted under, and `reason` is an optional bounded label for the most recent recruitment. `recruited` must never exceed `maxRecruits`, and the bound must not exceed the run's effective `maxSubagents`. Absent means the node cannot recruit; `recruited: 0` means it can and has not. |
| `nodes[].branches` | Optional. The live parallel branches of a node that splits its work (today: `best-of-n`, and any kind that fans out into candidate attempts). An array of `{ id, status, label?, executionId? }`, `id` unique within the node, `status` drawn from the same node-status union and subject to the same run-to-node coherence matrix as `nodes[].status`. It is a projection of real candidate state — a renderer may draw exactly what is here and nothing it infers. Absent means the node does not split. |

Both are optional, so every persisted and in-flight projection stays valid without them, and both are
derived from run state the executor already has rather than from a second source of truth. Neither is a new
top-level key, so the frozen top-level union is unchanged; `parseRunStateV1()` validates them under the same
detached-value rules as the rest of the projection.

## Run-to-node status coherence

The matrix applies to every `nodes[].status` and to
`backgroundAgentTrailingNode.status` when that slot exists.

| Run status | Allowed node statuses |
| --- | --- |
| `queued` | `pending` |
| `running` | `pending`, `running`, `waiting`, `blocked`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |
| `waiting` | `pending`, `running`, `waiting`, `blocked`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |
| `blocked` | `pending`, `running`, `waiting`, `blocked`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |
| `paused` | `pending`, `running`, `waiting`, `blocked`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |
| `interrupted` | `pending`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |
| `succeeded` | `succeeded`, `skipped` |
| `failed` | `pending`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |
| `cancelled` | `pending`, `succeeded`, `failed`, `skipped`, `interrupted`, `cancelled` |

Thus interrupted and terminal run statuses (`succeeded`, `failed`, or
`cancelled`) reject active node statuses (`running`, `waiting`, or `blocked`). A
`succeeded` run must also contain at least one `nodes[]` entry whose status is
`succeeded`; a projection containing only skipped nodes cannot represent success.

`serializeRunStateV1()` validates before JSON serialization;
`parseRunStateV1()` validates structure, progress bounds, unique state and topology
node IDs, unique edge IDs, state/topology membership, edge endpoints, and optional
node references plus run-to-node status coherence before returning a detached value.
