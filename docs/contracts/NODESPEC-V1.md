# NodeSpec v1 — FROZEN

**FROZEN:** Wave B lanes may extend this contract only through a change that
updates this document and the TypeBox schema together. Existing fields may not
be removed or reinterpreted.

**How "together" is satisfied in this repository, and why the wording changed.**
The clause used to say "through a PR". This repository has no PR workflow —
lanes are reviewed by independent adversarial agents and the orchestrator merges
locally — so "a PR" had no referent, and on 2026-08-18 it was read as "the merge
wave" to justify landing the schema and this document in two adjacent commits.
That reading produced exactly what the clause exists to prevent: commit
`6342ec0` on the published branch carries the schema's `meta`/`provenance`
additions while this document does not yet describe them. One commit, resolved
by the next one, but reachable by checkout, bisect, revert or cherry-pick. See
`docs/adr/S11-contract-freeze-mechanism.md`.

Adjacency is not atomicity, and the fix is not to try harder at atomicity —
a lane may not write `docs/contracts/` at all (these files are uninventoried,
which is how `ownership-check` spells orchestrator-only), so "one commit
containing both" is unsatisfiable by construction. **The document leads.** An
orchestrator commit describing the new fields lands BEFORE the lane merge that
adds them to the schema. A document that describes a field the schema does not
yet carry is harmless — it is a specification ahead of its implementation, and
this section is where you would say so. A schema that carries a field the
document does not describe is the dangerous direction, and ordering the two
makes that state unreachable rather than merely discouraged.

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

### Node kinds, and what lane F5 is authorised to add (2026-08-19)

Node **kinds** are outside the frozen `settings` surface — `WorkflowNodeSchema` is a union of per-kind
objects, and `NodeSpecV1Schema` is one optional property inside each of them. `freeze-check.sh` does not
read the union. They are recorded here anyway, before the lane that changes them, for the same reason the
W3 fields above are: the boundary is easy to misread, and a reader who finds a kind in the schema and not
in the contract cannot tell which of the two is wrong.

**Kinds that exist today** (`server/src/workflows/schema.ts`, union at `:520`): `agent`,
`research-until-goal`, `council`, `fusion`, `prompt-optimization`, `best-of-n`, `evidence-gate`, `lean4`.
Matrix rows 27, 28, 31, 32 and 33 are asking for kinds this list already contains — **lane F5 delivers the
mapping from the owner's vocabulary to these kinds, not a second implementation of any of them.** A
duplicate kind alongside an existing one is rejected at review.

**Kinds lane F5 is authorised to add** (specification ahead of implementation):

| Kind | Row | What it is |
| --- | --- | --- |
| `elevate-to-dag` | 26 | Takes a prompt and emits a durable DAG definition that validates against this contract and saves. **One implementation, three entry points** — the chat panel (row 17, lane F9) and the skill (row 43, lane F11) call F5's engine and API; they do not each build an elevator. |
| `hypothesis` | 34 | Generates n hypotheses with matched nulls, runs them, and produces the terminal analysis artifact. |
| `reasoning-style` | 35 | Selects which personas a downstream council instantiates: auto (best fit of n scientists), manual, or from an InfraNodus map. The InfraNodus source is an external service and is gated behind explicit configuration, failing closed when unset (#44/#57/#64). |
| `formatted-output` | 36 | Constrains and validates the shape of a node's actual output. |

**Existing kinds lane F5 is authorised to extend:**

| Kind | Change | Row |
| --- | --- | --- |
| `council` | A **`fuser`** role. `CouncilNodeSchema` (`:413`) has `members` (2-16), `chair`, `rounds` (1-20) and `preserveMinorityReports` — a chair and members, two roles against the three the owner asked for. The owner's default is **4 heads + 1 neutral judge + 1 fuser**. F5 either adds the role to the schema or maps judge→`chair` plus a downstream `fusion` node, and **records which in `docs/adr/F5-council-roles.md`**. Both directions are authorised here; exactly one may land, and this table is corrected to match at merge. | 29 |
| `council` | Head auto-selection by workflow type, and judge-initiated **recruitment** of additional heads on detecting a blind spot: a bounded `maxRecruits` that respects the effective `maxSubagents` and is observable in RunState v1 (see `RUNSTATE-V1.md`). Recruitment must not let a node exceed the subagent bound it was admitted under. | 30 |
| `evidence-gate` | A **council evaluator** alongside the single-LLM `evaluator` (`:493`), so "verification style" is LLM *or* LLM council and the council one actually runs a council. | 31 |
| `best-of-n` | No schema change is authorised. It already executes (`candidateCount` 2-16, `candidateModels`, `evaluator`); the missing half is the visualisation, which is lane F6's. F5 publishes the run-state fields that visualisation reads. | 33 |
| `rescue` (`RescuePolicySchema`, `:268`) | No new field is authorised without a further contract commit. F5 audits what of `enabled` / `maxAttempts` / `triggers` is not reachable and exposes it; both branches (retry n, and supervisor-fixes-the-DAG) are proven with an induced failure. | 32 |

**`graphSha256` and the new fields.** `graphSha256 = sha256(canonicalJson(document))` and the canonicaliser
strips nothing, so every field F5 adds is inside the content address. All of them are **content-derived and
hash-stable**: they carry authored configuration, not timestamps, run ids or counters, so a retried save of
the same logical document hashes identically. Whether `meta`/`provenance` — or anything else — *should* be
inside that address is an owner decision (§12.4 of the wave brief) and is **not** decided here or by F5.

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
| `hyperparameters.temperature` | BOUND — for Pi-delegated nodes the trusted child extension stamps it onto `before_provider_request`; for hosted OpenRouter Fusion the serialized supervised request now carries the whole `nodeControl` binding object and the coordinator binds `providerRequest` onto the session, refusing a request that arrives without it (`c988bf0`, #54). Both transports fail closed rather than falling back to provider defaults |
| `hyperparameters.top_p` | BOUND — same as `temperature` |
| `hyperparameters.sampling` | BOUND — non-reserved keys only (reserved keys fail validation), on both transports as for `temperature` |
| `conditions.when` | BOUND — pre-admission boolean evaluator |
| `conditions.exists` | BOUND — sandbox-safe path/named-input gate |
| `harness` | PARTIAL — a real dispatch **decision** now happens on both transports before budget reservation: `assertWorkflowHarnessAdapterBound` is shared by the in-process `dispatchWorkflowHarness` and by the supervised client's `getDelegationSession` override (`c988bf0`, #55/#68/#45), so a non-`pi` harness is refused with `WORKFLOW_HARNESS_NOT_INSTALLED` / `WORKFLOW_HARNESS_NOT_BOUND` instead of quietly buying a Pi child. What is still missing is a *second adapter*: `pi` remains the only harness with one, so no value of this field yet selects a different runtime, and a node whose call ceiling is served entirely by hosted Fusion requests no delegation session at all and so never reaches the decision. **Lane F2 is authorised to close both** — see "Harness registry" below |
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
| Workflow `settings.defaultHarness` | PARTIAL — inheritance resolves correctly and the inherited value now reaches the same shared dispatch decision as `harness`, with the same missing-second-adapter and hosted-Fusion-only limitations. Lane F2 is authorised to close both |
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
| `harness` | CLI selection, from the frozen `HarnessSchema` union. `pi` is today the only harness with a trusted delegation adapter; every other value reaches the shared adapter decision before budget reservation and fails closed there with an explicit discovery diagnostic. The full literal set, what each names, and what lane F2 is authorised to add are in "Harness registry" below. |
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

## Harness registry (specification ahead of implementation — authorising lane F2)

`HarnessSchema` (`server/src/workflows/schema.ts`) is inside the frozen surface: it is the type of
`settings.harness` and of workflow `settings.defaultHarness`. Every literal it carries must be described
here, and this section is written **before** the lane that adds the last three — the document leads
(`docs/adr/S11-contract-freeze-mechanism.md`). Rows marked *authorised, not yet in the schema* are a
specification awaiting implementation; that is the harmless direction, and this is the section that says so.

`server/src/workflows/supervisor/protocol.ts` carries a second copy of this list (`WORKFLOW_HARNESSES`)
because the supervised node-control envelope is validated on the wire without importing the TypeBox
schema. The two lists are one contract with two spellings and must move together. A literal in one and
not the other is the same defect class this freeze exists to prevent, one file over.

| Literal | Names | Adapter state |
| --- | --- | --- |
| `pi` | The vendored `pi-subagents` delegation runtime — the default, and the harness the node-control envelope targets (`parsed.harness !== "pi"` is a child-side rejection). | **BOUND.** The only harness with a trusted delegation adapter on either transport. |
| `claude-code` | The Claude Code CLI, resolved through the vendored engine's existing discovery (`server/vendor/pipeline-engine/packages/providers/src/claude/binary-resolver.ts` → `pathToClaudeCodeExecutable`, consumed at `providers/src/claude/provider.ts:513`). Executable candidates today: `claude`. | Pre-existing literal, no adapter. **Authorised for F2:** a relay adapter reached through the vendored resolver, never a second discovery implementation. |
| `codex` | The Codex CLI. Executable candidates: `codex`. | Pre-existing literal, no adapter; fails closed at the decision. |
| `opencode` | The OpenCode CLI. Executable candidates: `opencode`. | Pre-existing literal, no adapter; fails closed at the decision. |
| `copilot` | The GitHub Copilot CLI. Executable candidates: `github-copilot`, `copilot`. | Pre-existing literal, no adapter; fails closed at the decision. |
| `deepseek` | The DeepSeek CLI (matrix row 11). | *Authorised, not yet in the schema.* Lane F2 adds the literal to `HarnessSchema` and to `WORKFLOW_HARNESSES`, with its executable candidates registered alongside the existing four. |
| `grok-cli` | The Grok CLI (matrix row 12). | *Authorised, not yet in the schema.* As above. |
| `oh-my-pi` | The oh-my-pi harness (matrix row 13). | *Authorised, not yet in the schema.* As above. |

### What BOUND will mean for `harness` and `defaultHarness` once F2 lands

The bar is behavioural and is deliberately stricter than "the schema accepts the literal", because that
is exactly what shipped last time and reached no dispatch decision (#55/#68/#45):

1. **The dispatch decision is on the supervised transport.** `server/src/index.ts` boots the
   out-of-process supervisor on every real server start, so the in-process executor defaults are a test
   path, not production. Evidence for this field must come from the booted-server seam
   (`WorkflowSupervisorClient.nodeExecutorDependencies().getDelegationSession`), not from the in-process
   default.
2. **A node declaring `harness: "grok-cli"` selects the grok-cli adapter**, and a server test asserts on
   *which adapter the dispatch selected* — the resolved harness, its resolved executable, and the fact
   that the Pi factory was not called. A test that only proves validation accepts the literal does not
   satisfy this contract.
3. **A harness with no adapter on this machine still fails closed**, before admission and before budget
   reservation, with `WORKFLOW_HARNESS_NOT_INSTALLED` or `WORKFLOW_HARNESS_NOT_BOUND` and a message that
   names the user's next action without leaking a filesystem path.
4. **`claude-code` resolves through the vendored resolver.** The resolved path, and any user override of
   it, are exposed to the web layer through a server endpoint under `server/src/api/harness*.ts`; an
   unresolvable path yields a legible not-found state, never a silent fallback. The Settings surface that
   consumes it belongs to lane F8 (Team C) and is fed by that endpoint, not by a second resolver.
5. **`defaultHarness` inherits into the same decision**, node value winning, proven by the same class of
   test.
6. **Hosted-Fusion-only nodes are decided, not skipped.** A node whose entire call ceiling is served by
   hosted Fusion requests no delegation session, so today it never reaches the decision and `harness` is
   inert for it. F2 either reaches the decision for such a node or rejects a non-`pi` harness on it at
   validation. Silently ignoring the field is not an option this contract permits.

Until every one of those holds, the enforcement-status rows above stay `PARTIAL` and say why. The rows
are updated by the orchestrator when the lane merges with the evidence, not in advance of it.

### Hosted Fusion carries `nodeControl` over the wire (#54)

Recorded here because it changes what a frozen field means in production, and because this document
asserted the opposite until now. `SerializedHostedOpenRouterFusionRequest`
(`server/src/workflows/supervisor/protocol.ts`) carries a **required** `nodeControl: S4NodeExecutionBindings`
field, strictly validated on the wire (frozen enums, NodeSpec ranges, reserved sampling keys rejected);
the client refuses to send a hosted-Fusion request without it and the coordinator refuses to run one,
binding `providerRequest` onto the session through the same `createS4HostedFusionSession` the in-process
path uses. Because the bindings live inside the request, they are inside the journal's request digest.
That is why the `hyperparameters.*` rows above now read BOUND on both transports. Lane F2 owns
`protocol.ts` for Wave F and must not regress this while adding harness fields to the same structures;
Team A's F1 rows 4-5 depend on it holding.

## Known production gaps (2026-08-18, revised 2026-08-19)

Recorded here because this document previously asserted the opposite, and because each one is a case where a
user can set a value, nothing rejects it, and nothing acts on it. Full evidence with file:line citations:
`dfg-evidence-20260807-135127/s11/NODESPEC-BOUND-AUDIT-20260818.md`. These are product defects, not contract
changes; the frozen schema surface is unchanged by this correction.

**Revision, 2026-08-19.** Gaps 1 and 2 were written from an audit of `f5e5079`. Commit `c988bf0`
(*"carry the node-control bindings and the harness decision across the supervised transport (#54/#55)"*)
landed before the Wave-F base `b702a8b` and closed the transport half of both. The original text is kept
below rather than deleted — a gap that was real and is now closed is history a reader needs — with the
current state stated after it. Gap 3 is unchanged and still open.

1. **CLOSED at `c988bf0`. Hosted-Fusion sampling controls are silently dropped.** `server/src/index.ts` boots the out-of-process
   workflow supervisor on every real server start, and its dependency overrides replace the in-process wrapper
   that fails closed on a missing node-control binding. `WorkflowSupervisorHostedFusionRequest`
   (`server/src/workflows/supervisor/protocol.ts`) carries no `nodeControl` field, so `temperature`, `top_p` and
   `sampling` never cross the wire and the coordinator builds a session with no provider binder. A user who sets
   `temperature: 0.2` on a hosted-Fusion node gets `1`, with no error anywhere.
   *Current state:* the serialized hosted request carries a required, wire-validated `nodeControl` field and
   both ends refuse a request without it. See "Hosted Fusion carries `nodeControl` over the wire" above.

2. **PARTIALLY CLOSED at `c988bf0`. `harness` and workflow `defaultHarness` reach no dispatch decision.** The supervisor client's
   `getDelegationSession` drops the harness argument, and the coordinator binds the Pi factory directly, so
   `dispatchWorkflowHarness` — whose own comment says it exists "without silently falling back to Pi" — is
   unreachable from the booted server. The only surviving guard is the child extension's harness check, which
   fires after admission and budget reservation. Hosted-Fusion-only nodes never request a delegation session at
   all, so `harness` is inert for them on every transport.
   *Current state:* the decision itself now happens on both transports through the shared
   `assertWorkflowHarnessAdapterBound`, before admission and before budget reservation. Two parts remain open
   and are lane F2's to close: `pi` is still the only harness with an adapter, so no value selects a different
   runtime; and the hosted-Fusion-only case above is still undecided. See "Harness registry" for the bar.

3. **`server/src/workflows/node-spec-enforcement.ts` is unreachable.** Its workflow-settings function returns an
   empty list unconditionally; its other two emit only `S5` findings, and both validation loops skip `S5`; and
   by the time the executor's gate runs, `withDeliberationBindings` has stripped `settings.deliberation` and
   `materializeEffectiveHostedFusionNode` has deleted `settings.reasoningEffort`. The test intended to prove the
   gate filters its table to `unit === "S5"` rows, of which the file contains none, so it expands to zero cases.

