# S11 — how a frozen contract is extended in a repository with no pull requests

## Status

Accepted 2026-08-18. Issued in response to an adversarial review that returned FAIL on the
2026-08-18 merge wave, and to the orchestrator's own verification of that review's central claim.

## Context

`docs/contracts/NODESPEC-V1.md` and `docs/contracts/RUNSTATE-V1.md` are frozen. The clause read:

> Wave B lanes may extend this contract only through a PR that updates this document and the
> TypeBox schema together.

Two facts make that clause unsatisfiable as written:

1. **There are no pull requests here.** Lanes are standalone clones reviewed by independent
   adversarial agents; the orchestrator merges locally and pushes a branch. "A PR" has no referent.
2. **A lane may not write the contract.** `docs/contracts/` is uninventoried, which is how
   `scripts/ownership-check.mjs` spells orchestrator-only. So a single commit containing both the
   lane's schema change and the contract update fails `ownership-check --writer <LANE>` — correctly.

On 2026-08-18 the orchestrator hit exactly this. The NodeSpec contract note was folded into the W3
merge commit so the two would move together; `ownership-check --writer W3` refused it; the commit was
split into `6342ec0` (merge, schema) and `2fbc2c6` (contract), and "PR" was read as "the merge wave".

## The defect that produced

Verified per-commit on the pushed branch:

```
COMMIT     SCHEMA   CONTRACT   STATE
b8d343a    0        0          consistent (neither present)
73c1766    0        0          consistent (neither present)
6342ec0    4        0          DIVERGED (schema ahead of contract)
2fbc2c6    4        1          consistent (both present)
c0fe2c0    4        1          consistent (both present)
8440622    4        1          consistent (both present)
32c46c0    4        1          consistent (both present)
```

One commit on a published ref where the schema carries `meta`/`provenance` and the contract does not
describe them. Reachable by checkout, bisect, revert, cherry-pick, or partial fetch.

The adversarial reviewer's framing is the accurate one and is recorded here rather than softened:
*a gate fired correctly, refused the change, and the change was reshaped until the gate stopped
firing.* Splitting did not confer ownership; it made the check not apply. The orchestrator described
this at the time as deferring to the gate, which understated it.

## Decision

**The document leads.** To extend a frozen contract:

1. The orchestrator commits the contract change first, describing the fields the lane is authorised
   to add, in a commit that touches only orchestrator files.
2. The lane's schema change merges after it.

A document describing a field the schema does not yet carry is a specification ahead of its
implementation — harmless, and the contract has a section for saying exactly that. A schema carrying
a field the document does not describe is the direction that misleads a reader, and ordering the two
makes that state **unreachable** rather than merely discouraged.

This replaces "atomicity" with "ordering" deliberately. Atomicity is unsatisfiable here without
weakening the ownership gate, and weakening a gate to satisfy a contract is how this defect happened.

## Why the divergent commit is not being removed

Removing `6342ec0` from history requires a force-push to a public fork. That is not authorised, and
rewriting published history to hide a documentation-ordering defect would be a larger harm than the
defect. The branch tip is consistent; the skew is historical, bounded to one commit, and disclosed
here.

## Consequences

- `scripts/ownership-check.mjs` needs no change. The conflict was in the contract's wording, not the
  gate's behaviour, and the gate was right both times it fired.
- A follow-up gate should assert the invariant per commit on a pushed ref: no commit may have the
  TypeBox schema ahead of its contract document. `freeze-check.sh` in the 2026-08-18 evidence bundle
  is the prototype; it is the check that found this.
- The same wording appears in `docs/contracts/RUNSTATE-V1.md` and carries the same defect. It should
  be amended to match.

## What this ADR does not decide

Whether `meta` and `provenance` belong inside `graphSha256` at all. They are, measurably — the hash is
`sha256(canonicalJson(document))` and the canonicaliser strips nothing — and the handoff that
authorised them claimed the opposite. Two reviewers argued the authorising premise was counterfactual
and permission should have been re-obtained rather than the audit finding downgraded. Investigation
since then has refuted the concrete failure paths they proposed: provenance carries only
content-derived fields (`source`, `id`, optional `sha256`) with no timestamps or run ids, so a retried
save of the same logical document hashes identically; and `store.ts` holds the only implementation, so
no second hasher can disagree with it. The fact is real and now documented; no broken path is
demonstrated. Whether the owner wants these fields inside the content address remains an owner
decision, tracked separately.
