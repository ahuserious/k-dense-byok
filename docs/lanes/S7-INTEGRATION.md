# S7 production integration and deferred seams

S7 owns and registers `restart-workflow`, `escalate-fix-redeploy`, and
`lateral-pass` behavior implementations.

## Production bootstrap and hooks

The granted server composition point installs one production coordinator:

```ts
const contextEngineering = new ContextEngineeringProduction(workflowController, options.contextEngineering);
```

The DAG Fusion bridge terminal hook feeds the durable fingerprint and semantic
records into the coordinator through the server-local write-ahead queue. Failed
deliveries retain their record with exponential backoff, and registration drains
the queue on process boot:

```ts
this.removeCompactionSink = installDagFusionCompactionEventSink((event) => this.handleDagFusionCompaction(event), { onError: this.onError });
```

The session route dispatches lateral pass through the registered behavior:

```ts
return await contextEngineering.dispatchLateralPass(projectId, lateralPassRequest);
```

Each project gets its own registry and `FileCompactionWatcherOperationStore`
rooted in the canonical sandbox. The durable stopped-run poll feeds interrupted
and failed states into watcher-owned restart/proposal handling. Operation
identity remains `(runId, nodeId, auditIdentity)`.

## Deferred cross-lane seams

- The seeded `dag-workflow-rescue` specialist still declares
  `inheritSkills: false` in S5-owned `server/src/agent/subagents.ts`. The
  dedicated `workflow-rescue` session is wired independently: it receives only
  the custom `workflow_rescue_read` tool. That tool uses realpath containment,
  permits bounded text reads only from the selected run's artifacts directory
  or the exact canonical Scientific DAG Studio `SKILL.md`, and denies all other
  absolute, home, symlink, extension, and oversized-file reads. Extensions,
  project skills, MCP, built-in filesystem tools, and write/control tools remain
  disabled. Post-Wave-B integration should decide whether the separately seeded
  specialist should inherit that same skill.
- Vendored workflow routes still return their S2b `resumable`,
  `restartRequired`, and `restartWarning` response fields. The watcher restart
  seam preserves that complete response shape and fails closed: it restarts only
  with a verified exact-run checkpoint/restart token plus declared side-effect
  safety. A non-resumable or restart-required response, or missing proof, creates
  an unapplied rescue proposal instead of calling restart. The vendored route
  must not advertise or consume watcher authority until its owner integrates the
  behavior registry after Wave B.
- The deterministic fingerprint JSONL remains the cheap first pass. A separate,
  bounded semantic record is durable beside it and is consumed only after the
  DAG Fusion terminal event identifies the exact child run.
- The S8 helper-context projection currently contains a generic statement that
  helpers have no tools. The dedicated rescue session's system prompt and live
  tool registry are authoritative for its assigned `workflow_rescue_read`
  capability; S8 should specialize that projection copy after Wave B so the
  user-visible boundary text names the `workflow_rescue_read` exception.

The proposal-only rescue helper does not gain restart authority. Runner
auto-rescue also remains separate from watcher-owned restart.
