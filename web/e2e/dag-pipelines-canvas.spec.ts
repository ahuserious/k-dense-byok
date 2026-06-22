// Verifies: DAG Pipelines -> canvas; no separate Pipeline Builder pill; Agent Console -> /console;
// Archon canvas has no top nav row; console is de-purpled (screenshots for visual proof).
import { test, expect } from "@playwright/test";
const SHOTS = "test-results/dag-pipelines-canvas";

test("right nav = Workflows / DAG Pipelines / Agent Console (no Pipeline Builder pill)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Workflows", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "DAG Pipelines", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agent Console", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pipeline Builder", exact: true })).toHaveCount(0);
});

test("DAG Pipelines opens the canvas / YAML editor", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "DAG Pipelines" }).click();
  const frame = page.locator('iframe[title="Pipeline Builder"]');
  await expect(frame).toBeVisible({ timeout: 15000 });
  await expect(frame).toHaveAttribute("src", /\/legacy\/workflows\/builder$/);
  await page.screenshot({ path: `${SHOTS}/01-dag-pipelines-canvas.png`, fullPage: true });
});

test("Archon canvas (direct) has no top nav row", async ({ page }) => {
  await page.goto("http://localhost:3091/legacy/workflows/builder", { waitUntil: "domcontentloaded" });
  // The deleted nav row contained Dashboard + Pipelines NavLinks + the brand.
  await expect(page.getByRole("link", { name: /^Dashboard$/ })).toHaveCount(0);
  await expect(page.getByRole("navigation").filter({ hasText: "Dashboard" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/02-archon-canvas-no-nav.png`, fullPage: true });
});

test("Agent Console = /console, de-purpled", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Agent Console" }).click();
  await expect(page.locator('iframe[title="Agent Console"]')).toHaveAttribute("src", /:3091\/console/);
  // Direct console screenshot for the visual de-purple proof.
  await page.goto("http://localhost:3091/console", { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: `${SHOTS}/03-console-depurpled.png`, fullPage: true });
});
