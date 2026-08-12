import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  STUDIO_ACTIONS,
  STUDIO_FONT_SPECIMENS,
  STUDIO_SECTIONS,
  STUDIO_STATUS_ITEMS,
  STUDIO_SWATCHES,
} from "./inventory";

async function openStudio(page: Page) {
  await page.getByRole("button", { name: "Components studio" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Components studio" })).toBeVisible();
  return dialog;
}

test.describe("Scientific DAG Studio component popup", () => {
  test("launcher opens the popup", async ({ workspacePage }) => {
    await openStudio(workspacePage);
  });

  test("popup identifies the workflow designer", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await expect(dialog.getByText("Scientific DAG Workflow Designer")).toBeVisible();
  });

  test("close control dismisses the popup", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await dialog.getByRole("button", { name: "Close components studio" }).click();
    await expect(dialog).toBeHidden();
  });

  test("Escape dismisses the popup", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await workspacePage.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("popup takes keyboard focus", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await expect(dialog.getByRole("button", { name: "Close components studio" })).toBeFocused();
  });

  for (const sectionName of STUDIO_SECTIONS) {
    test(`${sectionName} section renders`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      await expect(dialog.getByRole("heading", { name: sectionName })).toBeVisible();
    });
  }

  for (const specimen of STUDIO_FONT_SPECIMENS) {
    test(`${specimen} resolves its font token`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const label = dialog.getByText(specimen, { exact: true });
      await expect(label).toBeVisible();
      const styles = await label.locator("..").evaluate((element) => {
        const computed = getComputedStyle(element);
        const token = element.textContent?.match(/--f(?:hero|nav|cta|fig|ann)/)?.[0] ?? "";
        return {
          family: computed.fontFamily,
          tokenValue: token ? getComputedStyle(element.closest("[data-scientific-dag-studio-theme]") ?? element).getPropertyValue(token) : "",
        };
      });
      expect(styles.family.trim()).not.toBe("");
      expect(styles.tokenValue.trim()).not.toBe("");
    });
  }

  for (const swatchName of STUDIO_SWATCHES) {
    test(`${swatchName} palette swatch renders its color`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const swatch = dialog.getByText(swatchName, { exact: true }).locator("..");
      await expect(swatch).toBeVisible();
      await expect(swatch.locator("code")).toHaveText(/^#[0-9a-f]{6}$/i);
    });
  }

  for (const statusItem of STUDIO_STATUS_ITEMS) {
    test(`${statusItem} status specimen renders`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      await expect(dialog.getByText(statusItem, { exact: true })).toBeVisible();
    });
  }

  for (const actionName of STUDIO_ACTIONS) {
    test(`${actionName} action specimen renders`, async ({ workspacePage }) => {
      const dialog = await openStudio(workspacePage);
      const action = dialog.getByRole("button", { name: actionName });
      await expect(action).toBeVisible();
      if (actionName === "Awaiting graph") await expect(action).toBeDisabled();
    });
  }

  test("model and compute node cards are both present", async ({ workspacePage }) => {
    const dialog = await openStudio(workspacePage);
    await expect(dialog.getByText("Literature synthesis")).toBeVisible();
    await expect(dialog.getByText("Differential analysis")).toBeVisible();
  });
});
