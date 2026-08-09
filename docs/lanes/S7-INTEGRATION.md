# S7 post-Wave-B integration seams

S7 owns and registers `restart-workflow`, `escalate-fix-redeploy`, and
`lateral-pass` behavior implementations. Two consumers remain deliberately
deferred so this lane does not cross active ownership boundaries:

## Merge-time bootstrap and hooks

Import `registerContextEngineering` from
`server/src/workflows/context-watcher.ts`, then install S7 exactly once during
server bootstrap:

```ts
const contextEngineering = registerContextEngineering({ registry: workflowBehaviorRegistry, runner: contextEngineeringRunnerDeps, sessions: contextEngineeringSessionDeps, models: contextEngineeringModelDeps, budget: contextEngineeringBudgetDeps });
```

Feed each runner-owned, exact pre/post compaction record through this hook after
the deterministic audit sidecar is durable:

```ts
await contextEngineering.watcher.watch(compactionRecord);
```

Dispatch the session-owned clean-window request through the frozen registry:

```ts
await workflowBehaviorRegistry.dispatch(LATERAL_PASS_BEHAVIOR, lateralPassDispatch);
```

`contextEngineeringRunnerDeps.operationStore` must be a
`FileCompactionWatcherOperationStore` rooted in the selected project's canonical
sandbox. Its operation identity is `(runId, nodeId, auditIdentity)`; it persists
the deployed revision and verified restart proof before restart, and serializes
same-operation calls.

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
- The S7 watcher consumes the trusted child-run fingerprint sidecar first and
  accepts the exact pre-compaction record and installed summary as bounded
  in-memory semantic-model input. The S4 node-executor owner must supply those
  two values from the child session record when it wires the registered watcher;
  S7 does not weaken `compaction-audit.ts` by persisting transcript or summary
  contents in its deterministic sidecar.
- The S8 helper-context projection currently contains a generic statement that
  helpers have no tools. The dedicated rescue session's system prompt and live
  tool registry are authoritative for its assigned `workflow_rescue_read`
  capability; S8 should specialize that projection copy after Wave B so the
  user-visible boundary text names the `workflow_rescue_read` exception.

The proposal-only rescue helper does not gain restart authority. Runner
auto-rescue also remains separate from watcher-owned restart.
