# DAG Workflows architecture

> **Status: integration branch.** `dynamic-fusion-graph` contains the graph,
> storage, runner, API, bounded Pi leaf runtime, visual surfaces, helper-agent
> sessions, Fusion executors, and Lean verifier described below. The status
> matrix distinguishes integrated branch behavior from reviewed adapters and
> release work that is intentionally not claimed complete.

DAG Workflows adds visual, durable multi-agent workflows to Kady without
turning a third-party workflow engine, UI, or model router into Kady's source of
truth. The design keeps project isolation, visible model resolution, bounded
execution, cost accounting, and recoverable run history as first-class
requirements.

## Implementation status

| Surface | Branch status |
|---|---|
| Typed graph, validation, revisioned definitions | Implemented and exercised by backend/frontend contract tests. |
| Durable run events, leases, cancellation, restart recovery, resume | Implemented for graph/run state. Cancellation intent and owner fencing are cross-process; interrupted work resumes only through an explicit control. This does **not** recover an in-memory pi-subagents child quarantine after abnormal backend death; that P0 boundary is described below. |
| Project/run token, cost, and model-call ceilings | Implemented with fail-closed durable reservations. Modal and DAG admission share the project-cap lock. |
| Pi leaf execution | Integrated through a dedicated workflow-only Pi session and owned `pi-subagents` Delegation V2 transport. Graceful lifecycle is tested; abnormal-restart child ownership recovery remains the P0 production/release gate described below. |
| Research, Council, Kady panel Fusion, best-of-N, evidence gate, Lean | Integrated as typed, bounded node behaviors. Leaf workspaces are deliberately read-only. Lean is host-owned, disabled by default, and requires the explicit unsandboxed server opt-in described below. |
| Hosted OpenRouter Fusion | Integrated as one exact compound request with separate requested/resolved receipts and no implicit judge fallback. |
| Dynamic Workflows package kernel | Integrated ordinary Agent nodes use the pinned adapter and trusted single-agent compiler. Compound nodes remain on Kady's typed multi-slot executor so partial usage and per-slot requested/resolved receipts stay visible; the saved graph never becomes package-owned JavaScript. |
| Builder, Console, Raindrop | Implemented as persistent project surfaces. Console controls the durable runner; Raindrop autosaves native DAG-run and ordinary Pi chat-session references and uses a separate no-tools Pi log analyst over bounded server projections. |
| Legacy DAG-Pipelines state | A preview-only clean-room translator handles the safe prompt-DAG subset. Interactive/loop/join semantics block for manual redesign; legacy runs are archive-only and never presented as resumable native runs. |
| Automatic rescue | The runner performs bounded policy-controlled retry and exposes manual rescue as a new auditable run. The separate helper can propose a diagnosis, but automatic diagnosis or graph repair is not implemented and a saved graph is never silently rewritten. |
| Pre/post-compaction checks | Owned child sessions install a mandatory structural lifecycle audit. It records bounded fingerprints/counts rather than transcript or summary text; the trusted Kady reader emits durable checks and routes failures through bounded rescue policy. It does not establish that a summary is semantically complete or correct. |
| `dag-fusion-drive` package and marketplace release | A narrow exported nonvisual Agent/panel-judge graph API and trusted-host adapter are implemented. The package remains private; abnormal-restart child ownership, Kady lowering/parity, provenance, artifact review, namespace ownership, and explicit publication approval remain release gates. |

## Decisions

### Kady owns the canonical graph

The canonical artifact is a versioned, provider-neutral
`WorkflowGraphDocument` owned and validated by Kady. It contains stable node and
edge ids, entry nodes, typed node configuration, explicit limits, model
selectors, evidence policies, and rescue policies. The visual builder edits this
document; runtime-specific JavaScript is a generated artifact, never the saved
source of truth.

The graph must be acyclic. Bounded iteration belongs inside typed nodes such as
Research Until Goal, Gate, and Rescue rather than appearing as an unbounded
cycle. Validation rejects duplicate or dangling ids, unreachable nodes,
unsupported node configuration, cycles, and missing limits before a run starts.
An ordinary nonterminal node either uses unconditional fan-out or declares both
success and failure routes; the two styles cannot be mixed. Multiple edges for
the same outcome are explicit fan-out. A node with multiple activated parents is
an **any-ready merge**: it runs once on the first activated inbound edge and later
arrivals attach evidence without executing it again. A future all-parent join
would require a new versioned field rather than changing this behavior silently.

Definitions and execution evidence stay inside the selected project:

```text
sandbox/.kady/workflows/
├── definitions/<workflowId>.json
└── runs/<runId>/
    ├── run.json
    ├── events.jsonl
    ├── journal.jsonl
    └── summary.json
```

Writes use the same atomic, bounded, project-scoped conventions as Kady's other
durable state. A run records the graph revision and hash, compiler version, and
runtime adapter version so a resumed result can be tied to the definition that
produced it. Declared write paths use canonical forward-slash project-relative
syntax, are compared conservatively without case distinctions, and are resolved
again against the real project root at the mutation boundary.

### Dynamic Workflows is a kernel, not the owner

Kady compiles a validated ordinary Agent node to the public `runWorkflow()` API from
[`@quintinshaw/pi-dynamic-workflows`](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows).
The branch's adapter uses only that low-level execution kernel. Its standalone
extension, TUI, workflow manager, saved-workflow store, home-directory
persistence, and log persistence are not installed into the Kady server.

Branch execution and adapter tests supply the project sandbox as `cwd`, a Kady run id, an explicit
agent registry snapshot, Kady's abort signal and limits, and a Kady-owned leaf
runner. Raw user-authored JavaScript is not accepted; trusted scripts are
generated from validated nodes. Research, Council, Fusion, Best-of-N, evidence,
and Lean remain direct typed Kady executions because each may own several model
slots or trusted local effects. Moving those compound behaviors onto the kernel
would first require parity for partial usage, durable callbacks, cancellation,
budget reconciliation, receipts, and provenance. The Node VM used by the kernel
is a determinism aid, not a security boundary.

The injected leaf runner's promise is also the cancellation settlement boundary.
An abort or deadline signals the runner and kernel, but Kady keeps the full budget
reservation open until their trusted promises settle; a late ordinary result is
never accepted as success, and a cleanup or reconciliation rejection remains
visible. There is intentionally no adapter-side grace timer. The Kady-owned
runner and its transport must therefore provide bounded process cancellation and
must not settle until provider work has stopped and usage reconciliation is
terminal. A signal by itself is not evidence that those conditions hold.

### `pi-subagents` owns leaf transport after a focused V2 upgrade

Leaf work is performed through a focused, separately reviewed upgrade to the
V2 `pi-subagents` execution path. Kady remains responsible for admission,
project scope, model resolution, budgets, durable events, receipts, and
terminal status. A leaf cannot recursively create unaccounted work: nested
delegation is disabled unless it participates in the same run-wide limits and
receipts. End-to-end integration with Kady's existing provenance surface is
still incomplete and remains a package-release blocker.

The branch has focused compatibility and regression tests for the owned V2
transport, existing session bridges, budget reconciliation, and cancellation.
Those gates must be rerun in the dependent PR. Internal `pi-subagents` source
paths are not an integration contract; the integration uses public entries and
the narrow owned-delegation API.

Cancellation is two-phase at that exported boundary. Kady emits the exact V2
ownership tuple, then retains the leaf and its reservation until the matching
terminal response proves pi-subagents' child executor has settled. Wrong-owner
and stale events are ignored. Missing or malformed acknowledgements fail with a
non-abort error and no terminal usage, leaving maximum-commitment accounting in
force. That caller-visible failure does not detach the attempt: its exact tuple
and dedicated Pi session remain quarantined, all new delegation is rejected,
and graceful session teardown and project deletion remain blocked. Only a later
exact, fully validated terminal response releases quarantine; malformed exact
responses remain rejected. The package host waits `cancellationAckTimeoutMs`
(5,000 ms by default, configurable from 1-60,000 ms); a local abort signal plus
reconciliation alone is never reported as provider stop.

The quarantine is process-local because the current public pi-subagents event
API has no durable cross-process reattachment. Force-killing or restarting a
quarantined backend therefore cannot establish child quiescence. The
fail-closed maximum charge remains accounting protection, not proof of stop;
durable reattachment/recovery is an unresolved **P0 production DAG-leaf and
package-release blocker**.
The durable run/controller recovery described in the status table restores
workflow state and fail-closed accounting only; it must not be read as recovery
or proof of quiescence for an in-flight quarantined Pi child.

### Node semantics are typed and bounded

| Node | Contract |
|---|---|
| **Research Until Goal** | Repeats bounded research rounds until every explicit completion criterion passes. Exhaustion fails visibly with `WORKFLOW_RESEARCH_GOAL_NOT_MET`; the normal bounded rescue policy may start a fresh attempt, but the runner never relabels partial progress as success. |
| **Council** | Runs named perspectives, preserves dissent, and produces a reasoned synthesis. This is the user-facing replacement for “debate,” not a simple majority vote. |
| **Fusion** | Runs a typed compound multi-model operation with member roles, synthesis, evidence, and stopping rules. |
| **Best of N** | Creates independent candidate paths and selects with a recorded rubric; `N` defaults to **2** and remains explicitly bounded. |
| **Gate** | Checks evidence, hallucination risk, schema, or another declared invariant and emits a pass/fail decision with supporting artifacts. |
| **Rescue policy** | The runner records the prior failure and retries only errors explicitly marked retryable, within configured attempt, time, token, model-call, and spend limits. Policy triggers never override a nonretryable error. This is a workflow/node policy, not a standalone graph node. The separate rescue helper may diagnose and propose a new manual rescue run but cannot mutate the saved graph or control a run. Automatic diagnosis and graph repair are deferred. |
| **Compaction check** | An owned child extension validates bounded pre/post lifecycle metadata, correlates attempt identity, and persists only fingerprints/counts. Kady independently reads the sidecar, records durable checks, and fails visibly on missing, malformed, mismatched, or incomplete audits. This is structural integrity evidence, not a judgment that the compacted summary preserved every important fact. |
| **Lean Verifier** | In solve mode, a model returns only a proof body for an exact graph-authored proposition; Kady owns the deterministic theorem declaration and verifies that statement. Verify mode accepts reviewed complete source. Proof and diagnostic receipts are host-written artifacts. |

Rescue is enabled by default for newly created workflows and visible in the UI,
with workflow-wide and per-node overrides. “Enabled” never means infinite
self-healing: exhaustion is a visible failed or blocked terminal state, and the
Console reports it back to the DAG runner. The optional Lean integration is
exposed through the `byom-dag-fusion` skill/template; absence of Lean is reported
according to the gate policy rather than silently treated as a proof.
`limits.maxRetries` is the hard count of automatic retries beyond attempt 1;
the effective node override (bounded by the workflow limit) and rescue
`maxAttempts` are additional ceilings, so the lowest applicable value wins.

An enabled common evidence policy is enforced after every non-gate node, not
only at explicit Gate nodes. It adds one declared and budgeted
`evidence-policy-evaluator` call; evaluator selection is node policy, then graph
policy, then the graph default model. The evaluator may cite only bounded source
ids derived from evidence-labelled fields in the node output and inbound
records. Kady independently checks the configured source-count threshold and
real normalized artifact receipts, then writes a durable `evidence_checked`
event. Unsupported results fail, enter bounded rescue, or follow explicit
`evidence-supported`/`evidence-unsupported` routes exactly as configured. This
is a model-assisted support check, not proof that a claim is true; invented
source ids and model-asserted artifacts are rejected.

An explicit Evidence Gate receives a catalog derived only from activated inbound
node records. Any authored `artifactIds` are mandatory evidence: the runner binds
each id to its declared writer and exact path, reopens and hashes the current
regular file under the project root, and rejects stale, replaced, symlinked,
wrong-writer, wrong-path, or model-invented receipts. The runner persists the
complete `gate_evaluated` decision before it may route, fail, or enter rescue;
event replay rejects a terminal or route that lacks the matching decision.

#### Lean execution and trust boundary

Lean execution is **disabled by default**. A server owner may set
`KADY_ALLOW_UNSANDBOXED_LEAN=1` only after reviewing the boundary. That opt-in
is not a sandbox: the Lean/Mathlib process runs as Kady's OS user and therefore
retains that account's filesystem and network authority. Kady strips provider
keys, auth tokens, `NODE_OPTIONS`, and other ambient variables from the child
environment, but environment scrubbing does not remove OS-user authority. The
unsandboxed policy is unavailable on native Windows until Kady can guarantee
descendant-process termination; WSL or a separately sandboxed deployment is the
current path there.

Preflight happens before a solve-model call. It requires a user-provided Lake
project at `sandbox/lean-project`, a detached Mathlib commit matching the full
Lake-manifest revision, an empty tracked/untracked Git status, and a stable Git
tree identity. Kady checks the revision/tree again after verification and fails
if either changed. This does not make the whole Lake project immutable: the
pre/post Git identity and cleanliness checks apply specifically to the Mathlib
checkout, while the lakefile, toolchain pin, and other same-user project files
remain inside the documented unsandboxed trust boundary. Kady never installs or
updates Lean or Mathlib.

The read-only leaf never receives a writable path. A trusted host process writes
exactly these visible, run-scoped files instead:

```text
sandbox/workflow_artifacts/dag-workflows/lean/<runId>/<executionId>/
├── Proof.lean
└── verification.log
```

The runner accepts only those exact derived paths as the Lean host exception,
requires both files before accepting a `verified` result, rehashes them under
its normal no-symlink artifact rules, and includes the receipts in
`evidence_checked` even when the proof is rejected and the node enters
failure/rescue. A model-assisted evidence evaluator is additive: it can never
turn the trusted verifier's `failed` or `unavailable` result into support.
A successful verification also requires one well-formed axiom-audit receipt;
the successful host receipt records the exact audited subset of the allowed
`propext`, `Classical.choice`, and `Quot.sound` set instead of claiming the
proof used no assumptions.

If common model-assisted evidence checking is disabled, a verifier failure that
occurs after source/log creation still writes its normalized `evidence_checked`
receipt before `node_failed`. An unavailable preflight that happens before any
source is created fails directly and truthfully has no artifact receipt.

### Fusion modes remain distinct

The graph exposes two different Fusion executors and never presents them as
equivalent:

- **`openrouter-router`** uses OpenRouter's hosted Fusion router. Its hosted
  panel behavior, tool restrictions, estimated pricing, and source visibility
  limitations remain explicit. The router is the exact `openrouter/fusion`
  alias, panels contain two to eight exact fixed OpenRouter models, and the
  router, panel, and judge share the one reasoning level the hosted adapter can
  express. Per-member fallback or auth-profile semantics belong in `kady-panel`.
  On cancellation or failure, the adapter races the provider prompt against the
  caller/deadline, then allows 5 seconds for prompt settlement, abort
  acknowledgement, and an idle temporary session. If those three conditions are
  not proven, the call fails visibly and the missing-usage settlement charges
  the full reserved envelope. Kady retains the exact session and Fusion config
  in a process-local quarantine; new hosted Fusion admission, project deletion,
  and graceful shutdown are blocked until a genuine late acknowledgement lets
  Kady clear and dispose that owner. This is bounded caller settlement, not
  proof of stop after abnormal backend death. The cross-platform launcher sends
  the backend an owned IPC shutdown request and waits without an automatic kill
  deadline. A second explicit Ctrl+C is the visible unsafe force-exit path.
- **`kady-panel`** runs each selected OpenRouter, supported OAuth, Ollama/local,
  or configured OpenAI-compatible model as an owned Kady leaf, then performs
  Council/judging/synthesis as declared by the node. This is the path that
  enables private local-model fusion. OpenAI-compatible endpoints are currently
  classified as local/$0 and must not point at a paid gateway; route paid hosted
  models through the configured OpenRouter base URL instead.

Each member selector records the requested provider, model, reasoning level,
auth mode, and fallback policy. Each model-resolution receipt separately records
the resolved provider/model, resolved reasoning, auth owner (never credential
contents), runtime, and fallback decision and reason. Usage and charged cost are
stored in durable workflow-budget settlements, while errors are durable workflow
events; billing classification is not currently a receipt field. Unsupported
exact requests fail visibly, and a fallback is legal only when the graph
explicitly allows it.

### Helper agents have narrow boundaries

- The **main Kady agent** owns ordinary chat and remains the agent selected by
  the `Pi (Kady)` pipeline setting.
- The **DAG Builder agent** is a separate, project-scoped agent that may propose,
  explain, and validate one exact saved workflow revision. The server reconstructs
  a bounded projection from its typed revision binding at every turn. The helper
  has no tools, filesystem access, MCP startup, project extensions, skills, or
  custom-tool initialization; it does not own execution state or bypass graph
  validation.
- The **Workflow Rescue helper** receives one server-reconstructed bounded
  projection of an exact blocked, interrupted, or failed run and proposes a
  repair. Its session is scoped to that run, has no tools or project-controlled
  initialization, and cannot apply, retry, or control anything. Manual rescue
  creates a new auditable run from the saved definition and failure context; the
  helper's proposal is not applied automatically.
- The **Raindrop log analyst** is a separate Pi coding agent with no active tools
  or filesystem access. A typed run/session id is validated in the active project,
  then the server supplies one size-bounded, secret-redacted log projection with
  binary content omitted. The analyst cannot follow log-authored path instructions,
  mutate a workflow, or control a run.

Every helper session has an authoritative profile/source binding in server-owned
project metadata outside the sandbox API. A mutable Pi display name never selects
privilege. Cold reopen, ordinary-session history filtering, main-model admission,
and every helper turn validate that binding; missing, malformed, or mismatched
identity fails closed. The browser sends a typed source when selecting a helper
and only the user's question when running it. Kady reconstructs the selected
projection server-side at run time, so client-supplied text cannot substitute a
different graph, run, session, or filesystem path.
This is an application boundary against helper content and sandbox APIs, not an
OS sandbox against another same-user process; the local-shell limitation still
applies.

All helpers have distinct persistent session/run identities and enforced tool
allowlists, and their model usage enters ordinary session accounting even when
they share Kady's provider/auth runtime. Dedicated helper-specific token, turn,
and time ceilings are not yet exposed.

### UI surfaces are projections of durable state

The **DAG Workflows** experience replaces the old Archon/software-development
framing for these features. It personalizes Kady's Machine Learning & AI and
Data & Analysis workflows while keeping the underlying graph general.

- **DAG Builder** renders and edits the typed graph, exposes node-level models,
  gates, limits, rescue, and the dedicated Builder agent.
- **Runner** renders live node and edge state from durable events rather than
  inferring completion from a browser tab or process exit.
- **Console** shows the runner's authoritative sequenced logs, receipts,
  warnings, degradation, and failed-node events. It does not maintain or report
  a second copy of run state; runner and rescue decisions consume the same
  durable event stream.
- **Raindrop** provides slim per-run/session tabs and automatically discovers and
  saves native run references plus open, resumed, and stored ordinary-chat
  session references. The user selects which bounded projection the analyst
  receives. Selection sends only the typed id to a project-scoped context
  endpoint; arbitrary paths and helper-session logs are rejected before the
  separate no-tools analyst receives evidence. Analyst history is scoped to the
  selected typed source so one untrusted log cannot persist instructions into
  another log's analysis.
- **Settings** labels the pipeline runtime `Pi (Kady)`, routes it to the main
  Kady agent, and explains runtime ownership. DAG Builder configures each node's
  hosted OpenRouter or Kady-panel Fusion; **Settings -> Fusion** manages the
  separate ordinary-chat OpenRouter presets.

### Fusion behavior is reimplemented clean-room

The `claude-fusion-drive` source carries an additional rider that creates an
upstream redistribution and acceptance risk. Kady will not copy its source,
comments, prompts, tests, fixtures, or assets. Fusion behavior is reimplemented
from independently written requirements, public interfaces, and observable
behavior, with new names, schemas, prompts, tests, and fixtures. Permissively
licensed dependencies retain their required attribution. This decision is an
engineering boundary, not a conclusion about the rider's legal validity.

## Review and delivery plan

The branch should be proposed as a stack of independently reviewable pull
requests rather than one integration diff. The practical split, required tests,
and explicit deferrals are maintained in the
[DAG Workflows stacked-PR plan](./dag-workflows-pr-plan.md).

The persistence and UI compatibility boundary with the former branch is
documented separately in
[Legacy DAG-Pipelines migration](./dag-workflows-legacy-migration.md).

Marketplace publication is outside that implementation stack.
`dag-fusion-drive` remains private until the richer Kady graph has an explicit
reviewed lowering/parity boundary, provenance is complete, the packed artifact
and namespace are reviewed, and the repository owner gives new explicit
publication approval.

## Open product and package decisions

These choices still require implementation evidence or upstream maintainer
input:

- which richer Kady graphs should lower losslessly into the narrower exported
  `dag-fusion-drive` v1 runtime, and how rejected graphs report that boundary;
- whether compound executors should ever move onto the Dynamic Workflows kernel
  after partial-usage, cancellation, budgeting, receipt, and provenance parity
  is demonstrated;
- whether raw workflow scripts will ever be supported in a separate sandbox;
- marketplace namespace ownership and release account;
- retention duration for archive-only legacy DAG-Pipelines files; they are not
  eligible for native resume or control.
