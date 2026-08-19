# Passing state between steps

The two surfaces do this completely differently. Emitting one surface's syntax
into the other's document is the most common way an otherwise-good pipeline
comes out broken.

## Vendored engine — `$` substitution

Verified against `server/vendor/pipeline-engine/packages/workflows/src/executor-shared.ts`
and `.../dag-executor.ts`.

| Variable | Resolves to |
|---|---|
| `$ARGUMENTS` | the run's trigger message |
| `$USER_MESSAGE` | the same value |
| `$WORKFLOW_ID` | the run id |
| `$ARTIFACTS_DIR` | a pre-created directory for this run's artifacts |
| `$BASE_BRANCH` | the base branch; **throws if referenced and unresolvable** |
| `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT` | external issue/PR context, or empty |
| `$nodeId.output` | the full text output of a completed upstream node |
| `$nodeId.output.field` | a field of that node's structured output — requires `output_format:` on the upstream node |

Details that matter:

- In `bash:` bodies, `$nodeId.output` is shell-quoted for you. In `script:`
  bodies it is **not** — assign it directly (`const data = $nodeId.output;`) and
  never wrap it in a template literal, which breaks the moment the output
  contains a backtick.
- An unknown node reference resolves to an empty string with a logged warning.
  It does not fail the node, so a typo silently produces a prompt with a hole in it.
- Write `\$` for a literal dollar sign.

## Typed runtime — no substitution at all

The typed runtime has **no `$` variable syntax**. There is nothing to escape and
nothing to interpolate. State moves in two ways:

1. **The run record.** Each node's execution and output are persisted in the run
   event stream, and a node is given the verified record of its inbound
   dependencies. You write prompts that refer to "the plan from the previous
   step", not to `$plan.output`.
2. **Declared artifacts.** A node with a writable workspace writes into its own
   `workspace.writePaths`; the document declares those outputs in the top-level
   `artifacts:` block, and a downstream node reads them from the sandbox by path.

```yaml
artifacts:
  - id: stats-outputs
    name: Statistical analysis outputs
    kind: directory
    writerNodeId: stats
    path: analysis/stats

nodes:
  - id: stats
    workspace: { isolation: isolated-worktree, writePaths: [analysis/stats] }
    prompt: |
      Run the planned tests and write every result under `analysis/stats/`.
  - id: report
    workspace: { isolation: read-only, writePaths: [] }
    prompt: |
      Read `analysis/stats/` and write the report. Do not restate a number you
      cannot find in those files.
```

**The rule of thumb:** in a typed pipeline, if a downstream step must have a
value, make an upstream step *write it to a declared artifact path* and tell the
downstream step where to read it. Do not rely on the prose reference alone for
anything the run's correctness depends on.

## What the legacy importer does to `$` when it translates

`server/src/workflows/legacy-pipeline-import.ts` accepts exactly two forms and
rejects the rest:

- `$ARGUMENTS` → rewritten to a reference to the verified run context (warning);
- `$dep.output` where `dep` is an **immediate** dependency → rewritten to a
  reference to that node's verified inbound record (warning);
- `$dep.output` where `dep` is *not* an immediate dependency → **blocker**;
- anything else beginning with `$` → **blocker**.

So a legacy pipeline whose verify nodes all cite `$plan.output` while depending
on the previous verify node cannot be imported until each prompt is rewritten to
cite the node it actually depends on. That is not a bug in the importer: the
typed runtime only guarantees a node the record of its own inbound edges.
