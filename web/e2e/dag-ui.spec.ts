// danbot-byok — dag-ui.spec.ts
//
// The authoritative spec for the DAG Builder / Console / chat-rail restructure. Replaces
// the older dag-pipelines-{e2e,debrand,fixes,canvas} specs (which asserted the now-removed
// "Pipeline Builder" / "Agent Console" labels and old iframe titles).
//
// New right-side nav (exact labels): Workflows · DAG Pipelines · DAG Builder · Console.
//   - DAG Pipelines = a native LIST of saved pipelines (incl. the default Archon ones).
//   - DAG Builder   = Archon's visual builder canvas, iframe title "DAG Builder".
//   - Console       = Agents + Raindrop sub-tabs (iframe titles "Agents" / "Raindrop").
//   - Chat rail     = a far-right collapsible KADY chat (aria "Open/Collapse chat rail").
import { test, expect } from "@playwright/test";

const SHOTS = "test-results/dag-ui";

test("right nav = Workflows / DAG Pipelines / DAG Builder / Console (old labels gone)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Workflows", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "DAG Pipelines", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "DAG Builder", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Console", exact: true })).toBeVisible();
  // Renamed-away labels must be gone.
  await expect(page.getByRole("button", { name: "Pipeline Builder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agent Console", exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/01-nav.png`, fullPage: true });
});

test("DAG Pipelines opens the native pipelines LIST (no iframe)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "DAG Pipelines", exact: true }).click();
  // The list panel: an engine-status chip + an "Open builder ↗" link (unique to this
  // panel), NOT an embedded iframe.
  await expect(page.getByText(/engine online|engine offline|checking/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: /Open builder/i })).toBeVisible();
  await expect(page.locator('iframe[title="DAG Builder"]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/02-dag-pipelines-list.png`, fullPage: true });
});

test("DAG Builder opens the Archon visual builder canvas (iframe)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "DAG Builder", exact: true }).click();
  const frame = page.locator('iframe[title="DAG Builder"]');
  await expect(frame).toBeVisible({ timeout: 20000 });
  await expect(frame).toHaveAttribute("src", /\/legacy\/workflows\/builder/);
  await page.screenshot({ path: `${SHOTS}/03-dag-builder.png`, fullPage: true });
});

test("Console has Agents + Raindrop sub-tabs that embed the right engines", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Console", exact: true }).click();
  // Sub-tabs.
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Raindrop", exact: true })).toBeVisible();
  // Agents (default) = Archon console.
  await expect(page.locator('iframe[title="Agents"]')).toHaveAttribute("src", /:3091\/console/, { timeout: 20000 });
  // Switch to Raindrop = local Workshop (:5899).
  await page.getByRole("button", { name: "Raindrop", exact: true }).click();
  await expect(page.locator('iframe[title="Raindrop"]')).toHaveAttribute("src", /:5899/, { timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/04-console-raindrop.png`, fullPage: true });
});

test("chat rail opens from the far-right strip and collapses again", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Collapsed by default → an "Open chat rail" affordance on the far right.
  const open = page.getByRole("button", { name: "Open chat rail" });
  await expect(open).toBeVisible();
  await open.click();
  // Expanded → a collapse control appears.
  const collapse = page.getByRole("button", { name: "Collapse chat rail" });
  await expect(collapse).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-chat-rail-open.png`, fullPage: true });
  await collapse.click();
  await expect(page.getByRole("button", { name: "Open chat rail" })).toBeVisible();
});
