// danbot-byok — e2e/fusion-live.spec.ts
// Proves the live-update fix: a Fusion config created in Settings appears in the model
// picker WITHOUT a page reload (use-models now re-reads on the "fusion-configs-changed"
// event Settings dispatches). This upgrades items 61/69 from "needs reload" to live.

import { test, expect } from "@playwright/test";

test("a new Fusion config appears in the picker without reload [61 live]", async ({ page }) => {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("dialog").getByText("Fusion", { exact: true }).click();
  await page.getByPlaceholder(/Config name/).fill("Live Fusion");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Close settings (Escape) and open the picker — NO reload.
  await page.keyboard.press("Escape");
  await page.getByText("Claude Opus 4.8").first().click();
  await expect(page.getByText(/Live Fusion/).first()).toBeVisible({ timeout: 10_000 });
});
