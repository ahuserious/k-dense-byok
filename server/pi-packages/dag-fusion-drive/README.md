# dag-fusion-drive

Incubating, nonvisual Pi package for Kady's typed DAG Workflows and model-fusion
runtime. It is deliberately marked `private` until the runtime, provenance,
license, and marketplace metadata have passed release review and the owner has
approved publication.

The package now contains four nonvisual resources:

- a versioned, provider-neutral graph contract for a bounded `agent` +
  `panel-judge` Fusion subset, with deterministic validation and trusted-host
  execution;
- a trusted-host client for `pi-subagents` Delegation V2, keyed by the complete
  `(requestId, ownerRunId, nodeId)` ownership tuple;
- child-only pre/post compaction auditing with a trusted reader for Kady; and
- `byom-dag-fusion`, an optional Lean 4 + Mathlib research-verification skill.

Contract v1 exposes exact model selectors, graph/node/Fusion request types,
`validateDagFusionGraphV1`, `executeDagFusionGraphV1`, and
`createDagFusionDelegatingTrustedHostV1`. Execution is serial in stable
topological order. A trusted host owns model resolution, credentials, tools,
processes, and budget admission; the portable runtime verifies receipts and
rejects silent model/reasoning/auth fallback or usage beyond the admitted
limits. Graphs and results are bounded plain JSON, and selectors contain only
authentication kind/profile identifiers—never secrets. See
[`RUNTIME.md`](./RUNTIME.md) for the exact API and limitations.

For caller aborts and node deadlines, the portable runtime signals the trusted
host and then waits for its explicit abort-settlement acknowledgement. The host
may acknowledge only after provider activity stops and usage reconciliation
finishes; cleanup failures remain visible host failures.

The delegation client requires explicit model, thinking, turn, tool, timeout,
token, and cost limits. It rejects model/thinking fallback, validates cumulative
usage, cancels on timeout/abort, and reconciles every terminal path before
settling. After it emits a V2 cancel, it retains the full ownership tuple and
reservation until pi-subagents returns the exact matching terminal response;
only that response proves the child executor settled. A wrong-owner or stale
response is ignored. A malformed or missing acknowledgement fails visibly as
unconfirmed cancellation and reconciles without terminal usage, preserving the
owner ledger's maximum-commitment behavior rather than claiming provider stop.
That settles only the caller-visible attempt: the exact tuple remains
quarantined, the host rejects new delegation, and host/session disposal remains
pending. Only a later exact, fully validated terminal response releases the
quarantine; a malformed exact response does not. Project deletion is likewise
blocked while the owned session is quarantined. The acknowledgement window
defaults to 5,000 ms and is host-configurable from 1 through 60,000 ms with
`cancellationAckTimeoutMs`.
Its identity history is bounded but non-evicting: when full, the host fails
closed and must be replaced by a fresh dedicated workflow session.

The current public pi-subagents event API has no durable cross-process
reattachment for an in-memory ownership tuple. Graceful shutdown therefore
waits for quarantine release; force-killing or restarting the process while a
tuple is quarantined cannot be represented as confirmed child quiescence and
remains an unresolved P0 for production DAG-leaf use and package release. Durable graph/accounting recovery
does not recover this process-local child ownership or prove provider stop.

The Pi extension entrypoint installs no model-facing tools and cannot launch
work by itself. In an exact `PI_SUBAGENT_CHILD=1` environment it writes a
size-bounded sidecar keyed by a digest of `PI_SUBAGENT_RUN_ID`, then audits Pi's
`session_before_compact` and `session_compact` hooks. Records contain bounded
counts plus SHA-256/byte-length fingerprints, never transcript, instruction,
path, prior-summary, or new-summary contents. The audit checks structural
continuity only; it does not claim that a generated summary is semantically
complete or correct. A trusted Kady reader revalidates file identity, bounds,
record shape, phase order, and matching pre/post identity before emitting
workflow checks.

The Lean skill requires successful host receipts to preserve the verifier's
exact audited allowed-axiom subset. Kady's pre/post revision, tree, and
cleanliness checks protect the pinned Mathlib checkout; they do not claim that
the surrounding Lake project is immutable.

Kady binds the delegation client to the `pi.events` bus of a dedicated workflow
session through `createDagFusionWorkflowSessionBridge`; ordinary chat sessions
do not own DAG leaves. The visual DAG Builder remains part of Kady and is not
included in this package. Kady's richer durable graph remains an internal
schema pending an explicit, reviewed adapter to this narrower exported boundary.

This directory is release-shaped but not release-authorized. See
[`RELEASE.md`](./RELEASE.md) for the explicit approval gate,
[`SECURITY.md`](./SECURITY.md) for the trust boundary, and
[`NOTICE.md`](./NOTICE.md) for provenance and dependency notes.
