// TIER: UNMOCKED. Real backend on KADY_PORT and real engine on
// KADY_PIPELINE_ENGINE_PORT. Gate U/D evidence only; backend effects are pinned
// by server/test/subscription-usage.test.ts and F2 remains a named blocker.

import type { Page } from "@playwright/test";

import { expect, test } from "../../live-fixtures";

const SHOT_DIR = process.env.F8_SHOT_DIR;

async function capture(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function setDark(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), enabled);
}

test("@live F8 row 14 shows one real spend and subscription widget", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;
  const bar = page.getByRole("button", { name: /Spend and subscription usage/ });
  await expect(bar).toBeVisible();
  await bar.click();
  await expect(page.getByRole("heading", { name: "Subscription usage" })).toBeVisible();
  await expect(page.getByText("Quota not readable.", { exact: false }).first()).toBeVisible();
  expect(await page.getByRole("button", { name: /Spend and subscription usage/ }).count()).toBe(1);
  await capture(page, "row14-one-widget-light");
  await setDark(page, true);
  await capture(page, "row14-one-widget-dark");
  await setDark(page, false);
});

test("@live F8 row 15 exposes the grouped Kady CLI tab but fails closed without F2", async ({
  liveWorkspace,
}) => {
  const { page } = liveWorkspace;
  // React's development Strict Mode mounts the tab effect twice; both reads
  // reach the same absent F2 route and both refusals remain exact.
  liveWorkspace.expectRefusedResourceStatus(404);
  liveWorkspace.expectRefusedResourceStatus(404);
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Kady CLI" }).click();
  await expect(settings.getByText("Harness settings are unavailable.", { exact: false })).toBeVisible();
  await expect(settings.getByText("not available from this backend yet", { exact: false })).toBeVisible();
  await expect(settings.getByRole("radiogroup")).toHaveCount(0);
  await capture(page, "row15-f2-disabled-light");
  await setDark(page, true);
  await capture(page, "row15-f2-disabled-dark");
  await setDark(page, false);
});
