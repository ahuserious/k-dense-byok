# Hosted-runner E2E execution

`.github/workflows/stably-cloud.yml` provides two independent experiments for the Scientific DAG
Studio outer-loop suite. It runs on pushes to `integration/**` and by manual dispatch.

## Trigger and credentials

The repository owner must configure these GitHub Actions secrets:

- `STABLY_API_KEY`
- `STABLY_PROJECT_ID`

Run the default two-worker suite from the integration branch with:

```bash
gh workflow run stably-cloud.yml --ref integration/dfg-20260807-135127
```

The optional dispatch inputs are `grep`, passed as one Playwright `--grep` value, and `workers`, a
positive integer whose default is `2`. For example:

```bash
gh workflow run stably-cloud.yml \
  --ref integration/dfg-20260807-135127 \
  -f workers=2 \
  -f grep='DAG Builder'
```

## Job A: GitHub-hosted runner

`github-runner` installs the root, backend, frontend, and vendored Pipeline Engine dependencies on
`ubuntu-latest`. It builds and checks the ignored vendored builder dist, installs Chromium and its
system dependencies, and starts the hermetic preview on backend `18000`, frontend `13000`, and engine
`13091`. The preview readiness barrier already checks all three health endpoints; the job then makes
one additional request to the main page before starting the suite.

The test command is `npx playwright test --trace on`, with `CI=1`, two workers by default, the
localhost frontend as `KADY_E2E_BASE_URL`, and a run-specific `E2E_SUITE_NAME`. It deliberately does
not use `--browser cloud`: the Playwright process and Chromium execute on the GitHub-hosted runner.
The suite step sets `FORCE_COLOR=0` and `NO_COLOR=1`, so the reporter epilogue retained as evidence is
byte-exact text rather than an ANSI-normalized approximation.
Stably credentials enable the reporter from the repository's base config, so results and traces can
also appear in the Stably dashboard. Reporter `2.1.16` resolves credentials from the environment and
receives only the non-secret suite name as an option.

The pinned `stably@4.12.28` CLI remains only on the Chromium installation step. Its `test` wrapper is
not used because that wrapper replaces the audited base reporter with credential-bearing options.
Direct Playwright retains the config's always-on tracing, and `--trace on` makes that evidence policy
explicit in the hosted command; the Stably reporter still handles suite/result/trace dashboard uploads.
Only wrapper-specific CLI source/version metadata is absent from those reports.

The job always attempts the owned preview teardown and requires, scans, and seals evidence including:

- `runner-fingerprint.json`;
- the scrubbed Stably/Playwright console log and browser-install method;
- the preview readiness log;
- `.stably/test-results/`, plus conventional `test-results/` and `playwright-report/` paths when they
  exist.

Only `hosted-evidence-bundle.tar` is uploaded. Its manifest records structured pass, fail, and
skipped/fixme counts plus the freshness-validated Stably run identifier and URL; raw logs are removed
after scrubbing and never uploaded.

The final artifact scan is one linear pass over each payload file while the upload tar is assembled.
Each file is classified by magic bytes, hashed once, and searched with a fixed set of views. ZIP, TAR,
and GZIP members are recursed (depth ≤ 4 per descent path; 8 GiB of inspected bytes for the whole
seal, counted as a single global total across every payload file and every nested member, else the
artifact is rejected). Members whose magic identifies zstd, xz, 7z, rar, or bz2 fail closed and the
rejection names that codec. Brotli and raw DEFLATE have no magic and are undetectable: they are
searched on the latin1 view and otherwise left untouched. The payload tar and the outer bundle tar
are not re-scanned; the seal is the recorded per-file SHA-256 digests plus the hash of the assembled
payload tar. Malformed percent syntax, invalid UTF-8, and unknown binary content emit a WARN line
and stay fail-open.

Reporter `2.1.16` prints the server-returned `createdSuiteRun.url` directly (the pinned CJS dist at
`index-CdLJi9uc.cjs:9593-9594`). This evidence tool documents its checked-in Stably dashboard contract
as `https://app.stably.ai/project/<project>/playwright/history/<run>`, anchored by the host and project
URL described in the [Stably reporter guide](https://docs.stably.ai/stably/stably-test-reporter). Evidence requires that
exact raw string before URL parsing, so normalization, userinfo, explicit ports, encoded separators,
trailing slashes, queries, and fragments fail closed. The retained manifest replaces its project
segment with `<REDACTED-PROJECT>`; changing the dashboard contract requires a reviewed source change,
not an environment override.

The raw suite log is capped at 32 MiB in the first post-suite step, before teardown or any count grep,
and only its final 64 KiB is retained in memory for reporter-epilogue validation. If that suffix does
not contain the reporter epilogue, the failure says so explicitly and retains only a scrubbed final
4 KiB diagnostic. Scrubbing uses 64 KiB chunks with overlap, then verifies the capped scrubbed result.
A `finally` cleanup removes raw suite and preview logs after every success or failure.
Reporter isolation tests audit WebSocket, `fetch`, HTTP, HTTPS, `net`, TLS, and DNS transports. The guard
is installed through inherited `NODE_OPTIONS`, and the pinned reporter is exercised through `onBegin`
so its `create-suite.mjs` child transport is covered too.

### Threat model

Purpose: our own credential values (`STABLY_API_KEY`, `STABLY_PROJECT_ID`, and any other value listed
in the secrets set) must not appear in uploaded evidence produced by our tooling. This is accidental
inclusion, not adversarial obfuscation.

Views searched, per file (recursing into ZIP, TAR, and GZIP members only; depth ≤ 4 per descent
path; inspected bytes bounded at 8 GiB as one global total for the whole seal — every top-level
payload file plus every nested member counts against the same counter — else reject):

1. raw bytes (latin1 view);
2. percent-decoded view — tolerant: any `%HH` run is decoded byte-wise; malformed or incomplete
   percent syntax is left as-is and never rejects a file;
3. JSON-unescaped view (`\uXXXX`, `\/`, `\"`, and the other JSON string escapes);
4. Base64 / Base64URL spans: any run of the base64 alphabet plus `=` where ASCII whitespace,
   including CR/LF, is removed first (a run continues across line breaks and spaces until a
   structural non-base64, non-whitespace byte), minimum 16 characters, decoded once, and the decoded
   bytes are searched with views (1)–(3);
5. composition depth exactly 2 (for example `base64(percent(x))` and `percent(base64(x))`). There is
   no fixed-point loop, no UTF-16 scanning (traces and logs are UTF-8; UTF-16 is documented out of
   scope), no longer chains, and no per-file variant caps.

Compressed members whose magic bytes are recognised but not supported for inspection are rejected,
naming the codec — `unsupported zstd compressed member in <hashed member ref>` — for zstd, xz, 7z,
rar, and bz2; member paths stay hashed. Brotli and raw DEFLATE have no magic and are
undetectable; they are out of scope and are not treated as a silent acceptance of a recognised
framing. Unreadable members and the decompressed-bytes bound fail closed.

Fail closed only on: a credential match, an unsupported-compression member with recognisable magic,
the decompressed-bytes bound, or an unreadable member. Fail open (with a WARN line) on: malformed
percent syntax, invalid UTF-8, and unknown binary content — these are searched on the latin1 view and
left otherwise untouched.

Performance: one streaming pass over the final upload payload while it is assembled (scan each file
once, record its SHA-256, write the tar). The seal is those recorded digests plus one hash of the
payload tar. There is no re-scan of the payload tar and no third scan of the bundle tar. The scan is
linear in bytes.

### What Job A proves

A green run proves that the checked-out revision's Playwright suite executed against the hermetic app
from a GitHub-hosted runner, provided the fingerprint rule below is satisfied. The Stably dashboard
record separately proves that the reporter accepted the results.

It does not prove that Stably hosted the browser, that the mocked E2E traffic exercised a real backend,
or that the application is deployable at a public origin. Collection, a dashboard record, and a green
subset selected with `grep` also do not prove that all collected items ran.

### Fingerprint deny-list rule

A run counts as remote only when both the hostname and egress IP evidence in
`runner-fingerprint.json` are outside the operator host's enumerated hostname and IP set. The
orchestrator records that deny-list before evaluating the artifact; CI does not discover or embed the
operator's identifiers. Missing or ambiguous fingerprint fields are not remote proof.

IPv4 is required. IPv6 is recorded when the runner has working IPv6 egress and is otherwise `null`.

## Job B: Stably Cloud action spike

`stably-cloud` runs in parallel and is non-blocking (`continue-on-error: true`). After checkout it calls
`stablyai/stably-runner-action@v4` with the `chromium` Playwright project, synchronous execution, GitHub
comments disabled, and `KADY_E2E_BASE_URL=http://127.0.0.1:13000` as an environment override. It does
not install dependencies, build the vendored dist, or start the preview. That absence is intentional:
the spike observes what the action actually materializes or starts in Stably Cloud.

A failure may identify an unsupported assumption about checkout transfer, the execution image,
dependency installation, web-server startup, or localhost reachability. It does not invalidate Job A.
A reported pass is a lead, not closure: inspect the Stably run for the requested commit SHA, all expected
test items, the Playwright project, app startup, and the target URL before treating it as evidence that
this repository ran on Stably Cloud. The action summary records `success`, `testSuiteRunId`, and `runId`;
both ID fields are retained because current Stably sources disagree on the v2 output name.

Until that inspection is complete, Job B does not prove how the checkout reached Stably Cloud, which
image executed it, whether a Playwright `webServer` or the repository preview started, or whether the
localhost URL referred to the intended application.
