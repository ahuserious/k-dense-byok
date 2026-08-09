# S4 merge-time integration

This lane deliberately does not edit S5-owned validation, runner, hosted-Fusion,
or contract files. Apply the steps below in the merge commit after the S4 files
are present. Do not remove or change any S5 enforcement.

## 1. Remove the S4 fail-closed findings

In `server/src/workflows/node-spec-enforcement.ts`, delete only these S4 finding
blocks from `pendingNodeSpecEnforcements()`:

- `node-conditions-enforcement-pending`
- `node-harness-enforcement-pending`
- `node-hyperparameters-enforcement-pending`
- `node-databases-enforcement-pending`
- `node-skills-mode-enforcement-pending`
- `node-skills-list-enforcement-pending`
- `node-subagents-mode-enforcement-pending`
- `node-autonomy-enforcement-pending`
- `node-billing-mode-enforcement-pending`

Delete only these blocks from `pendingWorkflowSettingsEnforcements()`:

- `workflow-default-harness-enforcement-pending`
- `workflow-databases-enforcement-pending`

Keep `PendingNodeSpecEnforcement`, the S5 deliberation finding, the S5 hosted
Fusion reasoning finding, and both validation loops. After the deletions the
loops naturally reject only fields that remain owned by S5.

## 2. Validate unsafe S4 binding inputs

In `server/src/workflows/validate.ts`, import `s4NodeBindingIssues` from
`../agent/workflow-delegation-session.ts`. In `validateNode()`, immediately
after this anchor:

```ts
if (node.limits) validateNodeLimits(node.limits, nodePath, document, issues);
```

insert this one line:

```ts
issues.push(...s4NodeBindingIssues(resolveNodeSpecV1(document, node), `${nodePath}/settings`));
```

This turns reserved sampling keys and sandbox-escaping `conditions.exists`
entries into semantic validation errors. The TypeBox schema continues to own
all enum/range/shape validation. `resolveS4NodeExecutionBindings()` remains the
runtime binder; it is already called in `createKadyWorkflowNodeExecutor()`
before dispatch and is intentionally not called from validation because it
resolves project skill and database state.

## 3. Gate conditions in the runner before model-slot construction

In `server/src/workflows/runner.ts`, import:

```ts
import { assertS4NodeConditions } from "../agent/workflow-delegation-session.ts";
import { resolveNodeSpecV1 } from "./validate.ts";
```

`resolvePaths` is already imported by `runner.ts`; extend its existing
`./validate.ts` import rather than adding a second import declaration.

Inside `executeNodeWithRescue()`, in the `try` block following `node_started`,
move the existing `const modelCalls = new ModelCallTracker(...)` statement to
immediately after the existing `const inbound = ...` construction. Between the
`inbound` construction and the moved `ModelCallTracker` statement, insert:

```ts
assertS4NodeConditions(resolveNodeSpecV1(manifest.graph, node), { runInput: manifest.input, attempt, resumed: initialOutcome?.status === "interrupted" && attempt === initialOutcome.attempt, inbound }, resolvePaths(manifest.projectId).sandbox);
```

This placement is required: a false/missing condition must throw before the
tracker declares expected model slots, before a receipt can be recorded, before
budget reservation, and before either Pi or hosted-Fusion dispatch. The
executor repeats the same gate at its trust boundary as defense in depth.

## 4. Hosted Fusion sampling is already lane-local

No merge-time edit to `hosted-fusion.ts` is required. The default wrapper in
`kady-node-executor.ts` is now `runS4HostedFusionWithNodeControl()`. It forwards
`nodeControl.providerRequest` into `createS4HostedFusionSession()` in
`workflow-delegation-session.ts`. That S4-owned session factory installs
`makeFusionRequestExtension(...)` first and the S4 provider-request binder
second, so temperature, top-p, and sampling keys apply to the final Fusion
router payload without modifying S5-owned code.

## 5. Contract table flips

In `docs/contracts/NODESPEC-V1.md`, change exactly these enforcement rows to
`BOUND` (the explanatory suffixes may use the text shown):

| Field | Merge-time status |
| --- | --- |
| `hyperparameters.temperature` | `BOUND — provider request sampling` |
| `hyperparameters.top_p` | `BOUND — provider request sampling` |
| `hyperparameters.sampling` | `BOUND — provider request sampling map` |
| `conditions.when` | `BOUND — pre-admission boolean evaluator` |
| `conditions.exists` | `BOUND — sandbox-safe path/named-input gate` |
| `harness` | `BOUND — Pi dispatch; explicit unavailable/unbound CLI errors` |
| `databases` | `BOUND — per-node execution context` |
| `skills.mode` | `BOUND — Pi child skill selection` |
| `skills.list` | `BOUND — Pi child skill selection` |
| `subagents.mode` | `BOUND — node subagent policy context` |
| `autonomy` | `BOUND — child tool/subagent access gate` |
| `billingMode` | `BOUND — resolved-auth admission gate` |
| Workflow `settings.defaultHarness` | `BOUND — inherited harness dispatch` |
| Workflow `settings.databases` | `BOUND — inherited node execution context` |

Update the matching prose rows below the table so they describe the same bound
semantics rather than the former pending-S4 rejection.

## 6. Post-integration tests

The `POST-INTEGRATION(S4)` suite remains skipped in this lane because the
contract-freeze validator still rejects S4 fields before the owned executor can
run. In `server/test/kady-node-executor.test.ts`, change only:

```ts
describe.skip("POST-INTEGRATION(S4) validation, persistence, and runner path", ...)
```

to `describe(...)`. That suite passes the complete S4 NodeSpec through semantic
validation, durable `WorkflowStore` persistence, `runWorkflowDag()`, the Kady
executor, receipt/reservation construction, and delegation. Keep all Tier A
suites enabled.

Also in `server/test/pipelines.test.ts`, change only:

```ts
describe.skip("POST-INTEGRATION(S4) settings-bearing vendored loader", ...)
```

to `describe(...)`. This is the S3/S4 merge proof that the vendored loader
preserves `settings.budget`; the enabled Tier A tests continue covering the
current loader/API legacy shape (`provider`, `model`, and `maxBudgetUsd`).

## 7. Engine idempotency and accounting watermark

The vendored engine is outside S4 ownership, so the merge commit must make the
fields already sent by `POST /pipelines/:name/run` authoritative:

1. At the run-request schema/handler anchor that currently accepts
   `conversationId` and `message`, accept `kadyProjectId`,
   `kadyAdmissionId`, `kadyEngineAdmissionKey`, `idempotencyKey`,
   `workflowRevisionSha256`, and `metadata`. Require
   `idempotencyKey === kadyEngineAdmissionKey`, and validate the scoped key as
   `kadypipe_ + first32hex(sha256(kadyProjectId + "\0" + kadyAdmissionId))`.
   Make `(kadyProjectId, kadyEngineAdmissionKey)` unique in durable run
   storage. In the same transaction that creates a run, insert that key; on a
   duplicate return the existing run's accepted result without starting
   another executor.
2. Before creating the run or invoking a provider, hash the exact normalized
   workflow revision the engine is about to execute: SHA-256 of canonical JSON
   over the workflow object only (object keys recursively sorted; array order
   preserved; exclude the API wrapper's `filename` and `source`). Reject when
   it differs from `workflowRevisionSha256`. Persist that revision on the run.
   This closes the remaining race after Kady's own immediately-pre-dispatch
   revision recheck.
3. Persist and echo `metadata.kadyProjectId`,
   `metadata.kadyAdmissionId`, `metadata.kadyEngineAdmissionKey`, and
   `metadata.kadyWorkflowRevisionSha256` on both list and detail run
   responses. Extend `GET /api/workflows/runs` with exact `projectId` plus
   `admissionId` filters. Its response must include
   `admissionQuery: { projectId, admissionId, authoritative: true }` after the
   durable composite-key lookup, including when `runs` is empty. Kady never
   trusts an unscoped or non-authoritative negative result.
4. At the terminal run transaction, persist
   `metadata.kady_completion_watermark` only after all node results and usage
   are durable. Its exact shape is:

   ```ts
     {
       version: 1,
       projectId: string,
       engineAdmissionKey: string,
       nodeIds: string[],
     usageByNode: Record<string, {
       costUsd: number,
       tokensIn: number,
       tokensOut: number,
     }>,
   }
   ```

   `nodeIds` and `usageByNode` must cover every admitted model node exactly.
   Do not derive this watermark from best-effort event rows. A terminal run
   without this complete durable watermark is intentionally full-charged by
   the server-owned reconciliation worker.

These engine changes are required for safe negative admission lookup and
observed-cost settlement. Kady already passes the idempotency key, persists
the workflow revision and project/run/reservation correlation before dispatch,
and runs write-ahead recovery independently of clients. Against the current
non-echoing engine, Kady can prove presence only by finding both reserved
project/admission labels in the real `user_message` list shape; absence remains
`unknown`, so the reservation is retained. The enabled Tier A
`degrades safely against the current non-echoing engine run-list shape` test
locks this fallback contract until the engine half lands.

No merge edit is needed for Kady crash recovery. The reservation file embeds
the complete admission intent in the same atomic write as the cost hold; a
restarted worker materializes a missing correlation sidecar from it. The
sidecar then advances write-ahead through `intent`, `dispatching`, `dispatched`,
`settling`, and `settled`. `settling` includes the exact durable usage payload,
so a crash before or after ledger settlement replays idempotently.
