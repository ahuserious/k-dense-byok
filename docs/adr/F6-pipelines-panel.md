# ADR F6 — `pipelines-panel.tsx` is deleted, not promoted (#43)

- **Status:** accepted, and acted on in the same change (the file is deleted in this commit).
- **Lane:** F6 (Wave F, round 1). **Defect:** #43.
- **Date:** 2026-08-19.

## Context

#43 records that `web/src/components/pipelines-panel.tsx` is orphaned, and the wave constraint is
**"do not leave two panels."** Re-measured on the lane clone at base `b702a8b`:

```
$ wc -l web/src/components/pipelines-panel.tsx
     128 web/src/components/pipelines-panel.tsx

$ grep -rn "pipelines-panel\|PipelinesPanel" web/src e2e | grep -v "components/pipelines-panel.tsx:"
web/src/components/settings-dialog.tsx:593:function PipelinesPanel() {
web/src/components/settings-dialog.tsx:736:            <PipelinesPanel />
```

Both hits are a **locally declared, unrelated** `function PipelinesPanel()` inside
`settings-dialog.tsx` (lane F8's file, untouched here). **Nothing imports
`@/components/pipelines-panel`.** The file is dead code with a live-looking API: `onRunPipeline` /
`onEditPipeline` props, an engine health probe, and a `listPipelines()` call.

## The decision, and what it is measured against

**Delete it.**

The question is not "is it dead" — it plainly is — but "should it become the one panel instead?" It
should not, and the reason is which **store** it reads.

`pipelines-panel.tsx` lists the **vendored engine's** pipelines via `listPipelines()`
(`web/src/lib/pipelines.ts:55`), which is the engine's legacy YAML store. The product's authoring and
execution path is the **typed** store at `/dag-workflows`. Those are two different document models
with two different runtimes — the typed one has `agent`/`council`/`fusion`/`best-of-n`/`evidence-gate`/
`lean4` nodes, the engine one has `command`/`prompt`/`bash`/`script`/`loop`.

What the user already has, without this file:

* `web/src/components/dag-workflows-panel.tsx` lists **typed** workflows with revision, node and edge
  counts, a **Run typed workflow** control (`:669`), and per-entry **Edit** and **Run** for
  engine-native rows (`:341`, `:350`) — so it already covers both stores, in one list.
* `page.tsx → DagBuilderSurface → PipelineBuilderPanel` is the live builder route, and
  `dag-builder-surface.tsx` is a typed authoring controller that lists, loads, validates and saves
  typed workflows.

So promoting `pipelines-panel.tsx` would mean making an **engine-only** list the primary surface,
losing the typed store — a regression — and would still leave `dag-workflows-panel.tsx` in place.
That is the "two panels" outcome the constraint forbids, arrived at from the other direction.

Deleting it leaves exactly one workflow list (`dag-workflows-panel.tsx`) and one builder route.

## Consequence for the dead call sites — the part an ADR that only recommends would miss

`web/src/lib/pipelines.ts` exports three functions. After this deletion:

| Export | Status after deletion |
|---|---|
| `pipelineHealth()` | **Still live.** Used at `web/src/components/pipeline-builder-panel.tsx:13,37` as the `healthCheck` for the builder iframe. Keep. |
| `runPipeline()` | Out of scope for #43; not referenced by the deleted panel. |
| `listPipelines()` | **Now dead in app code.** Its only remaining references are its own unit test at `web/src/lib/pipelines.test.ts:4,33,36`. |

**`web/src/lib/pipelines.ts` and `web/src/lib/pipelines.test.ts` are not in lane F6's writable set**
(the glob is `web/src/lib/pipeline-*.ts`, which requires the hyphen and does not match
`pipelines.ts`). This lane therefore **does not** remove `listPipelines()`. The exact removal is
written into `INTEGRATION.md` at the clone root for the orchestrator, together with the test lines
that must go with it. Leaving the function is safe — it is an unused export, not a broken one — and
removing it from a file this lane does not own would fail `ownership-check` and bounce the whole
lane.

## `OriginBadge.tsx`

#43 also names a user-visible legacy identity badge at
`server/vendor/pipeline-engine/packages/web/src/components/.../OriginBadge.tsx:9`. **That file is not
in lane F6's writable set.** It is noted here and left alone; it needs its own lane assignment.

## Alternatives rejected

1. **Keep it and wire it up somewhere.** Rejected: it duplicates `dag-workflows-panel.tsx` over a
   narrower store, which is the defect rather than a fix for it.
2. **Merge its engine-health badge into `dag-workflows-panel.tsx`.** Rejected as scope this round:
   the builder route already health-gates the engine through `EngineIframePanel`, so the badge would
   be a third place reporting the same fact.
3. **Recommend deletion without deleting.** Rejected explicitly — the brief is that an ADR which
   recommends without acting leaves the defect open.
