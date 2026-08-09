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

## 4. Apply sampling to hosted Fusion

Pi delegation already applies `temperature`, `top_p`, and the sampling map via
the seeded `kady-workflow-node-control` extension. Hosted Fusion uses an
in-process Pi session, so merge the same pure binder into its extension chain:

1. In `HostedOpenRouterFusionRequest` and `CreateHostedFusionSessionInput` in
   `server/src/workflows/hosted-fusion.ts`, add an optional
   `providerRequest` field with the structural shape
   `{ temperature: number; top_p: number; sampling: Record<string, string | number | boolean> }`.
2. Pass `request.providerRequest` through the `dependencies.createSession({...})`
   call.
3. Import `applyS4ProviderRequestBindings` from
   `../agent/workflow-delegation-session.ts` and,
   immediately after `makeFusionRequestExtension(...)` in
   `createDefaultHostedFusionSession()`'s `extensionFactories`, add:

```ts
(pi) => pi.on("before_provider_request", ({ payload }) => input.providerRequest ? applyS4ProviderRequestBindings(payload as Record<string, unknown>, input.providerRequest) : payload),
```

Finally, replace the default dependency in
`dependenciesWithDefaults()` in `kady-node-executor.ts`:

```ts
runHostedFusion: (request) => runHostedOpenRouterFusion(request),
```

with:

```ts
runHostedFusion: (request, transport) => runHostedOpenRouterFusion({ ...request, ...(transport?.nodeControl ? { providerRequest: transport.nodeControl.providerRequest } : {}) }),
```

The ordering above intentionally runs the S4 binder after the Fusion bridge so
the final provider payload retains the Fusion plugin body and receives the
node's sampling controls.

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

In `server/test/kady-node-executor.test.ts`, change only:

```ts
describe.skip("POST-INTEGRATION(S4) validation, persistence, and runner path", ...)
```

to `describe(...)`. That suite passes the complete S4 NodeSpec through semantic
validation, durable `WorkflowStore` persistence, `runWorkflowDag()`, the Kady
executor, receipt/reservation construction, and delegation. Keep all Tier A
suites enabled.
