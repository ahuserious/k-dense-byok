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
| `WORKFLOW_HARNESS_NOT_BOUND` | `claude-code` selected on a node declaring sampling controls | `The Claude Code CLI cannot apply <fields>. Remove those node settings, or run this node on the pi harness.` |

No message contains a filesystem path the user did not themselves supply (#71). The *fact* that a candidate
resolved is reported; the path it resolved to is not.

### Hosted-Fusion-only nodes

A hosted-Fusion node whose whole call ceiling is served by the OpenRouter router requests no delegation
session, so it starts no CLI process for any harness to be. A non-`pi` `harness` or inherited
`defaultHarness` on such a node is **refused at validation** (`unreachable-node-harness` /
`unreachable-inherited-harness`) rather than accepted and discarded.

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
<binary> -p --output-format json [--model <model>] [--system-prompt <override>]
```

with the node's task on **stdin** (never as an argument, and never through a shell). The `-p` argv is built
here rather than taken from the vendored provider: that provider calls the Claude Agent SDK's `query()` and
the SDK applies `-p` internally, so there is no argv in this repo to reuse.

- The `KADY_NODE_CONTROL_V1:` envelope the executor prefixes onto the task is a Pi-extension protocol. The
  relay decodes it, keeps it out of the Claude prompt, and uses it to refuse — before spawning — a node
  whose `hyperparameters.temperature` / `top_p` / `sampling` the CLI has no flags for. Dropping them
  silently would be defect #54 one harness over.
- The receipt records the relay path: `resolved.agent` is `claude-code-relay` and
  `resolved.launchContractDigest` is a sha256 over the binary path, the argv and the system prompt — a
  pathless proof of exactly what was launched.
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
throw in render phase (#62). The wire shapes are specified field by field in
`s11/wave-f/interfaces/F2-harness-and-nodecontrol.md`.

## Where settings live

`~/.kady/harness-settings.json`, overridable with `KADY_HARNESS_SETTINGS_PATH`. This follows the
`~/.kady/<purpose>` convention `server/src/config.ts` already establishes three times (`pi-agent`,
`skills-cache`, `personality-store`) and the atomic write-then-rename idiom used by
`agent/capability-state.ts` and `sandbox-seed.ts`. A missing, unreadable or malformed file reads as "no
override" — a corrupt settings file must not make every workflow node fail.
