# Hermetic preview and browser E2E loop

This suite exercises the local three-service preview before the same Playwright items are submitted to Stably's cloud browser. Cloud credentials are optional locally and are read only when both `STABLY_API_KEY` and `STABLY_PROJECT_ID` are present.

## One-time prerequisites

The repository must declare compatible development dependencies for:

```text
@playwright/test >= 1.52
@stablyai/playwright-test
```

Then install the Chromium browser managed by Playwright. Lane S11 does not add dependencies or install packages; the orchestrator owns that change.

## Run locally

Start the hermetic preview from the repository root:

```bash
node scripts/preview-up.mjs
curl --fail --silent --show-error http://127.0.0.1:18000/health
curl --fail --silent --show-error http://127.0.0.1:13000/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1:13091/api/health
npx playwright test
node scripts/preview-down.mjs
```

`playwright.config.ts` defaults to `http://127.0.0.1:13000`. Override it with `KADY_E2E_BASE_URL` only when intentionally targeting another preview. API calls are hermetically mocked at the browser boundary; the real frontend and vendored DAG Builder are still loaded from the preview.

Always run `preview-down.mjs`, including after a failed test. It terminates the preview launcher group and the service groups discovered from the owned listener ports, verifies that all three ports are free, and removes the isolated state tree.

The teardown command does not return successfully until `deploy/preview/.state.json` is confirmed absent. Callers must await the `preview-down.mjs` process itself; the `Removed preview lifecycle state` line is the explicit lifecycle handoff for a following `preview-up.mjs`.

`preview-up.mjs` first waits for every fixed preview port to have no listener. It then probes all three endpoints until they are healthy in the same pass. A launcher-parent exit is diagnostic rather than a readiness failure; an observed service-child exit fails immediately with its exit status and a preview-log excerpt. Other connection failures remain retryable until the bounded service timeout.

To prove consecutive cleanup, run the complete up/curl/down sequence three times. A later `preview-up.mjs` must not encounter occupied ports or reuse state from an earlier cycle.

The orchestrator's 2026-08-12 live proof completed three consecutive cycles: every service was healthy at roughly 24 seconds, every teardown removed the isolated state, and no listener or child process survived.

## Test inventory

Playwright expands the parameterized declarations into 246 independent test items. A local reporter
fails collection if any per-file count or the substantive/thin split changes without an intentional update:

| Surface | Items |
|---|---:|
| Workspace tabs and workflow library | 37 |
| Scientific Pipelines and 23 templates | 54 |
| Chat lifecycle and live Scientific DAG | 28 |
| DAG Builder, node cards, and every NodeSpec field | 60 |
| Console and Raindrop | 33 |
| Scientific DAG Studio popup | 34 |
| **Total** | **246** |

Of those 246 items, 210 are substantive behavior checks and 36 are explicitly labelled thin inventory
or documented-product-gap items. The split is checked at collection time as well as the per-file totals.

Each item establishes the state required by its surface. Builder items open a named draft before using the canvas; live Scientific DAG items submit a run before expecting a projection; typed-pipeline items create and open their stored definition; Console and Raindrop items wait for durable records. Assertions use Playwright's signal-based locator waits and do not contain fixed sleeps.

List the expanded inventory without running browsers:

```bash
npx playwright test --list
```

Local traces are always enabled. Playwright writes run artifacts under `.stably/test-results/`; failures retain screenshots and video.

## Orchestrator-owned cloud run

Lane S11 must not invoke billed cloud execution. After local preview proof and review, the orchestrator supplies `STABLY_API_KEY` and `STABLY_PROJECT_ID` and runs:

```bash
stably test --browser cloud --suiteName "Scientific DAG Studio S11"
```

The conditional reporter in `playwright.config.ts` uploads results only when both credentials exist. Cloud run evidence lands in the Stably project/suite dashboard; local trace, screenshot, video, and result material remains under `.stably/test-results/`.

## Evidence gate

Cloud completion is evidence, not release approval. The orchestrator must preserve the suite URL/run identifier and failed-item artifacts, then send the changed implementation plus local and cloud evidence through the adversarial-assessment lane. Publication, merge, push, or a release-ready claim remains blocked until that assessment passes and the orchestrator explicitly authorizes the next action.
