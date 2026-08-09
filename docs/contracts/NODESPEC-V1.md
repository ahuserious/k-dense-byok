# NodeSpec v1 — FROZEN

**FROZEN:** Wave B lanes may extend this contract only through a PR that updates
this document and the TypeBox schema together. Existing fields may not be
removed or reinterpreted.

NodeSpec v1 is the optional `settings` object shared by every node in a typed
`WorkflowGraphDocument`. The schema is `NodeSpecV1Schema`; omitted settings keep
all persisted workflow v1 documents valid. `resolveNodeSpecV1()` applies defaults
without mutating stored documents.

## Per-node fields

| Field | Semantics |
| --- | --- |
| `version` | Contract discriminator; omitted means NodeSpec version `1`. |
| `model` | Optional requested-model contract, including the existing `auth.kind` values `api-key`, `oauth`, `local`, and `custom`. |
| `reasoningEffort` | Per-node reasoning override: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults from the selected model, then `high`. |
| `hyperparameters.temperature` | Sampling temperature from `0` through `2`; defaults to `1`. |
| `hyperparameters.top_p` | Nucleus-sampling probability from `0` through `1`; defaults to `1`. |
| `hyperparameters.sampling` | Extensible map of up to 16 scalar sampling parameters for later harness adapters; defaults to empty. |
| `conditions.when` | Optional harness condition expression; absence means no expression gate. |
| `conditions.exists` | Paths or named inputs that must exist before execution; defaults to an empty list. |
| `harness` | Per-node CLI choice: `pi`, `claude-code`, `codex`, `opencode`, or `copilot`; defaults from the workflow, then `pi`. |
| `databases` | Database catalogue IDs added to the workflow-wide database references; defaults to empty. |
| `skills.mode` | Skill-selection policy: `auto`, `auto-manual`, or `manual`; defaults to `auto`. |
| `skills.list` | Explicit skill references used by manual-capable modes; defaults to empty. |
| `subagents.mode` | Subagent-selection policy: `auto` or `auto-manual`; defaults to `auto`. |
| `autonomy` | Node execution authority: `strict` or `loose`; defaults to `strict`. |
| `deliberation.personalityStoreRef` | Opaque reference to the pi-invisible personality store; no filesystem path or secret is embedded. |
| `deliberation.bestOfNPersonalityCount` | Number of personalities sampled for deliberation, from `1` through `32`; defaults to `2`. |
| `deliberation.mimeographs.mode` | Mimeographs staffing policy: `auto` or `manual`; defaults to `auto`. |
| `deliberation.mimeographs.personalityRefs` | Explicit personality references for manual staffing; defaults to empty. |
| `billingMode` | Billing selector `api` or `subscription`; `inherit` keeps the existing provider billing classifier and is the default. |
| `budget.maxTokens` | Per-node token ceiling; admission uses the stricter of this value, legacy node limits, and the workflow ceiling. |
| `budget.maxCostUsd` | Per-node USD ceiling; admission uses the stricter of this value, legacy node limits, and the workflow ceiling. |

## Workflow-level fields

The optional root `settings` object uses `WorkflowSettingsV1Schema`.

| Field | Semantics |
| --- | --- |
| `version` | Workflow-settings discriminator; omitted means version `1`. |
| `defaultHarness` | Default CLI/harness inherited by nodes without an override; defaults to `pi`. |
| `databases` | Database catalogue IDs available to every node; defaults to empty and is unioned with per-node references. |

