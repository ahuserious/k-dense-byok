// danbot-byok — dag-ui.spec.ts
//
// Authoritative spec for the two-tier nav restructure.
//   Top row (6 tabs): Chat · Workflows · DAG Pipelines · DAG Builder · Console · Raindrop
//   - Chat        → chat-tabs strip (Chat 1, +) + relocated hide-sandbox toggle
//   - Workflows   → searchable template grid; de-bubbled category links; per-card
//                   "Add to DAG builder"
//   - DAG Pipelines → native saved-pipeline list (no iframe)
//   - DAG Builder → Archon canvas iframe, defaulting to composed-research-pipeline,
//                   with the far-right chat rail (the only view that has it)
//   - Console     → Archon /console directly (no sub-tabs)
//   - Raindrop    → local Workshop (:5899)
import { test, expect } from "@playwright/test";

const SHOTS = "test-results/dag-ui";
const nav = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name, exact: true });

test("top nav row has all six tabs", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  for (const t of ["Chat", "Workflows", "DAG Pipelines", "DAG Builder", "Console", "Raindrop"]) {
    await expect(nav(page, t)).toBeVisible();
  }
  await page.screenshot({ path: `${SHOTS}/01-topnav.png`, fullPage: true });
});

test("Chat view shows the chat-tabs strip + relocated hide-sandbox, no suggestion buttons", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Chat tab strip + the relocated hide-sandbox toggle (moved out of the header).
  await expect(page.getByRole("button", { name: "Chat 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Hide sandbox|Show sandbox/ })).toBeVisible();
  // The two empty-state suggestion CTAs are gone.
  await expect(page.getByRole("button", { name: /Stitch workflows into a pipeline/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Build a pipeline/i })).toHaveCount(0);
});

test("Workflows: de-bubbled categories + per-card Add to DAG builder", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await nav(page, "Workflows").click();
  await expect(page.getByPlaceholder(/Search workflows/i)).toBeVisible({ timeout: 10000 });
  // At least one workflow card exposes an "Add to DAG builder" action (DOM-present even
  // if hover-revealed).
  await expect(page.getByRole("button", { name: /Add to DAG builder/i }).first()).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/02-workflows.png`, fullPage: true });
});

test("DAG Pipelines is the native list (no iframe)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await nav(page, "DAG Pipelines").click();
  await expect(page.getByText(/engine online|engine offline|checking/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('iframe[title="DAG Builder"]')).toHaveCount(0);
});

test("DAG Builder opens the canvas defaulting to composed-research-pipeline + chat rail", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await nav(page, "DAG Builder").click();
  const frame = page.locator('iframe[title="DAG Builder"]');
  await expect(frame).toBeVisible({ timeout: 20000 });
  await expect(frame).toHaveAttribute("src", /composed-research-pipeline/);
  // The chat rail lives here (and only here) — its strip or open panel is present.
  await expect(page.getByRole("button", { name: /chat rail/i }).first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/03-dag-builder.png`, fullPage: true });
});

test("Console embeds the Archon console directly (no sub-tabs)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await nav(page, "Console").click();
  await expect(page.locator('iframe[title="Console"]')).toHaveAttribute("src", /:3091\/console/, { timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/04-console.png`, fullPage: true });
});

test("Raindrop tab embeds the local Workshop (:5899)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await nav(page, "Raindrop").click();
  await expect(page.locator('iframe[title="Raindrop"]')).toHaveAttribute("src", /:5899/, { timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/05-raindrop.png`, fullPage: true });
});
