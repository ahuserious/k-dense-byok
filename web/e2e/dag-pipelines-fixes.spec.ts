// Verifies the DAG-Pipelines UX fixes:
//  1. Agent Console pill -> iframe of Archon's REAL console (/console), not the synthetic dashboard
//  2. "Open builder" under DAG Pipelines -> the builder canvas (/legacy/workflows/builder), not Archon root (-> /console)
//  3. Run on a pipeline -> opens a NEW Kady chat tab (view switches to chat)
//  4. Edit on a pipeline -> Pipeline Builder view with the workflow deep-linked (?edit=)
import { test, expect } from "@playwright/test";

const SHOTS = "test-results/dag-pipelines-fixes";

test("Agent Console embeds the real Archon console (/console)", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Agent Console" }).click();
  const frame = page.locator('iframe[title="Agent Console"]');
  await expect(frame).toBeVisible({ timeout: 15000 });
  await expect(frame).toHaveAttribute("src", /:3091\/console/);
  // The synthetic ACP dashboard text must be gone.
  await expect(page.getByText("Start a loop", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/01-agent-console-archon.png`, fullPage: true });
});

test('"Open builder" under DAG Pipelines targets the builder canvas, not the console', async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "DAG Pipelines" }).click();
  const openBuilder = page.getByRole("link", { name: /Open builder/i });
  await expect(openBuilder).toBeVisible({ timeout: 15000 });
  await expect(openBuilder).toHaveAttribute("href", /\/legacy\/workflows\/builder/);
  await expect(openBuilder).not.toHaveAttribute("href", /3091\/?$/); // not bare root
  await page.screenshot({ path: `${SHOTS}/02-dag-pipelines.png`, fullPage: true });
});

test("Run on a pipeline opens a new chat tab", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "DAG Pipelines" }).click();
  // Wait for the pipeline list to populate from the proxy.
  const runBtn = page.getByRole("button", { name: /^Run$/ }).first();
  await expect(runBtn).toBeVisible({ timeout: 20000 });
  const tabsBefore = await page.getByRole("button", { name: /^(Chat \d+|Run: )/ }).count();
  await runBtn.click();
  // A new chat tab titled "Run: <pipeline>" appears and the chat view is shown.
  await expect(page.getByRole("button", { name: /^Run: / }).first()).toBeVisible({ timeout: 10000 });
  const tabsAfter = await page.getByRole("button", { name: /^(Chat \d+|Run: )/ }).count();
  expect(tabsAfter).toBeGreaterThan(tabsBefore);
  await page.screenshot({ path: `${SHOTS}/03-run-new-chat.png`, fullPage: true });
});

test("Edit on a pipeline opens the Pipeline Builder canvas deep-linked to it", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "DAG Pipelines" }).click();
  const editBtn = page.getByRole("button", { name: /^Edit$/ }).first();
  await expect(editBtn).toBeVisible({ timeout: 20000 });
  await editBtn.click();
  // Switches to the Pipeline Builder view; iframe deep-links the workflow via ?edit=.
  const frame = page.locator('iframe[title="Pipeline Builder"]');
  await expect(frame).toBeVisible({ timeout: 15000 });
  await expect(frame).toHaveAttribute("src", /\/legacy\/workflows\/builder\?edit=/);
  await page.screenshot({ path: `${SHOTS}/04-edit-builder-deeplink.png`, fullPage: true });
});
