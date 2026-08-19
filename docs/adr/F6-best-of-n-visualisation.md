# ADR F6 — best-of-n is drawn from real slot state, sequentially, and not in React Flow (row 33)

- **Status:** accepted, with two declared divergences from the row as written.
- **Lane:** F6, Wave F round 1. **Row:** 33.
- **Date:** 2026-08-19.

## What row 33 asks for

> **Best of n** — splits the workflow n ways, **visually depicted in the React Flow dashboard**.
> The graph view **renders the n-way split as n parallel branches, live**. The existing `best-of-n`
> executes; the visualisation reflects real candidate state, **not a static fan-out drawing**.

Three claims. The third is met in full. The first two are not, for measured reasons, and this ADR
records the harsher framing rather than softening it.

## Divergence 1 — it is not React Flow

```
$ grep -n "xyflow\|reactflow" web/package.json          # (no output)
$ grep -n "xyflow" server/vendor/pipeline-engine/packages/web/package.json
20:    "@xyflow/react": "^12.10.1",
```

**React Flow exists only inside the vendored engine package.** `web/package.json` is not lane F6's
file, so the dependency cannot be added here.

The one React Flow surface that does exist — `WorkflowDagViewer.tsx`, which F6 *does* own — renders
the **vendored engine's** runs: its props are `dagNodes: readonly DagNode[]` and
`liveStatus: readonly DagNodeState[]` (`WorkflowDagViewer.tsx:41-48`), fed from the vendored REST+SSE
in `WorkflowExecution.tsx`. That runtime has no `modelCallSlots` and no `best-of-n` kind; those are
**typed Kady runtime** concepts. Feeding it typed run state would need a new host→canvas bridge
message, and the bridge vocabulary is a closed seven-entry list (`HostBridge.ts:47-53`) in a file
that is also not F6's.

So the branch view is built in Kady's own web app (`web/src/components/pipeline/`) with tokenised
DOM. Requested in `W/requests/c-f6-3.md`: either `@xyflow/react` in `web/package.json`, or a
`builder.setRunCandidates` bridge message. Either would let a later round move this projection onto
React Flow without redesigning it — the projection (`web/src/lib/best-of-n-branches.ts`) is
deliberately separate from the rendering for exactly that reason.

## Divergence 2 — the branches are not parallel, and the UI says so

`server/src/workflows/kady-node-executor.ts:2862-2872`:

```ts
      if (node.kind === "best-of-n") {
        const count = node.candidateCount ?? node.candidateModels?.length ?? 2;
        const candidates: AnalysisResult[] = [];
        for (let index = 1; index <= count; index += 1) {
          candidates.push(await delegate({ slotId: `candidate-${index}`, ...
```

`await` **inside** the loop. Candidate *k+1* is not even declared until candidate *k* has resolved.

**Drawing a fan-out that implies concurrency would be a lie about the runtime**, so the view does not.
The n branches are real — n candidates genuinely exist for `candidateCount: n` — but they light up
one at a time in index order, and `SEQUENTIAL_CANDIDATES_NOTICE` is rendered on screen:
*"Candidates run one at a time, in order — the executor resolves each before starting the next."*

An unreached candidate reports `not-started`, deliberately **not** `pending`: "pending" reads as
"queued alongside the others", which is precisely the false impression this divergence exists to
avoid.

Changing the executor to run candidates concurrently is Orchestrator B's file. Raised as a finding
with a proposed patch and two things to check first (slot-declaration ordering in `run-state.ts`, and
budget accounting) in `W/requests/c-f6-5.md`. **If it stays sequential, the row's wording should be
corrected**, so no later lane builds against a promise the runtime does not keep.

## What IS met: real candidate state, from two sources

The acceptance test — "reflects real candidate state, not a static fan-out drawing" — is met, and the
unit tests are written to fail a static fan-out (a projection ignoring slot data reports every branch
identically and is caught).

Per-candidate progress and the verdict come from **different places**, and both are needed:

| | Source | Why |
|---|---|---|
| branch **state** | `state.executions[*].modelCallSlots[candidate-N]` from `GET /dag-workflow-runs/:id` | `run-state.ts:1648` writes the slot on `model_slot_declared` with **no** receipt; `:1685` sets `slot.receipt` on `model_resolved`. Absent = not started, no receipt = in flight, receipt = resolved. |
| **winner**, scores, rationale | `data.output` on the `node_succeeded` **event** | `WorkflowRunState` (`run-state.ts:216-231`) reduces artifacts, receipts, gate and evidence decisions — there is **no** generic node-output field, so the winner never reaches run state. |

`candidateCount` supplies only the branch **count**, which is legitimately topology. Every branch's
**state** is read from that branch's own slot. `candidateCountForNode` mirrors the executor's own
fallback chain (`candidateCount ?? candidateModels?.length ?? 2`) exactly — reading only
`candidateCount` would draw the wrong number of branches for a node configured with
`candidateModels`, and the drawing would look authoritative while being wrong.

An absent verdict renders as "No candidate has been chosen yet", never as "candidate 1 won".

## Resilience and accessibility

`WorkflowRunState.executions` is `Record<string, unknown>` on the client (`dag-workflows.ts:365`) —
deliberately opaque. Per **#62**, every read is guarded and a malformed-but-200 body yields an empty
projection instead of throwing in render phase; two unit tests pin that.

Per **§6.6**, no state is carried by colour alone: each branch prints its state as a word, the winner
is labelled "★ winner" in text, and the branch marker is a border weight rather than a hue.

## Evidence

Proven on the lane's preview: a `candidateCount: 4` run declared
`candidate-1`, `candidate-2`, `candidate-3`, `candidate-4` and `candidate-evaluator` as real slots on
the run's execution. Transcript in `W/reports/f6-evidence.md`, with the honest note that the
candidates then failed on `WORKFLOW_MODEL_NO_AUTHENTICATED_CANDIDATE` because the preview has no
provider credentials, which this lane must not supply.
