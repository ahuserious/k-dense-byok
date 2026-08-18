# HANDOFF — supervisor hardening, units U3–U6

For a **fresh agent** picking this up. Read `GOAL.md` first (goal, acceptance
criteria, unit definitions, gate config); this file is only "where it stands and
what to do next."

- Workspace: `/Users/DanBot/Documents/ChatGPT/k-dense-byok-dynamic-fusion-graph`
- Branch: `dynamic-fusion-graph`, **6 commits** ahead of `upstream/main`
- Tree: clean except untracked `RESCUE.md`
- Never push to `K-Dense-AI`. Push only to `ahuserious` remotes, only when asked.

## Where it stands

| Commit | What |
|---|---|
| `318e776` | detached supervisor + the two entrypoint blockers (`sun_path`, failed-boot hang) |
| `6ed7723` | handoff doc + honest correction of the connection-capacity claim |
| `73487af` | **WIP** — U1 (durable settlement) + U2 (lossless cancellation) |

`73487af` is deliberately labelled WIP: **its adversarial gates have not passed.**
Suites are green on it (server typecheck clean, 1018 passed / 5 skipped), but
green suites are not the bar — see "Gate discipline" below.

| Unit | State |
|---|---|
| U1 settlement-durable terminalization | implemented, suite-green, **gate #1 failed then redesigned; not re-gated** |
| U2 settlement ownership on abort | implemented, suite-green, **never gated** |
| U3 reserved lifecycle connection capacity | **not started** |
| U4 credential replacement race | **not started** |
| U5 test-harness process hygiene | **not started** |
| U6 PR series | **not started** |

## Do this first

1. **Re-gate U1 and U2 against the commit, not the working tree.**
   The second U1 gate was launched with `--scope working-tree` and then U2 edits
   landed underneath it, so it reviewed a mix of both units and produced nothing
   before being stopped. Do not trust it; there is no verdict to inherit.

   ```bash
   node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" \
     adversarial-review "--model gpt-5.6-sol --effort xhigh --wait --base 6ed7723 <focus text>"
   ```

   **Never run a gate with `--scope working-tree` while you intend to keep
   editing.** Commit first and gate with `--base <previous commit>`.

2. Then U3 → U4 → U5 → U6 in order. U3 and U4 are independent of each other.

## The units still open

**U3 — reserved lifecycle connection capacity** · `supervisor/server.ts`
`accept()` destroys sockets past `DEFAULT_MAXIMUM_CONNECTIONS` (64) *before*
classifying the request. Lifecycle requests (snapshot, quiesce, shutdown,
credential reload) open their own connections, so saturation can refuse exactly
the controls needed to intervene. Message-id replay capacity already reserves
control capacity; connection capacity does not.
**U2 made this worse on purpose and knowingly:** the new cancel op also opens its
own connection, so under saturation a cancel can be refused and the operation
falls back to the hard socket drop. Reserve a lifecycle quota, or multiplex
lifecycle ops over the existing control lease.
→ verify: open `maximumConnections` provider sockets, then issue each lifecycle
request *and* a cancel. Afterwards revisit the caveat added to
`docs/dag-workflows.md` in `6ed7723` so it describes the fixed behavior — it
currently documents the gap honestly and must not be left stale.

**U4 — credential replacement race** · `api/credentials.ts:377-379`
`targetMatchesSnapshot(snapshot)` and `renameSync` are separate operations. The
earlier fix closed the bounded-*read* race; a same-length concurrent write
landing between the final validation and the rename is still silently
overwritten. POSIX has no conditional rename, so this needs a cross-process
mutation protocol (lockfile with owner identity and staleness rules), not a
tighter check.
→ verify: deterministic injection in that exact window; the other writer's data
survives or the update fails closed — never a silent overwrite.

**U5 — test-harness process hygiene** · `test/backend-shutdown-ipc.test.ts`
Cleanup kills the `tsx` CLI wrapper, not the backend grandchild it execs, so a
failed run orphans a backend and its supervisor. `start.mjs` already solves this
with `waitForOwnedTree`. Also decouple the test's 20 s readiness budget from the
client's 20 s `DEFAULT_STARTUP_TIMEOUT_MS` — equal budgets make a slow start
indistinguishable from a hang, which is the exact confusion that hid the original
blocker.
→ verify: induce a failure, assert no surviving descendants.

**U6 — PR series** · slice per `docs/dag-workflows-handoff.md`:
(1) supervisor runtime foundation, (2) supervisor process + coordinator,
(3) backend client + wiring — U1/U2 live here, (4) docs. U3 and U4 are
independent follow-ups. Each slice must typecheck and test standalone.

## Gate discipline (learned the hard way here)

The gate caught two real defects in U1 that green suites did not:

- The first U1 fix refused to terminalize but had no retry path, turning a
  transient disk failure into a permanent project-wide outage. Strictly worse
  than the bug.
- Its regressions used `completed` settlements, which the journal already
  rejects — so the pre-fix code quarantined too and the tests proved nothing.
  Only the quarantine *reason string* differed.

So: **verify every gate finding against the code yourself** — the second finding
was only provable by re-running the stashed pre-fix tree and reading the actual
assertion diff. And **prove a regression fails for the right reason**, not just
that it fails. The reliable technique here:

```bash
git stash push -- <the source file>     # tests stay, fix goes away
npx vitest run <the test file>          # read the assertion diff, not just the ×
git stash pop
```

For U1 that showed pre-fix `OPERATION_FAILED` (it reached `markTerminal` and
dropped the usage) versus post-fix `SUPERVISOR_BUSY` — the actual bug.

## Environment gotchas that will waste your time

- **Orphaned processes poison later runs.** A failed integration test leaves a
  detached backend + supervisor alive; they accumulate and cause spurious
  startup-timeout failures. Clear before any run you intend to cite as evidence:
  list the exact pids first (`ps -Ao pid=,lstart=,command= | grep kady-workflow-supervisor`) and kill only
  those you can attribute to a finished run, by exact pid — never a pattern kill, which can take down a
  supervisor a live preview still owns
- **Single-file vitest runs stall ~300 s on import**; the full suite imports in
  ~33 s and finishes in ~110 s. Prefer the full suite — it is genuinely faster.
- **`vitest.config.ts` sets `PI_CODING_AGENT_DIR` run-wide**, which a spawned
  production backend inherits and which overrides a test's own
  `KADY_PI_AGENT_DIR`. Supervisor state lands in the shared vitest agent dir, not
  the test's temp root. This wasted an hour of log hunting.
- **`server/tsconfig.json` only includes `src`** — test files are never
  typechecked. Type errors in tests surface at runtime or not at all.
- Gate ladder: rung 1 (openrouter-fusion) is `bad-key`/401 and dead; rung 2
  `sol` → `gpt-5.6-sol` @ `xhigh` is live-probed OK. Re-probe with
  `CODEX_EFFORT=xhigh CONFIG_SEATS=sol bash ~/.claude/skills/relentless-inception/scripts/check_prereqs.sh`

## Evidence bar (unchanged, from GOAL.md)

Nothing is "done" without: a regression that fails pre-fix for the *right*
reason; server typecheck + full server suite green **twice consecutively** on a
machine with zero orphaned processes; web typecheck + tests + production build
green; a codex `pass` at `xhigh`; and docs re-read against the code *after* the
change.

## Do not claim as done

Unchanged and still true: automatic graph-repair rescue is not implemented,
`dag-fusion-drive` is private with no marketplace release, Pipeline engine resume does not
exist, and supervisor-or-host death remains the fail-closed quarantine boundary.
