# Portable graph runtime contract

`dag-fusion-drive` contract v1 is the smallest nonvisual boundary an external
Pi host can implement without importing Kady's server, visual Builder, project
store, sessions, or credentials. The package remains private and its version
remains developmental; this document is not publication authorization.

## Supported graph subset

`DagFusionGraphV1` uses `version: "1.0"` and contains exact model selectors,
run ceilings, nodes, and unconditional directed edges. The limits are 64 nodes,
256 edges, and 1 MiB of plain JSON. Identifiers are bounded lowercase slugs.
USD ceilings and usage are normalized to twelve decimal places so cumulative
budget arithmetic is deterministic rather than dependent on binary floating
error.

Contract v1 supports two node kinds:

- `DagFusionAgentNodeV1`: one specialist, instruction, exact model selector,
  and hard execution limits.
- `DagFusionFusionNodeV1`: a `panel-judge` request with two through eight
  members, one logical judge slot, an instruction, and hard execution limits.

A `DagFusionModelSelectorV1` names `provider`, `model`, `reasoning`, and a
host-owned authentication selector. Authentication selectors contain only a
kind (`api-key`, `oauth`, `local`, or `custom`) and optional profile name. They
must never contain a token, key, cookie, base URL containing credentials, or
other secret material.

The exact exported runtime functions are:

- `validateDagFusionGraphV1(value)` returns a cloned graph or deterministic,
  path-addressed validation issues.
- `assertDagFusionGraphV1(value)` returns a cloned graph or throws
  `DagFusionRuntimeError` with code `DAG_FUSION_RUNTIME_INVALID_GRAPH`.
- `dagFusionExpectedModelSlotsV1(node)` returns `agent`, `member:<id>`, and
  `judge` receipt slots as applicable.
- `executeDagFusionGraphV1(graph, host, { runId, signal? })` executes every node
  once, serially, in stable topological order.
- `createDagFusionDelegatingTrustedHostV1(options)` adapts agent nodes to the
  existing owned Delegation V2 client while leaving Fusion execution explicit.
- `dagFusionHostAbortSettledV1()` creates the only valid acknowledgement for a
  host callback that has stopped work and reconciled after cancellation.
- `sameDagFusionModelSelectorV1(left, right)` compares exact selector identity.

The relevant host types are `DagFusionTrustedHostV1`,
`DagFusionAgentExecutionRequestV1`, `DagFusionFusionExecutionRequestV1`,
`DagFusionHostExecutionOutcomeV1`, `DagFusionNodeExecutionResultV1`,
`DagFusionHostAbortSettlementV1`, `DagFusionModelResolutionV1`, and
`DagFusionGraphExecutionResultV1`.

## Trusted-host execution

The portable runtime owns graph validation, stable order, inbound result
routing, deadlines, cumulative run accounting, node-result validation, and
exact-resolution checks. Before a callback, the host receives `admission`, the
smaller of the node ceiling and the graph's remaining timeout/token/cost/model
call budget.

The trusted host owns all effects. It must:

1. Resolve the selector without silent provider, model, authentication profile,
   or reasoning fallback.
2. Reserve and enforce the supplied admission before invoking a provider.
3. Honor the supplied `AbortSignal` and reconcile every terminal path.
4. Return bounded plain JSON plus non-negative usage and exactly one resolution
   receipt for each expected logical model slot.
5. Report actual compound model calls. For example, a hosted provider that
   bills the judge twice reports both calls even though there is one `judge`
   identity slot.

The runtime rejects a result after the fact if it exceeds admission or reports
a different resolved selector. That visible failure cannot refund or terminate
an external call, so pre-admission and cancellation remain mandatory host
responsibilities.

The callback promise is also the cancellation settlement boundary. When a
caller abort or node deadline fires, the runtime first aborts the supplied
signal and then keeps the exported execution promise pending. The trusted host
must stop provider work, reconcile its reservation, and resolve with
`dagFusionHostAbortSettledV1()`. Only then does the runtime reject the exported
call with `DAG_FUSION_RUNTIME_ABORTED` or `DAG_FUSION_RUNTIME_TIMEOUT`. A host
that rejects during cleanup, or resolves without the explicit settlement
acknowledgement, produces `DAG_FUSION_RUNTIME_HOST_FAILED`; the runtime does not
claim successful reconciliation in that case.

There is deliberately no portable forced-cleanup grace timer. The graph runtime
does not own the host's provider process or reservation, so returning after a
grace period would recreate the same unverified-accounting gap. Hosts must make
their cancellation path bounded and settle the callback themselves.

```ts
import {
  createDagFusionDelegatingTrustedHostV1,
  executeDagFusionGraphV1,
} from "dag-fusion-drive";

const trustedHost = createDagFusionDelegatingTrustedHostV1({
  delegationHost,
  prepareAgent(request) {
    return {
      request: buildOwnedDelegationV2Request(request),
      reconcileUsage: reconcileReservedUsage,
    };
  },
  mapAgentReceipt(receipt, request) {
    return mapReceiptToExactRuntimeResult(receipt, request);
  },
  executeFusion(request) {
    return executeHostOwnedPanelFusion(request);
  },
});

const result = await executeDagFusionGraphV1(graph, trustedHost, {
  runId: crypto.randomUUID(),
});
```

The delegation adapter overwrites token/cost limits and cancellation with the
runtime admission, and it rejects a prepared request whose `ownerRunId`,
`nodeId`, or timeout escapes the owning run. The host still explicitly maps a
provider-neutral selector to a Pi model reference and maps the Delegation V2
receipt back to the exact runtime receipt. Expected Delegation V2 cancellation
errors are converted to the explicit abort-settlement acknowledgement only
after the owned client receives the exact correlated V2 terminal response and
reconciles usage. Emitting a cancel is only the first phase and does not release
ownership. Wrong-owner and stale responses are ignored. A malformed or missing
cancellation acknowledgement rejects with a non-abort host failure and no
terminal usage, preserving maximum-commitment reconciliation; it is never
translated to `dagFusionHostAbortSettledV1()`. After that caller-visible error,
the owned tuple remains quarantined. The host rejects every new delegation and
keeps disposal pending until a later exact, fully validated terminal response
arrives; an exact response with malformed fields, inconsistent execution
identity, or invalid usage cannot release it. Kady exposes the quarantine in
session diagnostics and blocks project deletion while the session owns it. The
exact acknowledgement bound is `cancellationAckTimeoutMs`, defaulting to 5,000
ms and constrained to 1-60,000 ms. A pre-aborted request that never reached
Delegation V2 is reconciled through the supplied callback before it is
acknowledged; reconciliation failure remains a visible host failure.

This quarantine is process-local because the current public pi-subagents event
API does not offer durable reattachment to a prior event bus. Graceful shutdown
waits for its release. A forced process death or restart cannot turn the
fail-closed maximum charge into evidence that provider work stopped; durable
reattachment/recovery is an unresolved P0 before production DAG-leaf use or
marketplace release. Kady's
durable graph/run recovery does not recover this in-memory tuple or prove child
quiescence.

## Child compaction audit

The package's separate `./compaction-audit` entry installs only when
`PI_SUBAGENT_CHILD` is exactly `1` and requires a bounded
`PI_SUBAGENT_RUN_ID`. It creates a size-bounded JSONL attestation inside the
project sandbox and registers `session_before_compact` plus `session_compact`
hooks. Persisted metadata is limited to counts, booleans, numeric limits, and
SHA-256/UTF-8-length fingerprints. It never persists message, instruction,
file-path, prior-summary, or new-summary content.

`readTrustedDagFusionCompactionAudit(sandboxRoot, runId)` independently checks
the sidecar's single-file identity, maximum size, header/run digest, record
shape and sequence, and pre/post identity continuity. A valid header with no
phase records means no compaction occurred. This is a structural integrity
check, not a semantic evaluation of whether a summary preserved every relevant
fact. Kady owns the policy that turns a failed pre/post check into a durable
workflow failure and bounded rescue attempt.

## Deliberate exclusions

Contract v1 has no conditional edges, loops, parallel scheduler, retries,
research-until-goal, Council, best-of-N, evidence gates, rescue, compaction
nodes or graph-level compaction policy, Lean node, artifacts, writable
workspace policy, durable state, cross-process leases, UI positions, or
dynamic workflow kernel. It also does not prescribe OpenRouter, local, or
custom-provider transport. Those are host
policies or richer Kady features, not silently simulated by this package.

Kady currently uses a larger internal graph and durable runner. A future
adapter must be explicit about which internal graphs lower losslessly into this
subset; the shared name does not imply wire compatibility today.
