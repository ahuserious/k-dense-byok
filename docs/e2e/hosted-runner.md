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

The test command is `npx stably test`, with `CI=1`, two workers by default, the localhost frontend as
`KADY_E2E_BASE_URL`, and a run-specific suite name. It deliberately does not use `--browser cloud`:
the Playwright process and Chromium execute on the GitHub-hosted runner. Stably credentials enable the
reporter, so results and traces can also appear in the Stably dashboard.

The job always attempts the owned preview teardown and uploads available evidence, including:

- `runner-fingerprint.json`;
- the Stably/Playwright console log and browser-install method;
- the preview readiness log;
- `.stably/test-results/`, plus conventional `test-results/` and `playwright-report/` paths when they
  exist.

The step summary extracts pass, fail, and skipped/fixme counts plus any Stably run identifier or URL
printed by the reporter. The raw log remains authoritative if a future reporter changes its formatting.

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
