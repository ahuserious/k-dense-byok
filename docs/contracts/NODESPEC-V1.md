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
| `model` | BOUND — primary/inherited model slot only; ambiguous compound configurations and deterministic Lean verify nodes fail validation |
| `model.requested.auth.kind` | BOUND — existing provider/auth resolution |
| `reasoningEffort` | BOUND — authoritative for every effective model/evidence-evaluator slot, including the hosted Fusion router, panel, duplicate judge slots, receipts, accounting definition, and provider request; rejected when slotless |
| `hyperparameters.temperature` | BOUND — provider request sampling |
| `hyperparameters.top_p` | BOUND — provider request sampling |
| `hyperparameters.sampling` | BOUND — provider request sampling map |
| `conditions.when` | BOUND — pre-admission boolean evaluator |
| `conditions.exists` | BOUND — sandbox-safe path/named-input gate |
| `harness` | BOUND — Pi dispatch; explicit unavailable/unbound CLI errors |
| `databases` | BOUND — per-node execution context |
| `skills.mode` | BOUND — Pi child skill selection |
| `skills.list` | BOUND — Pi child skill selection |
| `subagents.mode` | BOUND — node subagent policy context |
| `autonomy` | BOUND — child tool/subagent access gate |
| `deliberation.personalityStoreRef` | BOUND — selects a server-only, Pi-invisible scientific-agents snapshot verified against an administratively pinned commit and content-manifest SHA-256; the run receipts that exact snapshot before provider dispatch |
| `deliberation.bestOfNPersonalityCount` | BOUND — deterministic task matching selects exactly this many personality profiles |
| `deliberation.mimeographs.mode` | BOUND — auto selects across the store; manual uses the authored roster in order |
| `deliberation.mimeographs.personalityRefs` | BOUND — exact unique manual staffing roster, matched against the installed store before execution |
| `billingMode` | BOUND — resolved-auth admission gate |
| `budget.maxTokens` | BOUND — budget admission |
| `budget.maxCostUsd` | BOUND — budget admission |
| Workflow `settings.version` | BOUND — schema discriminator |
| Workflow `settings.defaultHarness` | BOUND — inherited harness dispatch |
| Workflow `settings.databases` | BOUND — inherited node execution context |

## Per-node fields

| Field | Semantics |
| --- | --- |
| `version` | Contract discriminator; omitted means NodeSpec version `1`. |
| `model` | Authoritative only for the node's primary/inherited model slot; explicit evaluator, member, chair, judge, router, and synthesizer requests retain their declared models, compound configurations without an unambiguous primary slot fail validation, and deterministic Lean verify nodes reject the field because they have no primary slot. |
| `reasoningEffort` | Authoritative per-node reasoning override when a model or evidence-evaluator slot exists: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; non-default values are rejected on slotless nodes. Hosted Fusion applies one effective value to the router, all panel members, both billed judge slots, runtime receipts, accounting, and the OpenRouter request; its provider cannot represent `max`, so that value remains invalid there. |
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
| `deliberation.personalityStoreRef` | Selects an installed server-only personality store. The default is `scientific-agents/v1`; store installation fails if its path is under a project/Pi-visible root or its content differs from the administratively configured immutable commit and content-manifest SHA-256. First execution persists the source, commit, store digest, selected refs, and effective prompt hash; retries load that content-addressed snapshot and fail closed when it is unavailable. |
| `deliberation.bestOfNPersonalityCount` | Selects exactly this many best-matching personalities for the node goal, independently of best-of-N model candidate count. |
| `deliberation.mimeographs.mode` | `auto` ranks the full store; `manual` uses the exact authored roster in order. Staffing is supported only by best-of-N, Council, and Fusion nodes. |
| `deliberation.mimeographs.personalityRefs` | Unique manual personality refs. Manual mode requires exactly `bestOfNPersonalityCount` refs; auto mode requires none. The selected mimeograph instructions and identities are materialized into the bounded provider-visible node task. |
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
