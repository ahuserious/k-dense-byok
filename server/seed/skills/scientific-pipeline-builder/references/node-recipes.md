# Canonical Node Recipes

Copy these snippets and adapt the ids, prompts, skills, and models to the
user's pipeline. Each node has exactly ONE of: `prompt`, `bash`, `script`,
`loop`, `approval`, `cancel`. All AI nodes can take `model`, `skills`,
`allowed_tools`, `depends_on`, `when`, `output_format`.

`$ARTIFACTS_DIR` is the workflow's artifacts directory; `$ARGUMENTS` is the
user's run message; `$nodeId.output` is an upstream node's output.

---

## Plan / experiment-design node (reasoning-heavy `prompt`)

```yaml
- id: plan
  prompt: |
    Research goal: $ARGUMENTS

    Design the experiment to answer this goal. Specify: the hypothesis, the
    variables, the method, the success criteria, and the expected artifacts.
    Write the plan to $ARTIFACTS_DIR/plan.md.
  model: openrouter/anthropic/claude-opus-4.8
  skills: [hypothesis-generation, scientific-critical-thinking]
```

## Literature-review node (`prompt` with search skills)

```yaml
- id: lit-review
  prompt: |
    Survey the prior work relevant to: $ARGUMENTS
    Produce a cited synthesis of the state of the art and the open gap this
    work addresses. Save to $ARTIFACTS_DIR/lit-review.md with a BibTeX block.
  model: openrouter/anthropic/claude-opus-4.8
  skills: [literature-review, citation-management]
  depends_on: [plan]
```

## Data acquisition / cleaning node (`script`, no AI)

```yaml
- id: prep-data
  script: |
    import polars as pl, json, pathlib
    # ... load + clean ...
    df = pl.read_csv("data/raw.csv")
    out = pathlib.Path("artifacts") / "clean.parquet"
    df.write_parquet(out)
    print(json.dumps({"rows": df.height, "cols": df.width, "path": str(out)}))
  runtime: uv
  deps: ["polars>=1.0"]
  timeout: 120000
  depends_on: [plan]
```

## EDA node (AI `prompt` that reads data + can run code)

```yaml
- id: eda
  prompt: |
    Explore the cleaned dataset described here: $prep-data.output
    Characterize distributions, missingness, correlations, and anomalies.
    Save findings + figures under $ARTIFACTS_DIR/eda/.
  model: openrouter/anthropic/claude-opus-4.8
  skills: [exploratory-data-analysis, statistical-analysis]
  depends_on: [prep-data]
```

## Modeling / heavy-compute node

Deterministic fit as a `script`:

```yaml
- id: fit-model
  script: model-fit          # resolves .archon/scripts/model-fit.py
  runtime: uv
  deps: ["scikit-learn>=1.4", "pandas>=2.0"]
  timeout: 600000
  depends_on: [eda]
```

Iterate-to-converge as a `loop`:

```yaml
- id: tune
  depends_on: [eda]
  idle_timeout: 600000
  loop:
    prompt: |
      FRESH session. Read $ARTIFACTS_DIR/eda/ and the current model metrics.
      Improve the model one step, validate, log metrics. When target metric is
      reached: <promise>COMPLETE</promise>
    until: COMPLETE
    max_iterations: 10
    fresh_context: true
    until_bash: "test -f artifacts/model/PASS"
```

## Result-interpretation node

```yaml
- id: interpret
  prompt: |
    Interpret the model results in $fit-model.output against the hypothesis in
    $ARTIFACTS_DIR/plan.md. State what is supported, what is not, effect sizes,
    and threats to validity. Save to $ARTIFACTS_DIR/interpret.md.
  model: openrouter/anthropic/claude-opus-4.8
  skills: [statistical-analysis, scientific-critical-thinking]
  depends_on: [fit-model]
```

## Scribe node (per-phase reproducibility log)

Append one after each substantive phase node `X`. It does not block the main
arc — downstream real nodes depend on `X` (or `X`'s verify chain), not on the
scribe. Always uses the markdown+citation skills.

```yaml
- id: eda-scribe
  prompt: |
    Write a reproducible log of the "eda" phase to
    $ARTIFACTS_DIR/scribe/eda.md. Record, exactly:
      - every command/script that was run (verbatim),
      - data and source provenance (file paths, URLs, DB queries, versions),
      - the methods applied,
      - the results produced.
    The goal: someone could re-run this phase from your log alone.
    Phase output to summarize: $eda.output
  model: openrouter/anthropic/claude-opus-4.8
  skills: [markdown-mermaid-writing, citation-management]
  depends_on: [eda]
```

## Approval gate (`approval`) — requires workflow-level `interactive: true`

Default gate placements: after planning, before expensive compute, before final
synthesis.

```yaml
# workflow level (set once):
# interactive: true

- id: gate-before-compute
  approval:
    message: |
      Review the plan and EDA above. Approve to start the (expensive) modeling
      run, or reject with guidance to revise.
    capture_response: true
    on_reject:
      prompt: "Revise the plan based on this feedback: $REJECTION_REASON"
      max_attempts: 3
  depends_on: [eda-verify-3]
```

Conditional gate (only pause when a threshold is crossed) — put the condition on
the node as `when:`:

```yaml
- id: gate-if-costly
  approval:
    message: "Estimated run exceeds the budget threshold — approve to proceed."
  depends_on: [estimate-cost]
  when: "$estimate-cost.output > '50'"
```

## Final synthesis node (writing skills from Step 4)

```yaml
- id: write-paper
  prompt: |
    Write the final paper from all artifacts under $ARTIFACTS_DIR/.
    Include: abstract, methods, results, discussion, and references.
    Save to $ARTIFACTS_DIR/paper.md.
  model: openrouter/anthropic/claude-opus-4.8
  skills: [scientific-writing, citation-management]
  depends_on: [interpret-verify-3]
  when: "$interpret-verify-3.output == 'PASS'"
```

Parallel synthesis (paper + slides) — two nodes in the same layer:

```yaml
- id: make-slides
  prompt: "Build a slide deck from $ARTIFACTS_DIR/paper.md."
  model: openrouter/anthropic/claude-opus-4.8
  skills: [scientific-slides, markdown-mermaid-writing]
  depends_on: [interpret-verify-3]
  when: "$interpret-verify-3.output == 'PASS'"
```

## Cloud-compute advisory (Step 5)

Kady has no Modal/cloud executor yet. If the user picks cloud, still run the
node locally and document intent with a comment + a note in the prompt/script:

```yaml
- id: train-big
  # cloud: requested target=modal gpu=A100 — ADVISORY ONLY; runs locally for now
  script: train
  runtime: uv
  deps: ["torch>=2.2"]
  timeout: 600000
  depends_on: [eda]
```
