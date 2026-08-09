# S7 post-Wave-B integration seams

S7 owns and registers `restart-workflow`, `escalate-fix-redeploy`, and
`lateral-pass` behavior implementations. Two consumers remain deliberately
deferred so this lane does not cross active ownership boundaries:

- The seeded `dag-workflow-rescue` specialist still declares
  `inheritSkills: false` in S5-owned `server/src/agent/subagents.ts`. The
  dedicated `workflow-rescue` session is wired independently: it receives only
  the `read` tool and an absolute pointer to the committed Scientific DAG Studio
  skill while extensions, project skills, MCP, and write/control tools remain
  disabled. Post-Wave-B integration should decide whether the separately seeded
  specialist should inherit that same skill.
- Vendored workflow routes still return their S2b `resumable`,
  `restartRequired`, and `restartWarning` response fields. The watcher restart
  seam accepts that response shape, records `resumable: false` as upstream
  evidence, and still issues an origin-independent `resume: true` restart. The
  vendored route must not advertise or consume watcher authority until its owner
  integrates the behavior registry after Wave B.
- The S7 watcher consumes the trusted child-run fingerprint sidecar first and
  accepts the exact pre-compaction record and installed summary as bounded
  in-memory semantic-model input. The S4 node-executor owner must supply those
  two values from the child session record when it wires the registered watcher;
  S7 does not weaken `compaction-audit.ts` by persisting transcript or summary
  contents in its deterministic sidecar.
- The S8 helper-context projection currently contains a generic statement that
  helpers have no tools. The dedicated rescue session's system prompt and live
  tool registry are authoritative for its assigned `read` capability; S8 should
  specialize that projection copy after Wave B so the user-visible boundary text
  names the same read-only exception.

The proposal-only rescue helper does not gain restart authority. Runner
auto-rescue also remains separate from watcher-owned restart.
