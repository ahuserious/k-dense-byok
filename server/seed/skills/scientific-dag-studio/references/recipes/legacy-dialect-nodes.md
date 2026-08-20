# The vendored engine's dialect — node types the typed runtime does not have

Read `two-runtimes.md` first. This file is the authoring reference for the
**vendored pipeline engine** only. Every field below was re-derived from
`server/vendor/pipeline-engine/packages/workflows/src/schemas/dag-node.ts` and
`.../validator.ts`. The upstream reference this is adapted from also documented a
standalone CLI, a config file, and Discord/Slack/Telegram/GitHub adapters as
product surfaces; **this app ships none of those**, so none of that is here.

Reach for this dialect only when the researcher needs a human gate, a loop, or a
step that runs no model at all.

## Document shape

```yaml
name: my-pipeline
description: |
  What it does. This text is what routing reads, so write it for a stranger.
provider: pi
interactive: false        # true only if the pipeline contains an approval or interactive loop
nodes:
  - id: …
```

## Node types — mutually exclusive, one per node

| Field present | Node type | What it does |
|---|---|---|
| `prompt:` | prompt | one AI step |
| `command:` | command | run a stored command file as the prompt |
| `bash:` | bash | shell, no model (`timeout:` seconds) |
| `script:` | script | `runtime: uv` (Python) or `runtime: bun` (TypeScript), `deps: [...]`, no model |
| `loop:` | loop | repeat a prompt until a condition |
| `approval:` | approval | pause for a human |
| `cancel:` | cancel | stop the run with a stated reason |

## Base fields available on every node

```yaml
  - id: analyse
    depends_on: [profile]        # list of upstream node ids
    trigger_rule: all_success    # all_success | one_success | none_failed_min_one_success | all_done
    when: "profile.output.ok == true"
    model: anthropic/claude-opus-4.8
    provider: pi
    context: fresh               # fresh | shared
    output_format: { … }         # JSON-schema-ish object; makes `$id.output.field` work
    allowed_tools: [Read, Grep]
    denied_tools: [Bash]
    idle_timeout: 600000         # ms with no output before the node is considered stalled
    retry: { … }                 # NOT valid on a loop node — hard error
    hooks: { … }                 # intercept tool calls
    mcp: path/to/mcp.json        # attach an MCP server to this node
    skills: [statistical-analysis]
    agents: { … }                # inline subagent definitions
    effort: high                 # low | medium | high | max
    thinking: { type: enabled, budgetTokens: 8000 }
    sandbox: { … }
    always_run: false
    persist_session: false
    output_type: text
    settings: { … }              # NodeSpec v1, the same object the typed runtime uses
```

`skills:` here is resolved by the engine's validator against
`.claude/skills/<name>/SKILL.md` in the project or the user's home. A name that
resolves nowhere is a validation error, not a silent no-op — so only list skills
the project actually has.

## Loop nodes

```yaml
  - id: implement
    depends_on: [plan]
    idle_timeout: 600000
    loop:
      prompt: |
        Implement the next unfinished step of the plan. When every step is
        implemented and validated, output: <promise>COMPLETE</promise>
      until: COMPLETE
      max_iterations: 10
      fresh_context: false
    model: anthropic/claude-opus-4.8
```

- `until:` matches on the emitted text; `until_bash:` runs a shell test instead.
- `fresh_context: false` keeps the session across iterations — cheaper, and the
  model remembers what it already tried.
- **`retry:` on a loop node is a hard error.** The loop *is* the retry.
- A `max_iterations` of 2 or 3 on an open-ended task is the most common way a
  loop pipeline fails: it stops halfway and reports success.

## Approval nodes

```yaml
  - id: review
    depends_on: [implement]
    approval:
      message: |
        Review the results above. Approve to continue, or reject with feedback.
      capture_response: true
      on_reject:
        prompt: |
          The reviewer rejected the results with this feedback:
          $REJECTION_REASON
          Address it: fix the analysis, re-run, and summarize what changed.
        max_attempts: 3
```

- An approval node needs **`interactive: true` at the workflow level**, or the
  gate never surfaces and the run stalls.
- `capture_response: true` makes the reviewer's text available downstream as
  `$review.output`.
- `$REJECTION_REASON` is available **only** inside `on_reject.prompt`.
- An approval node has no `model` and no `prompt` of its own.

## Cancel nodes

```yaml
  - id: abort-if-no-data
    depends_on: [profile]
    when: "profile.output.rows == 0"
    cancel: "The uploaded dataset is empty; there is nothing to analyse."
```

Use `cancel` when stopping is the correct outcome and you want the reason
recorded. Use a failing `bash:` check when stopping is an error.

## Conditions and trigger rules

`when:` is evaluated against upstream outputs. It reads structured fields with
dot notation (`node.output.field`), which only works if that node declared
`output_format:`. Pattern-matching free-form prose in `when:` is the single most
common brittle construction in this dialect — give the upstream node an
`output_format` and read a field instead.

`trigger_rule:` decides when a node with several parents fires:

| Rule | Fires when |
|---|---|
| `all_success` (default) | every parent succeeded |
| `one_success` | at least one parent succeeded |
| `none_failed_min_one_success` | nothing failed and at least one succeeded — the right rule after a conditional branch, where some parents are skipped |
| `all_done` | every parent finished, however it finished |

## Variables

See `variables-and-outputs.md`. Short version: `$ARGUMENTS`, `$USER_MESSAGE`,
`$WORKFLOW_ID`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$CONTEXT` (and its two
aliases), plus `$nodeId.output` and `$nodeId.output.field`.
