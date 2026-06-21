// danbot-byok — e2e/pipelines.spec.ts
// Proves the Pipelines view (checklist 91/92): the new tab opens the Pipelines panel,
// which shows the Archon engine as online and lists the workflows it knows about
// (proxied through Kady's /pipelines). Run against the production server.

import { test, expect } from "@playwright/test";

test("Pipelines tab lists Archon workflows", async ({ page }) => {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });

  await page.getByRole("button", { name: "Pipelines" }).click();

  await expect(page.getByText("engine online")).toBeVisible({ timeout: 15_000 });
  // A bundled Archon workflow surfaced through the Kady proxy.
  await expect(page.getByText("archon-issue-review-full")).toBeVisible({ timeout: 15_000 });
});
