// Verifies the console refactor (navigating directly to Archon :3091):
//  - project rail reduced to a compact dropdown (menu trigger), big rail gone
//  - Settings / Workflows / Old-UI nav links removed
//  - a chat pop-out affordance exists inside the builder canvas
import { test, expect } from "@playwright/test";
const SHOTS = "test-results/console-refactor";

test("console project rail is a compact dropdown, no Settings/Workflows/Old-UI", async ({ page }) => {
  await page.goto("http://localhost:3091/console", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500); // let the SPA hydrate
  // The classic-UI escape hatches are gone.
  await expect(page.getByRole("link", { name: /Old UI/i })).toHaveCount(0);
  await expect(page.getByText(/Switch back to the classic UI/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Workflows$/ })).toHaveCount(0);
  // The compact project switcher is a menu trigger (replaces the wide rail).
  await expect(page.locator('[aria-haspopup="menu"]').first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/01-console-compact-rail.png`, fullPage: true });
});

test("builder canvas no longer hosts the in-canvas chat pop-out (moved to Kady's chat rail)", async ({ page }) => {
  await page.goto("http://localhost:3091/legacy/workflows/builder", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  // The old CanvasChatPopout (a floating "Chat" pill) is disabled — chat now lives in
  // Kady's far-right collapsible chat rail (see dag-ui.spec.ts). So the canvas must NOT
  // render a "Chat" trigger anymore.
  await expect(page.getByRole("button", { name: /^chat$/i })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/02-builder-no-popout.png`, fullPage: true });
});
