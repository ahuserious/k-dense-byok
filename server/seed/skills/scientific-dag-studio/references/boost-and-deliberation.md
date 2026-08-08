# KADY-BOOST: Fusion-direct vs Council-tool

Two ways to boost a node's reasoning. The mapping below mirrors the server's
`applyDeliberationBackend` (in `server/src/agent/agent-files.ts`) so whatever
you emit in the workflow YAML matches what Kady actually enacts at runtime.

| Backend | Effect on the node |
|---------|--------------------|
| `none` | plain per-node `model`, nothing added (default) |
| `fusion-direct` | force `model: openrouter/openrouter/fusion` (panel + judge) |
| `council-tool` | keep base `model`; add `council` to `allowed_tools`; wrap the prompt with a deliberation instruction |

Default boost = **3 personas**, chosen automatically (you propose a fitting
trio per phase) or manually (the user names them). Good scientific personas to
draw from: **Theorist, Methodologist, Statistician, Domain-Expert, Skeptic,
Experimentalist, Reproducibility-Reviewer**.

---

## fusion-direct — the simplest boost

Just swap the model. Fusion runs a panel of models and a judge behind the
single alias, so the node "thinks harder" with no other change. Use it for the
heaviest single-shot reasoning steps (experiment design, result synthesis).

```yaml
- id: design-experiment
  prompt: |
    Research goal: $ARGUMENTS
    Design the most informative experiment to test the core hypothesis.
  # KADY-BOOST: fusion-direct — model pinned to the Fusion panel+judge alias
  model: openrouter/openrouter/fusion
  skills: [hypothesis-generation, scientific-critical-thinking]
```

Note: with `fusion-direct` the personas are implicit in Fusion's panel — you
don't enumerate them in YAML. If the user wants *named, visible* personas,
use council-tool instead (below).

---

## council-tool — explicit, named deliberation

Keep the node's chosen base model, add the native `council` tool, and prepend a
deliberation instruction naming the personas. This gives transparent,
persona-driven debate before the node commits to an answer.

```yaml
- id: interpret-results
  prompt: |
    AI COUNCIL DELIBERATION — convene a 3-persona council and debate before you
    answer. Personas:
      1. Statistician — scrutinize effect sizes, intervals, multiple comparisons.
      2. Domain-Expert — judge plausibility against known mechanisms.
      3. Skeptic — argue the null / alternative explanations; hunt confounds.
    Use the `council` tool to run the deliberation, then synthesize the
    council's verdict into a single interpretation.

    Results to interpret: $fit-model.output
    Hypothesis: see $ARTIFACTS_DIR/plan.md
  model: openrouter/anthropic/claude-opus-4.8
  # KADY-BOOST: council-tool — council added to the allowlist below
  allowed_tools: [Read, Write, Edit, Bash, council]
  skills: [statistical-analysis, scientific-critical-thinking]
  depends_on: [fit-model]
```

Key points for council-tool:
- `council` MUST appear in `allowed_tools` (this is exactly what the server's
  `applyDeliberationBackend` does — appends `council` to the tool list).
- Keep the rest of `allowed_tools` the node legitimately needs (Read/Write/etc).
- The deliberation instruction at the top of the prompt names the personas and
  tells the model to actually invoke the `council` tool — without it the tool is
  available but unused.

---

## Combining both

For an all-out boost on the single hardest node you can do both — run the
deliberation on the Fusion model:

```yaml
- id: synthesize-finding
  prompt: |
    AI COUNCIL DELIBERATION (Theorist, Methodologist, Skeptic) — debate via the
    `council` tool, then write the final synthesized finding.
    Inputs: all artifacts under $ARTIFACTS_DIR/.
  model: openrouter/openrouter/fusion        # fusion-direct
  allowed_tools: [Read, Write, Edit, council] # council-tool
  skills: [scientific-writing, scientific-critical-thinking]
```

Use the combined form sparingly — it is the most expensive node configuration.
Reserve it for the one step where being right matters most.

---

## Which phases to boost (Step 7 menu)

| User choice | Boost these nodes |
|-------------|-------------------|
| planning | the plan / experiment-design node |
| experiment | the modeling / interpretation node(s) |
| result-synthesis | the final synthesis node |
| all-3 | plan + interpretation + synthesis |
