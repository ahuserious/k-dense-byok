# ADR F7 — importing the DAG-Pipelines seed workflows and de-branding them

- Lane: **F7**, master-brief rows 20–21
- Source: branch `DAG-Pipelines` @ `a6c1962` of the fork
- Base: `b702a8b`
- Status: accepted and wired into the project scaffold

`docs/adr/**` is an allowed path in `config/token-ban.json`, so this file — and
only this file — may name the retired brand token. It is **`archon`**,
case-insensitive. Everywhere else, including `docs/inventory/f7-seed-import.json`,
that token is written `{legacy}`.

---

## 1. Context

`server/seed/pipelines/` does not exist on the integration tip and the string
`seed/pipelines` is referenced zero times in `server/src`, `server/test` and
`web/src`. The source branch carries three pipeline documents, two skill trees
and a de-branding toolkit under `server/seed/`. Row 20 asks for the pipelines to
appear in the library and to load, validate and run; row 21 asks for a
pipeline-builder skill named for what it is, with substantive content.

Two findings shaped the whole lane and are recorded before the decisions,
because the decisions do not make sense without them.

**Finding 1 — row 21's stated defect no longer exists.** The master brief quotes
NT-1's finding that `scientific-dag-studio` was a nominal rename carrying zero
rescue guidance (`grep -rniE 'rescue|stuck|failed'` → 0). Re-measured in this
lane's clone at `b702a8b`: **65 hits**, and `references/rescue-playbook.md` is
**24344 bytes**. NT-1 fixed it. F7 did not, and claims no credit for it.

**Finding 2 — the translator already exists.** `server/src/workflows/legacy-pipeline-import.ts`
(587 lines, tested) converts legacy pipeline YAML into a typed
`WorkflowGraphDocument`, and is already served at
`POST /dag-workflow-imports/legacy-pipeline/preview`. Writing a second parser
for the seed files would have been a duplicate of an existing capability. The
loader therefore owns no parser and no translator.

The live row-21 gap, re-derived: the upstream `archon/**` skill — 21 files,
~150 KB, including `references/workflow-dag.md` (28403 B),
`references/parameter-matrix.md` (18505 B), `references/dag-advanced.md`
(11174 B) — was never imported into this fork at all, even though
`server/src/agent/skills.ts:32-37` still fingerprints a removed `archon`
directory. The builder skill in this fork is named correctly and carries no
authoring reference for the dialect it exists to emit.

---

## 2. Decision — what came across

### 2.1 The three pipelines

| Upstream at `a6c1962` | Lands as | Dialect |
|---|---|---|
| `server/seed/pipelines/kdense-starter.yaml` | `server/seed/pipelines/research-starter.yaml` | legacy pipeline YAML, unchanged in structure |
| `server/seed/pipelines/data-scientist.yaml` | `server/seed/pipelines/data-scientist.yaml` | typed NodeSpec v1 |
| `server/seed/pipelines/composed-research-pipeline.yaml` | `server/seed/pipelines/composed-research-pipeline.yaml` | typed NodeSpec v1 |

### 2.2 The authoring corpus

Adapted out of `server/seed/skills/archon/**` into paths this lane owns:

| Landed | Adapted from |
|---|---|
| `scientific-dag-studio/references/recipes/two-runtimes.md` | new — derived by measuring both of this fork's schemas |
| `scientific-dag-studio/references/recipes/typed-node-vocabulary.md` | `archon/references/{workflow-dag,parameter-matrix}.md`, re-derived against `server/src/workflows/schema.ts` |
| `scientific-dag-studio/references/recipes/legacy-dialect-nodes.md` | `archon/references/{workflow-dag,dag-advanced,interactive-workflows}.md`, re-derived against the vendored `schemas/dag-node.ts` |
| `scientific-dag-studio/references/recipes/variables-and-outputs.md` | `archon/references/variables.md` |
| `scientific-dag-studio/references/recipes/good-practices.md` | `archon/references/{good-practices,troubleshooting}.md` |
| `scientific-dag-studio/references/recipes/example-pipelines.md` | `archon/examples/dag-workflow.yaml`, retargeted at the three seeded pipelines |
| `scientific-pipelines/references/typed-workflow-operations.md` | new — the typed runtime's routes, which the operational skill had no reference for at all |
| `scientific-pipelines/references/seeded-pipelines.md` | new |

Both `SKILL.md` files index the new files, and `server/test/rescue-skill-content.test.ts`
pins that index against the same canonical path the rescue helper resolves.

---

## 3. Decision — what did NOT come across, and why

### 3.1 `server/seed/archon-rebrand/**` — not imported (D2 confirmed)

Nine files read at `a6c1962`: `apply-debrand.sh` (21350 B),
`apply-archon-models.sh` (14022 B), `apply-rebrand.sh` (5611 B), four upstream
console component overrides (`BuilderToolbar.tsx`, `CanvasChatPopout.tsx`,
`ProjectRail.tsx`, `kady-builder-chrome.css`) and two brand PNGs
(`kdense-logo.png` 384815 B, `favicon.png` 6988 B).

The scripts *perform* a rename this fork already performed — landing them would
ship the tool for a migration that is complete. The component overrides target
the upstream console, not `web/src/components/**`. The PNGs are assets for a
brand surface this app does not ship. Nothing product-critical; no request filed.

### 3.2 `server/seed/skills/archon-dev/**` — not imported (D2 confirmed)

Eleven files: a SKILL.md and ten cookbooks (`commit`, `debug`, `implement`,
`investigate`, `issue`, `plan`, `pr`, `prd`, `research`, `review`) describing the
*upstream project's* contributor workflow — its issue tracker, its PR
conventions, its repo layout. It is a developer skill for that repository, not a
capability of this product. Nothing product-critical; no request filed.

### 3.3 `server/seed/skills/archon/**` — not imported as a directory (D1 confirmed, with an addition)

D1 stands: no `archon/` directory lands, and the product-relevant content is
adapted rather than pasted. Dropped outright:

- `references/cli-commands.md` (12286 B) and `references/authoring-commands.md`
  (6856 B) — a standalone CLI and a stored-command catalogue this app does not ship.
- `guides/{cli,config,server,setup,github,discord,slack,telegram}.md` (~35 KB) —
  install, configuration and chat-adapter operations for surfaces that do not exist here.
- `examples/command-template.md` — command nodes are vendored-engine-only and
  there is no command catalogue for a template to land in.

**The addition to D1.** D1 says to key the adapted content "to what this fork's
engine actually supports". That has *two* answers, and treating it as one would
have produced exactly the lying skill D1 warns about. This fork runs

- the **typed NodeSpec v1 runtime** (`server/src/workflows/**`), which has no
  `loop`, no `approval`, no `bash`/`script` node, no `output_format`, no
  `context: fresh`, and spells node skills `settings.skills.list`; and
- the **vendored pipeline engine** (`server/vendor/pipeline-engine/**`), whose
  `packages/workflows/src/schemas/dag-node.ts` carries the upstream dialect
  nearly in full — including all of the above.

So the upstream prose is mostly *true*, just true of the wrong surface. Every
adapted file states which surface each field belongs to, and
`recipes/two-runtimes.md` exists solely to establish that distinction before any
other file is read.

### 3.4 The other 47 science skill directories — not imported

`server/seed/skills/**` at `a6c1962` also holds 619 files across 47 unrelated
science skills (`docx`, `pptx`, `polars`, `pymc`, `matplotlib`,
`database-lookup`, …). They are outside rows 20–21 and outside F7's writable
set, and this app fetches its skills catalogue at runtime. Importing them would
be a 619-file uninstructed change. The lead's response to
`W/requests/c-f7-1.md` explicitly decided that they remain runtime-fetched;
F7 therefore imports none of those directories.

---

## 4. The de-branding rename map

Applied **in the same change that lands the files**, per master-brief §2
constraint 4. Nothing was landed and then renamed.

| Kind | Old | New |
|---|---|---|
| directory | `server/seed/skills/archon/` | *(no directory; content adapted into `scientific-dag-studio/references/recipes/`)* |
| directory | `server/seed/skills/archon-dev/` | *(not imported)* |
| directory | `server/seed/archon-rebrand/` | *(not imported)* |
| file | `server/seed/pipelines/kdense-starter.yaml` | `server/seed/pipelines/research-starter.yaml` |
| YAML `name:` | `kdense-starter` | `Research Starter` |
| YAML `name:` | `data-scientist` | `Data Scientist` |
| YAML `name:` | `composed-research-pipeline` | `Composed Research Pipeline` |
| workflow id | `kdense-starter` | `research-starter` |
| prose | "A single Archon DAG that COMPOSES three real Kady WorkflowsPanel templates…" | "A single scientific DAG that composes three research phases…" |
| prose | "Built with the scientific-pipeline-builder method" | "the 3× adversarial verification block this skill appends" |
| prose | "A gentle starter workflow for new K-Dense projects." | "A gentle starting point for a new project." |
| prose | `.archon/scripts/` | "the engine's scripts directory" |
| prose | `archon run` / `archon workflow …` | *(dropped — no CLI here)* |

The pipeline id `kdense-starter` was renamed even though `kdense` is not the
banned token. Rows 20–21 ask for names that say what the thing is; a seeded
pipeline named after the product it ships inside tells a researcher nothing.

Verification: `node scripts/token-ban.mjs` returns `PASS (0 violations)` with
exit 0 on the landing tree, and `server/test/seed-pipelines.test.ts` asserts —
from fragments, so the assertion is not itself a violation — that neither the
seed source bytes nor the translated documents contain the token.

---

## 5. Where the loader lives

`server/src/workflows/seed-pipelines.ts`, beside the store it writes through.

```
server/seed/pipelines/*.yaml
   → seedProjectPipelines(projectId)
       → schemaVersion: "1.0"?  → validateWorkflowGraphDocument   (existing)
         otherwise               → previewLegacyPipelineWorkflow  (existing)
       → WorkflowStore.saveDefinition                             (existing)
   → GET /dag-workflows                                           (existing)
   → Scientific Pipelines ▸ Workflow registry                     (existing)
```

Rejected alternatives:

- **`web/src/data/dag-workflow-templates/**` (S10).** That is a client-side
  *template picker* behind a create flow, not a library of existing workflows.
  Seeding there would put product content in the web bundle and would not satisfy
  "seeded pipelines appear in the library".
- **`server/src/workflows/store.ts` (S5).** The correct destination, but it needs
  no change. F7 calls `saveDefinition`; it does not edit the store.

Behaviour: non-clobbering (a workflow id the project already holds is skipped,
mirroring `copySkillDirs`), idempotent, and it reports content failures instead
of throwing — a malformed seed must never be able to take project creation down.

The approved call site is `server/src/projects.ts` inside
`ensureProjectExists`, the function that scaffolds both new and pre-wave
projects. The handoff from dormant lane C5 permits exactly one import and one
call beside `seedSandboxFiles`; no duplicate call was added to
`server/src/api/projects.ts` or `server/src/prep.ts`.

`ensureProjectExists` is synchronous and has many synchronous callers. The
loader also performs only synchronous filesystem/store operations, so it now
returns `SeedPipelineReport` synchronously and is called directly. Converting
the scaffold to async merely to spell `await` would require widening unrelated
public APIs and could let callers forget to wait. The direct call preserves the
approved intent: the first workflow-list read cannot race the seed pass.

---

## 6. NodeSpec v1 position of the seeded documents

The seeds are **subject to** the frozen NodeSpec v1 contract, not an extension of
it. This lane changed no schema and no file under `docs/contracts/**`.

- Every seeded document is validated by `validateWorkflowGraphDocument` before it
  is stored, and again by `WorkflowStore.saveDefinition`, which refuses an invalid
  document and refuses one whose `id` does not match its workflow id.
- `graphSha256` is computed by the store over the canonical document, exactly as
  for a user-authored workflow. A seeded definition is not distinguishable from a
  hand-authored one once stored — deliberately, since that is what makes the
  existing list endpoint and the existing panel work unchanged.
- Each seeded document additionally carries the existing optional, validation-
  neutral `provenance: { source: "seed-pipelines", id: "<file>.yaml", sha256 }`,
  where the sha256 is of the committed seed file's bytes. This is an existing
  field on `WorkflowGraphDocumentSchema`; no field was added to use it.

**Where a pipeline needed a field that does not exist, the pipeline was adapted
and the adaptation recorded — never the schema.** Per pipeline:

### `research-starter` (legacy dialect)

One adaptation: `interactive: true` → `false`. NodeSpec v1 has no human gate
between stages, and `previewLegacyPipelineWorkflow` rejects the flag outright
rather than silently dropping the pause. Everything else — the three nodes, the
prompts, the models, the `depends_on` chain — is upstream's.

It lands with the import path's defaults: read-only workspaces, `rescue`
disabled, and **`maxCostUsd: 0`**, which closes paid execution until a human
reviews and sets a budget. That is deliberate on the translator's part and is
kept, not overridden: it is the honest disabled state for a document nobody in
this fork has yet reviewed for spend. Both `docs/seed-pipelines.md` and the
operational skill's reference say so, so it does not read as a defect.

### `data-scientist` (typed)

- upstream `loop:` node (`until: COMPLETE`, `max_iterations: 10`,
  `fresh_context: false`) → a bounded agent node. `limits.maxIterations: 10`
  carries the bound; the prompt carries the completion condition **and** the
  instruction to name the remaining steps rather than claim completion if ten
  passes are not enough.
- upstream `approval:` node (`capture_response: true`, `on_reject.max_attempts: 3`,
  `$REJECTION_REASON`) → an adversarial reviewer agent node. **The human gate is
  gone.** It is stated in the document's own `description`, so a researcher
  launching it from the registry is told before they run it, not after.
- upstream `idle_timeout: 600000` → dropped; no NodeSpec v1 equivalent.
- upstream `interactive: true` → no counterpart.

### `composed-research-pipeline` (typed)

Kept: the three-phase structure; the 3× adversarial verification block after
every substantive phase; the per-phase scribe nodes; per-node skills
(`skills:` → `settings.skills.list`); and the two reasoning-boosted steps, which
land as real `kind: "fusion"` nodes on the hosted OpenRouter router rather than
as agent nodes pointed at the `openrouter/fusion` compound alias — which the
validator explicitly refuses (`compound-model-needs-fusion-node`).

Lost, each for a named reason:

| Upstream | Why it could not land |
|---|---|
| two `approval:` gates | NodeSpec v1 has no human gate of any kind |
| `context: fresh` per node | no field; obtained structurally instead — each verification pass is its own node and therefore its own execution |
| `output_format:` JSON schema on verify nodes | no field; the prompts state the required answer shape |
| `$ARTIFACTS_DIR` interpolation | the typed runtime has no variable substitution; artifacts are declared in the `artifacts:` block |
| `$plan.output` cited from non-adjacent nodes | the typed runtime guarantees a node only the record of its own inbound edges; each verify prompt now stands on its own |

Both losses of a *human* gate are stated in the document's `description` and in
the file's header comment. A researcher must not discover from a completed run
that nobody reviewed it.

---

## 7. The harsher framing

Recording it here rather than softening it, per master-brief §11:

1. **Row 20's Gate U depends on the scaffold wire, not only on committed
   content.** The approved `server/src/projects.ts` handoff is now applied, and
   both a server effect test and the live browser path create a fresh project
   without invoking the loader directly before reading the registry.
2. **The "run" in Gate B is a run of the durable runner, not of a provider.**
   `runWorkflowDag` executed the seeded graphs with the real store, the real run
   manifest and the real event stream, and the assertions are on which node
   executed in which order and which prompt and resolved model reached the
   executor's dispatch boundary. The provider transport below that boundary was
   not exercised. That is stated plainly in `W/reports/f7-evidence.md` rather
   than described as an end-to-end run.
3. **The `composed-research-pipeline` that lands is not the file that was
   imported.** It carries the same intent and a third fewer capabilities. Calling
   it "imported" without the loss table would be false; the loss table is in §6
   and in the file's own header.
