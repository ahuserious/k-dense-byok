---
name: byom-dag-fusion
description: Formalize and mechanically check mathematical claims with Lean 4 and Mathlib inside a bounded DAG research workflow. Use this skill whenever research depends on a proof, disproof, derivation, invariant, exact symbolic identity, or a mathematically consequential assumption; do not use it for routine arithmetic or when an informal calculation is sufficient.
---

# BYOM DAG Fusion

Use Lean as an evidence-producing verifier within a research workflow. A
successful check proves that the submitted formal statement typechecks under
its declared imports and assumptions. It does not prove that the formalization
faithfully represents the real-world research claim.

## Workflow

1. State the exact claim, variable domains, units, assumptions, and desired
   conclusion in ordinary language. Separate observed premises from modeling
   assumptions.
2. Decide whether Lean is useful. Prefer it for proof obligations, invariants,
   identities, edge cases, and counterexamples. Keep numerical estimation,
   statistical inference, and empirical validation in their appropriate nodes.
3. In solve mode, let the trusted host own the exact normalized proposition,
   theorem name, and reviewed imports. Supply only a bounded Lean proof body
   for that proposition plus translation notes; do not rewrite, weaken, or
   replace the statement. In verify mode, submit reviewed full Lean source and
   treat its statement/import surface as part of the human-reviewed input.
4. Ask Kady's Lean workflow node to verify the host-assembled solve source or
   the reviewed verify-mode source against the pinned Lake project. The trusted host
   launches `scripts/verify-lean4.mjs` with Kady's already-resolved Node
   executable (`process.execPath`); never launch the verifier through a shell
   `node` lookup or a task-controlled `PATH`. The project must already contain
   an installed, commit-pinned Mathlib checkout and stable Lean toolchain.

   The verifier performs no installation or update. Missing Lean/Mathlib is a
   visible `unavailable` result, not permission to substitute an LLM judgment.
   It accepts only the current OS account's canonical `.elan` directory,
   rejects task-supplied `ELAN_HOME` overrides, requires user-owned,
   non-writable-by-others Elan paths on POSIX, and never executes `lake` from
   `PATH`. It records the Elan path and SHA-256 digest and fails if that binary
   changes during verification.
   Kady checks the pinned Mathlib checkout's manifest revision, Git tree, and
   clean tracked/untracked status before and after execution. Those checks do
   not make the surrounding Lake project immutable; its other same-user files
   remain inside the documented unsandboxed trust boundary.
5. Preserve the `.lean` source, the complete verifier log, Lean toolchain,
   Mathlib revision and tree, imported modules, the exact audited allowed-axiom
   subset, and the workflow node execution ID as run artifacts.
6. Report two conclusions separately:

   - Formal result: whether Lean accepted the submitted theorem without
     `sorry`, `admit`, or user-declared axioms, plus the exact audited subset of
     the host allowlist (`propext`, `Classical.choice`, and `Quot.sound`) that
     Lean reported.
   - Translation result: why the theorem matches the research claim, plus any
     assumptions, omitted cases, unit conversions, or empirical premises Lean
     did not validate.

## Failure and review rules

- Treat a nonzero verifier exit, missing dependency, timeout, or malformed log
  as a failed or unavailable node. Never relabel it as a successful proof.
- Reject admitted placeholders and user-declared axioms. Imported Mathlib
  foundations remain visible through the pinned environment and imports.
- Require exactly one well-formed allowed-axiom audit receipt. Missing,
  duplicate, unknown, or non-allowlisted axioms make verification fail; never
  summarize an audited subset as “no assumptions.”
- When formalization is uncertain, send the statement and translation gap to a
  Council or human gate before revising it. A solver model may propose proofs;
  only the local verifier can produce the formal success receipt.
- Keep proof repair bounded by the node's attempt, token, and wall-clock limits.
  Do not run `lake update`, install toolchains, or fetch dependencies implicitly.
- A counterexample disproves only the formal statement it inhabits. Map it back
  to the original domains and assumptions before drawing a research conclusion.

## Output contract

Return:

- `status`: `verified`, `failed`, or `unavailable`;
- the theorem name and normalized statement;
- Lean and Mathlib versions, revision, and pinned Mathlib tree identity;
- the exact audited allowed-axiom subset;
- source and log artifact paths;
- assumptions and translation gaps;
- a concise explanation of what the result does and does not establish.
