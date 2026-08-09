# NodeSpec v1 — FROZEN

**FROZEN:** Wave B lanes may extend this contract only through a PR that updates
this document and the TypeBox schema together. Existing fields may not be
removed or reinterpreted.

NodeSpec v1 is the optional `settings` object shared by every node in a typed
`WorkflowGraphDocument`. The schema is `NodeSpecV1Schema`; omitted settings keep
all persisted workflow v1 documents valid. `resolveNodeSpecV1()` applies defaults
without mutating stored documents.

## Enforcement status

`BOUND` means the current production runtime consumes the field. `FAIL-CLOSED(unit)`
means the schema shape remains frozen, but semantic validation rejects non-default
values until that Wave B unit binds the field.

| Field | Enforcement status |
| --- | --- |
| `version` | BOUND — schema discriminator |
| `model` | BOUND — validation, executable slots, and dispatch |
| `model.requested.auth.kind` | BOUND — existing provider/auth resolution |
| `reasoningEffort` | BOUND — executable slots and dispatch |
| `hyperparameters.temperature` | FAIL-CLOSED(S4) |
| `hyperparameters.top_p` | FAIL-CLOSED(S4) |
| `hyperparameters.sampling` | FAIL-CLOSED(S4) |
| `conditions.when` | FAIL-CLOSED(S4) |
| `conditions.exists` | FAIL-CLOSED(S4) |
| `harness` | FAIL-CLOSED(S4) |
| `databases` | FAIL-CLOSED(S4) |
| `skills.mode` | FAIL-CLOSED(S4) |
| `skills.list` | FAIL-CLOSED(S4) — no per-node list binding exists in this runtime |
| `subagents.mode` | FAIL-CLOSED(S4) |
| `autonomy` | FAIL-CLOSED(S4) |
| `deliberation.personalityStoreRef` | FAIL-CLOSED(S5) |
| `deliberation.bestOfNPersonalityCount` | FAIL-CLOSED(S5) |
| `deliberation.mimeographs.mode` | FAIL-CLOSED(S5) |
| `deliberation.mimeographs.personalityRefs` | FAIL-CLOSED(S5) |
| `billingMode` | FAIL-CLOSED(S4) |
| `budget.maxTokens` | BOUND — budget admission |
| `budget.maxCostUsd` | BOUND — budget admission |
| Workflow `settings.version` | BOUND — schema discriminator |
| Workflow `settings.defaultHarness` | FAIL-CLOSED(S4) |
| Workflow `settings.databases` | FAIL-CLOSED(S4) |

## Per-node fields

| Field | Semantics |
| --- | --- |
| `version` | Contract discriminator; omitted means NodeSpec version `1`. |
| `model` | Authoritative per-node requested-model contract; it overrides legacy node/default requests for validation and executable model slots, while absence preserves legacy fallback behavior and the existing `auth.kind` values `api-key`, `oauth`, `local`, and `custom`. |
| `reasoningEffort` | Authoritative per-node reasoning override applied to the executable request and its fallback alternatives: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; absence preserves the selected model reasoning, then defaults to `high` when no model exists. |
| `hyperparameters.temperature` | Frozen sampling-temperature shape; only the default `1` is accepted pending S4 binding. |
| `hyperparameters.top_p` | Frozen nucleus-sampling shape; only the default `1` is accepted pending S4 binding. |
| `hyperparameters.sampling` | Frozen extensible sampling-map shape; only an empty map is accepted pending S4 binding. |
| `conditions.when` | Frozen shape for an optional harness condition expression; validation fails closed when populated pending per-node-control enforcement in S4. |
| `conditions.exists` | Frozen shape for paths or named inputs that must exist before execution; validation fails closed when nonempty pending per-node-control enforcement in S4. |
| `harness` | Frozen CLI-selection shape; only the default `pi` is accepted pending S4 binding. |
| `databases` | Frozen per-node database-reference shape; only an empty list is accepted pending S4 binding. |
| `skills.mode` | Frozen skill-policy shape; only the default `auto` is accepted pending S4 binding. |
| `skills.list` | Frozen explicit skill-reference shape; only an empty list is accepted pending S4 binding. |
| `subagents.mode` | Frozen subagent-policy shape; only the default `auto` is accepted pending S4 binding. |
| `autonomy` | Frozen execution-authority shape; only the default `strict` is accepted pending S4 binding. |
| `deliberation.personalityStoreRef` | Frozen personality-store reference shape; absence is required pending S5 binding. |
| `deliberation.bestOfNPersonalityCount` | Frozen personality-count shape; only the default `2` is accepted pending S5 binding. |
| `deliberation.mimeographs.mode` | Frozen staffing-policy shape; only the default `auto` is accepted pending S5 binding. |
| `deliberation.mimeographs.personalityRefs` | Frozen personality-reference shape; only an empty list is accepted pending S5 binding. |
| `billingMode` | Frozen billing-selector shape; only the default `inherit` is accepted pending S4 binding. |
| `budget.maxTokens` | Per-node token ceiling; admission uses the stricter of this value, legacy node limits, and the workflow ceiling. |
| `budget.maxCostUsd` | Per-node USD ceiling; admission uses the stricter of this value, legacy node limits, and the workflow ceiling. |

## Workflow-level fields

The optional root `settings` object uses `WorkflowSettingsV1Schema`.

| Field | Semantics |
| --- | --- |
| `version` | Workflow-settings discriminator; omitted means version `1`. |
| `defaultHarness` | Frozen workflow harness-default shape; only `pi` is accepted pending S4 binding. |
| `databases` | Frozen workflow database-reference shape; only an empty list is accepted pending S4 binding. |
