import { defineConfig, stablyReporter } from "@stablyai/playwright-test";
import { devices } from "@playwright/test";

const stablyCredentialsPresent = Boolean(
  process.env.STABLY_API_KEY && process.env.STABLY_PROJECT_ID,
);

function e2eWorkerCount(): number {
  const configured = process.env.KADY_E2E_WORKERS;
  if (configured === undefined) return 4;
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error("KADY_E2E_WORKERS must be a positive integer.");
  }
  const workers = Number(configured);
  if (!Number.isSafeInteger(workers)) {
    throw new Error("KADY_E2E_WORKERS must be a safe positive integer.");
  }
  return workers;
}

export default defineConfig({
  // Playwright config has no Page lifecycle. The automatic `runtimeErrors`
  // fixture in e2e/fixtures.ts attaches console.error and pageerror listeners
  // before navigation and fails the owning test after fixture teardown.
  testDir: "./e2e",
  outputDir: ".stably/test-results",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: e2eWorkerCount(),
  reporter: stablyCredentialsPresent
    ? [
        ["./e2e/item-count-reporter.ts"],
        // Streams one line per finished test to .stably/e2e-spec-timings.ndjson so a slowdown can
        // be attributed to a spec. It writes no terminal output and asserts nothing.
        ["./e2e/spec-timing-reporter.ts"],
        ["list"],
        // Reporter 2.1.16 resolves credentials from process.env and accepts
        // suiteName as a non-secret option (dist/index-D8lS6VkX.mjs:9438-9441).
        // Credentials in this object leak through FullConfig.reporter.
        stablyReporter({ suiteName: process.env.E2E_SUITE_NAME }),
      ]
    : [["./e2e/item-count-reporter.ts"], ["./e2e/spec-timing-reporter.ts"], ["list"]],
  use: {
    baseURL: process.env.KADY_E2E_BASE_URL ?? "http://127.0.0.1:13000",
    trace: "on",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // `chromium` must stay at index 0: playwright.live-alt.config.ts builds its single project from
    // the base project list, and e2e/global-setup.ts reads config.projects[0].use for the baseURL it
    // warms. Both now resolve by name rather than by position, but the ordering is still the shape a
    // reader expects, and the contract tests in e2e/config-contracts.node.mjs pin the result.
    {
      name: "chromium",
      // The Wave-F tier lives in its own project below with its own testDir. Without this ignore the
      // default `./e2e` collection would walk e2e/wave-f as well and every Wave-F item would be
      // collected twice -- once per project -- which the item-count reporter would (correctly) call
      // inventory drift.
      testIgnore: "wave-f/**",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // The Wave-F click-through tier (row 38). Three things make it different from `chromium`, and
    // all three are the point of it:
    //   1. testDir is e2e/wave-f, whose fixtures install NO route interception -- these items reach
    //      the real backend. The mocked tier at ./e2e proves front-end behaviour and nothing about
    //      the server, which is why Gate U asks for evidence from here instead.
    //   2. video and screenshot are "on", not "retain-on-failure"/"only-on-failure". A passing item
    //      has to leave a visual record behind; that record IS the row-38 deliverable.
    //   3. trace stays "on" so a passing item keeps its filmstrip too.
    {
      name: "wave-f",
      testDir: "./e2e/wave-f",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
        trace: "on",
        video: "on",
        screenshot: "on",
      },
    },
  ],
  expect: { timeout: 10_000 },
  timeout: 45_000,
});
