# Seeded pipelines

Three workflow documents ship with the app in `server/seed/pipelines/`. They are
imported from the `DAG-Pipelines` branch and de-branded; the decision record is
`docs/adr/F7-seed-import.md`.

## What a user sees

Once a project is seeded, the three pipelines appear in **Scientific Pipelines ▸
Workflow registry** alongside anything the user has authored. There is no
separate "seeded" section and no separate endpoint: a seeded definition is
written through the same `WorkflowStore.saveDefinition` the Builder uses, so
`GET /dag-workflows` lists it and `web/src/components/dag-workflows-panel.tsx`
renders it with no client change.

| Workflow | id | Nodes | Ready to run as seeded? |
|---|---|---:|---|
| Research Starter | `research-starter` | 3 | **No** — `limits.maxCostUsd` is `0`; Run must be disabled-with-reason, not live-looking |
| Data Scientist | `data-scientist` | 5 | Yes, with an OpenRouter key and an uploaded dataset |
| Composed Research Pipeline | `composed-research-pipeline` | 24 | Yes, with an OpenRouter key and an uploaded dataset — but it is expensive |

`research-starter` arrives through the legacy import path, which sets the spend
cap to zero on purpose: an imported pipeline is opened for review, not for
execution. Run on that seed must not look live. The panel F7 does not own should
set `aria-disabled` and show reason
`This workflow's cost cap is $0. Raise limits.maxCostUsd before running.`
See `reports/F7-INTEGRATION.md`. Amendment #4 on dest `fdd0221` granted
`server/src/projects.ts` (C5→F7): one import and one `seedProjectPipelines`
call next to `seedSandboxFiles` in `ensureProjectExists`. Dest still does not
seed until this lane merges.

Do not disable Run for a missing seed. Amendment #4 **rejected** F7 taking
`dag-workflows-panel.tsx` (F6 already holds it). `$0` Run disable is F6 work
on that panel. This clone does not steal the panel. Dest Run stays
live-looking at a $0 cap until F6 merges. Edit the definition and raise
`limits.maxCostUsd` to enable Run after that lands.

## Two things the seeded pipelines do not have

**No human approval gate.** Upstream, `data-scientist` paused for a human to
approve the results and `composed-research-pipeline` paused twice. The typed
runtime has no human gate at all, so those pauses became adversarial *model*
reviewers. Each affected document says so in its own `description`, so a
researcher reading the registry sees it before launching. If a real gate is
required, that pipeline belongs on the vendored engine.

**No `$` variables.** The typed runtime has no variable substitution. State moves
through the run record and through declared artifacts.

## How seeding works

`server/src/workflows/seed-pipelines.ts` reads `server/seed/pipelines/*.yaml` and
dispatches each file by dialect:

- a document whose root declares `schemaVersion: "1.0"` is a typed NodeSpec v1
  document and goes to `validateWorkflowGraphDocument`;
- anything else is the upstream legacy pipeline dialect and goes to
  `previewLegacyPipelineWorkflow` — the same translator behind
  `POST /dag-workflow-imports/legacy-pipeline/preview`.

The loader owns no parser and no translator of its own. It stamps each stored
document with the existing optional `provenance` field —
`{ source: "seed-pipelines", id: "<file>.yaml", sha256: <sha256 of the committed bytes> }` —
so a stored definition can be traced back to the exact file it came from.

Seeding is:

- **non-clobbering** — a workflow id the project already holds is left alone, so
  a user's edits survive every later seed pass, exactly like committed skills;
- **idempotent** — a second pass seeds nothing;
- **non-fatal** — a malformed seed is reported in the returned
  `SeedPipelineReport`, never thrown. A bad seed cannot take project creation down.

`ensureProjectExists` calls the loader beside `seedSandboxFiles`, so the first
request for a new project and the first request for a pre-wave project both
back-fill the library before `GET /dag-workflows` reads it. The scaffold and
loader are synchronous; there is no background seed race.

## Adding a seed pipeline

1. Drop a `.yaml` file in `server/seed/pipelines/`. **The file name is the
   workflow id** and must match `^[a-z][a-z0-9_-]{0,63}$`; for a typed document
   the `id:` field must equal it.
2. Run `npx vitest run test/seed-pipelines.test.ts` from `server/`. The suite
   translates every committed seed, asserts the expected node and edge counts,
   seeds a real project, and executes two of the pipelines through
   `runWorkflowDag`.
3. Update the expected list in that test. It pins the exact set of seeds on
   purpose: a seed that appears without a decision behind it should fail the build.
4. `node scripts/token-ban.mjs` must stay at zero violations.

If a pipeline needs a NodeSpec v1 field that does not exist, it does not land
as-is. Adapt it and record the adaptation in a header comment on the file and in
the ADR, or leave it out and say why.
