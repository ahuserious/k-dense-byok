# Worked examples — the seeded pipelines

Three pipelines ship with the app, in `server/seed/pipelines/`. They are the
reference implementations for the shapes this skill emits, and two of them are
worth reading before you author anything, because they show a real adaptation
with its losses stated rather than hidden.

Read them from disk. What follows is the map, not a copy.

## `research-starter.yaml` — the legacy dialect, end to end

Three nodes, `scope → research → writeup`, in the **upstream legacy dialect**.
It is deliberately not a typed document: it is the artifact that proves the
import path works. The loader hands its bytes to `previewLegacyPipelineWorkflow`
and what lands in the library is the typed document that translator returns.

Read it to see:

- the minimum legal legacy document (`name`, `description`, `provider: pi`,
  `interactive: false`, `nodes`);
- `$ARGUMENTS` and `$scope.output` in the only two forms the importer accepts;
- a strictly linear `depends_on` chain — the importer rejects multi-parent joins.

What it lands as: `maxCostUsd: 0`, read-only workspaces, `rescue` disabled. That
is the import path's deliberate "review before you run" default. Tell the
researcher to set a budget before their first run.

## `data-scientist.yaml` — a typed document with two honest losses

Five nodes, `plan → code → review → reflect → summarize`. Upstream this had a
`loop:` node and an `approval:` gate. Neither exists in the typed runtime.

Read it to see:

- a `loop` node re-expressed as a bounded agent node — `limits.maxIterations: 10`
  carries the bound, and the prompt states the completion condition *and* what to
  do if ten passes are not enough ("say which steps remain rather than claiming
  completion");
- an `approval` gate re-expressed as an adversarial reviewer node, with the loss
  of the human stated **in the document's own `description`**, so the researcher
  running it from the registry sees it;
- `workspace.isolation: isolated-worktree` with a `writePaths` entry and a
  matching declared artifact;
- per-node `settings.skills` with `mode: auto-manual` — the researcher keeps
  their installed skills, the pipeline adds the phase-specific ones.

## `composed-research-pipeline.yaml` — the full shape

Twenty-four nodes: plan → 3× verify → literature (+ scribe) → 3× verify →
exploratory analysis → 3× verify → statistics (+ scribe) → 3× verify →
synthesis → 3× verify → evidence gate → final scribe.

Read it to see:

- **the 3× adversarial verification block**, which is the pattern this skill
  appends after every substantive phase. Each pass is its own node, so each is
  its own execution with its own context — which is what the upstream
  `context: fresh` flag bought, obtained structurally instead of declaratively;
- **a real `kind: fusion` node** on the hosted OpenRouter router, with three
  members and a judge, all sharing the router's reasoning level (the validator
  requires it) and none of them selecting `openrouter/fusion` recursively;
- **an `evidence-gate` node** with `checks: [citations, claim-support,
  artifact-exists]`, routed with `condition: evidence-supported`;
- **scribe nodes** that write reproducibility logs to their own declared write
  paths, with no two nodes' write paths overlapping;
- a header comment that enumerates, item by item, what was kept and what was
  lost in translation. Copy that habit.

## The template for a new pipeline

Start from `data-scientist.yaml` for a linear analysis, and from
`composed-research-pipeline.yaml` when the researcher wants verification gates
and multi-model planning. Change the prompts and the skills first; change the
limits second; change the topology last.
