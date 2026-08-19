# Read this first — this app has two execution surfaces, not one

Everything else in `references/recipes/` is organised around this fact. Get it
wrong and you will emit a pipeline that validates against the wrong grammar and
is rejected on save, or — worse — one that saves and then silently drops the
behaviour the researcher asked for.

## The two surfaces

| | **Typed runtime** | **Vendored pipeline engine** |
|---|---|---|
| What it is | This app's own workflow runtime | A vendored copy of the upstream pipeline engine, run as a sidecar |
| Document | `WorkflowGraphDocument`, `schemaVersion: "1.0"` (JSON or YAML) | Legacy pipeline YAML |
| Grammar defined by | `server/src/workflows/schema.ts` | `server/vendor/pipeline-engine/packages/workflows/src/schemas/dag-node.ts` |
| Validated by | `server/src/workflows/validate.ts` (~70 issue codes) | the engine's own loader/validator |
| Where it appears in the UI | **Scientific Pipelines ▸ Workflow registry**, typed rows | the same registry, vendored rows (Edit / Run with vendored engine) |
| Executed by | `runWorkflowDag` — durable, event-sourced, leased | the engine's DAG executor |

A row in the registry can be typed, vendored, or both. That is why the row has
separate "Open … details" and "Edit … with vendored engine" controls.

## Which one you are authoring for

**Default to the typed runtime.** It is the one that persists through
`GET /dag-workflows`, the one whose runs the Console shows, the one with budget
reservations and model-resolution receipts, and the one the seeded pipelines
land in.

Author for the vendored engine only when the researcher needs a capability the
typed runtime does not have — in practice: a **human approval gate**, a **loop
until a condition**, or a **shell/Python step that runs no model**. Say so out
loud when you make that trade, and say what they give up: the vendored side has
no typed budget envelope and no NodeSpec v1 receipts.

## The capability table — verified against both schemas

| Capability | Typed runtime | Vendored engine |
|---|---|---|
| Prompt/agent step | `kind: "agent"` with `prompt` | `prompt:` node |
| Shell step, no model | **absent** | `bash:` node (`timeout`) |
| Python/TypeScript step, no model | **absent** | `script:` node (`runtime: uv \| bun`, `deps`) |
| Loop until a condition | **absent** — bound it with `limits.maxIterations` and say the condition in the prompt | `loop:` node (`until`, `until_bash`, `max_iterations`, `fresh_context`) |
| Human approval gate | **absent** — there is no human gate at all | `approval:` node (`message`, `capture_response`, `on_reject`) |
| Guarded exit | **absent** | `cancel:` node |
| Slash-command step | **absent** | `command:` node |
| Multi-model panel + judge | `kind: "fusion"` (`openrouter-router` or `kady-panel`) | fusion topology nodes |
| Deliberating council | `kind: "council"` (members, chair, rounds, minority reports) | — |
| Best-of-N sampling | `kind: "best-of-n"` | — |
| Evidence gate on citations/claims/artifacts | `kind: "evidence-gate"` | — |
| Lean 4 proof step | `kind: "lean4"` | — |
| Research until a goal is met | `kind: "research-until-goal"` | — |
| Per-node skills | `settings.skills = { mode, list }` | `skills: [name, …]` |
| Per-node MCP server | **absent** | `mcp:` |
| Per-node tool allow/deny | fixed policy derived from `settings.autonomy` | `allowed_tools` / `denied_tools` |
| Per-node hooks | **absent** | `hooks:` |
| Structured output schema | **absent** — state the answer shape in the prompt | `output_format:` |
| Fresh context per step | implicit: every node is its own execution | `context: fresh \| shared` |
| Conditional edges | edge `condition: always \| success \| failure \| evidence-supported \| evidence-unsupported` | node `when:` expression + `trigger_rule` |
| Retry | `limits.maxRetries` (workflow) | per-node `retry:` |
| Spend envelope | `limits.maxCostUsd`, enforced before dispatch | — |

## The three traps

1. **Do not emit `skills: [...]` in a typed document.** The typed spelling is
   `settings.skills.list`, and `additionalProperties: false` means the wrong
   spelling is a validation error, not a warning.
2. **Do not promise a human approval gate in a typed pipeline.** There is none.
   If the researcher needs one, either author for the vendored engine or replace
   it with an adversarial reviewer node and *tell them that is what you did*.
   `server/seed/pipelines/data-scientist.yaml` is the worked example of that
   trade, and it says so in its own description.
3. **Do not emit `$ARTIFACTS_DIR` or `$node.output` in a typed prompt.** Typed
   documents declare artifacts in the `artifacts:` block and pass state through
   the run's node record. See `variables-and-outputs.md`.
