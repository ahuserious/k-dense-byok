# S10 Scientific DAG library scope — "span the library" ruling

## Status

Accepted by the owner on 2026-08-15. Closes finding (1) of task #44; finding (2) (self-satisfiable
evidence gate on "Blank bounded workflow") remains open and is unaffected by this ADR.

## Context

S10 (task #28) delivered 20 scientific templates spanning finance, ML, and literature workflows. An audit
(task #44, finding 1) found the requirement "span finance + ML + k-dense standard prompt workflows into a
full Scientific DAG library" admits two readings:

- **Floor-of-20**: the 20-row floor is spanned and proven — met.
- **Corpus**: the K-Dense finance / ML / literature prompt corpus is spanned — roughly 20 of 326 prompts
  converted (~6 %), i.e. not met.

The auditor also flagged a population mismatch worth recording: the 20 rows in the workflow inventory are
software-development workflows from the vendored engine, whereas the 20 scientific templates derive from
`web/src/data/workflow-*`, so "replacing the 20-row export" compares two different populations. No ADR
recorded which reading governed; the cut was silent.

## Decision

**Floor-of-20 governs S10.** S10 is complete under the requirement as accepted. Converting the remaining
~306 K-Dense prompt-corpus workflows is separate work with its own backlog item (`BACKLOG-20260815.md`
item N-01 in the evidence bundle) and no bearing on S10's status.

## Consequences

- Task #44(1) closes. Task #44(2) stays open: the "Blank bounded workflow" library entry ships an armed,
  self-satisfiable 2-source evidence gate by default; fix the default and make source-counting reject
  model-authored sources.
- Any future claim that the library "spans the K-Dense corpus" must cite a conversion count against 326.
- The inventory/template population mismatch is acknowledged; a later lane may reconcile the inventory
  export, but that is not S10 acceptance work.
