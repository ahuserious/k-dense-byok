# Typed node vocabulary — every field of a `schemaVersion: "1.0"` document

Adapted from the upstream pipeline-authoring reference and re-derived field by
field from `server/src/workflows/schema.ts`. Anything the upstream reference
documented that does not exist here has been removed rather than softened.

## Document

```yaml
schemaVersion: "1.0"          # required, literally "1.0"
id: my-pipeline               # required, ^[a-z][a-z0-9_-]*$, ≤64 chars
name: My Pipeline             # required, 1–256 chars
description: |                # optional, ≤4096 chars
  What this pipeline is for.
entryNodeId: plan             # required, must name a node with no incoming edge
defaultModel: { … }           # optional ModelRequest, inherited by model-driven nodes
settings:                     # optional workflow-wide NodeSpec defaults
  version: 1
  defaultHarness: pi          # pi | claude-code | codex | opencode | copilot
  databases: []
limits: { … }                 # required, see below
rescue: { … }                 # optional
evidence: { … }               # required
artifacts: [ … ]              # optional, ≤512
preconditions: { … }          # optional — what the launch form demands
nodes: [ … ]                  # required, 1–256
edges: [ … ]                  # required (may be empty for a single node), ≤1024
provenance: { … }             # optional {source, id, sha256}
```

### `limits` — all eight fields are required

| Field | Range | Notes |
|---|---|---|
| `maxIterations` | 1–1000 | must be ≥ the sum of every node's configured iteration demand |
| `maxModelCalls` | 1–10000 | same, for model calls — a fusion node demands more than one |
| `maxParallelism` | 1–16 | set >1 only if the graph actually branches |
| `maxSubagents` | 0–256 | **an agent node needs at least one**, so `0` fails validation |
| `timeoutMs` | 1000–86400000 | whole-run wall clock |
| `maxTokens` | 1–100000000 | |
| `maxCostUsd` | 0–1000000 | **`0` closes paid execution** — a cap-counted call is refused before dispatch |
| `maxRetries` | 0–3 | |

`maxCostUsd: 0` is the deliberate default of the legacy-import path: an imported
pipeline is opened for review, not run, until someone sets a budget. If you emit
a pipeline meant to run, give it a real number and tell the researcher what you
chose.

### `evidence` (required) and `rescue` (optional)

```yaml
evidence:
  enabled: false
  minimumIndependentSources: 0     # 0–20
  requireArtifactReferences: false
  onUnsupportedOutput: fail        # fail | rescue | route
rescue:
  enabled: false
  maxAttempts: 0                   # 0–10
  triggers: []                     # failure | stalled | unsupported-output | pre-compaction | post-compaction
```

`onUnsupportedOutput: rescue` requires `rescue.enabled: true` — the validator
refuses a route to a rescue that does not exist.

### `artifacts`

```yaml
artifacts:
  - id: analysis-outputs
    name: Analysis outputs
    kind: directory              # file | directory | dataset | report | proof | log
    writerNodeId: stats
    path: analysis/stats         # optional; sandbox-relative, canonical
```

Two rules the validator enforces and that are easy to trip: the writer node may
**not** be `workspace.isolation: read-only`, and the artifact `path` must sit
inside one of that node's `workspace.writePaths`.

## Fields every node has

```yaml
  - id: stats                    # ^[a-z][a-z0-9_-]*$
    name: Statistical analysis   # 1–256 chars
    description: …               # optional
    kind: agent
    terminal: false              # true iff the node has no outgoing edge
    workspace:
      isolation: read-only       # read-only | isolated-worktree | exclusive-project
      writePaths: []             # empty iff read-only; ≥1 otherwise; no two nodes may overlap
    position: { x: 400, y: 80 }  # optional, canvas layout, participates in graphSha256
    limits: { … }                # optional per-node subset, may not exceed the workflow's
    rescue: { … }                # optional
    evidence: { … }              # optional
    settings: { … }              # optional NodeSpec v1 — see below
    meta: { compositeOf: { … } } # optional, set when the node arrived from a stitch
    provenance: { … }            # optional
```

## `settings` — NodeSpec v1

```yaml
    settings:
      version: 1
      model: { … }                 # a ModelRequest; do not also set the node's own `model`
      reasoningEffort: high        # off|minimal|low|medium|high|xhigh|max
      hyperparameters:
        temperature: 0.2           # 0–2
        top_p: 0.9                 # 0–1
        sampling: { … }            # provider passthrough; reserved keys are rejected
      conditions:
        when: "…"                  # instruction text
        exists: ["analysis/stats"] # ≤64 paths
      harness: pi                  # pi | claude-code | codex | opencode | copilot
      databases: []                # ≤64 refs, resolved against the database catalogue
      skills:
        mode: auto-manual          # auto | auto-manual | manual
        list: [statistical-analysis, statsmodels]   # ≤64 refs
      subagents: { mode: auto }    # auto | auto-manual
      autonomy: strict             # strict | loose — `loose` is what permits subagents
      deliberation: { … }          # council/best-of-n staffing; see boost-and-deliberation.md
      billingMode: inherit         # inherit | api | subscription
      budget: { maxTokens: …, maxCostUsd: … }
```

**`skills.mode` decides what the node's child process is actually given:**

- `auto` — every skill installed in the project.
- `manual` — only the names in `list`, and nothing else.
- `auto-manual` — the union. This is the right default for a science pipeline:
  the researcher keeps their installed skills and you add the phase-specific ones.

`settings.autonomy: strict` (the default) means the node gets a read-only tool
policy and **no subagents**, whatever `maxSubagents` says. Set `loose` only when
the phase genuinely needs to fan out.

## Node kinds

```yaml
  kind: agent                # + prompt
  kind: research-until-goal  # + goal, completionCriteria: [1–32 short strings]
  kind: council              # + goal, members[2–16]{id,role,model}, chair, rounds[1–20], preserveMinorityReports
  kind: fusion               # + goal, preserveMinorityReports, fusion{…}
  kind: best-of-n            # + goal, candidateCount[2–16] or candidateModels[2–16], evaluator
  kind: evidence-gate        # + checks[1–4], artifactIds, onUnsupportedOutput, evaluator
  kind: lean4                # + goal, theorem, mode: verify|solve, mathlib, skill: byom-dag-fusion
  kind: prompt-optimization  # see the prompt-optimization schema
```

### `fusion` in the two modes

```yaml
    fusion:
      mode: openrouter-router
      router:  { requested: { source: fixed, provider: openrouter,
                              model: openrouter/fusion, auth: { kind: api-key },
                              reasoning: high },
                 resolution: { mode: exact } }
      members: [ {id, role, model}, … ]     # 2–8
      judge:   { … }
```

Hosted Fusion is strict, and the validator says so precisely:

- the router model must be exactly `openrouter/fusion`; a member or the judge
  may **not** be `openrouter/fusion`;
- every participant must be a fixed OpenRouter model on API-key auth with
  `resolution.mode: exact`;
- **every member and the judge must carry the router's `reasoning` level** —
  hosted Fusion exposes one shared level;
- `reasoning: max` is not representable; use `xhigh`.

```yaml
    fusion:
      mode: kady-panel
      members: [ … ]        # 2–32, any provider
      synthesizer: { … }
      rounds: 2             # 1–20
```

Use `kady-panel` when the researcher wants models from different providers, or
more than eight of them.

## Edges

```yaml
edges:
  - id: plan-to-stats
    from: plan
    to: stats
    condition: always      # always | success | failure | evidence-supported | evidence-unsupported
```

Rules the validator enforces:

- the entry node may have no incoming edge; no self-edges; no duplicate ids;
  no duplicate `(from,to)` pairs;
- a node's outgoing edges are either **all** `always`, or a `success`/`failure`
  pair — mixing the two is rejected;
- an `evidence-gate` routes with `evidence-supported` / `evidence-unsupported`
  and nothing else;
- every non-terminal node needs an outgoing route, every sink must be marked
  `terminal: true`, and every node must have a path to a terminal node.

## The shortest legal document

```yaml
schemaVersion: "1.0"
id: one-step
name: One Step
entryNodeId: only
defaultModel:
  requested: { source: fixed, provider: openrouter, model: anthropic/claude-opus-4.8,
               auth: { kind: api-key }, reasoning: high }
  resolution: { mode: exact }
limits: { maxIterations: 2, maxModelCalls: 2, maxParallelism: 1, maxSubagents: 1,
          timeoutMs: 600000, maxTokens: 200000, maxCostUsd: 2, maxRetries: 0 }
evidence: { enabled: false, minimumIndependentSources: 0,
            requireArtifactReferences: false, onUnsupportedOutput: fail }
nodes:
  - id: only
    name: Only step
    kind: agent
    terminal: true
    workspace: { isolation: read-only, writePaths: [] }
    prompt: Do the thing.
edges: []
```
