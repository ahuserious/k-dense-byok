# F5 — council roles

**Status:** Accepted  
**Date:** 2026-08-20

## Decision

Add an optional `fuser` model slot to `CouncilNodeSchema`. The existing `chair`
remains the judge. A fuser, when authored, runs once after the last chair
decision and writes `fusedAnswer` on the node output.

Palette defaults (row 29) are **4 heads + 1 judge + 1 fuser**. The schema
minimum stays 2 members so existing graphs keep validating. `fuser` is optional
for the same reason.

## Rejected option

Mapping judge→`chair` and fuser→a downstream `fusion` node. That would make the
owner's 4/1/1 default two nodes and a hidden edge, and F6 would have to author
a pair every time. One kind with three roles is the smaller change.

## Recruitment

`maxRecruits` is optional, 0–8, and must not exceed the node's effective
`maxSubagents`. Recruited heads use dynamic slots
`council-round-{n}-member-recruited-{k}` and appear in
`nodes[].recruitment = { recruited, maxRecruits, reason? }`.

## Head selection

`headSelection: "auto" | "manual"` is read by `selectCouncilHeads` before
dispatch. `manual` keeps the authored `members[]` roles. `auto` replaces
those roles with inbound reasoning-style refs, then mimeograph refs, then
the four workflow-type scientist defaults. Omitted `headSelection` is
manual unless inbound reasoning-style refs are present (row 35). The
member ids and models stay authored so declared slots remain valid.
