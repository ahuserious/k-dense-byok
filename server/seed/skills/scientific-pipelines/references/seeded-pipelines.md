# The seeded pipelines — what ships, and what each one needs before it runs

Three pipelines are committed in `server/seed/pipelines/` and seeded into a
project's typed workflow library. A user sees them in **Scientific Pipelines ▸
Workflow registry** without creating anything.

They are seeded **non-clobbering**: once a project holds a workflow with that
id, the seeder leaves it alone forever. A user's edits are safe, and a user who
deletes one does not get it back on the next seed pass unless the id is free.
If someone asks "why did my edits disappear" the answer is that they did not —
check whether they are looking at a different project.

## `research-starter` — Research Starter

Three steps: scope the question, gather and synthesize, write it up.

- **Before running:** `limits.maxCostUsd` is `0` on purpose. Run is disabled
  with reason `This workflow's cost cap is $0. Raise limits.maxCostUsd before
  running.` until someone reviews the seed and raises the cap. That is the
  intended state, not a defect. The seeder call site is already live.
- Read-only workspaces throughout; it writes no artifacts.

## `data-scientist` — Data Scientist

Five steps: plan, implement and run, review, reflect, summarize.

- **Before running:** upload the dataset to the sandbox. The implementation step
  writes under `analysis/`.
- **Tell the user this:** upstream this workflow paused for a human to approve
  the results before the write-up. This runtime has no human approval gate, so
  the review step is an adversarial *model* reviewer. It is written into the
  workflow's own description. If they need a real gate, they need the vendored
  engine.
- Budget: a real cap ships with it, so it runs as seeded.

## `composed-research-pipeline` — Composed Research Pipeline

Twenty-four steps across three phases — literature, analysis, synthesis — each
followed by three independent adversarial verification passes, each with a
scribe node writing a reproducibility log, ending in an evidence gate.

- **Before running:** upload the dataset. The exploratory and statistical steps
  both need it and both will stop and say so if it is absent.
- **It is expensive.** Two hosted-Fusion nodes (a panel plus a judge, three
  members each) and twelve verification passes. Show the user the cap before
  they launch, and offer to run `data-scientist` first if they are exploring.
- **Two human approval gates were lost in translation** — after planning and
  before synthesis. The verification chain stands in their place and a model is
  not a reviewer. This is stated in the workflow's description and in the file's
  header comment.
- Requires an OpenRouter API-key credential: the Fusion nodes are hosted-router
  nodes and are not representable on any other provider.

## When a seeded pipeline will not start

1. Budget — see `typed-workflow-operations.md`. `maxCostUsd: 0` is the most
   common cause and it looks like nothing happening.
2. Credentials — the seeded pipelines resolve fixed OpenRouter models on API-key
   auth. No key, no dispatch.
3. Missing dataset — for the two analysis pipelines, this fails inside the node
   rather than at launch, and the node will say so in its output.

Report which of the three it is. Do not report "the pipeline is broken".
