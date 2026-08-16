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
        ["list"],
        // Reporter 2.1.16 resolves credentials from process.env and accepts
        // suiteName as a non-secret option (dist/index-D8lS6VkX.mjs:9438-9441).
        // Credentials in this object leak through FullConfig.reporter.
        stablyReporter({ suiteName: process.env.E2E_SUITE_NAME }),
      ]
    : [["./e2e/item-count-reporter.ts"], ["list"]],
  use: {
    baseURL: process.env.KADY_E2E_BASE_URL ?? "http://127.0.0.1:13000",
    trace: "on",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
  expect: { timeout: 10_000 },
  timeout: 45_000,
});
