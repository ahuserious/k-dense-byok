# Hermetic preview and browser E2E loop

This suite has two evidence tiers over the local three-service preview. Cloud credentials are optional locally and are read only when both `STABLY_API_KEY` and `STABLY_PROJECT_ID` are present.

- The mocked tier loads the real frontend and vendored DAG Builder, then intercepts backend and engine API calls with deterministic fixtures. It proves browser rendering, interaction, request serialization, and response handling against those fixtures. It does not prove server behavior or client/server compatibility.
- The `@live` tier installs no routes and no streaming-fetch replacement. The browser talks to the preview's real backend and real pipeline engine. It proves a small set of server-truth contracts: template creation, list/read consistency, exact revision/hash/timestamp values, revision-1 idempotent-save semantics, rendered detail counts, browser-facing origins, and provider-free engine validation.

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
KADY_E2E_BASE_URL=http://127.0.0.1:13000 npx playwright test
node scripts/preview-down.mjs
```

`playwright.config.ts` defaults to `http://127.0.0.1:13000`. Override it with `KADY_E2E_BASE_URL` only when intentionally targeting another preview. Run the tiers separately with:

```bash
# Deterministic UI tier: 246 mocked items.
KADY_E2E_BASE_URL=http://127.0.0.1:13000 npx playwright test --grep-invert @live

# Server-truth tier: 3 unmocked items.
KADY_E2E_BASE_URL=http://127.0.0.1:13000 npx playwright test --grep @live
```

Run the same three contracts as the `@live-alt` origin-regression leg against a preview whose backend and engine ports are both non-default:

```bash
node scripts/preview-up.mjs --backend-port 18600 --frontend-port 13600 --engine-port 13691
KADY_E2E_BASE_URL=http://127.0.0.1:13600 \
KADY_PORT=18600 \
KADY_PIPELINE_ENGINE_PORT=13691 \
npx playwright test --config playwright.live-alt.config.ts
```

The alternate config fails during configuration if `KADY_PORT` or `KADY_PIPELINE_ENGINE_PORT` is missing, invalid, or still `18000`/`13091`. Its flows assert the configured non-default origin on the initial PUT, list GET, detail GET, repeated PUT, independent post-PUT GET, Builder iframe, invalid validation, and valid validation response. The default and alternate legs therefore cover both ordinary behavior and the prior remote-browser hardcoded-origin failure class.

Known limitation: the mocked tier's backend interception pattern is fixed to port `18000`. Run the combined or mocked tier with the default preview ports (`18000` backend, `13000` frontend, `13091` engine); changing the backend port lets mocked requests escape the fixture. The `@live` tier derives its service origins independently, but this lane deliberately does not broaden the established mocked-fixture semantics.

The unmocked tier uses unique workflow ids and names on every item so a warm shared preview cannot collide with an earlier run. The typed-workflow API has no delete route, so those definitions cannot be cleaned up through the public contract; the unique names make the bounded leftovers harmless, and `preview-down.mjs` removes them with the isolated preview state. The builder validation item does not persist its draft.

An identical PUT of a revision-1 typed workflow currently returns the same `201` as its first PUT because the handler derives status from the stored revision. The no-op proof is the unchanged revision, `createdAt`, `updatedAt`, `graphSha256`, and graph in the repeated response. Returning `200` for this no-op is the desired API change tracked as server-owned backlog item N-09; it is not a C3 test-fixture change.

The live engine path is create-draft → validate → observe. Validation parses the submitted graph in the real engine without calling a model. A real run is deliberately out of reach in the hermetic preview: providers are unset, the fresh engine has no registered codebase to bind/save the draft, and the Builder keeps Run disabled until the graph is saved. Claim validation evidence only, not execution evidence.

Always run `preview-down.mjs`, including after a failed test. It terminates the preview launcher group and the service groups discovered from the owned listener ports, verifies that all three ports are free, and removes the isolated state tree.

The teardown command does not return successfully until `deploy/preview/.state.json` is confirmed absent. Callers must await the `preview-down.mjs` process itself; the `Removed preview lifecycle state` line is the explicit lifecycle handoff for a following `preview-up.mjs`.

`preview-up.mjs` first waits for every fixed preview port to have no listener. It then probes all three endpoints until they are healthy in the same pass. A launcher-parent exit is diagnostic rather than a readiness failure; an observed service-child exit fails immediately with its exit status and a preview-log excerpt. Other connection failures remain retryable until the bounded service timeout.

Playwright then performs its default worker barrier in `e2e/global-setup.ts`. Both its request context and Chromium context inherit the resolved project's `baseURL` and `extraHTTPHeaders`. It waits for the web root, renders the project workspace, opens Builder, and waits for the Builder name field inside the iframe. Backend and engine health probes run only for an included live topology whose resolved service origin is loopback or shares the app hostname; `KADY_E2E_WARMUP_SERVICES=1` explicitly forces both probes. The warm-up records `console.error` and `pageerror` before navigation and fails setup if either occurs, so cold-only hydration, chunk, and iframe failures cannot be hidden by the compile barrier.

The public-URL overlay replaces that barrier with `e2e/global-setup.cloud.ts`. It accepts HTTPS by default, passes the resolved headers to a request context with redirects disabled, and verifies only that the response remains on the configured origin and returns `200` with the expected Kady HTML title. App-page, project, and Builder warm-up is impossible in that topology: the backend is deliberately not exposed, and the API mocks are installed later by worker fixtures. The suite defaults to 4 workers; set `KADY_E2E_WORKERS` to a positive integer only for an intentional measured override. Raising timeouts or worker counts is not a substitute for investigating contention.

At commit `640b39a`, the orchestrator ran the default-port cold, warm, and `@live` legs plus the alternate-port `@live-alt` leg. Those results established the pre-final runtime state; every leg must be rerun at the final reviewed SHA so the evidence binds to the delivered code.

Orchestrator evidence at 01d9eb9 (2026-08-16, outside the Codex sandbox, this machine, default preview ports 18000/13000/13091 unless stated): cold fresh-preview `npx playwright test` → 249 collected (213 substantive + 36 thin + 4 fixme), 245 passed / 0 failed / 4 skipped in 2.2 m at 4 workers; warm re-run 245 / 0 / 4 in 2.2 m; `--grep @live` → 3 passed (LIVE_VALUES revision=1 nodes=4 edges=3); `@live-alt` against a second preview on 18600/13600/13691 → 3 passed; `npm run test:e2e-config` → 6 passed / 0 failed / 0 skipped (redirect sentinel included). Logs: `dfg-evidence-20260807-135127/s11/lane-gates/c3/01d9eb9-*` (outside this repository).

To prove consecutive cleanup, run the complete up/curl/down sequence three times. A later `preview-up.mjs` must not encounter occupied ports or reuse state from an earlier cycle.

The orchestrator's 2026-08-12 live proof completed three consecutive cycles: every service was healthy at roughly 24 seconds, every teardown removed the isolated state, and no listener or child process survived.

## Test inventory

Playwright expands the parameterized declarations into 249 independent test items. A local reporter
fails collection if any per-file count or the substantive/thin split changes without an intentional update:

| Surface | Items |
|---|---:|
| Workspace tabs and workflow library | 37 |
| Scientific Pipelines and 23 templates | 54 |
| Chat lifecycle and live Scientific DAG | 28 |
| DAG Builder, node cards, and every NodeSpec field | 60 |
| Console and Raindrop | 33 |
| Scientific DAG Studio popup | 34 |
| Unmocked backend and engine contracts | 3 |
| **Total** | **249** |

Of those 249 items, 213 are substantive behavior checks and 36 are explicitly labelled thin inventory
or documented-product-gap items. All three `@live` items are substantive because each asserts exact values returned by a real service and a corresponding browser-visible consequence. The split is checked at collection time as well as the per-file totals.

Each item establishes the state required by its surface. Builder items open a named draft before using the canvas; live Scientific DAG items submit a run before expecting a projection; typed-pipeline items create and open their stored definition; Console and Raindrop items wait for durable records. Assertions use Playwright's signal-based locator waits and do not contain fixed sleeps.

List the expanded inventory without running browsers:

```bash
npx playwright test --list
```

Playwright's list mode only collects tests; it does not start the global warm-up or require reachable services. There is no root TypeScript project covering `e2e/` or `playwright.config.ts`; `npx playwright test --list` is the available socket-free compilation/collection check for these files.

Local traces are always enabled. Playwright writes run artifacts under `.stably/test-results/`; failures retain screenshots and video.

## Public-URL/tunnel overlay

The historical public-URL topology uses the explicit overlay config:

```bash
KADY_E2E_BASE_URL=https://public-preview.example \
npx playwright test --config playwright.cloud.config.ts
```

`playwright.cloud.config.ts` excludes `@live`: that topology deliberately exposes the frontend and vendored engine but not the real Kady backend. Its cloud-safe global setup fetches only the web root, so collection contains the 246 mocked items without pretending that a project page was warmed. The mocked-only tier can also be selected explicitly:

```bash
KADY_E2E_BASE_URL=https://public-preview.example \
npx playwright test --config playwright.cloud.config.ts --grep-invert @live
```

Run server-truth evidence through the complete default or alternate local preview legs above.

The conditional reporter in `playwright.config.ts` uploads results only when both credentials exist. It resolves credentials from the environment and serializes only the non-secret `E2E_SUITE_NAME` option. Cloud run evidence lands in the Stably project/suite dashboard; local trace, screenshot, video, and result material remains under `.stably/test-results/`.

## Hosted-runner (CI) evidence

The real remote path is the `github-runner` job in [`.github/workflows/stably-cloud.yml`](../../.github/workflows/stably-cloud.yml). It runs the complete default `playwright.config.ts` suite, including the three `@live` items, on a GitHub-hosted runner; it does not use the public-URL overlay above. CI pins Stably CLI `4.12.28` for browser installation only and reporter `2.1.16`. The suite itself runs through `npx playwright test --trace on`: the Stably CLI test wrapper is deliberately excluded because it generates credential-bearing reporter options. Direct Playwright preserves always-on traces and the base reporter's suite/result/trace uploads without replacing the audited config; only wrapper-specific CLI source/version metadata is absent. The retained `hosted-evidence-manifest.json` must contain:

- the exact test command and relevant environment (`CI`, `KADY_E2E_BASE_URL`, workers, and `KADY_E2E_WORKERS` when set), with `STABLY_API_KEY` and `STABLY_PROJECT_ID` recorded only as variable names;
- the tested commit SHA and GitHub run ID;
- `E2E inventory verified: 249 total = 213 executing-substantive + 36 thin; 4 fixme + 0 skip.`;
- the final Playwright summary line and suite outcome;
- the embedded runner fingerprint, including runner image/identity fields available to the job; and
- the Stably run ID and URL when the conditional reporter attached.

The job uploads only `hosted-evidence-bundle.tar`. Its inner `hosted-evidence-payload.tar` contains every mandatory runner artifact, including the fresh Stably last-run record when the reporter attached. Each payload file is scanned once while that tar is assembled; the manifest records the per-file SHA-256 digests plus the payload tar's SHA-256. The outer bundle contains only that payload and the manifest and is hashed once without being re-scanned. This two-layer shape avoids claiming that a file embedded in an archive can contain the archive's own self-referential hash.

A dispatch with the optional grep input is diagnostic and does not satisfy this complete-suite evidence contract.

## Evidence gate

Cloud completion is evidence, not release approval. The orchestrator must preserve the suite URL/run identifier and failed-item artifacts, then send the changed implementation plus local and cloud evidence through the adversarial-assessment lane. Publication, merge, push, or a release-ready claim remains blocked until that assessment passes and the orchestrator explicitly authorizes the next action.
