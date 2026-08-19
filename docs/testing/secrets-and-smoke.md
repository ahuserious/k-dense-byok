# Secret prefill, the secret-diff gate, and the free-OpenRouter smoke test

Three scripts, one rule: **a value is moved, never shown.** Nothing here prints, logs,
echoes, or commits a credential. Every invocation below has actually been run.

| Script | What it does | Run it |
|---|---|---|
| `scripts/secrets-prefill.mjs` | Assembles the run environment from your local sources and injects it into a child process. | `node scripts/secrets-prefill.mjs --list` |
| `scripts/secret-diff-gate.mjs` | Fails the build when a secret-shaped string appears in a diff's **added lines**. | `node scripts/secret-diff-gate.mjs --base <sha>` |
| `scripts/smoke-openrouter.mjs` | Unmocked end-to-end BYOK smoke test on the cheapest free OpenRouter model. | `node scripts/secrets-prefill.mjs -- node scripts/smoke-openrouter.mjs --require-key` |

Each has a `--help` that explains every mode. None of them needs you to read its source.

---

## 1. `secrets-prefill.mjs` — assemble and inject

### Source precedence, highest first

| # | Source name | Where | Notes |
|---|---|---|---|
| 1 | `ambient-env` | the current process environment | Always wins. Disable with `--no-ambient`. |
| — | `source:<path>` | every `--source <path>`, in the order given | Sorts between 1 and 2. A directory is read one-value-per-file; anything else as `KEY=VALUE`. |
| 2 | `integration-worktree-env` | `/Users/DanBot/Documents/ChatGPT/dfg-integration-20260807-135127/.env` | Default. |
| 3 | `private-evidence-dir` | `/Users/DanBot/Documents/ChatGPT/dfg-evidence-20260807-135127/s11/PRIVATE-do-not-share` | Default. `stably-api-key.txt` → `STABLY_API_KEY`, `stably-project-id.txt` → `STABLY_PROJECT_ID`. |
| 4 | `repo-root-env` | `<repo>/.env` | Default; gitignored. |

`--no-default-sources` drops rows 2-4, so the script works for someone who is not this
repository's owner: point it at your own layout with `--source`.

A **missing** source is a skip with a named reason (`SKIPPED — path does not exist`), never
an error and never a silent zero. An **unparseable** source is an error that names the file
and the **line number** — never the line's content.

A directory file is skipped, by name and with a reason, when it is not a regular file, is
larger than 4096 bytes, is not a single line, is empty, or has a name that does not map to a
variable name. A file readable beyond its owner is loaded but reported.

### Modes

```
node scripts/secrets-prefill.mjs --list                    # NAME / SOURCE / present-absent, exit 0
node scripts/secrets-prefill.mjs --help                    # every mode, exit 0
node scripts/secrets-prefill.mjs -- <command> [args...]    # inject, inherit stdio, exit with the child's code
node scripts/secrets-prefill.mjs --write <path>            # write an env file, if and only if git allows it
```

Injection mode is what CI and the smoke test use. The environment reaches the child through
the process table only — nothing is staged on disk to do it (there is a test that asserts the
working directory is byte-for-byte unchanged across an injection run).

### The refuse-to-write rule

`--write <path>` resolves the path, then asks git twice, **in the target's own directory**:

- `git ls-files --error-unmatch -- <path>` — is it tracked?
- `git check-ignore --quiet -- <path>` — is it ignored?

It writes (mode `0600`) **only if the path is untracked AND ignored**. Anything else is a
refusal that names the path and the reason and exits 1:

- tracked → *"git tracks this path; writing a secret here would commit it"*
- not ignored → *"git does not ignore this path; an untracked-but-unignored file is one `git add .` from being committed"*
- not inside a git repository at all → refused, because the question cannot be answered

### What it never does

There is deliberately **no** `--emit-for-eval NAME` mode. A value printed to stdout for
`VAR="$(…)"` capture lands in shell history and in any `set -x` trace. Injection mode covers
every use it would have had. Every byte the script writes is scrubbed against the
representations of every value it loaded (via `scrubText` / `findSecretRepresentation` from
`scripts/hosted-evidence-secrets.mjs`) and re-scanned before it is emitted; a value that
somehow survived scrubbing aborts the write instead of leaking.

Injection mode inherits the child's stdio. What the **child** prints is the child's
responsibility — point it at a command that does not print secrets.

---

## 2. `secret-diff-gate.mjs` — the gate

```
node scripts/secret-diff-gate.mjs --base <sha> [--head <sha>]   # commit range, head defaults to HEAD
node scripts/secret-diff-gate.mjs --base <sha> --worktree       # base vs the working tree + untracked files
```

Scope is the prior art's: **added lines only** (`git diff --unified=0`, `^+` lines that are
not `+++` headers).

It reports **counts and file names only** — never a matched substring, never a line's
content, never a line number.

### The two halves

- **Fourteen shape patterns**, reproducing the pre-push scan's printed report row for row:
  `openai sk-`, `aws AKIA`, `github ghp/pat`, `slack xox`, `private key`, `google AIza`,
  `jwt`, `tailscale tskey`, `ngrok authtoken-shaped`, `generic key=long`, `tailnet host`,
  `ngrok domain`, `operator email`, `local abs path`.
  (The brief's prose says "12 credential patterns" while the artifact prints 14 rows; rows
  11-14 are host/PII leaks rather than credentials. The gate ships the **superset**.)
- **`env var value (any encoding)`** — the value-derived check. Every secret-shaped variable
  in the gate's own environment is expanded by `collectSecretRepresentations` from
  `scripts/hosted-evidence-secrets.mjs` into all of its encodings (raw, JSON-escaped,
  percent, strict RFC3986, `+`-for-space, form-encoded, base64, base64url) and the added
  lines are searched for those. This catches the real leak the regexes miss: the actual key,
  base64'd into a fixture. It reports the variable **NAME** — a name is not a value.

The `operator email` pattern deliberately does not embed the operator's address (that would
itself be the leak). It matches any address outside a documented example/reserved list.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | clean |
| 1 | findings — at least one non-allowlisted hit |
| 2 | usage or environment error, an allowlist entry without a reason, or a git failure |

It never exits 0 on an error. **Never pipe it into anything**: capture to a log and test `$?`.

### Adding an allowlist entry

Entries live in `ALLOWLIST` in `scripts/secret-diff-gate.mjs`. Each needs an exact
repo-relative path, a pattern id, and a **reason of at least ten characters** — an entry
without one fails the gate itself (exit 2).

```js
{
  path: "server/test/raindrop-context.test.ts",
  patternId: "openai-sk",
  reason: "Raindrop context fixture pins a synthetic sk- shaped string so the redaction test has something to redact.",
},
```

`patternId: "*"` covers every *shape* pattern for a path — for a file whose whole purpose is
to hold one fixture per pattern, like this gate's own test. It deliberately does **not**
cover `env-value`: a real key encoded into a fixture must fail the gate whatever file it is
in, so the check that searches for actual environment values can never be wildcarded away.

An allowlisted hit prints as `(allowlisted) <path>: <count>` and does not fail the gate.

---

## 3. `smoke-openrouter.mjs` — the BYOK smoke test

### The two modes, and what each proves

| Mode | What runs | What it proves |
|---|---|---|
| `--mode product` (default) | `scripts/smoke-openrouter-runtime.mjs` under `server/node_modules/.bin/tsx`: `ModelRuntime.create` → `setupModelRuntime` (`server/src/agent/models.ts`, where `OPENROUTER_API_KEY` becomes `setRuntimeApiKey("openrouter", …)`) → `new ModelRegistry` → `resolveModel` → `assertModelAuthentication` → `ModelRuntime.complete` | **This repository's own BYOK path.** The same chain a chat turn or a LaTeX-assist call takes (`server/src/latex/assist.ts:122`). |
| `--mode direct` | one HTTPS POST to `<base>/chat/completions` | The network is up and the key is valid. It does **not** prove this repository's BYOK path — nothing under `server/src` ran. The script says so in its own output. |

The product-mode driver uses an **in-memory credential store** rather than the owner's Pi
`auth.json`, so the key never touches disk and the test cannot pass off a previously stored
credential: it passes only if the key in *this run's environment* reached the provider. It
also runs with `allowModelNetwork: false` and `modelsPath: null`, so the completion is the
only request it makes. It boots no server and binds no port.

There is no `--mode server`: no backend HTTP route performs a single completion without a
project sandbox and a live agent session, and booting one would prove less than product mode
already proves.

### Model resolution — never hardcoded

The live catalogue is fetched and every **strictly free** model is ranked: every numeric
field of `pricing` must be zero, not merely a `:free` suffix and not merely zero
prompt/completion while a fee hides in another field. Ties break on the smallest context
window, then the id, so the choice is deterministic. Up to `--max-candidates` (default 3) are
tried in order; if a candidate refuses the request the next is tried and the reason is
printed. With **no** free model, the script fails closed rather than falling back to a paid
model or to an id nobody verified.

### Key handling

The key is read from `OPENROUTER_API_KEY` and from nowhere else. `--api-key`, `--key` and
`--token` are rejected with an explanation (a key on the command line lands in `ps` output
and shell history), and an argument that merely *looks* like a key is refused. Every byte the
script writes is scrubbed against every representation of the key first.

### Absent key

```
SKIP: OPENROUTER_API_KEY is not set; the BYOK smoke test proves nothing without a real key.
```

Exit 0. It never prints `PASS` without a key. `--require-key` turns that absence into exit 2
— that is what CI uses when the secret is supposed to be present.

### Assertions — on the response, not the request

- the completion text is non-empty
- the model id the provider returned matches the one requested
- token usage was recorded

Plus the elapsed time for the call and for the whole run.

---

## 4. Real invocations

### The prefill listing (no values, ever)

```
$ node scripts/secrets-prefill.mjs --list
Sources, highest precedence first:
  - ambient-env: loaded 85 name(s) — (process environment)
  - integration-worktree-env: loaded 7 name(s) — /Users/DanBot/Documents/ChatGPT/dfg-integration-20260807-135127/.env
  - private-evidence-dir: loaded 2 name(s) — /Users/DanBot/Documents/ChatGPT/dfg-evidence-20260807-135127/s11/PRIVATE-do-not-share
      · agent-run4-provenance-summary.json.orig: not a single-line value
      · cloud-agent_clean-run-provenance.jsonl.orig: larger than 4096 bytes; not a single-value file
      · cloud-run-final_funnel-provenance.jsonl.orig: larger than 4096 bytes; not a single-value file
      · local-fingerprint-denylist-RAW.json: not a single-line value
  - repo-root-env: SKIPPED — path does not exist — /Users/DanBot/Documents/ChatGPT/sds-lane-f10b/.env

NAME                         SOURCE                    STATUS
---------------------------  ------------------------  ------
CLAUDE_CODE_MESSAGING_TOKEN  ambient-env               present
DEFAULT_MODEL_ID             integration-worktree-env  present
DEFAULT_MODEL_PROVIDER       integration-worktree-env  present
EODHD_API_KEY                ambient-env               present
EXA_API_KEY                  integration-worktree-env  present
HIVE_CREDENTIAL_KEY          ambient-env               present
LINEAR_API_KEY               ambient-env               present
MAX_THINKING_TOKENS          ambient-env               present
MODAL_TOKEN_ID               integration-worktree-env  present
MODAL_TOKEN_SECRET           integration-worktree-env  present
OLLAMA_BASE_URL              integration-worktree-env  present
OPENAI_API_KEY               ambient-env               present
OPENROUTER_API_KEY           ambient-env               present
OPENROUTER_BASE_URL          -                         absent
ORCA_AGENT_HOOK_TOKEN        ambient-env               present
SSH_AUTH_SOCK                ambient-env               present
STABLY_API_KEY               private-evidence-dir      present
STABLY_PROJECT_ID            private-evidence-dir      present
SUPERMEMORY_API_KEY          ambient-env               present
TELEGRAM_BOT_TOKEN           ambient-env               present
VOYAGE_API_KEY               ambient-env               present
XAI_API_KEY                  ambient-env               present

21 of 22 reported name(s) present. Values are never printed.
```

### The gate, against an uncommitted lane

```
$ node scripts/secret-diff-gate.mjs --base b702a8b --worktree
# Secret/PII diff gate — b702a8b..worktree, working tree

Counts of ADDED lines matching each pattern, by file. Values never printed.

- openai sk-: 3 in 2 files
    - (allowlisted) scripts/secret-diff-gate.test.mjs: 2
    - (allowlisted) scripts/smoke-openrouter.test.mjs: 1
…
- env var value (any encoding): 0

Scanned 2648 added lines across 8 files.
$ echo $?
0
```

### The live BYOK smoke test, with the key injected by the prefill script

```
$ node scripts/secrets-prefill.mjs -- node scripts/smoke-openrouter.mjs --require-key
MODEL RESOLUTION: 19 strictly-free model(s) in the live catalogue; ranked cheapest-first, will try up to 3.
MODE: product
  proves: this repository's own BYOK path — server/src/agent/models.ts setupModelRuntime() injecting the key, resolveModel(), assertModelAuthentication(), ModelRuntime.complete().
ATTEMPT: nvidia/nemotron-3.5-content-safety:free
MODEL: nvidia/nemotron-3.5-content-safety:free
RESOLVED REF: openrouter/nvidia/nemotron-3.5-content-safety:free
STOP REASON: stop
REPLY (model output, first 200 chars): "User Safety: safe"
ASSERT the completion text is non-empty: PASS — 17 characters
ASSERT the returned model id matches the requested one: PASS — requested=nvidia/nemotron-3.5-content-safety:free returned=nvidia/nemotron-3.5-content-safety:free
ASSERT token usage was recorded: PASS — input=472 output=5 total=477 costUsd=0
ELAPSED: 578 ms for the call, 3190 ms total
RESULT: PASS
$ echo $?
0
```

(The top-ranked free model that day was a content-safety classifier, which answers
`User Safety: safe` rather than `pong`. The assertions are on the *response's* shape — text,
model id, usage — not on its wording, precisely so that resolving the model instead of
hardcoding one does not make the test brittle.)

### The tests

```
$ node --test scripts/*.test.mjs                       # hermetic: no network, no real key
$ KADY_SOCKET_TESTS=1 node --test scripts/*.test.mjs
$ KADY_SMOKE_LIVE=1 node --test scripts/smoke-openrouter.test.mjs   # adds the one live leg
```

The network-dependent path is **not** run under `node --test` unless `KADY_SMOKE_LIVE=1` is
set, so the battery stays hermetic.

---

## 5. CI wiring

This lane does not own `.github/workflows/`. The exact YAML to add is in `INTEGRATION.md` at
the repository root, for the workflow-owning lane to paste in. In summary:

- run `node scripts/secret-diff-gate.mjs --base "$BASE_SHA"` on every pull request, capturing
  to a log and testing `$?` (never piping);
- run `node scripts/smoke-openrouter.mjs --require-key` in a job that has
  `OPENROUTER_API_KEY` in its environment, so an absent secret fails loudly instead of
  passing quietly.
