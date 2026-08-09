# RunState v1 — FROZEN

**FROZEN:** S8 and later lanes may extend this contract only through a PR that
updates this document and `RunStateV1Schema` together. The chat adapter and UI
are deliberately outside this contract-freeze lane.

RunState v1 is the JSON-safe live-run projection exposed through
`server/src/api/workflow-run-state.ts`. It is distinct from the durable
event-reducer `WorkflowRunState` used for storage and replay.

| Field | Semantics |
| --- | --- |
| `schemaVersion` | Required literal `1` discriminator. |
| `runId` | Stable live-run identifier. |
| `workflowId` | Typed workflow definition identifier. |
| `workflowRevision` | Positive definition revision represented by this projection. |
| `status` | Current workflow status: queued, active/waiting states, or a terminal result. |
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

`serializeRunStateV1()` validates before JSON serialization;
`parseRunStateV1()` validates structure, progress bounds, unique state and topology
node IDs, unique edge IDs, state/topology membership, edge endpoints, and optional
node references before returning a detached value.
