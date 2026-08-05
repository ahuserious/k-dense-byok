# DAG Workflows stacked-PR plan

> **Local integration status:** this checklist describes how to split
> `dynamic-fusion-graph` into reviewable pull requests. It is not a release
> announcement. Each PR should be based on the previous PR's tip unless the
> change can be reviewed independently against upstream `main`.

## Readiness snapshot

| Area | Current branch status | Delivery consequence |
|---|---|---|
| Typed graph, validation, revisioned definitions | Implemented and tested | Ready for the first PR. |
| Durable runs, events, leases, cancellation, recovery, resume, budgets | Implemented and tested for graph/run state | Ready after the graph contract. This does not recover process-local Pi child quarantine after abnormal backend death. |
| Bounded Pi Delegation V2 and dedicated workflow sessions | Implemented and tested for graceful lifecycle | **P0 remains:** public V2 exposes no child PID or durable reattachment handle, so abnormal-restart quarantine recovery is not release-ready. |
| Research Until Goal, Council, both Fusion modes, Best-of-N, evidence gates, bounded runner retry, Lean | Integrated through Kady's runner and node executor | Lean uses exact host-owned artifacts and is disabled unless the server owner explicitly accepts unsandboxed same-user authority. Writable DAG leaf workspaces remain unsupported. Production DAG-leaf use remains blocked on abnormal-restart ownership recovery. |
| Dynamic Workflows kernel adapter/compiler | Integrated for ordinary Agent nodes | Compound nodes stay on Kady's direct typed multi-slot executor so partial usage and requested/resolved receipts remain explicit. |
| Builder, Console runner controls, Raindrop, templates, dedicated helpers, `Pi (Kady)` | Implemented and tested | Ready after backend contracts stabilize. |
| Legacy DAG-Pipelines compatibility | Preview-only prompt-DAG translator plus an explicit archive-only run boundary | Include with the backend API. Interactive, loop, conditional, all-parent join, and sidecar-run semantics remain manual migrations. |
| Pre/post-compaction checks | Mandatory structural child lifecycle audit with trusted Kady readback | Records fingerprints/counts only and fails visibly on missing or contradictory audit state; it does not prove semantic summary quality. |
| Rescue diagnosis and workflow repair | A separate helper can inspect bounded stopped-run context and propose a manual rescue; the runner can retry within policy | **Deferred from automatic execution.** No helper may patch a saved graph or control the runner, and no automatic diagnosis/repair loop exists. |
| End-to-end workflow provenance | Durable workflow/model/artifact receipts exist, but the public extension/runtime provenance boundary is incomplete | Keep the limitation visible; do not claim package release readiness. |
| `dag-fusion-drive` | Private development package with a narrow exported Agent/panel-judge graph API, trusted-host adapter, compaction audit, and `byom-dag-fusion` Lean skill | **Publication blocked.** Abnormal-restart child ownership/recovery is an unresolved P0 in addition to Kady lowering/parity, provenance, clean install, packed-artifact review, namespace ownership, and owner approval. |

The runner's same-run durable lease prevents duplicate ownership across backend
processes. The configured global/per-project scheduler concurrency ceilings are
process-local, so a multi-backend deployment must not present them as a
cluster-wide capacity guarantee. DAG and Modal reservations share atomic
project-cap admission; ordinary chat does not yet declare and pre-reserve a
worst-case turn cost through that same mechanism.

## Proposed stack

### PR 1 — graph contract and clean-room boundary

Base: current upstream `main`.

- [ ] Add the versioned provider-neutral graph schema, normalization, semantic
  validation, typed limits, model selectors, receipts, and fixtures.
- [ ] Document any-ready fan-in, acyclic outer graphs, bounded compound-node
  iteration, read-only first-release leaf workspaces, and clean-room Fusion.
- [ ] Keep runtime, persistence, UI, and package publication out of this PR.
- [ ] Exit gate: graph tests cover every node type, invalid routing, cycles,
  budget shape, fallback policy, artifact ownership, and path containment.

Focused verification:

```bash
cd server
npx vitest run test/workflow-graph.test.ts
npm run typecheck
```

### PR 2 — durable store, runner lifecycle, API, and accounting

Base: PR 1.

- [ ] Add revisioned project definitions, immutable run snapshots, ordered event
  and journal logs, mutation locks, leases, cancellation intent, resume, and
  restart recovery.
- [ ] Add the bounded runner/controller, control API, project-delete quiescence,
  run-wide token/cost/model-call ceilings, and shared DAG/Modal cap admission.
- [ ] Add the preview-only legacy YAML compatibility route. It must never scan
  `.archon`, overwrite a definition, or expose legacy run rows as resumable.
- [ ] Fail closed on corrupt accounting or complete durable rows; repair only a
  provably torn final event row and record that repair.
- [ ] Keep real model execution and UI out of this PR by using test executors.
- [ ] Exit gate: competing processes cannot own one run or over-admit the same
  declared project budget; shutdown leaves resumable interrupted state.

Focused verification:

```bash
cd server
npx vitest run \
  test/workflow-store.test.ts \
  test/workflow-run-state.test.ts \
  test/workflow-runner.test.ts \
  test/workflow-controller.test.ts \
  test/workflow-budget.test.ts \
  test/workflow-service.test.ts \
  test/dag-workflows-api.test.ts \
  test/legacy-archon-import.test.ts \
  test/project-workflow-delete.test.ts \
  test/cost-ledger-hardening.test.ts
npm run typecheck
```

### PR 3 — owned Pi leaf transport and model-resolution receipts

Base: PR 2.

- [ ] Add the focused `pi-subagents` Delegation V2 contract and a dedicated,
  headless workflow session per project.
- [ ] Enforce full ownership identity, exact model/reasoning resolution,
  declared-only fallback, limits, cancellation, timeout, terminal usage
  reconciliation, and bounded identity history.
- [ ] Re-run regression coverage for ordinary chat bridges and harvesting so
  DAG work cannot silently change existing Pi session behavior.
- [ ] Keep compound-node semantics and visual surfaces out of this PR.
- [ ] Exit gate: wrong-owner/stale events are ignored; an exact terminal shape
  validates before quarantine release; missing/malformed acknowledgement
  full-charges, quarantines, and blocks admission/teardown/deletion; ordinary
  sessions cannot own DAG leaves. Abnormal restart remains blocked until V2
  exposes a durable child identity/reattachment or another reviewed positive
  quiescence mechanism—accounting recovery alone is not sufficient.

Focused verification:

```bash
cd server
npx vitest run \
  test/pi-subagents-compatibility.test.ts \
  test/workflow-delegation-session.test.ts \
  test/fusion-bridge.test.ts \
  test/agent-files.test.ts
npm run typecheck
```

### PR 4 — integrated node behaviors and trusted Lean verification

Base: PR 3.

- [ ] Wire Agent, Research Until Goal, Council, Kady panel Fusion, hosted
  OpenRouter Fusion, Best-of-N (default 2), evidence gates, bounded runner
  retry, and Lean solve/verify behavior to Kady's node executor.
- [ ] Preserve hosted Fusion's one compound accounting reservation and exact
  panel/judge semantics; preserve separate requested/resolved receipts for Kady
  panel members.
- [ ] Seed and validate the `byom-dag-fusion` Lean skill without treating missing
  Lean/Mathlib or a rejected proof as success.
- [ ] Keep `KADY_ALLOW_UNSANDBOXED_LEAN` disabled by default; document that its
  explicit opt-in retains same-user filesystem/network authority and is not a
  sandbox. Do not enable unsandboxed native-Windows execution without a reliable
  descendant-process termination boundary.
- [ ] Verify solve-mode proposition ownership, visible host-only artifacts,
  clean detached Mathlib revision/tree receipts, secret-free child environment,
  and durable failure receipts. Add a real installed Lean/Mathlib success job
  before describing formal verification as release-qualified.
- [ ] Execute ordinary Agent nodes through the pinned Dynamic Workflows
  adapter/compiler and Kady-owned leaf runner. Keep compound nodes on the direct
  typed executor unless multi-slot receipt and partial-usage parity is proven.
- [ ] Install the structural pre/post-compaction audit only in owned child
  sessions, persist no raw transcript/summary text, read it back in Kady, and
  route visible failures through bounded rescue policy.
- [ ] Exit gate: cancellation and all terminal failures reconcile exactly once,
  unsupported writable isolation fails before dispatch, and exact requests do
  not silently downgrade.

Focused verification:

```bash
cd server
npx vitest run \
  test/kady-node-executor.test.ts \
  test/hosted-fusion.test.ts \
  test/dynamic-workflow-adapter.test.ts \
  test/lean4-verifier.test.ts \
  test/dag-fusion-package.test.ts
npm run typecheck
```

### PR 5 — visual workflows, templates, helpers, and settings

Base: PR 4.

- [ ] Add the persistent DAG Workflows view, Builder/canvas/inspector, run
  launch, Console runner controls, and authoritative event polling.
- [ ] Add Machine Learning & AI and Data & Analysis templates with typed,
  bounded defaults.
- [ ] Add distinct source-scoped, no-tools Builder, rescue-proposal, and Raindrop
  analyst sessions. Keep authoritative typed profile/source bindings outside the
  sandbox, reconstruct bounded project-validated context server-side at every
  turn, and autosave/restore native-run and ordinary-chat references.
- [ ] Label the pipeline `Pi (Kady)` and keep it wired to the main Kady agent.
- [ ] Exit gate: stale definition saves preserve the local draft, dirty graphs
  cannot launch, run controls act on durable state, and helper identities never
  become the runner.

Focused verification:

```bash
cd server
npx vitest run \
  test/helper-sessions.test.ts \
  test/raindrop-context.test.ts \
  test/win-portability.test.ts
npm run typecheck

cd ../web
npx vitest run \
  src/lib/dag-workflows.test.ts \
  src/lib/dag-workflow-builder.test.ts \
  src/lib/dag-workflow-templates.test.ts \
  src/components/dag-workflows-panel.test.tsx \
  src/components/dag-builder.test.tsx \
  src/components/dag-builder-canvas.test.tsx \
  src/components/dag-builder-inspector.test.tsx \
  src/components/dag-workflow-console.test.tsx \
  src/components/raindrop-panel.test.tsx \
  src/components/helper-agent-chat.test.tsx \
  src/components/persistent-workspace-surfaces.test.tsx \
  src/components/workspace-navigation.test.tsx
npx tsc --noEmit
```

### PR 6 — private extension extraction and release hardening

Base: PR 4 or PR 5, depending on whether package seeding needs UI-visible
metadata. This PR remains private/release-blocked.

- [ ] Review the implemented narrow exported nonvisual Agent/panel-judge graph
  runtime API and define an explicit lowering boundary from Kady's richer graph;
  do not export Kady's visual components or project store.
- [ ] Demonstrate parity for identity, cancellation, limits, usage, fallback,
  provenance, and clean installation in a fresh Pi agent directory.
- [ ] Review package contents, dependency licenses, security boundary,
  namespace ownership, installation docs, and immutable artifact checksum.
- [ ] Keep `private: true` and the development version until a separate release
  change receives explicit owner approval.
- [ ] Do **not** publish to npm, create a release, or submit a marketplace entry
  as part of the implementation PR stack.

Package inspection (safe while publication remains blocked):

```bash
cd server
npx vitest run \
  test/dag-fusion-package.test.ts \
  test/dag-fusion-runtime-contract.test.ts \
  test/dag-fusion-compaction-audit.test.ts \
  test/pi-subagents-compatibility.test.ts
cd pi-packages/dag-fusion-drive
npm pack --dry-run --json
```

## Whole-stack acceptance gate

Run these commands from a clean checkout of the exact proposed stack tip. CI
must include Windows because process launch, locks, and path handling are part
of the runtime contract.

```bash
git fetch upstream
git merge-base --is-ancestor upstream/main HEAD

cd server
npm ci
npm run typecheck
LOG_LEVEL=silent npm test

cd ../web
npm ci
npx tsc --noEmit
npm run lint:dag
npm test
npm run build

cd ../server/pi-packages/dag-fusion-drive
npm pack --dry-run --json

cd ../../..
git diff --check
# When installed locally: actionlint .github/workflows/tests.yml
```

The commands above use POSIX shell environment syntax for the current macOS
worktree. Windows CI should run the same npm scripts using its native shell; it
must not be replaced by a POSIX-only local result.

The feature-scoped lint command is deliberate: upstream `main` currently has
unrelated React 19 ESLint failures. Typecheck, tests, and the production build
remain whole-frontend gates; converting `lint:dag` to a repository-wide lint
gate requires the baseline lint cleanup to land separately.

Before requesting upstream review:

- [ ] Every PR description states its base PR, new contract, excluded follow-up,
  verification evidence, and rollback boundary.
- [ ] No PR claims compound-node Dynamic Workflows execution, semantic
  compaction-summary verification, automatic rescue diagnosis/graph repair,
  writable DAG leaves, cluster-wide scheduler limits, or public package release
  readiness.
- [ ] No source, prompts, fixtures, tests, comments, or assets were copied from
  `claude-fusion-drive`; dependency notices remain intact.
- [ ] Requested and resolved model/reasoning/auth ownership, fallback decisions,
  budgets, evidence gates, and terminal degradation remain visible.
- [ ] An independent adversarial review passes on the final stack tip.
- [ ] `dag-fusion-drive` remains unpublished unless a later, explicit approval
  names the reviewed artifact and marketplace account.
