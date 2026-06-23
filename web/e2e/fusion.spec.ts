// danbot-byok — e2e/fusion.spec.ts
// Proves the Fusion config-creation UI (checklist 60): the Fusion settings tab has a
// name field + Add button, and adding a config persists it to localStorage["fusionConfigs"]
// (the store use-models.ts reads to render user-defined Fusion panels in the picker).

import { test, expect } from "@playwright/test";

test("Fusion config creation saves to fusionConfigs [60]", async ({ page }) => {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });

  await page.getByRole("button", { name: "Open settings" }).click();
  // 30s absorbs the Next dev-server's first-interaction compile of the settings chunk.
  await page.getByRole("dialog").waitFor({ timeout: 30_000 });
  // Use the stable tab role (getByText flakes during the dialog open animation).
  await page.getByRole("tab", { name: "Fusion" }).click();
  // The add-config form is behind a collapsible toggle — expand it first.
  await page.getByRole("button", { name: /Add Fusion config/i }).click();

  const nameInput = page.getByPlaceholder(/Config name/);
  await expect(nameInput).toBeVisible({ timeout: 30_000 });
  await nameInput.fill("E2E Test Fusion");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The config is persisted to localStorage where the model store reads it.
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("fusionConfigs") ?? ""), {
      timeout: 10_000,
    })
    .toContain("E2E Test Fusion");

  // [61] After a reload (the store reads fusionConfigs on mount), the user config shows
  // up in the model picker as a selectable Fusion model.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 60_000 });
  await page.getByText("Claude Opus 4.8").first().click(); // open the model selector
  await expect(page.getByText(/E2E Test Fusion/).first()).toBeVisible({ timeout: 10_000 });
});
