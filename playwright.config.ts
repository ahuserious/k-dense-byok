import { defineConfig, stablyReporter } from "@stablyai/playwright-test";
import { devices } from "@playwright/test";

const stablyCredentialsPresent = Boolean(
  process.env.STABLY_API_KEY && process.env.STABLY_PROJECT_ID,
);

export default defineConfig({
  // Playwright config has no Page lifecycle. The automatic `runtimeErrors`
  // fixture in e2e/fixtures.ts attaches console.error and pageerror listeners
  // before navigation and fails the owning test after fixture teardown.
  testDir: "./e2e",
  outputDir: ".stably/test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: stablyCredentialsPresent
    ? [
        ["./e2e/item-count-reporter.ts"],
        ["list"],
        stablyReporter({
          apiKey: process.env.STABLY_API_KEY,
          projectId: process.env.STABLY_PROJECT_ID,
        }),
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
