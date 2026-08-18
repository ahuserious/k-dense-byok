# S1 dropped-capability decision

## Status

Accepted for the S1 consolidation lane on 2026-08-08. The identifier and list-presentation boundary is superseded by S1b on 2026-08-10 as described below.

## Context

The workspace exposed two separate list tabs and a Builder toggle between the typed workflow editor and the vendored visual pipeline builder. The requested product shape has one `Scientific Pipelines` list tab and one `Builder` tab containing only the vendored visual builder plus its chat rail.

## Decision

The typed visual graph editor and its `DAG Builder agent` panel are intentionally removed. Typed definitions remain discoverable, creatable from blank or scientific templates, runnable with saved-revision/session/goal/budget safeguards, and fully inspectable from the consolidated `Scientific Pipelines` tab. Opening a typed definition now shows the complete stored definition as read-only JSON with a download affordance rather than routing to the removed editor.

No other list capability is intentionally dropped. The unified registry retains vendored health, refresh, empty/offline handling, Edit, Run, and Open builder. It also retains typed loading/error/empty handling, revision/schema/graph metadata, definition read/open, validation, template selection, creation, save-then-open, and safeguarded Run admission through the existing typed runtime.

Vendored Run now submits directly to the structured `/pipelines/:name/run` route. Its progress is no longer displayed in a newly-created Kady chat because that chat has no structured bridge to the vendored engine's conversation stream; retaining the natural-language chat dispatch would make engine selection ambiguous. The unified row instead shows the returned dispatch receipt and status inline. The current vendored response reports an acceptance status but no workflow `runId`, so the UI labels the client-generated conversation/dispatch id honestly rather than presenting it as an engine run id.

S1 applies client-side spend-limit guards in both the page dispatch callback and the consolidated panel, and it renders a vendored response as successful only when the documented body explicitly reports `accepted: true` with a valid status. These are mitigations, not authoritative accounting. S4 owns backend vendored admission, reservation, engine `runId`, and reconciliation in `server/src/api/pipelines.ts`. S2 owns HTTP failure rejection in `web/src/lib/pipelines.ts`; until that client checks `res.ok`, S1's strict body validation catches ordinary error JSON but cannot distinguish a non-2xx response whose body incorrectly imitates the success contract.

The two backing stores deliberately remain separate engines:

- Vendored pipelines continue to use the vendored engine's health, list, run, edit, and builder routes.
- Typed definitions continue to use Kady's project-scoped typed workflow definition API.

## S1b supersession: shared registry identity

S1b supersedes the earlier statement that presentation and identifiers remain separate. Scientific Pipelines now renders one registry list. Every backing record keeps a stable engine-scoped source identifier (`typed:<workflow-id>` or `vendored:<workflow-name>`), while the registry derives a shared identifier from the normalized workflow name plus a deterministic topology hash. Topology hashing canonicalizes sorted node identifiers and edges, including vendored `depends_on` relationships. Entries deduplicate only when both normalized name and topology hash match; a name match alone never hides a structurally distinct workflow.

A deduplicated row retains both backing routes. Typed details and Run continue through the project-scoped `/dag-workflows` runtime, while vendored Edit, Run, health, refresh, and builder actions continue through the existing pipeline engine routes. Persistence, runtime execution, and storage are still not merged. This is additive presentation deduplication: no runnable backing record is removed or made unreachable.

## 2026-08-18 amendment — owner direction reinstates typed authoring in the Builder (supersedes the "typed editor removed" decision)

The owner's product direction of 2026-08-17 (recorded verbatim in the rescue backlog and in policy amendments
#17/#18) requires that existing workflows load into the visual builder, that library items and saved typed DAGs can
be turned into DAGs, that workflows can be stitched together, and that a per-node CLI harness chosen before drag
reaches the runtime. Those requirements cannot be met while the typed definition has no editor: the vendored
validator rejects every non-default NodeSpec value (`server/vendor/pipeline-engine/packages/workflows/src/
node-spec-enforcement.ts:361-366`), so a harness (or skills, databases, autonomy) chosen in the vendored builder is
structurally unreachable at runtime.

Decision: the vendored React Flow canvas **remains the only builder surface the user sees**, and is demoted to a
projection of an authoritative typed `WorkflowGraphDocument` held by the Kady host. Load, validate (new non-writing
`POST /dag-workflows/validate`), save (`PUT /dag-workflows/:id` with CAS) and run go through the typed route;
engine-native pipelines keep `PUT /pipelines/:name` and `POST /pipelines/:name/run` unchanged in an explicit engine
mode. This supersedes S1's "the typed visual editor is removed and typed definitions stay read-only JSON" only for
the authoring path; the removed *typed builder page* is not reinstated. Rationale, alternatives and the preserved
dissent (finishing the vendored validator/executor pair) are in the fusion-drive plan of record
`dfg-evidence-20260807-135127/s11/fusion/w3w4-fused-plan.md` §1 and §7. Lane W3 implements it; the additive optional
schema fields it needs (`ui.positions`, `meta.compositeOf`, `provenance`) are excluded from validation semantics and
from `graphSha256`, and the NodeSpec v1 contract document is updated in the same lane so the freeze clause holds.

## 2026-08-18 amendment — the Components Studio entry point is retired

Owner direction 2026-08-17: "there should be no components studio or effects added". The launcher is retired at every
mount (workspace header and the projects landing screen) and its e2e spec is deleted (lane W1). The component file
remains importable for tests and documentation. Consequence recorded honestly: the CanvasUI showcase (S9 scope item,
tracked as backlog #40) had no other user-reachable entry, so that showcase is now unreachable by design; the font
gaps it was meant to demonstrate stay tracked separately. Consequence on the S11 item floor is recorded in
`docs/adr/S11-requirement-traceability.md`.

## 2026-08-18 amendment — the chat rail and the DAG compose popover are retired, and that reverses E1 step 6

Lane W1 round 2 deletes `chat-rail.tsx` and `dag-compose-popover.tsx` as unreferenced after round 1 replaced the rail
with the dedicated DAG-builder assistant the owner asked for ("the workflow builder should have a chat in there that
help build the visual / yaml dag workflows"). Recorded here because the deletion is not merely dead-code cleanup:
`e1/e1-port-plan.md` step 6 ported both surfaces deliberately and gated them ("rail collapses/persists, compose stacks
multiple items into one prompt, a rail turn executes and appears in cost UI"), and the project's standing rule is
additive-only — new requirements do not remove sidecar-era capability without a decision.

The decision: the compose-popover capability (stacking several items into one prompt) is **retired**, not ported
forward. The replacement assistant is scoped to proposing DAG structure for the workflow you have open; it does not
stack arbitrary items into a prompt, and it holds no tools. The trade is deliberate — the owner asked for a builder
chat, not for the general rail — and it is strictly a reduction in what a user can do, which is why it is written
down rather than left to the diff. If the stacking capability is wanted back, it returns as its own requirement
against the new assistant, not as a revert.
