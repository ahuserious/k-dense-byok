# GOAL: close the supervisor accounting and lifecycle gaps, then slice the PR series

Successor to `RESCUE.md`. That brief is **complete** — its blocker is fixed, its six
durability invariants are verified, its suites are green, and its WIP is committed.
This goal covers the work the adversarial review surfaced *after* that gate.

- Workspace: `/Users/DanBot/Documents/ChatGPT/k-dense-byok-dynamic-fusion-graph`
- Branch: `dynamic-fusion-graph` (5 commits ahead of `upstream/main`)
- Baseline: `6ed7723` — server + web suites green, tree clean except `RESCUE.md`/`GOAL.md`

## Goal statement

Make the detached workflow supervisor's accounting provably lossless and its lifecycle
controls provably reachable, close the remaining credential replacement race, then
prepare the reviewable PR series against `ahuserious/k-dense-byok`.

"Provably" means a regression test that fails without the fix and passes with it. No
finding is closed by inspection alone.

## Non-goals

Unchanged from `RESCUE.md`, restated so nothing drifts:

- No automatic graph-repair rescue. Bounded policy retry and manual rescue only.
- No `dag-fusion-drive` marketplace publication. The package stays private.
- No Pipeline engine runtime resume. Legacy YAML stays a preview-only, archive-only import.
- No push to `K-Dense-AI`. Push only to authorized `ahuserious` remotes, and only when
  the user explicitly asks.
- No attempt to make provider work reattachable after supervisor or host death. That
  fail-closed quarantine boundary is deliberate and stays.
- Do not resurrect the paused Codex swarm. Disk + git + tests remain the only truth.

## Acceptance criteria

Each is independently testable. The evidence column names the artifact that proves it.

| # | Criterion | Evidence |
|---|---|---|
| AC1 | A failure in durable budget settlement or in the journal settlement receipt never terminalizes an admitted operation. The operation quarantines and retries idempotently instead. | Test injecting `settleBudget` failure and `journal.recordSettlement` failure on both the delegation and hosted-Fusion paths |
| AC2 | After the supervisor admits an operation, the backend never settles it locally. Settlement ownership transfers to the supervisor and its observed usage survives caller abort. | Test aborting after provider start with nonzero partial usage; asserts one settlement, no journal `CONFLICT` |
| AC3 | Lifecycle requests (snapshot, quiesce, shutdown, credential reload) succeed while provider-operation connections fully occupy the non-control connection quota. | Saturation test opening `maximumConnections` provider sockets, then issuing each lifecycle request |
| AC4 | A same-length concurrent `.env` write landing between the final snapshot validation and the replacement cannot be silently overwritten. | Deterministic test injecting a write in that exact window |
| AC5 | A failed integration test cannot orphan a backend or supervisor process. | Suite run leaves zero `kady-workflow-supervisor` and zero `src/index.ts` processes after an induced failure |
| AC6 | The boot test's readiness budget is strictly greater than the backend's own supervisor-startup budget, so a slow start cannot present as a hang. | Assertion or constant relating the two budgets |
| AC7 | Server typecheck clean; full server suite green twice consecutively; web typecheck, tests, and production build green. | Command transcripts retained under the run directory |
| AC8 | Docs claim exactly what the code does. No new overclaim; finding-3 correction stays accurate after the fix. | Diff review of `README.md`, `docs/dag-workflows.md`, `docs/limitations.md` |
| AC9 | The PR series is sliced, each slice builds and tests on its own, and the plan doc matches reality. | Updated `docs/dag-workflows-pr-plan.md` + per-slice verification |

## Work units

Ordered by dependency. Each unit states its own verification.

**U1 — Settlement-durable terminalization** (AC1) · `supervisor/coordinator.ts`
Separate execution failure from settlement-persistence failure. The catch block currently
covers both `session.host.delegate(...)` and `persistSettlement(...)`; a disk error or
lock timeout inside settlement therefore consumes the operation identity through
`markTerminal` while the observed usage was never durably recorded. The journal only
demands a completed settlement for a *completed* outcome, so failed/aborted/interrupted
outcomes pass straight through. Hosted Fusion repeats the pattern.
→ verify: injected `settleBudget` and `recordSettlement` failures produce a retained
quarantine, not a terminal record; existing terminal paths keep their current receipts.

**U2 — Settlement ownership transfer on abort** (AC2) · `kady-node-executor.ts`
On abort the client destroys its one-shot socket and, with `reconciliationStarted` still
false, reconciles locally as `started: false, tokens: 0`. If the supervisor already
admitted the call it may later settle real partial usage against the same identity, which
the journal rejects as a conflict. Track admission explicitly; after admission, signal
cancellation without settling locally and take the supervisor's terminal settlement.
→ verify: abort after provider start with nonzero usage yields exactly one settlement
carrying the observed usage, and no `CONFLICT`.

**U3 — Reserved lifecycle connection capacity** (AC3) · `supervisor/server.ts`
`accept()` destroys sockets past `DEFAULT_MAXIMUM_CONNECTIONS` (64) *before* classifying
the request, so lifecycle requests — which open their own connections — can be refused
exactly when intervention is needed. Message-id replay capacity already reserves control
capacity; connection capacity does not. Reserve a lifecycle quota, or multiplex lifecycle
operations over the existing control lease.
→ verify: saturation test above; then revisit the `docs/dag-workflows.md` caveat added in
`6ed7723` so it describes the fixed behavior.

**U4 — Credential replacement race** (AC4) · `api/credentials.ts`
`targetMatchesSnapshot(snapshot)` and `renameSync` are separate operations. The earlier
fix closed the bounded-*read* race; this check-to-replace window is still open, and POSIX
has no conditional rename. Needs a cross-process mutation protocol (lockfile with owner
identity and staleness rules), not a tighter check.
→ verify: deterministic injection between validation and replacement; concurrent writer's
data survives or the update fails closed — never a silent overwrite.

**U5 — Test-harness process hygiene** (AC5, AC6) · `test/backend-shutdown-ipc.test.ts`
Cleanup kills the `tsx` CLI wrapper, not the backend grandchild it execs, so a failed run
orphans a backend and its supervisor; accumulated orphans then slow and destabilize later
runs. `start.mjs` already solves this with `waitForOwnedTree`. Also decouple the test's
20 s readiness budget from the client's 20 s `DEFAULT_STARTUP_TIMEOUT_MS`.
→ verify: induce a failure, assert no surviving descendants.

**U6 — PR series** (AC9) · `docs/dag-workflows-pr-plan.md`
Slice per `docs/dag-workflows-handoff.md`: (1) supervisor runtime foundation, (2)
supervisor process + coordinator, (3) backend client + wiring — carries U1/U2, (4) docs.
U3 and U4 are independent follow-ups.
→ verify: each slice typechecks and tests standalone.

## Adversarial gate

Every unit passes through a Codex adversarial review before it counts as done.

- Runtime: `~/.claude/skills/relentless-inception/scripts/adversarial_review.sh`
- Seat: `sol` → `gpt-5.6-sol`, effort `xhigh`, seat timeout 1800 s
- Backend: `codex` (rung 2). Rung 1 openrouter-fusion is `bad-key` and must not be
  silently used; rung 3 claude-panel is the only permitted descent, and any descent is
  recorded in the verdict `_meta`.
- Gate type: `phase` per unit, `summarize` before the PR series.
- A `fail` verdict feeds its `blocking_issues` back as new work. No unit ships on a
  `fail`, and no verdict is discarded because it is inconvenient.

Hooks backing this (see "Hook state" below): `UserPromptSubmit` → `relentless_relay.sh`,
`Stop` → `stall_watchdog.sh`.

## Evidence bar

Nothing is reported as done without:

1. A regression that demonstrably fails on the pre-fix tree and passes after.
2. Server typecheck + full server suite green **twice consecutively** on a machine with
   zero orphaned supervisor or backend processes.
3. Web typecheck + tests + production build green.
4. A Codex `pass` verdict at `xhigh` for the unit.
5. Claims in docs re-read against the code after the change, not before.

Suite runs on a loaded machine are not evidence — clear orphans first
(list pids with `ps -Ao pid=,lstart=,command= | grep kady-workflow-supervisor` and kill only the
attributable ones by exact pid; pattern kills are forbidden — they can kill a live preview's supervisor).

## Termination and budget

- Stop and report if the same unit fails its adversarial gate twice with the same
  blocking issue. That is a design problem, not a retry problem.
- Stop if a fix requires changing the fail-closed ownership boundary. Escalate instead.
- Stop before any push, tag, or publish.
- Do not expand into new subsystems. A finding outside U1–U6 gets recorded in the handoff
  note, not fixed opportunistically.

## Execution status

Durable across compaction. Update in place as units land.

| Unit | State | Notes |
|---|---|---|
| U1 settlement-durable terminalization | **implemented; full server suite green (1017 passed)**; second gate in flight | write-ahead `prepareSettlement` + `recoverPendingSettlements`; both gate-1 findings addressed and re-verified |
| U2 settlement ownership on abort | **implemented + regressions; suite green** — Option B (cancel op) | gate not yet run |
| U3 reserved lifecycle connection capacity | not started | |
| U4 credential replacement race | not started | |
| U5 test-harness process hygiene | not started | |
| U6 PR series | not started | |

### U1 gate verdict: needs-attention (gpt-5.6-sol @ xhigh)

The `settlementIsDurable` flag does block the unsafe terminalization, but the gate
found two things and **both were independently confirmed against the tree**:

1. **[high] Quarantine without a retry path is an availability regression.**
   Both paths now route persistence failures to `retainQuarantine`, but nothing
   retries. The retained `ActiveAttempt` does not carry the settlement or budget
   descriptor, the journal quarantine stores only a reason code, and
   `assertNoUncertainOwnership` rejects future admission before `persistSettlement`
   could run again. Restart preserves the quarantine. So a *transient* disk or
   lock failure discards the usage payload and permanently blocks supervised work
   for the project — including shutdown. Trading a silent accounting loss for a
   permanent project outage is not an improvement.
   → Real fix: a durable settlement-pending payload plus a recovery path that
   retries `settleBudget` and `recordSettlement` **without redispatching provider
   work**, terminalizing only once both succeed. Needs journal schema work and
   restart tests.

2. **[medium] The regressions passed for the wrong reason — verified.**
   The tests used `settlement(current)`, whose default reason is
   `terminal-response` → `responseStatus: "completed"`. The journal *already*
   refuses `markTerminal` with a `completed` outcome and no completed settlement
   receipt, so the pre-fix code also quarantined these operations. Re-running the
   stashed pre-fix tree confirms it: the record was already `quarantined`, and the
   only diff was `DELEGATION_TERMINAL_UNCONFIRMED` → `DELEGATION_SETTLEMENT_UNPERSISTED`.
   The tests never touched the outcomes the journal actually lets through.
   → Real fix: use `aborted`/`failed`/`interrupted` settlements with nonzero
   observed usage, on both paths, for both `settleBudget` and `recordSettlement`
   failures. Those must reach `state: "terminal"` pre-fix.

### U1 redesign (user chose: do the settlement-pending design)

Implemented as a **write-ahead settlement**:

- `journal.prepareSettlement(id, {settlementId, status, usageComplete, budget})`
  journals the intent *before* it is applied. The `budget` payload is the
  compact `SettleWorkflowBudgetInput` projection — status, reason, and six usage
  numbers. No prompts, results, credentials, or error text, so the journal's
  content-free contract holds.
- `recordSettlement` now refuses a receipt that disagrees with its prepared
  intent, and `validateStored` rejects a record whose receipt and pending
  settlement disagree, or whose pending settlement has no running operation.
- `recoverStartup()` reports `settlementPending`; the new
  `coordinator.recoverPendingSettlements()` reapplies each exactly once, keyed
  by the record's own `projectId` + `reservationId`. **No provider work is
  redispatched, and the ownership quarantine still stands** — this only makes
  the accounting whole. A failed replay stays journalled for the next startup.
- `settleBudget` dependency is now `(projectId, reservationId, input)` so the
  live path and the replay path are the same call. The default implementation
  re-narrows the journalled status against the budget enum and fails closed
  rather than casting.

Both gate findings re-verified against the tree:

- *Finding 1 (dead-end quarantine)*: the payload is durable and replayable; the
  restart test drives a fresh coordinator over the same journal directory,
  asserts one `settleBudget` call with the exact usage, and asserts a second
  recovery pass is a no-op.
- *Finding 2 (tests passing for the wrong reason)*: the regressions now use
  `caller-aborted` settlements carrying real usage. Re-running the stashed
  pre-fix coordinator gives **`OPERATION_FAILED`** — it reached `markTerminal`
  and dropped the usage. The earlier completed-settlement tests gave
  `SUPERVISOR_BUSY`, which is why they proved nothing.

### U2 as built (Option B, chosen by the user)

- **protocol.ts** — new `op: "cancel"` request carrying only `targetMessageId`
  (epoch-scoped, so no project id is needed), and a `{targetMessageId, cancelled}`
  result. Strict key/shape validation on both, matching the other ops.
- **server.ts** — the cancel route reuses the coordinator's existing
  `cancelMessage(epoch, messageId)`, the *same* cancellation the socket-close
  path already performs. The only difference is that the operation's own
  transport survives to deliver its terminal settlement. An initial version of
  this added a near-duplicate `cancelAttempt`; that was removed once the
  existing method turned out to do exactly the job.
- **client.ts** — `operationRequest()` wraps `delegate`/`hosted-fusion`. On
  abort it no longer destroys the socket: it sends a cancel over its own
  short-lived connection, keeps reading the operation socket, and arms a
  `CANCEL_SETTLEMENT_TIMEOUT_MS` (30 s) fallback that still performs the old
  hard drop if the supervisor stays silent. Abort before connect keeps the old
  behavior, since nothing can have been admitted yet.

Why this fixes the double settlement: the aborted call now returns a *response*
carrying the supervisor's settlement, so `reconcileExactSettlement` runs, which
sets `reconciliationStarted` in `kady-node-executor.ts`. The local
`started:false, tokens:0` reconciliation in its catch block is therefore never
reached after admission — no competing settlement, no journal `CONFLICT`. No
change to `kady-node-executor.ts` was needed.

**Note for U3:** the cancel opens a *new* connection, so under connection
saturation a cancel can be refused — one more reason lifecycle capacity needs
reserving.

Regressions replace the old `destroys only an aborted operation socket` test,
which asserted precisely the behavior this unit changes:

- *cancels an aborted operation out of band and still takes its settlement* —
  the fake supervisor records the cancel's `targetMessageId`, then answers the
  operation with a `caller-aborted` settlement. The caller now rejects with the
  supervisor's own `WorkflowSupervisorRemoteError`, not a bare `ABORTED`, and
  `reconcileUsage` is called exactly once with the observed usage.
- *falls back to dropping the operation socket when a cancelled supervisor stays
  silent* — with `cancelSettlementTimeoutMs: 250`, the old hard-drop `ABORTED`
  path still runs and the attach lease survives it.

`cancelSettlementTimeoutMs` is injectable through `ensureWorkflowSupervisor`
like every other timeout, defaulting to 30 s.

### Suite evidence at this checkpoint

Full server suite green after U1 + U2: **99 files passed / 1 skipped, 1018 tests
passed / 5 skipped**, typecheck clean.

One caveat worth keeping: running `test/workflow-supervisor-client.test.ts`
*alone* on a loaded machine failed `leaves no real detached child orphaned when
fresh readiness authentication fails` with a startup timeout, and passed in the
full suite immediately after clearing orphaned processes. That is the U5 problem
(20 s client startup budget under load), not a U1/U2 regression.

### U2 design decision (resolved — Option B)

The protocol has **no cancel op** — ops are `ping`, `attach`, `delegate`,
`hosted-fusion`, `reload-credentials`, `quiesce-project`, `snapshot`, `shutdown`.
Cancellation is signalled by destroying the one-shot socket, which is exactly why
the supervisor's terminal settlement can never reach the aborting backend. Two
defensible fixes, with different cost semantics:

**Option A — no protocol change.** Surface from `client.delegate` whether the
request frame was actually written. The executor keeps its local zero-settlement
only when the frame was *not* dispatched (connect/write failed, so the supervisor
never saw it). Once dispatched, it settles nothing; the reservation stays and the
existing stale-reservation reconciler charges the fail-closed maximum. Removes
the competing settlement and the journal `CONFLICT`. Cost: an abort after
dispatch is charged at the reserved maximum instead of released.

**Option B — add a cancel op.** Keep the transport alive on abort, send an
explicit cancel frame, and wait bounded for the supervisor's terminal settlement
so the real observed usage is charged. More accurate accounting, but it changes
the wire protocol, its version, and the "socket teardown means cancel" invariant
that the dropped-backend path depends on.

Option A is the smaller, safer change and matches the documented fail-closed
doctrine. Option B is more accurate but touches the ownership boundary this goal
otherwise treats as fixed.

## Hook state (verified at goal time)

| Hook | State |
|---|---|
| `UserPromptSubmit` → `relentless_relay.sh` | installed |
| `Stop` → `stall_watchdog.sh` | installed |
| `statusLine` | occupied by orca's statusline; `install_hooks.sh` refuses to clobber it, and relentless-inception's indicator is cosmetic — left as is |
| codex CLI | `codex-cli 0.144.5`, logged in |
| rung 1 openrouter-fusion | `bad-key` — dead, gates descend to codex |
| rung 2 seat `sol` @ `xhigh` | probed as part of this goal; see `~/.claude/relentless-inception/gate_capability.json` |

## Requirement traceability (added 2026-08-15)

This file does not state the S11 exit criterion. The verbatim requirement, the drift that occurred, the
honest status, and the owner's 2026-08-15 ruling are recorded in
[`docs/adr/S11-requirement-traceability.md`](docs/adr/S11-requirement-traceability.md). The S10 library-scope
ruling is in [`docs/adr/S10-library-scope.md`](docs/adr/S10-library-scope.md).
