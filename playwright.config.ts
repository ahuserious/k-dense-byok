import { defineConfig, stablyReporter } from "@stablyai/playwright-test";
import { devices } from "@playwright/test";

const stablyCredentialsPresent = Boolean(
  process.env.STABLY_API_KEY && process.env.STABLY_PROJECT_ID,
);

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".stably/test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: stablyCredentialsPresent
    ? [
        ["list"],
        stablyReporter({
          apiKey: process.env.STABLY_API_KEY,
          projectId: process.env.STABLY_PROJECT_ID,
        }),
      ]
    : [["list"]],
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
