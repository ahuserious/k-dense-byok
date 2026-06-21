// danbot-byok — playwright.config.ts
// Headless browser E2E harness used by the relentless loop to verify the [ui] items on
// the 100-point checklist. Points at the running Next.js dev server (baseURL overridable
// via PLAYWRIGHT_BASE_URL so the runner can target whatever port Next picked).

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
