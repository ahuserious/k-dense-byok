# DAG Workflows handoff — supervisor hardening wave

Written after the rescue pass that unblocked the detached workflow supervisor.
Branch: `dynamic-fusion-graph`, 4 commits ahead of `upstream/main`.

## What the rescue pass changed

`318e776 feat(workflows): own Pi and hosted Fusion leaves in a detached supervisor`
commits the previously uncommitted supervisor wave plus two blocker fixes.

**Blocker 1 — supervisor socket exceeded `sun_path`.** The POSIX control socket
was always placed inside the supervisor state directory, which lives under
Kady's Pi agent directory. Any agent directory deeper than roughly 88 bytes
pushed the socket past `sockaddr_un.sun_path` (104 bytes on macOS, 108 on
Linux), so `listen` failed with `EINVAL`, the detached child died before
publishing readiness, and the backend reported `STARTUP_FAILED`. A socket that
cannot fit now moves to a short private `0700` directory under the OS temporary
root named for its exact state directory; an unfittable path fails closed
naming `KADY_WORKFLOW_SUPERVISOR_SOCKET`.

**Blocker 2 — failed bootstrap hung instead of exiting.** The production
entrypoint set `process.exitCode = 1` but kept its signal handlers and the
launcher IPC channel, both of which reference libuv. The process sat forever on
an empty event loop, so the launcher and `backend-shutdown-ipc.test.ts` both
read a startup *failure* as a *hang* — which is why the earlier session could
not isolate the cause. Those handles are now released once nothing is owned.

Regressions land in `backend-shutdown-ipc.test.ts` (boot path plus
exit-on-failed-init), `workflow-supervisor-entry.test.ts` (binds from a state
directory deeper than `sun_path`), and `workflow-supervisor-runtime.test.ts`
(budget, per-state-directory fallback, private-mode enforcement).

## Verification evidence

| Gate | Result |
|---|---|
| `server`: `tsc --noEmit` | clean |
| `server`: `vitest run`, twice consecutively | 99 passed / 1 skipped files; 1009 passed / 5 skipped tests |
| `web`: `tsc --noEmit` | clean |
| `web`: `vitest run` | 88 files, 585 tests passed |
| `web`: `next build` | compiled successfully |

The failing case before the fix was exactly one test:
`backend-shutdown-ipc.test.ts > boots through the launcher's direct tsx entry`,
timing out at 20 s.

## Open findings (not fixed — decide before release)

A Codex adversarial review of the commit raised four items. All four were
re-read against the code and are accurate readings; none is fixed here.

1. **Terminalization without a durable settlement receipt.**
   `supervisor/coordinator.ts` terminalizes in its catch block for non-completed
   outcomes. The journal only demands a completed settlement for a *completed*
   outcome, so a failure inside `persistSettlement` (durable budget settle or
   journal receipt) still consumes the operation identity while the observed
   usage was never durably recorded. Worst case is the documented fail-closed
   maximum charge, but observed partial usage can be dropped from the journal.
   Suggested direction: never terminalize an admitted operation until both the
   budget settlement and the journal receipt are durable; quarantine and retry
   idempotently instead.

2. **Competing settlements on caller abort.**
   `kady-node-executor.ts` destroys the one-shot socket on abort and then
   locally reconciles as `started: false, tokens: 0`. If the supervisor had
   already admitted the call it may later settle real partial usage against the
   same operation identity, which the journal rejects as a conflict.
   Suggested direction: track admission explicitly and transfer settlement
   ownership rather than settling zero locally after admission.

3. **Connection saturation can lock out lifecycle control.**
   `supervisor/server.ts` destroys sockets past `DEFAULT_MAXIMUM_CONNECTIONS`
   (64) before classifying the request. Lifecycle requests (snapshot, quiesce,
   shutdown, credential reload) open their own connections, so saturation can
   refuse exactly the controls needed to intervene. Message-id replay capacity
   *is* reserved for control; connection capacity is not. `docs/dag-workflows.md`
   has been corrected to state this honestly rather than fixed in code.

4. **Credential `.env` replacement retains a check-to-replace window.**
   `api/credentials.ts` calls `targetMatchesSnapshot(snapshot)` and then
   `renameSync` as separate operations. The earlier fix closed the bounded-*read*
   race; a same-length concurrent write landing between the final validation and
   the rename is still silently overwritten. Closing it properly needs a
   cross-process mutation protocol, since POSIX has no conditional rename.

## Rescue-list invariants confirmed already implemented

Verified against the tree, each with a matching test:

- journal directory-fsync failures rethrow on POSIX (`fsyncDirectory`)
- prepared operations cannot take a settlement or a completed terminal receipt
- idempotent replays re-`fsync` the directory (`durableReplay`)
- credential snapshots compare `dev`/`ino`, `size`, **and** `mtimeNs`
- provider-executing replay identities are non-evicting, with separate control
  capacity (connection capacity excepted — see finding 3)
- provider settlement reaches the durable budget store before the ownership
  journal receipt (`persistSettlement`)

## Deliberately still not done

Unchanged from the branch's own status docs, restated so nobody reads the green
suites as more than they are:

- **Automatic graph-repair rescue** is not implemented. The runner does bounded
  policy retry and manual rescue as a new auditable run; the helper can propose
  a diagnosis but never rewrites a saved graph.
- **`dag-fusion-drive` marketplace release** has not happened. The package is
  private; lowering/parity, provenance, artifact review, namespace ownership,
  and explicit publication approval remain gates.
- **Pipeline engine resume** does not exist. Legacy DAG-Pipelines YAML is a preview-only
  clean-room import; legacy runs are archive-only and never presented as
  resumable native runs.
- **Supervisor or host-machine death** remains the fail-closed boundary: a
  running record becomes a durable quarantine, because no public Pi/provider
  handle can prove that provider work stopped.

## Suggested PR order

Slice against `docs/dag-workflows-pr-plan.md`. Suggested first-to-last:

1. **Supervisor runtime foundation** — `supervisor/{runtime,protocol,journal,
   integrity,credential-contract}.ts` plus their tests. Self-contained, no
   product wiring, and carries the `sun_path` fix that makes everything else
   startable. Reviewable on its own.
2. **Supervisor process and coordinator** — `supervisor/{server,coordinator,
   entry,credentials}.ts`, `supervised-budget.ts`. Depends on slice 1.
3. **Backend client and wiring** — `supervisor/client.ts`, `src/index.ts`,
   `api/{credentials,projects}.ts`, `workflows/{service,hosted-fusion,
   kady-node-executor}.ts`, `agent/workflow-delegation-session.ts`, `start.mjs`.
   This is where findings 1–4 live; land the fixes for 1 and 2 with it.
4. **Docs** — `README.md`, `docs/dag-workflows.md`, `docs/limitations.md`,
   `docs/dag-workflows-pr-plan.md`, this handoff.

Findings 3 and 4 are independent of the slicing and can go as their own
follow-ups.

## Local hygiene notes

- Test cleanup kills the `tsx` CLI wrapper, not the backend grandchild it
  execs, so a failed `backend-shutdown-ipc` run orphans a backend (and its
  supervisor). `start.mjs` handles this correctly with `waitForOwnedTree`; the
  tests do not. Accumulated orphans slow later runs. Clean up with
  by listing pids (`ps -Ao pid=,lstart=,command= | grep -E 'kady-workflow-supervisor|preflight'`) and killing
  only the attributable ones by exact pid; never a pattern kill (it can take down a live preview's supervisor).
- `vitest.config.ts` sets `PI_CODING_AGENT_DIR` for the whole run, which any
  spawned production backend inherits — it overrides a test's own
  `KADY_PI_AGENT_DIR`, so supervisor state lands in the shared vitest agent
  directory rather than the test's temporary root. Worth knowing when reading
  supervisor logs during a test.
