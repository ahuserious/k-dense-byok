# Workflow harnesses

A **harness** is the CLI runtime a workflow node's work is dispatched to. It is declared per node as
`settings.harness`, or workflow-wide as `settings.defaultHarness` (the node's own value wins). The literal
set is frozen by `docs/contracts/NODESPEC-V1.md`; the implementation is one table.

## The registry is the table

`server/src/workflows/harness-registry.ts` holds one row per harness: the literal, a human label, the
candidate executables, the adapter (or none), a summary, and whether it exposes a user-editable binary
path. Everything else derives from it:

| Consumer | What it takes |
| --- | --- |
| `server/src/workflows/schema.ts` — `HarnessSchema` | the frozen TypeBox union; a compile-time guard asserts it equals `WorkflowHarnessId` in both directions |
| `server/src/workflows/supervisor/protocol.ts` — `WORKFLOW_HARNESSES` | `WORKFLOW_HARNESS_IDS`, so the wire validator cannot drift from the schema |
| `server/src/agent/workflow-delegation-session.ts` — `WorkflowHarness`, the dispatch decision | the id union and `selectWorkflowHarnessAdapter` |
| `server/src/workflows/validate.ts` — `ResolvedNodeSpecV1.harness` | the id union |
| `server/src/api/harness.ts` — `GET /harnesses` | label, executables, adapter presence, resolvability |
| `docs/inventory/f2-harness.json` | a machine-readable snapshot, pinned against the registry by `server/test/harness-inventory.test.ts` |

**Adding a harness is one row** plus its literal in `HarnessSchema` (kept spelled out because
`freeze-check.sh` reads the literals out of that file, and a mapped union would widen `Static<>` to
`string`). If the two disagree, the build fails.

## The harnesses

| Literal | Label | Executable candidates | Adapter | State |
| --- | --- | --- | --- | --- |
| `pi` | Pi (built in) | `pi` | `pi-delegation` | **Bound.** The default. The vendored `pi-subagents` delegation runtime, and the only harness the node-control envelope targets. |
| `claude-code` | Claude Code CLI | `claude` | `claude-code-relay` | **Bound.** Invoked in print (`-p`) mode; see below. |
| `codex` | Codex CLI | `codex` | — | Fails closed at the dispatch decision. |
| `opencode` | OpenCode CLI | `opencode` | — | Fails closed at the dispatch decision. |
| `copilot` | GitHub Copilot CLI | `github-copilot`, `copilot` | — | Fails closed at the dispatch decision. |
| `deepseek` | DeepSeek CLI | `deepseek`, `deepseek-cli` | — | Fails closed at the dispatch decision. |
| `grok-cli` | Grok CLI | `grok`, `grok-cli` | — | Fails closed at the dispatch decision. |
| `oh-my-pi` | oh-my-pi | `oh-my-pi`, `ohmypi` | — | Fails closed at the dispatch decision. |

### About the candidate names

Each adapterless harness lists more than one candidate for the same reason the pre-existing `copilot` row
already did: the package name and the installed command frequently differ, and probing only one produces a
*wrong* diagnostic ("not installed") for a machine that has it. The candidates are a discovery hypothesis,
not a verified inventory — none of these CLIs is installed on the machine this lane was built on. They are
data in one table, the fail-closed message prints them, so a wrong guess is visible to the user and is a
one-line correction.

## The dispatch decision

`selectWorkflowHarnessAdapter` is reached by **both** transports before the node executor reserves any
budget:

- in-process — `dispatchWorkflowHarness` (`agent/workflow-delegation-session.ts`)
- supervised, and therefore production — `WorkflowSupervisorClient.nodeExecutorDependencies()
  .getDelegationSession` (`workflows/supervisor/client.ts`); `server/src/index.ts` boots the
  out-of-process supervisor on every real server start

It **returns the selection** — harness, label, adapter, resolved executable — rather than only failing to
throw, so a caller can assert which adapter was chosen.

### What fails closed, and with which message

| Code | When | Message |
| --- | --- | --- |
| `WORKFLOW_HARNESS_NOT_INSTALLED` | no candidate command exists on this machine | `Workflow harness <id> is not installed. Install one of: <candidates>.` |
| `WORKFLOW_HARNESS_NOT_BOUND` | a candidate exists, but this build has no adapter | `Workflow harness <id> is installed as <command>, but this Kady build has no trusted delegation adapter for it. Select a harness with an adapter, or keep the node on pi.` |
| `WORKFLOW_HARNESS_NOT_BOUND` | `claude-code` selected, but the binary does not resolve | the resolution detail — install instructions, or the rejection of the path the user supplied |
| `WORKFLOW_HARNESS_NOT_BOUND` | `claude-code` selected on a node whose bindings the relay cannot honour | `This node cannot run on the Claude Code CLI: <reasons>. Change <controls> on this node, or run it on the pi harness.` |

No message contains a filesystem path the user did not themselves supply (#71). The *fact* that a candidate
resolved is reported; the path it resolved to is not.

### Nodes that reach no dispatch decision

`kady-node-executor.ts` asks for a delegation session only when
`callCeiling > 0 && !hostedFusionWithoutPolicyEvaluator`. When that is false the node starts no child
process, so `harness` would be accepted and then discarded — the shape of #55. Such a node's non-`pi`
`harness`, or inherited `defaultHarness`, is **refused at validation**
(`unreachable-node-harness` / `unreachable-inherited-harness`) rather than silently dropped.

Both the executor's predicate and the validator's are computed by
`workflowHarnessDispatchReachability` (`workflows/harness-dispatch-reachability.ts`), so they cannot
drift. The node kinds it covers today:

| Node | Reaches the decision? |
| --- | --- |
| hosted Fusion (`fusion.mode: "openrouter-router"`) with no evidence-policy evaluation | **no** — refused |
| `lean4` with `mode: "verify"` | **no** — refused (no model call; the lean4 branch delegates only on `solve`) |
| `evidence-gate` with no `evaluator` and only `artifact-exists` checks | **no** — refused |
| `lean4` with `mode: "solve"` | yes |
| `evidence-gate` with an evaluator, or any check other than `artifact-exists` | yes |
| hosted Fusion with evidence-policy evaluation | yes |
| `agent`, `research-until-goal`, `council`, `best-of-n`, `kady-panel` fusion, `prompt-optimization` | yes |

## Claude Code: resolution, override, and the relay

### Resolution order

`server/src/workflows/claude-code-relay.ts` resolves the executable in this order, stopping at the first
answer and never falling through past a bad one:

1. the persisted override (`~/.kady/harness-settings.json`, `claudeCode.binaryPath`)
2. the `CLAUDE_BIN_PATH` environment variable
3. the canonical native-installer location, `~/.local/bin/claude` (`claude.exe` on Windows)
4. a PATH scan for the registry's `claude-code` candidates

Steps 2 and 3 are the vendored engine's own order
(`server/vendor/pipeline-engine/packages/providers/src/claude/binary-resolver.ts`). The host re-declares
them because it cannot import that module — it statically imports a package from the vendored engine's own
bun workspace, which is not installed on the Kady server's module path, and the vendored engine runs as a
separate bun process.
`server/test/claude-code-relay-vendor-parity.test.ts` reads the vendored file and fails the build if the two
drift.

Step 1 is host-only and deliberate: the vendored resolver's config override sits *below* its
`if (!BUNDLED_IS_BINARY) return undefined;` short-circuit, so in dev mode — the mode this repo runs in —
routing the user's override through it would have produced a Settings control that silently did nothing.

Step 4 is host-only too: the vendored resolver may return `undefined` and let the Claude Agent SDK find its
own bundled binary. A host that must `spawn()` has no such fallback.

### States

| State | Meaning | What the UI shows |
| --- | --- | --- |
| `resolved` | a path was found; `source` says which step won | the path, and where it came from |
| `not-found` | nothing resolved | install instructions and the path editor, harness not selectable |
| `rejected` | the user's override does not point at an executable file | the reason, quoting *their* path, harness not selectable |

An override naming a directory that contains the executable expands to the contained file, matching the
vendored resolver's behaviour. Anything else is rejected — never silently replaced with a different binary.

### The relay

`harness: "claude-code"` dispatches to `claude-code-relay`, which invokes the resolved binary as:

```
<binary> -p --output-format json [--model <id>] [--system-prompt <override>] \
         --tools <mapped> --allowedTools <mapped> --disallowedTools <denied> \
         --permission-mode default --strict-mcp-config --safe-mode \
         --max-turns <n>
```

with the node's task on **stdin** (never as an argument, and never through a shell). The `-p` argv is built
here rather than taken from the vendored provider: that provider calls the Claude Agent SDK's `query()` and
the SDK applies `-p` internally, so there is no argv in this repo to reuse.

**A relayed node leaves the supervised transport.** When the registry selects this adapter,
`supervisor/client.ts` returns a host that spawns the CLI **in the backend process** rather than routing
through `delegate(...)` to the out-of-process supervisor. The isolation that is the supervised transport's
reason to exist does not apply to a relayed child, and `delegateOptions.supervisedBudget` is not read by
the relay, so the supervisor-side budget descriptor never sees a relayed run. This is deliberate — the CLI
is host-owned and there is no supervisor-side process to own it — but Teams A and C would otherwise assume
the opposite.

#### What the relay binds, and what it refuses

| Node binding | On the relay |
| --- | --- |
| `settings.harness` | **bound** — selects this adapter at the shared dispatch decision |
| the node task / prompt | **bound** — stdin |
| `claudeCode.systemPrompt` | **bound** — `--system-prompt` |
| structured-output `result.schema` | **bound** — the exact JSON Schema the slot demands is appended to stdin, and the parsed object goes back on the receipt as `result.kind: "structured"` |
| `autonomy` / `toolPolicy.allowedTools` | **bound** — translated into `--tools`, the CLI's availability cap, and pre-approved with the same list on `--allowedTools`; plus `--disallowedTools` (`mcp__*`, `Agent`, `Task`, and every write/exec/network built-in), `--permission-mode default`, `--strict-mcp-config` and `--safe-mode`. Mapping: `read`→`Read`, `grep`→`Grep`, `find`→`Glob`, `ls`→`Glob`. An id with no mapping is **refused**, so a tool added to Pi's vocabulary later cannot silently vanish from the relayed child's policy |
| `turnBudget` | **bound** — `--max-turns (maxTurns + graceTurns)` |
| `model` | **bound after validation** — `request.model` is `provider/id`; only `anthropic/<id>` translates, and the provider prefix is stripped. Anything else is **refused** |
| `hyperparameters.temperature` / `top_p` / `sampling` | **refused** — the CLI has no sampling flags |
| `subagents.permitted` (i.e. `autonomy: "loose"`) | **refused** — the CLI's nearest equivalent is the `Agent` tool (`Task` on older builds), whose children are *not* bound by this node's tool cap, so granting it would grant strictly more than the node declared. Both names are denied on every launch as well, so the refusal does not depend on the node asking honestly |
| effective skills (`skills.configured`, `skills.delegated`, or `request.skill`, including auto discovery and the required `byom-dag-fusion` skill) | **refused** — the relay cannot inject them, so none may be silently dropped |
| `toolBudget` | **not bound** — the CLI counts turns, not tool calls. Published as an `unboundControls` entry on `GET /harnesses`; F8/F1 render the control disabled with that reason |
| `billingMode` | **not bound** — see the billing boundary below |
| `supervisedBudget` | **not bound** — see the supervised-transport note above |

`--permission-mode` is `default`, never `bypassPermissions`: in `-p` mode an approval prompt cannot be
answered, so a tool that needs approval and has none fails closed.

#### Why `--tools`, and not `--allowedTools` alone (round-3 correction)

This section previously said the allowlist plus `--permission-mode default` meant "anything outside
`--allowedTools` fails … fail-closed by construction". **That was false, and the round-3 reviewer was right
to call it a security-boundary failure rather than a documentation slip.** The Claude Code CLI reference
describes `--allowedTools` as the tools that "execute without prompting for permission" and says, in the
same row, that restricting *which tools are available* requires `--tools`. An allowlist of `Read,Grep,Glob`
therefore left the whole built-in set in the child's context and only removed the prompt for three of them.
The deny list was carrying the entire boundary, and it denied the obsolete `Task` name while the live tools
reference documents `Agent` as the subagent-spawning built-in with *Permission required: No* — so a node
whose envelope said `subagents.permitted: false` could still reach a subagent.

What the launch carries now, and what each part is for:

| Flag | Role |
| --- | --- |
| `--tools <list>` | **The cap.** Restricts the built-in set to exactly the translated list; `""` disables every built-in tool, which is what a node granting nothing gets. Does not affect MCP tools |
| `--allowedTools <list>` | Approval only — the same list, so the capped tools run without a prompt `-p` could not answer |
| `--disallowedTools mcp__*,Agent,Task,…` | Removes every MCP tool (the documented way, since `--tools` does not reach them) and re-denies the subagent and write/exec/network built-ins as a second lock |
| `--permission-mode default` | Never `bypassPermissions`; `manual` is the alias `--help` lists for the same mode |
| `--strict-mcp-config` | With no `--mcp-config`, the child loads **zero** MCP servers, so the `mcp__*` rule has nothing left to fire on |
| `--safe-mode` | No skills, plugins, hooks, custom agents, output styles or `CLAUDE.md`. The relay already *refuses* a node asking for delegated skills; this makes that true of the launch, so a `.claude/` directory in the node's cwd cannot widen the grant |

**The policy is verified against the binary, not assumed.** `assertClaudeCodeCliSupportsPolicy` reads the
resolved binary's own `--help` once per path per process and refuses the adapter with
`WORKFLOW_HARNESS_NOT_BOUND` when any of those flags is not advertised, naming the missing flag and the
user's next action. A confinement expressed in flags a binary does not implement is not a confinement, and
the failure would otherwise be silent. Verified against 2.1.237; `claude-code-relay.test.ts` asserts the
argv, the whole-token flag matching, the fail-closed paths, and — against the binary actually installed on
the machine running the suite — that every required flag is advertised.

**The billing boundary.** `billingMode` is admitted against the Kady provider/auth the node *resolved*
(`assertS4BillingMode`), while the actual call is billed to whatever credentials the local `claude` binary
holds. Refusing a non-Anthropic model reference keeps the model identity honest; it does not make the
billing identity the same one. A billing-mode control must not be rendered as if the relay honoured it.

- The `KADY_NODE_CONTROL_V1:` envelope the executor prefixes onto the task is a Pi-extension protocol. The
  relay decodes it, keeps it out of the Claude prompt, and uses it for the table above. Dropping any of it
  silently would be defect #54 one harness over — and for the tool policy it would also be a
  security-relevant drop.
- The receipt records the relay path: `resolved.agent` is `claude-code-relay` and
  `resolved.launchContractDigest` is a sha256 over the binary path, working directory, argv, system
  prompt and stdin — the complete launch contract, with no filesystem path exposed in the receipt (#71).
- The trusted pre/post-compaction audit is a `pi-subagents` artifact and is not demanded of a relay
  adapter, which runs one non-compacting invocation. The decision is made from the local dispatch
  selection, never from anything the child said.

### Overriding the Claude system prompt

`claudeCode.systemPrompt` (bounded at 16 KiB) is passed to the invoked binary as `--system-prompt`,
replacing Claude Code's own preset for relayed workflow nodes. When unset the flag is omitted entirely.

## The endpoint

Registered by `registerHarnessRoutes` (`server/src/api/harness.ts`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/harnesses` | every harness, its adapter state, resolvability, and the Claude Code path/system-prompt state |
| `PUT` / `POST` | `/harnesses/claude-code/binary-path` | set the override; rejected with `400 unresolvable-path` before persisting if it does not resolve |
| `DELETE` | `/harnesses/claude-code/binary-path` | clear the override |
| `PUT` / `POST` | `/harnesses/claude-code/system-prompt` | set the system-prompt override |
| `DELETE` | `/harnesses/claude-code/system-prompt` | clear it |

Every `GET` field is always present (`null`, never absent), so a client destructuring the payload cannot
throw in render phase (#62). `unboundControls` is always an array — empty for a harness with nothing to
report — and each entry is `{ control, reason }`: the node control the selected adapter cannot apply, and
one renderable sentence saying why. That is §6.7's "disabled with a visible reason" delivered as data, so
a picker never has to guess. The wire shapes are specified field by field in
`s11/wave-f/interfaces/F2-harness-and-nodecontrol.md`.

## Where settings live

`~/.kady/harness-settings.json`, overridable with `KADY_HARNESS_SETTINGS_PATH`. This follows the
`~/.kady/<purpose>` convention `server/src/config.ts` already establishes three times (`pi-agent`,
`skills-cache`, `personality-store`) and the atomic write-then-rename idiom used by
`agent/capability-state.ts` and `sandbox-seed.ts`. A missing, unreadable or malformed file reads as "no
override" — a corrupt settings file must not make every workflow node fail.
