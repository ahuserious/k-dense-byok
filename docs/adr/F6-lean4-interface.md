# ADR F6 — consume F4's Lean 4 authoring contract without duplicating proof UI

- Lane: F6
- Consumer interface: `wave-f/interfaces/F4-lean4.md` (draft)
- Integration base: `51f0b7d`

F6 wires the part of F4's interface already present on the integration base:
`addDefaultNode(graph, "lean4")` creates the canonical node defaults from
`dag-workflow-builder.ts`. The Compose surface exposes **Add Lean 4 node** and
an inline inspector for mode, theorem/proposition, informal goal, Mathlib, and
solver model. Verify mode disables the solver picker with F4's exact reason:
“Lean verify mode is deterministic and has no model slot.”

The added node is not disconnected. Current terminal nodes are demoted and hand
over to it using the same evidence-aware condition helper as stitching and
fusion boost. This makes the authored graph immediately valid and preserves the
existing evidence-route rules.

F6 does **not** add a proof renderer or parse `node_succeeded` output. F4's
`web/src/components/lean4/**`, `web/src/lib/lean4-proof.ts`, and API route are
not present at integration `51f0b7d`; they exist only as uncommitted lane-F4
work. Once F4 lands, the run-details follow-up is one import of
`Lean4ProofArtifact` plus the two published client calls. Until then, copying
those files into F6 would create the second renderer the interface explicitly
forbids.
