# ADR F6 — the stitch model: flatten with provenance, order with edges (row 22)

- **Status:** accepted. **Lane:** F6, Wave F round 1. **Row:** 22 (and row 19's live half).
- **Date:** 2026-08-19.

## The constraint that decided the design

Row 22 says the stitch must write "the **existing** `meta.compositeOf` provenance — do not invent a
parallel field". Read in full (`server/src/workflows/schema.ts:325-361`), that field says what it is
for, in its own doc comment:

> Additive, optional, and deliberately outside validation semantics: **nothing in validate.ts
> branches on it**, and it exists so an imported or stitched-in node can name its source **without
> the executor ever consulting it**.

and it is named "**Flatten** provenance for a node that arrived as part of a stitched subgraph."

So `compositeOf` is a **record that a flatten happened**. It is not an instruction and nothing
resolves it. Two consequences follow, and together they are the whole design:

1. **Provenance cannot carry the ordering.** If the phase order lived in `compositeOf`, nothing would
   read it, and the "composed pipeline executes phase by phase" half of row 22 would be a claim with
   no mechanism.
2. **Therefore the ordering is carried by edges.** `stitchWorkflows` routes phase *N*'s terminal
   nodes into phase *N+1*'s entry node. The ordinary DAG scheduler then runs the phases in sequence
   with no new concept, no new node kind, and no schema change.

`schema.ts` is frozen (NodeSpec v1) and all 43 of its objects are `additionalProperties: false`, so a
design needing a new field would have been blocked. This one needs none.

## The rule that is easy to get wrong

Phase *N*'s terminal nodes **stop being terminal**. They gain an outgoing edge, and
`validate.ts:1812` rejects a terminal node that has one. Once demoted they fall under
`validate.ts:1650`/`:1657`, which require either a success+failure pair or a single unconditional
route — and `:1641` forbids mixing the two styles.

So the handover edge's condition is **not a style choice**; it is dictated by the node:

* a node that **uses evidence routes** (`kind: "evidence-gate"`, or an effective evidence policy with
  `onUnsupportedOutput: "route"`) must route with `evidence-supported`, and additionally
  `evidence-unsupported` when its policy routes unsupported output (`:1717-1735`). `always` on such a
  node is rejected outright (`:1688`).
* every other demoted node is satisfied by one `always` edge.

**Both evidence outcomes are routed onward.** A stitch means "run phase 2 after phase 1", not "run
phase 2 only if phase 1 liked its evidence" — dropping the unsupported branch would silently strand
the run at the phase boundary.

## Decisions worth naming

* **Workflow-wide settings come from phase 1.** `limits`, `evidence`, `rescue`, `defaultModel` and
  `preconditions` are taken from the first phase. There is no meaningful merge — two different
  `limits` objects cannot both hold — and merging `preconditions` across phases would produce
  duplicate keys, which `validate.ts:302` rejects. **Per-node** `limits`, `rescue` and `evidence`
  travel with their own nodes and are untouched, so a phase that configured a node keeps that
  configuration.
* **Identifiers are namespaced and bounded.** `IdentifierSchema` is `^[a-z][a-z0-9_-]*$`, 1..64. A
  prefixed id that ran past 64 would be refused by the server with a message about the id, which
  reads like a bug in the author's workflow rather than in the stitch — so ids are truncated, and a
  `taken` set guarantees uniqueness afterwards, because two long ids sharing a 64-character prefix
  would otherwise silently merge two distinct nodes into one.
* **`idPrefix: ""` for the document already being edited.** "Add this saved workflow as a phase"
  must not rewrite every node id in the document on the canvas, or a second append would produce
  `p1-p1-head`. The appended phase is prefixed; the existing one is not.
* **`compositeOf.kind` is `"dag-workflow"`, and `provenance` is written too.** Not invented: the
  tree's own fixture at `web/src/lib/typed-canvas-adapter.fixture.ts:95-101` already models a composed
  node as `compositeOf: { kind: "dag-workflow", sourceId }` **with** a matching
  `provenance: { source: "dag-workflow", id }`. Matching it keeps one vocabulary rather than two. An
  existing `provenance` is never overwritten — a node that already named an outside origin keeps
  saying so.

## The harsher framing, recorded rather than softened

A stitch is a **copy with a receipt**, and the receipt is inert. `sourceGraphSha256` pins the exact
revision each node came from, so the provenance is precise — but if the source workflow is later
edited, **the composed workflow does not change and nothing tells the author it has drifted.** There
is no re-sync, and `compositeOf` cannot provide one because nothing reads it.

That is a real limitation of composing this way, and it is the same gap that makes **row 19's Gate B
unreachable this wave** (see `docs/adr/F6-pipelines-panel.md`'s sibling request
`W/requests/c-f6-4.md`): a reference that *resolves at run time* would fix both, and it needs a
`workflow-ref` node kind plus expansion at manifest build in `store.ts` — Orchestrator B's files.
Until then, "as reference" is rendered **disabled with that reason** and only "add as phase" is live.

## Evidence

Proven on the lane's own preview (backend `:18301`), not asserted: the composed document passed the
real `POST /dag-workflows/validate`, persisted at revision 1, and the run's node lifecycle events came
back in phase order — `p1-alpha-head`, `p1-alpha-tail`, then `p2-beta-head`, `p2-beta-tail`. Full
transcript in `W/reports/f6-evidence.md`.
