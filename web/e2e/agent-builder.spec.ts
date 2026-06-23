// danbot-byok — e2e/agent-builder.spec.ts
// Proves the deliberation-backend picker renders in the agent builder (checklist 96):
// Settings → Sub-agents → Edit an agent → the Default / Fusion (direct) / AI Council
// picker is present in the edit form.

import { test, expect } from "@playwright/test";

test("deliberation-backend picker renders in the agent builder [96]", async ({ page }) => {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New chat tab" }).waitFor({ timeout: 90_000 });

  await page.getByRole("button", { name: "Open settings" }).click();
  // 30s absorbs the Next dev-server's first-interaction compile of the settings chunk.
  await page.getByRole("dialog").waitFor({ timeout: 30_000 });
  // Use the stable tab role (getByText flakes during the dialog open animation).
  await page.getByRole("tab", { name: "Sub-agents" }).click();
  await page.getByRole("button", { name: "Edit code-reviewer" }).click();

  await expect(page.getByRole("button", { name: "AI Council" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Fusion (direct)" })).toBeVisible();
});
