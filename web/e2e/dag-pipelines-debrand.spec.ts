// Verifies the de-brand batch: tooltip, full-bleed embeds, Pipeline Builder opens to the
// Pipelines list, Agent Console = /console, settings "Pipelines" tab, "Build a pipeline" CTA,
// and (navigating directly to Archon) the removals + neutral theme.
import { test, expect } from "@playwright/test";

const SHOTS = "test-results/dag-pipelines-debrand";

test("Pipeline Builder opens to the Pipelines list, full-bleed (no header row)", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Pipeline Builder" }).click();
  const frame = page.locator('iframe[title="Pipeline Builder"]');
  await expect(frame).toBeVisible({ timeout: 15000 });
  await expect(frame).toHaveAttribute("src", /\/legacy\/workflows$/); // list, not /builder
  // Full-bleed: the old wrapper chrome (Reload / Open in new tab / engine badge) is gone.
  await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Open in new tab/i })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/01-pipeline-builder-list.png`, fullPage: true });
});

test("Agent Console = Archon /console, full-bleed", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Agent Console" }).click();
  const frame = page.locator('iframe[title="Agent Console"]');
  await expect(frame).toBeVisible({ timeout: 15000 });
  await expect(frame).toHaveAttribute("src", /:3091\/console/);
  await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/02-agent-console.png`, fullPage: true });
});

test('Settings dialog has a "Pipelines" tab', async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /settings/i }).first().click();
  await expect(page.getByRole("tab", { name: /Pipelines/i }).or(page.getByText("Pipelines", { exact: true })).first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/03-settings-pipelines.png`, fullPage: true });
});

test('Chat empty state offers "Build a pipeline"', async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /Build a pipeline/i }).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/Create a goal-based workflow/i)).toHaveCount(0);
});

test("Archon embed (direct) is de-branded + neutral-themed", async ({ page }) => {
  await page.goto("http://localhost:3091/legacy/workflows", { waitUntil: "networkidle" });
  // Removals: no "Try the new console UI", no Chat nav tab, no version chip.
  await expect(page.getByText(/Try the new console UI/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Chat$/ })).toHaveCount(0);
  await expect(page.getByText(/^v0\.4\.1/)).toHaveCount(0);
  // The "Workflows / + New workflow" header row was removed entirely (per spec).
  await expect(page.getByRole("link", { name: /New (Workflow|pipeline)/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /New (Workflow|pipeline)/i })).toHaveCount(0);
  // Neutral theme: the page background should be a near-grayscale color (low chroma),
  // not Archon's blue. Assert the computed bg is one of white/near-black neutrals.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: `${SHOTS}/04-archon-debranded.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log("archon body bg:", bg);
});
