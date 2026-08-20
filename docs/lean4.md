# Lean 4 proof artifacts

Matrix row 10, lane F4. This document describes how a Lean 4 node's proof reaches a user, and — just as
importantly — which parts of that path already existed and are deliberately not duplicated here.

Terminology, once: **"mimeographs"** in this codebase means the reusable persona/agent-definition library
(`deliberation.mimeographs` in `NodeSpecV1`, backed by `server/src/personality-store/`). It has nothing to do
with Lean; it is named here only because it lives a few lines away in `validate.ts`.

## What already existed

| Piece | Where | What it does |
|---|---|---|
| Node schema | `server/src/workflows/schema.ts:506` | `kind: "lean4"` with `goal`, `theorem`, `mode`, `solverModel?`, `mathlib`, `skill` |
| Validation | `server/src/workflows/validate.ts:522, 637, 969-1017` | model-call budget, verify/solve model rules, Lean-specific evidence-policy rules |
| Executor | `server/src/workflows/kady-node-executor.ts` (`lean4` branch) | preflight → optional solver call → **trusted verifier** → bounded receipt |
| Trusted verifier | `server/src/workflows/lean4-verifier.ts` | runs `lake env lean` against a pinned Mathlib checkout, writes the two artifacts, returns the receipt |
| Mathlib pin | `inspectPinnedMathlibCheckout()` | proves the checkout is **detached, clean and equal to its Lake manifest**, and returns `{revision, tree}` |
| Artifact trust boundary | `server/src/workflows/lean4-artifacts.ts` | `KADY_LEAN_ARTIFACT_ROOT` and the two exact host-owned paths |
| Runner enforcement | `server/src/workflows/runner.ts` | refuses a Lean node without a trusted status, and a `verified` status without **both** receipts |
| Replay enforcement | `server/src/workflows/run-state.ts` | re-derives the same invariant from the event log |

## Where the artifacts live

```
<projects root>/<projectId>/sandbox/
  workflow_artifacts/dag-workflows/lean/<runId>/<executionId>/
    Proof.lean          text/x-lean
    verification.log    text/plain
```

`isTrustedLeanArtifactPath(runId, executionId, candidate)` is an **exact string** test against those two
paths. `…/Proof-copy.lean` is refused, and `server/test/workflow-runner.test.ts` has the regression that
proves it. Nothing in this lane widens that boundary; the read API reuses the same predicate as a filter.

## What this lane added

### `server/src/api/lean4.ts`

Two read-only routes. See `interfaces/F4-lean4.md` in the wave evidence tree for the full wire contract.

- `GET /lean4/runs/:runId/proofs` — every Lean node execution of a run, projected into a bounded receipt
  carrying `status`, `theoremName`, `normalizedStatement`, `toolchain`, **`mathlibRevision`**,
  **`mathlibTree`**, `executionPolicy`, `assumptions`, `translationGaps`, and both artifact receipts with
  their sha256.
- `GET /lean4/runs/:runId/proofs/:executionId/source?artifact=proof|log` — a bounded (256 KiB) prefix of the
  artifact text, with `truncated` stated rather than implied.

The provenance is **projected, never recomputed**. `inspectPinnedMathlibCheckout()` is the single producer of
the Mathlib pin; a second computation would be a second source of truth for one commit id.

Three refusals the source route makes, in order:

1. The path is **derived** from `trustedLeanArtifactPaths(runId, executionId)` and never accepted from the
   caller, so there is nothing to traverse with.
2. A derived path bounds the *name*, not what the name resolves to, and the sandbox is user-writable — so a
   **symlinked component anywhere on the way down is refused** (`403 LEAN4_ARTIFACT_UNTRUSTED`) and the file
   is opened with `O_NOFOLLOW`. `runner.ts` refuses symlinked components on the write side for the same
   reason; the reader is not the one place that does not.
3. Only artifacts the run **durably accepted** are served. A file sitting at a trusted path that the runner
   refused, or for which no receipt exists, answers `404` — it is not this run's evidence and must not be
   presented as verified output.

No error body carries a filesystem path, an `errno`, or a stack.

### `web/src/components/lean4/` — the ONE proof renderer

```ts
import { Lean4ProofArtifact } from "@/components/lean4";
```

Purely presentational: the mounting surface owns both fetches (`web/src/lib/lean4-proof.ts`). Lane F6's node
inspector mounts it and lane F11's `lean4-prover` skill surface reuses it. **There must be no second proof
renderer.**

## Known gap: a rejected proof loses its Mathlib pin

`runner.ts` persists node output only on `node_succeeded`
(`data: nodeResultData(output, artifacts, routeCondition)`). A **rejected** Lean verification throws, so it
lands on `node_failed`, whose event data is `{error, routeCondition}` — the executor's output object, and
with it `mathlibRevision`/`mathlibTree`, is never stored.

The verdict survives (through the node error code `WORKFLOW_LEAN_VERIFICATION_FAILED` /
`WORKFLOW_LEAN_VERIFIER_UNAVAILABLE`) and so do the artifact receipts (through the `evidence_checked` event),
so the failed proof is still openable — which is the case a user most wants to read. Only the pin is lost.

The API reports this explicitly as `provenanceGap: "discarded-on-failure"` rather than letting a renderer say
"the verifier never reported it", which would be false. `runner.ts` belongs to another lane; the finding is
recorded in the clone's `INTEGRATION.md`.

## Reachability today

The `lean4` node kind is present in `web/src/lib/dag-workflow-builder.ts` (`WORKFLOW_NODE_KINDS`,
`createNode`, `nodeKindLabel`) but **nothing in the running app imports any of it** — the only consumer is
its own unit test. There is no node palette and no node inspector in the app at base `f98da86`; both are
lane F6's surfaces. Until F6 lands, this lane's renderer is reachable only from a test.
