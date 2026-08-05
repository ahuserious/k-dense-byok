# Legacy DAG-Pipelines migration boundary

The `dynamic-fusion-graph` implementation does not automatically adopt state
from the former `DAG-Pipelines` branch. It provides a narrow, preview-only
translation for portable legacy YAML and treats legacy run records as archives.
This is deliberate: the old and new runners do not have equivalent persistence
or control semantics.

## Where the legacy branch stored state

The former integration had three distinct state owners:

- Project workflow definitions were YAML files under
  `sandbox/.archon/workflows/`. Committed starter YAML was copied there without
  overwriting a same-named user file.
- Authoritative node execution and resume state belonged to the separate Archon
  sidecar database.
- Kady appended a lossy Console row under
  `sandbox/.kady/runs/<sessionId>/runs.jsonl` and reconciled reported usage into
  `costs.jsonl`. Those rows were useful history, but they were not a replayable
  workflow journal.

The native runner now owns revisioned JSON definitions under
`sandbox/.kady/workflows/definitions/` and immutable run manifests plus
sequenced events under `sandbox/.kady/workflows/runs/`. A native resume requires
the saved graph revision and hash, node events, lease/fence state, model
resolution receipts, and budget records. None can be reconstructed faithfully
from the old Console row.

For that reason, legacy runs are **archive-only**. They are not assigned a new
`wrun_...` id, shown as controllable native Console runs, or inserted into
Raindrop's autosaved native-run tabs. Keep the old project data if its historical
rows or the Archon database are still needed. Starting a native run creates new
evidence; it is not a resume of an old run.

## Opt-in YAML preview

`POST /dag-workflow-imports/legacy-archon/preview` accepts one YAML document
that the user explicitly supplies. The route never scans `.archon`, changes the
source file, saves a definition, or starts a run. It returns:

- a typed schema 1.0 graph when every behavior is portable;
- warnings describing conservative translations;
- blockers for semantics that need a human redesign; and
- the explicit `archive-only` legacy-run policy.

The request must include a new Kady workflow id and a reasoning level. Reasoning
is required because the old YAML model reference did not encode it and Kady does
not silently choose one.

```json
{
  "workflowId": "imported-research",
  "reasoning": "high",
  "source": "name: Imported research\nprovider: pi\ninteractive: false\nnodes: ..."
}
```

For a local legacy file, a user can explicitly stream that one file into the
preview endpoint:

```bash
jq -Rs \
  --arg workflowId imported-research \
  --arg reasoning high \
  '{source: ., workflowId: $workflowId, reasoning: $reasoning}' \
  projects/default/sandbox/.archon/workflows/my-workflow.yaml \
| curl --fail-with-body \
    -H 'Content-Type: application/json' \
    -H 'X-Project-Id: default' \
    --data-binary @- \
    http://localhost:8000/dag-workflow-imports/legacy-archon/preview
```

Review the returned graph and warnings before saving the graph through the
normal revisioned `PUT /dag-workflows/:workflowId` route. The preview sets
`maxCostUsd` to `0`, disables retry/rescue/evidence inference, and makes every
node workspace read-only. Paid execution therefore remains closed until a user
reviews and deliberately edits the new graph's models, limits, policies, and
workspace needs.

## Automatically portable subset

The translator accepts only a single-entry DAG made of prompt nodes with:

- `id`, `prompt`, an exact `provider/model`, and zero or one `depends_on` entry;
- `provider: pi`, which is recorded as a move to Pi (Kady);
- `interactive: false`; and
- model providers whose auth ownership Kady can represent exactly: OpenRouter,
  Ollama, OpenAI-compatible, or a supported Pi OAuth subscription provider.

It converts the old run-input and immediate-parent output placeholders into
references to Kady's explicit run context and verified inbound records. Edges,
terminal nodes, and a single entry node are derived from `depends_on`. The
source prompt remains user-owned input; no prompt, test fixture, source file,
or visual asset from the legacy branch is bundled into the new implementation.

## Manual translation required

The preview blocks instead of discarding or approximating these behaviors:

- `interactive: true` and approval/rejection gates;
- loop/until/fresh-context behavior;
- conditional `when` expressions;
- node skills, tool allowlists, extra context, or output schemas;
- a node with multiple `depends_on` parents, because the legacy runner waited
  for all parents while Kady schema 1.0 merge nodes are any-ready;
- implicit, unknown, or compound model routing; and
- non-inbound or otherwise unresolved legacy placeholders.

Consequently, the old starter marked interactive, the data-science loop with a
human review, and the larger composed research workflow all need deliberate
redesign in the native Builder. Kady's new ML/AI and Data & Analysis templates
cover similar product purposes using independently authored typed nodes; they
are not copies or claimed byte-for-byte migrations of the legacy seeds.

## User-visible surface mapping

| Legacy surface | Native boundary |
|---|---|
| Archon YAML and embedded visual builder | Explicit YAML preview, then a reviewed save into Kady's native DAG Builder. |
| Archon sidecar run/resume | No conversion. Native Runner starts a new, fully receipted run. |
| Combined lossy run-index Console | Native Console reads only the authoritative DAG event stream and sends controls to that runner. |
| External Raindrop Workshop iframe | Native Raindrop autosaves `wrun_...` tabs and uses its separate read-only Pi log analyst. Legacy ids remain archival. |

This boundary preserves inspectability without pretending that incompatible
control or persistence models are interchangeable.
