# RunState v1 + chat-run event taxonomy (lane W4, round 1)

Derived by reading the code, then confirmed against a hermetic preview
(`scripts/preview-up.mjs --backend-port 18500 --frontend-port 13500
--engine-port 13591`, 2026-08-17). Everything below is either a code citation
or a captured response body; nothing is inferred from the design brief.

Captured bodies live beside this lane's evidence at
`s11/human-sim/w4-console/round1/fixture-*.json`.

---

## 0. There are two different "run states", and they are not interchangeable

The name `RunState` is overloaded in this codebase. W4 consumes both, for
different halves of the console.

| Surface | Route | Return type | What it describes |
|---|---|---|---|
| **Typed workflow run projection** | `GET /sessions/:id/workflow-run-state` (`server/src/api/sessions.ts:827-828`) | `{ state: RunStateV1Projection \| null }` | The **typed DAG workflow run** currently associated with this chat session. Validated fail-closed on both sides. |
| **Chat run (the LLM's logs)** | `GET /sessions/:id/run/state` (`server/src/api/sessions.ts:822`) | `RunState` from `server/src/agent/run-broker.ts:28-35` | The **agent turn** the run broker is holding for this session: prompt, baseline transcript, and every client frame it has published, each with a monotonic `seq`. |

`web/src/components/chat-live-graph.tsx` polls the **first** one
(`useChatLiveGraphProjection` → `/sessions/:id/workflow-run-state`, line 458).
Its exported `RunStateV1Projection` type is therefore a *DAG-run* projection,
not a session-log projection.

W4's session half folds the **second** one. That is the surface the owner's
sentence points at: "even if not a DAG initially, the LLM's logs should be able
to turn into a DAG here."

---

## 1. `RunStateV1Projection` — the frozen union (probe B5)

Source of truth: `web/src/components/chat-live-graph.tsx:8-55` (browser mirror)
and `parseRunStateV1Projection` at line 133, which rejects anything outside it.

**Run status** (`RunStateV1Status`, 9 values):

```
queued | running | waiting | blocked | paused | interrupted | succeeded | failed | cancelled
```

**Node status** (`RunStateV1NodeStatus`, 9 values):

```
pending | running | waiting | blocked | succeeded | failed | skipped | interrupted | cancelled
```

Coherence is enforced, not advisory (`STATUS_COHERENCE`, line 84): a `queued`
run may only carry `pending` nodes; a `succeeded` run only `succeeded`/`skipped`
nodes **and at least one** `succeeded`; `interrupted`/`failed`/`cancelled` runs
carry only terminal node statuses. Bounds: ≤256 state nodes, ≤256 topology
nodes, ≤1024 edges, ids matching `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/` and ≤128
chars, progress `1 ≤ total`, `0 ≤ completed ≤ total`, message ≤512 chars.

Optional members: `backgroundAgentTrailingNode` (slotId, agentId, nodeId?,
status) and `errorRouting` (`source: "chat-stream"`, `surface: true`, nodeId?,
`error {code, message, retryable}`).

This union carries **no event stream at all** — it is a snapshot of node
statuses plus a topology. It cannot answer "what did the LLM just do", which is
why the session projector folds the chat-run frames instead.

Captured fresh-session body (`fixture-workflow-run-state.json`):

```json
{"state":null}
```

---

## 2. The chat run's `RunState` (what W4's session projector folds)

`server/src/agent/run-broker.ts:28-35`:

```ts
export interface RunState {
  status: "none" | "running" | "complete";
  run?: RunMetadata & { frames: SequencedClientFrame[]; lastSeq: number };
}
// RunMetadata = { runId, prompt, images, baseline: { messages, contextUsage } }
// SequencedClientFrame = ClientFrame & { seq: number }
```

Captured fresh-session body (`fixture-run-state-fresh.json`, real preview):

```json
{"status":"none"}
```

Note that `run` is **absent**, not `null`, when there is no retained run — the
client parser must treat both as "no run".

`frames` is append-only within a run and each frame's `seq` starts at 1
(`RunHandle.publish`, `run-broker.ts:127`). W4 therefore polls the whole
retained buffer and discards sequences it has already folded; that is the
append-only cursor, because `GET /sessions/:id/run/events?after=` is an **SSE
stream** (`streamRun`, `sessions.ts:870/883`), not a pollable page, and the plan of
record forbids adding SSE to the console.

---

## 3. The `ClientFrame` vocabulary (the LLM's logs)

Every frame is `{ type: string, ...}` (`server/src/agent/events.ts:18-21`). The
complete emitted set is `toClientFrame()` (`events.ts:283-343`) plus the frames
`server/src/api/sessions.ts` publishes directly.

| `type` | Fields | Emitted at | Node kind produced |
|---|---|---|---|
| `run_start` | `runId` | `sessions.ts:1094` | — (stamps the **session** root, sets it `running`) |
| `agent_start` | — | `events.ts:289` | — (ignored) |
| `turn_start` | — | `events.ts:293` | **turn** `turn:<n>` |
| `message_start` | `role`, `content` (user only) | `events.ts:303/305` | **turn** (opens one, or labels the open turn with the prompt) |
| `message_end` | `role` | `events.ts:308` | — (ignored) |
| `text_delta` | `delta` | `events.ts:311` | — (ignored) |
| `thinking_delta` | `delta` | `events.ts:312` | — (ignored) |
| `tool_start` | `toolCallId`, `toolName`, `args`, `skill?` | `events.ts:320` | **tool** `tool:<toolCallId>`; **subagent** `agent:<toolCallId>:<name>` when `toolName === "subagent"` |
| `tool_update` | `toolCallId`, `toolName` | `events.ts:327` | keeps the tool node `running` |
| `tool_end` | `toolCallId`, `toolName`, `isError`, `result`, `scientificResult?`, `images?`, `imagesTruncated?` | `events.ts:330` | closes the tool node → `ok` / `error` |
| `turn_end` | `usage` | `events.ts:296` | closes the open turn → `ok` |
| `queue_update` | `steering`, `followUp` | `events.ts:337` | — (ignored) |
| `retry` | `attempt`, `max` | `events.ts:339` | — (annotates the open turn) |
| `context_usage` | `tokens`, `contextWindow`, `percent` | `events.ts:27` | — (ignored) |
| `cost` | `cost`, `tokens`, `runCost`, `runTokens`, `runBillingMode`, `runProvider`, `runListPriceUsd?` | `sessions.ts:1385` | — (ignored) |
| `error` | `message`, `reason?`, `kind?` | `sessions.ts:1224/1241/1282/1346/1404/1421` | — (marks root + open turn `error`; `kind: "budget"` marks them `cancelled`) |
| `agent_end` | — | `events.ts:291` | — (closes everything still `running`) |
| `done` | — | `sessions.ts:1116/1409/1429` | — (closes everything still `running`) |

`message_update` never reaches the client as itself: `events.ts:309-316` splits
it into `text_delta` / `thinking_delta` / `error`, and returns `null` (frame
dropped) for anything else. Pi lifecycle events with no mapping are dropped
server-side by the `default: return null` arm at `events.ts:340-341`.

### 3.1 Fixture — the same vocabulary, captured

`GET /sessions/:id/history` replays a stored session through the *same* frame
vocabulary (`server/src/agent/session-history.ts:48`), so it is the cheapest
way to capture real frames without a provider key. From the preview
(`fixture-history.json`, abridged):

```json
{"messages":[
  {"role":"user","content":"Cluster the RNA-seq counts and summarise.","timestamp":1787008600000},
  {"role":"assistant","frames":[
    {"type":"thinking_delta","delta":"Plan: inspect the matrix, then run the clustering."},
    {"type":"text_delta","delta":"Inspecting the counts matrix."},
    {"type":"tool_start","toolCallId":"call_a1","toolName":"bash","args":{"command":"head -3 counts.tsv"}},
    {"type":"tool_end","toolCallId":"call_a1","toolName":"bash","isError":false,"result":"gene\ts1\ts2"},
    {"type":"tool_start","toolCallId":"call_a2","toolName":"subagent","args":{"agent":"statistical-reviewer","task":"Check the clustering choice."}},
    {"type":"tool_end","toolCallId":"call_a2","toolName":"subagent","isError":false,"result":"k=4 is defensible."}
  ],"timestamp":1787008601000}],
 "contextUsage":{"tokens":null,"contextWindow":1000000,"percent":null}}
```

History frames carry **no `seq`** — they are ordered by array position within an
assistant message. `web/src/lib/session-dag-projection.ts` requires a `seq`, so
a future "load older" path (W4-R4) must synthesize descending negative
sequences from `/history` rather than reusing array indices as ids. That is
recorded here so the R1 fold's "never array position" rule is not quietly
broken later.

### 3.2 Fixture — the session list

`GET /sessions` (`sessions.ts:474`, `fixture-sessions-list.json`):

```json
[{"id":"01a0125f-…","name":null,"created":"2026-08-18T00:56:40.000Z",
  "modified":"2026-08-17T23:16:43.000Z","messageCount":5,
  "firstMessage":"Cluster the RNA-seq counts and summarise."}]
```

`created` / `modified` arrive as **ISO strings** here (Fastify serializing
`Date`), while the mocked Playwright tier returns **epoch numbers**
(`e2e/fixtures.ts:631`). `console-live-sources.ts:toEpochMs` accepts both; a
parser that assumed one would silently drop every session from the rail in one
of the two tiers.

### 3.3 Probe B2 result — `GET /sessions` has no cross-project scope

Verbatim, same preview:

```
GET /sessions                    -> [{"id":"01a0125f-…", …}]
GET /sessions?scope=all&active=1 -> [{"id":"01a0125f-…", …}]     (byte-identical)
```

The route handler takes no `Querystring` type and reads no query at all
(`sessions.ts:474-484`); the parameters are ignored, not honoured. **Recorded
decision:** W4-R1 does **not** add the route. Cross-project discovery uses the
existing `GET /projects/activity` (one request, already project-wide) to learn
*which* projects are busy and then reads those projects' `GET /sessions` with
`X-Project-Id`, bounded to 20 projects and cached for 5 s. Rationale: this
lane's writable set contains `server/src/api/sessions.ts` but **no** server test
file, so a new server route could not be given a test in-lane; the client path
is fully covered by `console-live-sources.test.ts`. If a later round needs true
server-side scoping, the handoff is still open.

---

## 4. Node-kind mapping used by `session-dag-projection.ts`

| Node kind | Id | Created by | Status source |
|---|---|---|---|
| `session` (root) | `session:<sessionId>` | always | `RunState.status` + `error` frames |
| `turn` | `turn:<ordinal>` | `turn_start`, or a user `message_start` | `running` → `turn_end`/`done` → `ok`; `error` → `error` |
| `tool` | `tool:<toolCallId>` | `tool_start` (`tool_update`/`tool_end` create a placeholder if they arrive first) | `tool_end.isError` |
| `subagent` | `agent:<toolCallId>:<agentName>` | `tool_start` with `toolName === "subagent"`, one per name in `args.agent` / `args.tasks[].agent` | inherits the parent tool's terminal status |
| `dag` | `dag:<runId>` | the `workflowRun` fold option, sourced from `GET /sessions/:id/workflow-run-state` | `queued`→`pending`, `succeeded`→`ok`, `failed`→`error`, `cancelled`→`cancelled`, else `running` |
| `group` | `group:<turnId>` | the 13th+ tool/subagent/dag child of one turn | `running`, carries `collapsedToolCallIds` and `collapsedCount = collapsedToolCallIds.length` |
| `event` | `event:<seq>` | **any frame type not listed in §3** | `ok` |

Edges: `session → turn` for **every** turn (`kind: "turn"`), `turn → tool`
(`"tool"`), `tool → subagent` (`"subagent"`), `session → dag` (`"dag"`),
`turn → event` (`"event"`), `turn → group` (`"group"`). Any edge whose target is
already an ancestor of its source is stored with `kind: "back"` and badges the
target `cyclic` — a delegation cycle is drawn, never expanded.

**Turns are siblings, not a chain.** R1 parented each turn on the previous one
(`session → turn:1 → turn:2 → …`). That had two costs and no benefit: the
rendered tree gained one indent level per turn, so the newest turn — the one
being watched — walked off the right edge of a long session (60 turns ≈ 1,440px
of indentation); and the shape depended on arrival order, because a turn folded
out of sequence parented itself on a turn that came *after* it in the
conversation. Conversation order now comes from the folded sequence numbers
alone, which is where it always belonged. Indentation is reserved for the
delegation dimension that `MAX_DEPTH` actually bounds.

**The `dag` link hangs off the session root** for the same reason: it arrives
out of band from `GET /sessions/:id/workflow-run-state` and carries no sequence
of its own, so parenting it on "whichever turn was open when the poll landed"
made both its parent and its creation order depend on how the caller chunked
its polls. It is created at sequence `0` — the session's own.

Ids are derived from event ids (`toolCallId`, `runId`, `seq`) or from a
monotonic turn allocator. **No id is ever an array position**, so filtering,
re-ordering, or a partial poll cannot renumber a node. The turn *ordinal a
reader sees* (`Turn 1`, `Turn 2`, …) is assigned at save time from folded
sequence order, so a late low-sequence `turn_start` reads as "Turn 1" rather
than renaming an existing node.

### 4.0 Terminal frames and unfinished work

`agent_end` and `done` settle every still-`running` node, but not all to the
same status. A `turn`, `group`, or `event` genuinely ends when the run ends, so
it settles `ok`. A `tool`, `subagent`, or `dag` that never reported its own end
did **not** succeed: `sessions.ts` publishes `done` from a `finally` on every
exit path including abort and a thrown error (`sessions.ts:1409`, `:1429`), so a
run killed mid-`bash` would otherwise paint that tool green. Those settle
`cancelled`. `ok` is reserved for work that reported completion.

### 4.1 Why there is no `subagent`/`delegation` frame type

There is none to bind. Delegation reaches the client only as an ordinary
`tool_start` whose `toolName` is `subagent` (`server/src/agent/subagent-bridge.ts:421`,
`web/src/lib/use-agent.ts:204`), and a typed-workflow launch reaches the client
only through the session→run association recorded server-side
(`associateTypedWorkflowLaunch`, `sessions.ts:453`) and read back through
`/sessions/:id/workflow-run-state`. The projector therefore takes the workflow
link as an explicit fold input rather than sniffing frames for it.

### 4.2 What falls back to `event:<seq>`

Everything not in the §3 table. Concretely, that is any frame a future server
change starts publishing before the console learns about it — the projector adds
a node labelled with the raw `type`, hangs it off the open turn, and keeps
folding. It never drops a frame and never throws on one.

The five node statuses (`pending | running | ok | error | cancelled`) are
deliberately narrower than the nine `RunStateV1NodeStatus` values: a chat run
has no `waiting`/`blocked`/`skipped` concept. The DAG-run half (W4-R2) keeps the
full nine, because it overlays the real run document.

---

## 5. Bounds the projector enforces

| Bound | Value | Symbol |
|---|---|---|
| Tool/subagent/dag children per turn before grouping | 12 | `MAX_TOOLS_PER_TURN` |
| Rendered nodes | 200 | `MAX_RENDERED_NODES` |
| Retained frame sequences per source | 500 | `MAX_RETAINED_FRAMES` |
| Subagent/delegation expansion depth | 3 | `MAX_DEPTH` |

Crossing the first records the refused **tool-call id** on the group node
(`collapsedToolCallIds`) and reports `collapsedCount` as that list's length; the
second sets `truncated`; the third increments `droppedFrames`; the fourth sets
`depthCollapsed` and badges the parent `deeperCollapsed`.

The group count is per *call*, not per *frame*. One refused tool emits
`tool_start`, usually `tool_update`, and `tool_end` — counting the calls into
the grouping path reported the same hidden tool two or three times, so 5 hidden
tools read as "15 more tool calls" on any realistic stream.

### 5.1 What the invariants are stated over

Invariants 2 (incremental == full) and 3 (order tolerance) are statements about
a frame **set**: the same set of frames, folded in any chunking and in any order
inside a chunk, yields the same projection. They now hold across calls as well
as inside one, because neither the turn chain nor the `dag` link's parent
depends on arrival order any more, and because duplicate sequences inside one
body are collapsed before the fold loop runs (`alreadyFolded` cannot see the
first copy — nothing is retained until the loop starts).

### 5.2 The frame → node index

The projection carries `frameNodeIds: Record<seq, nodeId>`, pruned with the
retained ring. It is what lets the event drawer list a node's **real events**
rather than restating its projected children back at the reader. Frames the fold
models away — `text_delta`, `thinking_delta`, `message_end`, `queue_update`,
`context_usage`, `cost` — are attributed to the turn they arrived in, so nothing
the server sent is invisible in the console.

---

## 6. Not covered by this round

* The DAG-run graph (`projectRunToGraph`) needs the executed-document snapshot
  from `GET /dag-workflow-runs/:id` (probe B6, lane W3-R1). It is **not**
  stubbed here; the console says so in place of a graph. Clicking a session's
  `dag` node now swaps the main area to that run's placeholder and its genuine
  persisted events, which is the whole of the contract that does not need the
  snapshot.
* `GET /sessions/:id/history` as a "load older" source (see §3.1).
* Promote-this-session-to-a-DAG (W4-R3).
