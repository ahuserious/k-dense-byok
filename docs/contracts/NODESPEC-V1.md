# NodeSpec v1 — FROZEN

**FROZEN:** Wave B lanes may extend this contract only through a PR that updates
this document and the TypeBox schema together. Existing fields may not be
removed or reinterpreted.

NodeSpec v1 is the optional `settings` object shared by every node in a typed
`WorkflowGraphDocument`. The schema is `NodeSpecV1Schema`; omitted settings keep
all persisted workflow v1 documents valid. `resolveNodeSpecV1()` applies defaults
without mutating stored documents.

## What this freeze does and does not cover

The frozen surface is `NodeSpecV1Schema` — the `settings` object — and nothing
else. A node in a `WorkflowGraphDocument` carries fields beside `settings`, and
those are governed by their own reviews rather than by the clause above.

Lane W3 (2026-08-18) added two of them. They are recorded here because the
boundary is easy to misread, not because they are part of NodeSpec v1:

| Field | Where it lives | What it is |
| --- | --- | --- |
| `meta.compositeOf` | `WorkflowNodeSchema`, sibling of `settings` | Optional. Flattens the origin of a node that arrived as part of a stitched-in subgraph. |
| `provenance` | `WorkflowNodeSchema` and the document root | Optional. Names where a node or document came from. |

Two things about them are worth stating plainly, because the handoff that
authorised them got one of them wrong:

1. **They are outside validation semantics.** `server/src/workflows/validate.ts`
   is untouched and no validation path reads either field.
2. **They are inside `graphSha256`.** The handoff said "excluded from …
   `graphSha256`", and that is not how the hash works: it is
   `sha256(validation.document)`, and `canonicalize()` sorts keys while
   stripping nothing, so every persisted field participates. This is deliberate
   and follows the same rule the pre-existing per-node `position` already did —
   the store treats an identical hash as "unchanged" and skips the write, so a
   hash that ignored these fields would make a change to them a silent no-op
   that never persisted.

Round 1 of that lane also carried a document-level `ui` object holding
`positions` and `viewport`. It was removed before merge, and the reasoning is
worth keeping: it was persisted and round-tripped but never emitted and never
applied, and an optional field under `additionalProperties: false` is not free —
a document written with it is a document an older server rejects as CORRUPT on
read.

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
| Prompt optimization node `interviewUser` | BOUND — revisioned compare-and-swap makes submitted answers terminal and idempotent, occurrence-aware run+node state hashes the question set, reuses matching answered state across retries, durably writes fresh valid run_waiting/run_resumed transitions after recovery, folds answers into every iteration, and rejects placement downstream of concurrent fan-out while waiting remains run-scoped |
| Prompt optimization node `fusionDeliberation.enabled` | BOUND — false dispatches typed council deliberation; true requires and dispatches the typed Fusion configuration; configured council/Kady-panel child rounds execute independently inside the outer optimization-iteration cap |
| Prompt optimization model-call receipts | BOUND — every synthetic call has a stable iteration-prefixed outer slot and persisted declared/resolved receipt retaining requested provider, resolved provider, fallback, reasoning, auth, and compound runtime evidence |
| Prompt optimization cumulative envelope | BOUND — one deadline, token cap, and cost cap spans interview plus every iteration; each synthetic deliberation receives only its remaining bounded share and inherits resolved NodeSpec/rescue/evidence policy |
| Prompt optimization evidence policy | FAIL-CLOSED(S6) — node overrides or enabled workflow evidence are rejected before provider calls pending full evaluator support |
| Prompt optimization `artifactId` / artifact v1 | BOUND — the graph-declared owned path is a namespace; the host atomically writes a unique run+node+attempt child path and returns a checksummed runner-normalized receipt containing original prompt, iterations, winner, rationale, and cumulative usage |
| `hyperparameters.temperature` | PARTIAL — bound for Pi-delegated nodes (the trusted child extension stamps it onto `before_provider_request`); **not** bound for hosted OpenRouter Fusion on the production supervised transport, where the request carries no node-control bindings and the value is silently dropped (see "Known production gaps") |
| `hyperparameters.top_p` | PARTIAL — same as `temperature` |
| `hyperparameters.sampling` | PARTIAL — bound for Pi-delegated nodes, non-reserved keys only (reserved keys fail validation); same hosted-Fusion gap |
| `conditions.when` | BOUND — pre-admission boolean evaluator |
| `conditions.exists` | BOUND — sandbox-safe path/named-input gate |
| `harness` | NOT BOUND in production — the supervised transport dispatches Pi unconditionally and never reads the field. `dispatchWorkflowHarness`'s unavailable/unbound CLI errors exist but are reachable only through the in-process executor defaults used by tests. A non-`pi` value currently surfaces as a child-side envelope rejection *after* admission and budget reservation (see "Known production gaps") |
| `databases` | BOUND as provider-visible context text only — refs are resolved against the catalogue and serialised into the child prompt. It grants no network, mount, or credential; it is not a capability gate |
| `skills.mode` | BOUND — Pi child skill selection |
| `skills.list` | BOUND — Pi child skill selection |
| `subagents.mode` | BOUND as provider-visible context text only — the actual subagent tool grant is derived from `autonomy`, not from this field, so `auto-manual` behaves identically to `auto` |
| `autonomy` | BOUND — child tool/subagent access gate |
| `deliberation.personalityStoreRef` | BOUND — selects a server-only, Pi-invisible scientific-agents snapshot verified against an administratively pinned commit and content-manifest SHA-256; the run receipts that exact snapshot before provider dispatch |
| `deliberation.bestOfNPersonalityCount` | BOUND — deterministic task matching selects exactly this many personality profiles |
| `deliberation.mimeographs.mode` | BOUND — auto selects across the store; manual uses the authored roster in order |
| `deliberation.mimeographs.personalityRefs` | BOUND — exact unique manual staffing roster, matched against the installed store before execution |
| `billingMode` | BOUND — resolved-auth admission gate in the typed runtime, and at the `POST /pipelines/:name/run` host gate for the vendored path; the vendored engine itself reads nothing |
| `budget.maxTokens` | BOUND — budget admission in the Kady runtime and at the pipelines host gate; the vendored engine normalises but never reads it |
| `budget.maxCostUsd` | BOUND — budget admission |
| Workflow `settings.version` | BOUND — schema discriminator |
| Workflow `settings.defaultHarness` | NOT BOUND in production — inheritance resolves correctly, but the inherited value reaches no dispatch decision on the supervised transport, exactly as with `harness` |
| Workflow `settings.databases` | BOUND as provider-visible context text only, unioned with each node's own list; advisory in the same way as `databases` |

## Per-node fields

| Field | Semantics |
| --- | --- |
| `version` | Contract discriminator; omitted means NodeSpec version `1`. |
| `model` | Authoritative only for the node's primary/inherited model slot; explicit evaluator, member, chair, judge, router, and synthesizer requests retain their declared models, compound configurations without an unambiguous primary slot fail validation, and deterministic Lean verify nodes reject the field because they have no primary slot. |
| `reasoningEffort` | Authoritative per-node reasoning override when a model or evidence-evaluator slot exists: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; non-default values are rejected on slotless nodes. Hosted Fusion applies one effective value to the router, all panel members, both billed judge slots, runtime receipts, accounting, and the OpenRouter request; its provider cannot represent `max`, so that value remains invalid there. |
| `hyperparameters.temperature` | Sampling temperature applied to the child Pi provider request via the trusted node-control extension. Hosted OpenRouter Fusion does not receive it on the supervised transport (known gap). |
| `hyperparameters.top_p` | Nucleus-sampling value applied to the child Pi provider request via the trusted node-control extension; same hosted-Fusion gap. |
| `hyperparameters.sampling` | Extensible sampling map merged into the child provider payload. The keys `messages`, `model`, `tools`, `stream`, `max_tokens`, `temperature`, and `top_p` are reserved and rejected at validation; same hosted-Fusion gap. |
| `conditions.when` | Optional boolean pre-admission condition, evaluated without eval or shell expansion. Accepts `true`/`false` or one boolean reference (`inputs.*`, `variables.*`, `run.*`, `inbound.<nodeId>.*`, `attempt`, `resumed`), optionally negated with `!` or `not`. A missing or non-boolean reference fails closed before any model slot, receipt, or reservation. |
| `conditions.exists` | Sandbox-relative paths or named inputs (`input:name` / `inputs.name`) that must exist before admission. Paths are realpath-confined to the project sandbox; absolute, `..`-bearing, or NUL-bearing entries are rejected at validation. |
| `harness` | CLI selection. `pi` is the only harness with a delegation adapter. On the production supervised transport the value is currently not consulted at dispatch, so a non-`pi` value fails late inside the child rather than at harness selection — see the enforcement-status note and "Known production gaps". |
| `databases` | Per-node database references, unioned with the workflow-level list, resolved against the database catalogue and delivered to the child as execution-context data. Advisory: no tool, network, or credential is gated on it. |
| `skills.mode` | `auto` delegates the installed skill set, `manual` delegates only the authored list, `auto-manual` delegates their union. The result is the child delegation request's skill selection. |
| `skills.list` | Explicit skill refs used by `manual` and `auto-manual` modes; they become part of the child's skill selection. |
| `subagents.mode` | Declared subagent policy, delivered to the child as execution-context data. Advisory: the actual subagent tool grant is derived from `autonomy`, not from this field. |
| `autonomy` | `strict` grants the child `read`, `grep`, `find`, `ls`; `loose` additionally grants `subagent` when the effective `maxSubagents` is non-zero. The trusted child extension enforces the list with `setActiveTools`. |
| `deliberation.personalityStoreRef` | Selects an installed server-only personality store. The default is `scientific-agents/v1`; store installation fails if its path is under a project/Pi-visible root or its content differs from the administratively configured immutable commit and content-manifest SHA-256. First execution persists the source, commit, store digest, selected refs, and effective prompt hash; retries load that content-addressed snapshot and fail closed when it is unavailable. |
| `deliberation.bestOfNPersonalityCount` | Selects exactly this many best-matching personalities for the node goal, independently of best-of-N model candidate count. |
| `deliberation.mimeographs.mode` | `auto` ranks the full store; `manual` uses the exact authored roster in order. Staffing is supported only by best-of-N, Council, and Fusion nodes. |
| `deliberation.mimeographs.personalityRefs` | Unique manual personality refs. Manual mode requires exactly `bestOfNPersonalityCount` refs; auto mode requires none. The selected mimeograph instructions and identities are materialized into the bounded provider-visible node task. |
| `billingMode` | Declared billing channel. Admission rejects a node whose declared mode contradicts the resolved provider/auth billing, before any provider call, on both the typed-runtime and pipelines-host paths. |
| `budget.maxTokens` | Per-node token ceiling; admission uses the stricter of this value, legacy node limits, and the workflow ceiling. |
| `budget.maxCostUsd` | Per-node USD ceiling; admission uses the stricter of this value, legacy node limits, and the workflow ceiling. |

## Workflow-level fields

The optional root `settings` object uses `WorkflowSettingsV1Schema`.

| Field | Semantics |
| --- | --- |
| `version` | Workflow-settings discriminator; omitted means version `1`. |
| `defaultHarness` | Workflow-wide harness default; a node's own `harness` wins. Subject to the same production dispatch gap as `harness`. |
| `databases` | Workflow-wide database references, unioned with each node's own list; advisory in the same way. |

## Known production gaps (2026-08-18)

Recorded here because this document previously asserted the opposite, and because each one is a case where a
user can set a value, nothing rejects it, and nothing acts on it. Full evidence with file:line citations:
`dfg-evidence-20260807-135127/s11/NODESPEC-BOUND-AUDIT-20260818.md`. These are product defects, not contract
changes; the frozen schema surface is unchanged by this correction.

1. **Hosted-Fusion sampling controls are silently dropped.** `server/src/index.ts` boots the out-of-process
   workflow supervisor on every real server start, and its dependency overrides replace the in-process wrapper
   that fails closed on a missing node-control binding. `WorkflowSupervisorHostedFusionRequest`
   (`server/src/workflows/supervisor/protocol.ts`) carries no `nodeControl` field, so `temperature`, `top_p` and
   `sampling` never cross the wire and the coordinator builds a session with no provider binder. A user who sets
   `temperature: 0.2` on a hosted-Fusion node gets `1`, with no error anywhere.

2. **`harness` and workflow `defaultHarness` reach no dispatch decision.** The supervisor client's
   `getDelegationSession` drops the harness argument, and the coordinator binds the Pi factory directly, so
   `dispatchWorkflowHarness` — whose own comment says it exists "without silently falling back to Pi" — is
   unreachable from the booted server. The only surviving guard is the child extension's harness check, which
   fires after admission and budget reservation. Hosted-Fusion-only nodes never request a delegation session at
   all, so `harness` is inert for them on every transport.

3. **`server/src/workflows/node-spec-enforcement.ts` is unreachable.** Its workflow-settings function returns an
   empty list unconditionally; its other two emit only `S5` findings, and both validation loops skip `S5`; and
   by the time the executor's gate runs, `withDeliberationBindings` has stripped `settings.deliberation` and
   `materializeEffectiveHostedFusionNode` has deleted `settings.reasoningEffort`. The test intended to prove the
   gate filters its table to `unit === "S5"` rows, of which the file contains none, so it expands to zero cases.

