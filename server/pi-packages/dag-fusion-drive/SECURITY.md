# Security boundary

The package is a trusted-host transport component, not an operating-system
sandbox. Pi tools and child processes run with the current OS user's authority.
Use a container, VM, or separate account for adversarial inputs or stronger
credential isolation.

The extension entrypoint registers no model-facing delegation tool and starts
no provider work. The portable graph API invokes callbacks only when trusted
host code explicitly calls `executeDagFusionGraphV1`. A graph cannot
independently gain delegation authority, model credentials, filesystem access,
or persistence.

Inside an exact pi-subagents child environment, the entrypoint writes one
bounded compaction-audit sidecar beneath the project sandbox. Its filename is a
SHA-256 digest of the child run id. Directory components and the opened file
are checked against symbolic links; path/opened-file identity is also compared
where the platform exposes it. The trusted reader rejects hard-linked,
oversized, malformed, torn, reordered, or mismatched records. Audit records
must also have no group/other permission bits on POSIX; Windows relies on its
native ACL semantics. Records persist only structural counts, numeric limits,
booleans, and SHA-256/length fingerprints. They do not persist transcript,
instruction, file-path, or summary contents, and they do not establish the
semantic quality of a summary. Same-user filesystem access remains outside
the package's security boundary.

A trusted host must supply the Pi event bus, an explicit V2 request containing
the exact model, thinking level, working directory, timeout, turn limit, and
tool limit, plus trusted delegate options containing the token and cost
ceilings. Model and reasoning
fallback are rejected. On cancellation or timeout, the runtime signals the
trusted callback and waits for `dagFusionHostAbortSettledV1()` before rejecting
the exported call. Returning that acknowledgement asserts that provider work has
stopped and the host-owned budget reservation has reconciled. A cleanup
rejection or any other value fails visibly as
`DAG_FUSION_RUNTIME_HOST_FAILED`; the runtime does not infer reconciliation from
having sent an abort signal. Hosts must also validate any working directory or
tool policy they derive from their own configuration; the provider-neutral
graph contains neither.

The bundled Delegation V2 host treats cancellation as a two-phase protocol.
Emitting the full-tuple cancel only signals pi-subagents; it keeps the attempt
and reservation owned until an exact matching V2 terminal response arrives.
Wrong-owner and stale responses cannot acknowledge another attempt. If that
terminal response is malformed or does not arrive within the bounded response
window, the host rejects with a non-abort error and reconciles with no terminal
usage so the ledger retains its fail-closed maximum commitment. The tuple then
remains quarantined: new delegation is rejected, graceful disposal and project
deletion remain blocked, and only a later exact, fully validated terminal
response can release ownership. A malformed exact response remains rejected
and cannot release quarantine. That path must never produce
`dagFusionHostAbortSettledV1()`. The cancellation acknowledgement window is
`cancellationAckTimeoutMs` (default 5,000 ms; allowed 1-60,000 ms).

Quarantine state is process-local. The current public pi-subagents event API
does not provide durable cross-process reattachment, so force-killing or
restarting a quarantined host loses the positive-acknowledgement path. The
maximum-charge settlement limits accounting exposure but is not evidence of
provider quiescence; graceful shutdown is mandatory and durable recovery is an
unresolved P0 for production DAG-leaf use and publication. Durable
workflow/accounting recovery must not
be described as reattachment to the lost child execution.

Credentials remain owned by Kady/Pi and must never be serialized into a graph,
receipt, event, log, or package configuration. Receipts identify only the
provider, model, authentication kind/profile name, reasoning level, runtime,
and whether an explicitly permitted fallback was used.

Report suspected vulnerabilities privately to the repository owner before
opening a public issue containing exploit details, credentials, or private
research data.
