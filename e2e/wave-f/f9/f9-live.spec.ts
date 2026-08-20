// TIER: UNMOCKED. Real backend on KADY_PORT and real engine on
// KADY_PIPELINE_ENGINE_PORT. Gate U/D evidence; row 17 Gate B waits for F5.

import { randomUUID } from "node:crypto";

import type { Page, TestInfo } from "@playwright/test";

import { expect, selectLiveWorkspaceTab, test } from "../../live-fixtures";

const F5_REASON = "This build does not include the shared elevate-to-DAG service yet.";
const SHOT_DIR = process.env.F9_SHOT_DIR;

async function capture(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function setDark(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), enabled);
}

async function createPipeline(page: Page, testInfo: TestInfo): Promise<string> {
  const nonce = `${Date.now().toString(36)}-${testInfo.workerIndex}-${randomUUID().slice(0, 8)}`;
  const name = `F9 live pipeline ${nonce}`;
  await selectLiveWorkspaceTab(page, "Scientific Pipelines");
  await page.getByRole("button", { name: "New typed workflow" }).click();
  await page.getByLabel("Workflow template").selectOption("ml-model-selection-review");
  await page.getByLabel("New workflow id").fill(`f9-live-${nonce}`);
  await page.getByLabel("New workflow name").fill(name);
  const write = page.waitForResponse((response) => (
    response.request().method() === "PUT" &&
    new URL(response.url()).pathname.startsWith("/dag-workflows/f9-live-")
  ));
  await page.getByRole("button", { name: "Create and open" }).click();
  expect((await write).status()).toBe(201);
  return name;
}

test("@live F9 row 17 is visible but disabled until F5 lands", async ({ liveWorkspace }) => {
  const { page } = liveWorkspace;
  await selectLiveWorkspaceTab(page, "Chat");
  const panel = page.getByRole("region", { name: "Prompt elevation" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Elevate workflow to a durable scientific DAG pipeline?"),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Elevate", exact: true })).toBeDisabled();
  await expect(panel.getByText(F5_REASON, { exact: false })).toBeVisible();
  await capture(page, "row17-disabled-light");
  await setDark(page, true);
  await capture(page, "row17-disabled-dark");
  await setDark(page, false);
});

test("@live F9 row 18 previews a saved pipeline and traps focus", async ({
  liveWorkspace,
}, testInfo) => {
  const { page } = liveWorkspace;
  const pipelineName = await createPipeline(page, testInfo);
  await selectLiveWorkspaceTab(page, "Chat");

  const trigger = page.getByRole("button", { name: /Pipeline preview/ });
  await expect(trigger).toBeVisible();
  const railBox = await trigger.boundingBox();
  expect(railBox?.width ?? 0).toBeGreaterThan(70);
  expect(railBox?.width ?? 0).toBeLessThanOrEqual(96);

  await trigger.hover();
  const preview = page.getByRole("dialog", { name: "Pipeline preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(pipelineName, { timeout: 20_000 });
  await expect(preview).toContainText("Most recent in this project");
  const previewBox = await preview.boundingBox();
  expect(previewBox?.width).toBeCloseTo(192, 0);
  expect(previewBox?.height).toBeCloseTo(192, 0);
  await capture(page, "row18-actual-pipeline-light");
  await setDark(page, true);
  await capture(page, "row18-actual-pipeline-dark");
  await setDark(page, false);

  await trigger.focus();
  await expect(preview).toHaveAttribute("aria-modal", "true");
  const close = preview.getByRole("button", { name: "Close pipeline preview" });
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await capture(page, "row18-focus-trap");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
