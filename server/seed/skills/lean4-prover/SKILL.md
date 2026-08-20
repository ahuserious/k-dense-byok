---
name: lean4-prover
description: >-
  Author and run Kady's existing Lean 4 verify or solve node, preserve trusted
  proof/log receipts and pinned Mathlib provenance, and display them through
  F4's single proof API and Lean4ProofArtifact renderer.
argument-hint: "[theorem or proposition]"
---

# Lean 4 prover

Use the typed `kind: "lean4"` executor. This skill does not run a separate Lean
process, parse a model answer into a private receipt, or render proof artifacts
itself.

## Choose verify or solve

### Verify

- `mode: "verify"`
- `theorem` is the complete reviewed Lean source.
- Do not set `solverModel`.
- Do not set `settings.model`.
- The model-call budget for the Lean node is zero.

### Solve

- `mode: "solve"`
- `theorem` is the exact proposition whose declaration the host owns.
- `goal` is the informal task for the solver.
- Set `solverModel`, or ensure the workflow has a resolvable `defaultModel`.
- The solver returns only the tactic/term body; the host constructs the
  declaration.

For either mode:

- `mathlib` is explicit.
- `skill` is the fixed literal `"byom-dag-fusion"`.
- If node evidence is enabled, require artifact references and never route an
  unsupported proof as success.
- Attach this skill through
  `settings.skills = { "mode": "manual", "list": ["lean4-prover"] }`.

## Worked verify node

```json
{
  "id": "verify-sum",
  "name": "Verify one plus one",
  "kind": "lean4",
  "terminal": true,
  "workspace": {
    "isolation": "read-only",
    "writePaths": []
  },
  "goal": "Machine-check the arithmetic identity.",
  "theorem": "theorem one_plus_one : 1 + 1 = 2 := by norm_num",
  "mode": "verify",
  "mathlib": true,
  "skill": "byom-dag-fusion",
  "settings": {
    "version": 1,
    "skills": {
      "mode": "manual",
      "list": [
        "lean4-prover"
      ]
    }
  },
  "evidence": {
    "enabled": true,
    "minimumIndependentSources": 0,
    "requireArtifactReferences": true,
    "onUnsupportedOutput": "rescue"
  }
}
```

Put the node in a complete WorkflowGraphDocument and validate/save through the
normal DAG workflow endpoints. Never write a run manifest or receipt directly.

## Trusted proof surface

Use F4's only run-scoped client and renderer:

```ts
import {
  listLean4RunProofs,
  readLean4ProofSource,
} from "@/lib/lean4-proof";
import { Lean4ProofArtifact } from "@/components/lean4";
```

Endpoints:

- `GET /lean4/runs/<runId>/proofs`
- `GET /lean4/runs/<runId>/proofs/<executionId>/source?artifact=proof|log`

The source route serves only an artifact receipt accepted by that run. Do not
replace it with `/sandbox/file`, which cannot bind a file to a run or protect
against a changed/symlinked path.

Read these receipt fields:

- `executionStatus` and verifier `status`
- `mode`, theorem name, normalized statement
- `toolchain`
- `mathlibRevision` and `mathlibTree`
- assumptions and translation gaps
- proof/log artifact path, size, digest, and media type
- `provenanceGap`
- bounded error

Use `lean4DisplayState`, `lean4ReceiptPairComplete`,
`lean4ProvenanceComplete`, and `lean4MissingProvenanceReason`; do not rederive
their logic.

## Procedure

1. Confirm whether the user supplied reviewed Lean source (`verify`) or a
   proposition to solve (`solve`).
2. In solve mode, confirm the model and budget before a model call.
3. Validate the complete graph. Fix unsafe Lean evidence policy before running.
4. Start only after the user confirms.
5. Read the run and the F4 proof list. Select the receipt by node id and
   execution id, not by a filename guess.
6. Render with `Lean4ProofArtifact`.
7. Report verified/failed/unavailable/errored separately.
8. For a verified proof, report the full Mathlib revision/tree provenance and
   both artifact digests. A green word without provenance is incomplete.

## Failure handling

- F4 routes return an untyped 404: the proof API has not been mounted on this
  build. Disable source controls with that reason; do not add another client.
- `LEAN4_RUN_NOT_FOUND`: the selected run does not exist in this project.
- `LEAN4_ARTIFACT_UNTRUSTED`: stop. Never try a less restricted file route.
- `LEAN4_ARTIFACT_MISSING`: report the missing accepted receipt/file; do not
  search for a same-named replacement.
- Verifier `unavailable`: report toolchain/Mathlib setup as unavailable, not a
  failed theorem.
- `executionStatus: "failed"` with null verifier status: render as errored.
- `provenanceGap: "discarded-on-failure"`: show the supplied missing-provenance
  reason; do not claim the verifier omitted it.
- Verified receipt missing a proof/log pair: treat as incomplete/tampered
  evidence and stop.
