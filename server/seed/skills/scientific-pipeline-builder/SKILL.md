---
name: scientific-pipeline-builder
description: >-
  Conversational interview that turns a research goal into a runnable Archon
  workflow DAG (a multi-step scientific pipeline). Use this whenever the user
  wants to "build a pipeline", "design a workflow for my experiment", set up a
  "scientific pipeline", "set up a research DAG", asks for a "pipeline builder",
  or describes a "multi-step analysis workflow" — EVEN IF they never say the
  word "Archon". Also trigger when someone describes a research/experiment/
  analysis goal and asks how to break it into stages, wire literature review →
  EDA → modeling → synthesis, add review gates, pick per-step models, or boost
  reasoning for hard scientific steps. Maps phases to node types, picks per-node
  scientific skills, wires adversarial verify gates, and emits a validated
  Archon YAML.
argument-hint: "[research goal]"
---

# Scientific Pipeline Builder

You are interviewing a researcher to co-design a **scientific pipeline** — an
Archon workflow DAG that runs each phase of their research as a node, with the
right per-node skills, models, review gates, reasoning boosts, and a
reproducibility log. The deliverable is a single validated Archon workflow YAML.

The whole value of this skill is that the *researcher* shouldn't have to learn
the Archon schema. You do the translation. Keep the conversation in plain
research language ("literature review", "exploratory analysis", "fit a model",
"write the paper"); only surface node types, model IDs, and YAML when it helps
the user make a real decision.

Archon node vocabulary you map onto (full schema in
`references/node-recipes.md`): `prompt` (an AI step), `bash` / `script` (no-AI
compute — `script` runs Python via `uv` or TS via `bun`), `loop` (iterate until
done), `approval` (human gate — needs workflow-level `interactive: true`),
`cancel` (guarded exit). Per-node fields you'll use: `model`, `skills`,
`allowed_tools`, `depends_on`, `when`, `output_format`.

---

## The interview — run these eight steps in order

Don't dump all eight questions at once. Walk through them. After each answer,
restate what you captured in one line so the user can correct you before you
build on it. If the user says "just pick sensible defaults" at any point, take
the defaults named below, list the ones you chose inline, and keep moving — do
not re-ask.

### Step 1 — Elicit and restate the scientific goal

Ask what they're actually trying to find out. Get the *scientific question*,
the *data or system under study*, and what *done* looks like (a figure? a
fitted model? a paper? a decision?).

Then **restate it back** in your own words as a one-paragraph problem
statement, and ask "did I get that right?" This is the single most important
step — a pipeline built on a misunderstood goal is wasted compute. Don't
proceed until the restatement is confirmed (or the user says "close enough").

### Step 2 — Propose a 3–8 node DAG

Decompose the goal into phases, then map each phase to a node type. A typical
scientific arc and its mapping:

| Phase | Node type | Why |
|-------|-----------|-----|
| Literature review / background | `prompt` | reasoning + search-tool skills |
| Data acquisition / cleaning | `script` (uv) or `bash` | deterministic compute, no AI |
| Exploratory data analysis (EDA) | `prompt` + `script` | AI reads data, script computes |
| Hypothesis / experiment design | `prompt` | reasoning-heavy |
| Modeling / simulation / heavy compute | `script` (uv) or `loop` | runs code; loop if iterate-to-fit |
| Result interpretation | `prompt` | reasoning over outputs |
| Final synthesis (paper / slides / poster) | `prompt` | writing skills |
| Human checkpoints | `approval` | review gates (step 3) |

Pick **3 to 8** real nodes — match the user's actual arc, not this template.
For **each** node decide and present three things:

1. **Per-node skills** — pick from the scientific skill catalogue in
   `references/scientific-skills.md`, keyed by phase. E.g. a lit-review node
   gets `[literature-review, citation-management]`; an EDA node gets
   `[exploratory-data-analysis, statistical-analysis]`; a modeling node gets
   `[scikit-learn, shap]` or `[pymc, statistical-analysis]`.
2. **Per-node model** — fast model (e.g. a Haiku/small model) for cheap
   classification/parse steps; a strong model for reasoning/synthesis. Default
   strong model: `openrouter/anthropic/claude-opus-4.8`.
3. **Optional AI-council deliberation** — for genuinely hard reasoning nodes
   (experiment design, result interpretation), offer a deliberation backend
   (step 8 details the mechanics) with **intuitively-chosen scientific-agent
   personas** — e.g. *Theorist, Methodologist, Statistician, Domain-Expert,
   Skeptic*. Choose personas that fit the phase; don't ask the user to invent
   them, propose a fitting set and let them edit.

Present the proposed DAG as a **numbered list** (node → type → skills → model →
deliberation) **and** a Mermaid diagram so they can see the shape:

```mermaid
flowchart TD
  lit[1. Literature review<br/>prompt · literature-review] --> eda
  eda[2. EDA<br/>script+prompt · exploratory-data-analysis] --> model
  model[3. Modeling<br/>script uv · scikit-learn] --> interp
  interp[4. Interpretation<br/>prompt · statistical-analysis] --> synth
  synth[5. Synthesis<br/>prompt · scientific-writing]
```

Iterate on the node list with the user until they're happy with the shape.

### Step 3 — Approval gates

Ask where a human should review before continuing. Offer the **default** set
(it's good for most research):

- **after planning** (review the experiment design before spending compute),
- **before expensive compute** (confirm the run is worth the cost/time),
- **before final synthesis** (sign off on results before they're written up).

Or let them place **custom** gates with conditions. Emit each gate as an
`approval` node; when a gate should only fire under a condition, put it on the
node as `when:`. Any workflow with an approval gate **must** set
`interactive: true` at the workflow level (otherwise the gate message never
reaches the user). See the approval recipe in `references/node-recipes.md`.

### Step 4 — Desired output style → final-node skills

Ask what the end product is, and map it onto the final node's `skills`:

| They want | Final-node skills |
|-----------|-------------------|
| A written paper / report | `[scientific-writing, citation-management]` |
| A slide deck | `[scientific-slides, markdown-mermaid-writing]` |
| A markdown report with diagrams | `[markdown-mermaid-writing]` |
| A conference poster | `[latex-posters]` |

If they want more than one (paper + slides), give the final phase parallel
synthesis nodes, one per format.

### Step 5 — Cloud or local compute

Ask where the heavy compute should run.

- **Local (default)** — compute nodes are `bash` / `script` with `runtime: uv`
  and run in the sandbox. This works today.
- **Cloud** — record it as **advisory metadata** only (a `# cloud:` comment and
  a note in the node), because **Kady has no Modal/cloud executor yet** — be
  explicit with the user that selecting cloud documents intent but the node
  still runs locally for now. Don't silently pretend cloud works.

### Step 6 — Scribe agent (default: yes)

Offer a **Scribe**: after each substantive phase node `X`, append a `prompt`
node `X-scribe` with `skills: [markdown-mermaid-writing, citation-management]`
that writes a **reproducible log** of that phase to
`artifacts/scribe/<phase>.md` — capturing the **exact commands run**, **data /
source provenance**, **methods**, and **results**. This is what makes the
pipeline reproducible and is on by default; confirm or let them decline. See
the scribe recipe in `references/node-recipes.md`.

### Step 7 — KADY-BOOST (reasoning boost)

Ask whether to boost reasoning, and where: during **planning**, the
**experiment**, **result-synthesis**, or **all three**. Boost via:

- **Fusion** (fusion-direct) — set the boosted node's `model` to the
  fusion-direct alias `openrouter/openrouter/fusion` (a panel-of-models +
  judge), and/or
- **AI Council** (council-tool) — keep the node's base model, add `council` to
  its `allowed_tools`, and wrap its prompt with a council-deliberation
  instruction.

Default to **3 personas**, chosen **automatically** (you propose a fitting trio
per phase) or **manually** (the user names them). Full YAML for both backends is
in `references/boost-and-deliberation.md`.

### Step 8 — Confirm and emit

Show the final node list one more time, confirm, then write the YAML.

**Per-node deliberation-backend → alias mapping** (mirrors the server's
`applyDeliberationBackend`, so what you emit matches what Kady enacts):

| Backend | What to emit on the node |
|---------|--------------------------|
| `fusion-direct` | `model: openrouter/openrouter/fusion` |
| `council-tool` | keep the chosen base `model`; add `council` to `allowed_tools`; prepend a deliberation instruction to the prompt |
| `none` | plain per-node `model`, nothing extra |

---

## ALWAYS auto-append the 3× adversarial verify block

This is non-negotiable and is what makes the pipeline trustworthy. After
**every substantive phase node `X`** (lit-review, EDA, modeling, interpretation,
synthesis — not the tiny parse/scribe nodes), automatically insert **three
sequential fresh-context verify nodes** `X-verify-1`, `X-verify-2`,
`X-verify-3`, each on model `openrouter/anthropic/claude-opus-4.8`, each running
in a **fresh context** that re-reads `X`'s goal and `X`'s output and emits
either `PASS` or `FAIL: <reasons>`. They run in series (1 → 2 → 3) so each is a
genuinely independent re-check. The **next real node depends on
`X-verify-3` and only runs when its output is `PASS`**.

Three fresh re-reads, rather than one, catch the failure mode where a single
verifier rubber-stamps a plausible-but-wrong result; independent passes have to
agree. The exact node template is in `references/verify-template.md` — use it
verbatim, substituting the phase node id and goal.

---

## Output artifact and validation

Write a single valid Archon workflow YAML to:

```
<sandbox>/.archon/workflows/<slug>.yaml
```

where `<slug>` is a kebab-case slug of the research goal (e.g.
`protein-binding-affinity-pipeline`). Use the active project sandbox path as
`<sandbox>`; if you don't know it, ask, or default to `.archon/workflows/`
under the working directory.

**Before declaring done, validate it.** POST the YAML to the Kady pipelines
validate endpoint and only finish when it returns clean:

```bash
curl -sS -X POST http://localhost:8787/pipelines/validate \
  -H 'content-type: application/json' \
  --data-binary @<(yq -o=json '.' "<sandbox>/.archon/workflows/<slug>.yaml")
```

(Adjust host/port to the running Kady server.) If `yq` isn't available, convert
the YAML to JSON another way, or pass the workflow object as the JSON body. Fix
every error the validator reports and re-validate until it's clean — Archon
validation checks YAML syntax, DAG cycles, unknown `$nodeId.output` refs,
exactly-one node-type-field per node, and that all referenced `skills:`
directories exist. Then tell the user the file path and how to run it.

---

## Reference files (read when you reach that step)

- `references/scientific-skills.md` — the catalogue of available scientific
  skills, keyed by research phase. Read it in Step 2 to pick per-node skills.
- `references/node-recipes.md` — canonical node snippets (plan, EDA, model,
  verify, scribe, approval). Read it when emitting nodes.
- `references/boost-and-deliberation.md` — fusion-direct vs council-tool YAML
  examples. Read it for Steps 7–8.
- `references/verify-template.md` — the exact 3× adversarial verify block. Read
  it before appending verify nodes.
