# Secret prefill, the secret-diff gate, and the free-OpenRouter smoke test

Three scripts, one rule: **a value is moved, never shown.** Nothing here prints, logs,
echoes, or commits a credential. Every invocation below has actually been run.

One convention in the pasted output: a **`N`** or **`M`** in place of a number is elided on
purpose. Counts that depend on the size of the diff (added lines, files scanned) change on
every commit, so pinning one here would make this file wrong the moment the next line
lands. Everything that is a *behaviour* rather than a *measurement* is pasted verbatim.

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

`--write <path>` asks git twice, **in the target's own directory**:

- `git ls-files --error-unmatch -- <path>` — is it tracked?
- `git check-ignore --quiet -- <path>` — is it ignored?

It writes (mode `0600`) **only if the path is untracked AND ignored**. Anything else is a
refusal that names the path and the reason and exits 1:

- tracked → *"git tracks this path; writing a secret here would commit it"*
- not ignored → *"git does not ignore this path; an untracked-but-unignored file is one `git add .` from being committed"*
- not inside a git repository at all → refused, because the question cannot be answered

**Both of those questions are about a NAME, not about the bytes the name reaches**, and that
is not a detail — it was a real hole. An ignored-and-untracked **symlink** pointing at a
tracked file answers both questions correctly *about itself* while the write lands in the
tracked file: both branches evaluate exactly as designed and a credential still ends up one
`git commit -a` from being published. A **hard link** does the same with no link to see.
So the filesystem is interrogated before git is, and the name is pinned to its bytes:

- a symbolic link → refused outright, before git is asked at all. Resolving the link and
  re-asking git would also work; refusing is simpler, cannot be subtly wrong, and no
  legitimate caller needs to write a secret through a link.
- a file with more than one hard link → refused: another name for the same bytes may be
  tracked, and git was only asked about this one.
- anything that exists and is not a regular file → refused.

- a **symlink named as the target's parent** → refused: git resolves it, or refuses to
  answer about it at all (`fatal: pathspec … is beyond a symbolic link`), and neither
  answer is about the file the write would reach.

That closes the "it is a link right now" question. The "something was planted between the
check and the write" question is closed separately, on the descriptor, and it takes four
conditions because each one alone has a documented escape:

1. **`O_NOFOLLOW`** — `open()` itself fails on a symlinked *final* component. By definition
   it constrains only the last component; condition 4 is what covers the path above it.
2. **`fstat().nlink === 1`**, re-read on the descriptor actually held rather than on a name
   that may since have been re-pointed.
3. **`fstat().isFile()`, with `O_NONBLOCK`** — the non-regular-file refusal above is a
   question about a *name*, so a FIFO planted inside the window reached the open. Without
   `O_NONBLOCK` that open blocks forever on a FIFO with no reader, which in a script whose
   contract is to fail loudly is a hang with no timeout and no message; with it the open
   fails `ENXIO` and the type check refuses the device case too. A platform that exposes
   neither required open flag is refused instead of silently running a weaker writer.
4. **the parent directory's `(dev, ino)` is still the one git was asked about, and the
   descriptor's `(dev, ino)` is still what the path names.** Replacing an *ancestor
   directory* with a symlink inside the window redirects the whole open, and this was a
   real escape: classify `repo/ok/secrets.env` (untracked and ignored, correctly allowed),
   swap `repo/ok` for a symlink to `repo/real`, and the write landed in the tracked
   `repo/real/secrets.env`. Comparing inodes rather than strings catches any ancestor swap,
   because a swap that changes what the parent path *reaches* changes which inode the
   parent path `lstat`s to. The second half — the descriptor's inode against the inode the
   path names *now* — is what stops an attacker restoring the directory after the open so
   that the parent check passes over a descriptor already pointing elsewhere.

**Both the mode and the bytes are applied to that descriptor, never to the path.** (The
earlier `chmod(path)` followed a symlink too, and silently rewrote a tracked file's mode.)
`O_TRUNC` is deliberately not requested — truncating at open time would destroy the target
before any of these questions could be answered — so the truncation happens on the
descriptor, after all four have passed.

**What condition 4 does not claim.** Node exposes no `openat(2)`, so this is an identity
check after the fact, not an atomic directory-relative open. Two residuals follow, and both
are stated rather than papered over: an ancestor swap that is *reverted* fast enough can
still cause `O_CREAT` to leave a **zero-byte file** in the attacker's chosen directory
before the refusal (no secret is written, the target is never truncated, and no existing
file is modified); and the guarantee is "an ancestor swap is detected before any byte is
written", not "an ancestor swap is impossible". The threat model this closes is a local
adversary racing the process — strictly stronger than the checked-in symlink the first
layer refuses statically.

**Scope.** Without `--only`, `--write` emits every reported present name, which includes
every secret-shaped variable in the ambient environment. `--only <NAME>` governs the written
body as well as the printed table, so `--write ./local.env --only OPENROUTER_API_KEY` writes
exactly one name. Choose the blast radius deliberately.

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

**A zero on this row has two opposite meanings**, and the gate says which one happened.
"Every encoding of every secret this process holds was searched for and none appeared" is a
verdict; "this process held no secrets, so nothing was searched for" is not one — and the
second is what a CI job produces by default, because a job with no `env:` block ships no
secrets. So the row renders as either

```
- env var value (any encoding): not run — 0 secret-shaped variables in the environment
- env var value (any encoding): 0 (searched N representation(s) of M secret-shaped variable(s))
```

and **`--require-env-values`** turns the first state into exit 2. Use that flag in CI with
the real secrets mapped into the job environment (§5): without it, the strongest half of
this gate reports a clean zero forever. A tool that did not run is not a verdict. The counts
are counts — a variable name is printed only next to a hit, where the leak has already
happened.

The `operator email` pattern deliberately does not embed the operator's address (that would
itself be the leak). It matches any address outside a documented example/reserved list.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | clean |
| 1 | findings — at least one non-allowlisted hit |
| 2 | usage or environment error, an allowlist entry without a reason, a git failure, or `--require-env-values` with no secret-shaped variable in the environment |

**2 takes precedence over 1.** When `--require-env-values` is given, the environment holds
no secret-shaped variable, *and* the regex half also found hits, the exit code is **2**.
Both complaints are printed on stderr; the code reports the more actionable one, because
findings produced by the regex half alone, over a diff that nothing searched for actual
values, are not the reason that run should be looked at. This is a change: the code
previously returned 1 in that case, so the documented exit 2 held only on a clean diff.

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

**`--mode direct` is a reachability probe, and it can legitimately fail.** It reads the
answer out of `choices[0].message.content`, and today's cheapest free models are reasoning
models that spend the entire 32-token budget on reasoning tokens and return
`content: ""` with `finish_reason: "length"`. Direct mode therefore falls back to
`choices[0].message.reasoning` and prints a `TEXT FIELD: reasoning` line when it does —
reasoning text is still the model's own output arriving over the wire, which is all the
non-empty-text assertion claims to check, but "the model replied" and "the model thought out
loud and never replied" are not the same result and the output says which happened. A model
that emits neither still fails, correctly. Raise `--max-tokens` if a real reply is wanted.

### Where the two substitution assertions get their numbers

This is the part that was wrong for two rounds, in the mode that is the gate.

The `AssistantMessage` the runtime returns cannot answer either substitution question, and
both of its fields look like it can:

- `message.model` is assigned from the model this process **requested** — the provider
  adapter sets `output.model = model.id` when it builds the message
  (`@earendil-works/pi-ai/dist/api/openai-completions.js:110`) and never overwrites it from
  the response. Reading it back and comparing it to the requested id compares a value with
  itself, so a paid substitution on the wire compares equal.
- `message.usage.cost` is **computed, not received**: `parseChunkUsage` builds an all-zero
  cost object and hands it to `calculateCost(model, usage)` (same file, `:1128-1130`), which
  multiplies token counts by the **local** catalogue's rates. Under this driver's
  `modelsPath: null, allowModelNetwork: false` runtime the catalogue carries no rates, so a
  genuinely paid model resolves to an all-zero cost table and reports `costUsd = 0`.

The runtime's own `onResponse` hook carries only `{status, headers}`. What it does expose is
`StreamOptions.fetch`, forwarded verbatim to the provider adapter by
`ModelRuntime.prepareRequest`. So the driver passes a `fetch` that **clones the response and
reads the provider's own SSE frames out of the clone**. This does not change which code path
runs or what it sends — the same `setupModelRuntime → resolveModel →
assertModelAuthentication → ModelRuntime.complete` chain executes, through the same adapter,
with the same key injection and request payload. OpenRouter now includes detailed usage in
the final SSE frame automatically; the old `usage: {include: true}` and
`stream_options: {include_usage: true}` switches are deprecated and have no effect. The run
prints `OBSERVED FROM: …` naming the source, frame count, and that the observer modified
nothing. It also prints the runtime's own locally-computed cost beside the wire-observed one,
labelled as such, so a divergence is visible.

When the provider surfaces neither field, both are `null` and both assertions **fail**:

```
ASSERT the returned model id matches the requested one: FAIL — the runtime surfaced no
provider model id, so a substitution cannot be ruled out
```

There is no `?? model.id` and no `?? 0` on either. A smoke test that says "I could not rule
out a substitution" is worth more than one that prints PASS over a value that never arrived.

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
- the model id the provider returned matches the one requested — **exactly** when the
  requested id ends in `:free`. That suffix is not cosmetic: `vendor/model` is the *paid*
  twin of `vendor/model:free`, so normalizing it away on both sides would make a paid
  substitution compare equal, which is the one thing this row's careful free-model ranking
  exists to prevent. The tolerant comparison survives only for a request with no suffix,
  where there is no paid twin to confuse.
- provider-reported token usage was recorded
- **the call cost zero.** The row is "cheapest *free* model"; without this the cost was
  printed and read by nothing, so a substitution could print `RESULT: PASS` with a charge
  sitting visibly in the output. A provider that reports *no* cost figure fails this too —
  an unknown cost is not a zero cost.

Plus the elapsed time for the call and for the whole run. A run that fails prints
`ERROR: <message>` with the provider's own explanation (through the scrubber, so a provider
echoing a header cannot leak), and a candidate that answers with `stopReason: error` or a
non-null error message counts as a **failed** candidate, so the retry loop tries the next
model exactly as its printed "will try up to N" says it will.

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
- env var value (any encoding): 0 (searched N representation(s) of M secret-shaped variable(s))

Scanned N added lines across M files.
$ echo $?
0
```

(`N`/`M` elided per the note at the top: those counts move with every commit. The `env var
value` row shows the *searched* form because this run had the owner's environment loaded;
with an empty environment the same run prints `not run — 0 secret-shaped variables in the
environment` instead, and `--require-env-values` makes that exit 2.)

### The live BYOK smoke test, with the key injected by the prefill script

```
$ node scripts/secrets-prefill.mjs -- node scripts/smoke-openrouter.mjs --require-key
MODE: product
  proves: this repository's own BYOK path — server/src/agent/models.ts setupModelRuntime() injecting the key, resolveModel(), assertModelAuthentication(), ModelRuntime.complete().
MODEL RESOLUTION: 20 strictly-free model(s) in the live catalogue; ranked cheapest-first, will try up to 3.
ATTEMPT: liquid/lfm-2.5-2.6b:free
  candidate failed: 400: {"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_name":null}}
ATTEMPT: nvidia/nemotron-3.5-content-safety:free
MODEL: nvidia/nemotron-3.5-content-safety:free
RESOLVED REF: openrouter/nvidia/nemotron-3.5-content-safety:free
OBSERVED FROM: provider SSE frames observed through StreamOptions.fetch (6 frame(s); request payload modification: nothing)
RUNTIME-COMPUTED COST (from the local catalogue, NOT the wire, shown for contrast): 0
STOP REASON: stop
REPLY (model output, first 200 chars): "User Safety: safe"
ASSERT the completion text is non-empty: PASS — 17 characters
ASSERT the returned model id matches the requested one: PASS — requested=nvidia/nemotron-3.5-content-safety:free returned=nvidia/nemotron-3.5-content-safety:free
ASSERT provider-reported token usage was recorded: PASS — input=472 output=5 total=477
ASSERT the call cost zero: PASS — costUsd=0
ELAPSED: N ms for the call, N ms total
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

This lane does not own `.github/workflows/`, so the YAML below is not installed by this
commit — it is **printed here in full, on purpose**. An earlier draft pointed at an
`INTEGRATION.md` at the repository root, which is deliberately never committed; post-merge
that pointer resolved to nothing, which is exactly the drift these scripts exist to stop.
The workflow-owning lane pastes this in as-is.

```yaml
# .github/workflows/secrets.yml
name: secrets

on:
  pull_request:

jobs:
  secret-diff-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # The gate diffs against the PR base, so the base commit has to be present.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: secret/PII diff gate
        # The value-derived half of the gate searches the added lines for every encoding
        # of every secret-shaped variable IN THIS JOB'S ENVIRONMENT. With no `env:` block
        # it has nothing to search for and reports a clean zero forever — the leak it
        # exists to catch (the real key, base64'd into a fixture) is exactly the one the
        # regex half misses. So the secrets are mapped in, and --require-env-values makes
        # the job fail loudly (exit 2) if that mapping is ever dropped or renamed.
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          STABLY_API_KEY: ${{ secrets.STABLY_API_KEY }}
          STABLY_PROJECT_ID: ${{ secrets.STABLY_PROJECT_ID }}
        run: |
          # Captured to a log and $? tested, never piped: a pipe would report the exit
          # code of the pipe's last stage and turn a finding into a pass.
          node scripts/secret-diff-gate.mjs \
            --base "${{ github.event.pull_request.base.sha }}" \
            --head "${{ github.event.pull_request.head.sha }}" \
            --require-env-values > secret-diff-gate.log 2>&1
          status=$?
          cat secret-diff-gate.log
          exit $status
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: secret-diff-gate
          path: secret-diff-gate.log

  byok-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm ci
        working-directory: server
      - name: BYOK smoke test on the cheapest free model
        # --require-key turns an absent secret into exit 2 instead of a SKIP at exit 0.
        # Without it a rotated-away or misnamed secret would pass this job quietly.
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
        run: |
          node scripts/smoke-openrouter.mjs --require-key > smoke-openrouter.log 2>&1
          status=$?
          cat smoke-openrouter.log
          exit $status
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: smoke-openrouter
          path: smoke-openrouter.log
```

Two things in that YAML are load-bearing and easy to drop:

1. **`--require-env-values` plus the `env:` block on the gate job.** Together they are the
   difference between "searched and found nothing" and "searched for nothing". Removing
   either one silently disarms the half of the gate that catches a base64'd key.
2. **`--require-key` on the smoke job.** Without it, an absent `OPENROUTER_API_KEY` prints
   a SKIP and exits 0, and the job goes green having proved nothing.

Neither job pipes a script into anything. Both capture to a log, test `$?`, print the log,
and re-exit with the captured status — a pipe reports the last stage's exit code, which is
how a failing gate becomes a passing job.

`secrets-prefill.mjs` has no role in CI: CI already has the secrets in its environment. The
prefill script is for a local run, where they are spread across files and directories.
