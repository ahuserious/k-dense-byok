# ADR F6 — best-of-n uses React Flow without inventing concurrency (row 33)

- **Status:** accepted; React Flow is delivered, while sequential execution remains explicit.
- **Lane:** F6, Wave F rescue round. **Row:** 33.
- **Date:** 2026-08-20.

## What row 33 asks for

> **Best of n** — splits the workflow n ways, **visually depicted in the React Flow dashboard**.
> The graph view **renders the n-way split as n parallel branches, live**. The existing `best-of-n`
> executes; the visualisation reflects real candidate state, **not a static fan-out drawing**.

The dashboard and live-state claims are met. The word “parallel” is not: the executor is sequential,
and the visualisation must not claim otherwise.

## React Flow lives on the typed-runtime side

Round 1 found that the existing React Flow surface — `WorkflowDagViewer.tsx` — renders
the **vendored engine's** runs: its props are `dagNodes: readonly DagNode[]` and
`liveStatus: readonly DagNodeState[]` (`WorkflowDagViewer.tsx:41-48`), fed from the vendored REST+SSE
in `WorkflowExecution.tsx`. That runtime has no `modelCallSlots` and no `best-of-n` kind; those are
**typed Kady runtime** concepts.

The lead approved the smaller and correct boundary: `@xyflow/react` is now a direct `web/`
dependency at the same `^12.10.1` range as the vendored package. The typed run view renders its own
React Flow graph in `web/src/components/pipeline/best-of-n-branch-view.tsx`; no host-bridge message
and no vendored-run model were repurposed. The projection remains separate in
`web/src/lib/best-of-n-branches.ts`.

## Runtime divergence — the branches are not parallel, and the UI says so

`server/src/workflows/kady-node-executor.ts:2862-2872`:

```ts
      if (node.kind === "best-of-n") {
        const count = node.candidateCount ?? node.candidateModels?.length ?? 2;
        const candidates: AnalysisResult[] = [];
        for (let index = 1; index <= count; index += 1) {
          candidates.push(await delegate({ slotId: `candidate-${index}`, ...
```

`await` **inside** the loop. Candidate *k+1* is not even declared until candidate *k* has resolved.

**Drawing a fan-out that implies concurrency would be a lie about the runtime**, so React Flow lays
the candidates out as a left-to-right sequence with edges labelled “then”. The n candidate nodes are
real — n candidates genuinely exist for `candidateCount: n` — and they light up one at a time in
index order. `SEQUENTIAL_CANDIDATES_NOTICE` is rendered on screen:
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
deliberately opaque. Per **#62**, every read is guarded and a malformed-but-200 body never throws in
render phase. A valid graph with missing run state renders its candidates as `not started`; a
malformed graph renders no projection.

Per **§6.6**, no state is carried by colour alone: each candidate prints its state as a word, the
winner is labelled "★ winner" in text, and every React Flow node has an accessible label.

## Evidence

The server effect test runs a four-candidate node to success with an injected executor, records all
five real slots, persists the `node_succeeded` output, and asserts that the exact projection used by
the UI marks candidate 2 as winner with its score and rationale. The unmocked browser item then
launches a real run and verifies that the run's `modelCallSlots` render inside an actual
`.react-flow` canvas with the sequential notice.
